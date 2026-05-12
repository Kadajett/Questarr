// Retro fork: RomM HTTP client.
//
// Auth model: Bearer token only. RomM v4.8 mints `rmm_*` Personal Access
// Tokens via POST /api/client-tokens. The fork accepts EITHER:
//   - apiToken supplied directly (preferred), OR
//   - one-shot username+password — used to mint a token via /api/login +
//     POST /api/client-tokens, then the password is discarded and only the
//     minted token is persisted.
//
// We never persist the password. setRommConfig() ignores any password field
// that survives mint failure. The only source of truth in system_config is
// `romm.apiToken`.
//
// All client methods return null/undefined on failure and log warnings; the
// sync orchestrator decides whether to retry or surface to the user.

import { storage } from "./storage.js";
import { igdbLogger } from "./logger.js";

export interface RommPlatform {
  id: number;
  slug: string;
  name: string;
  category?: string;
  rom_count?: number;
}

export interface RommRom {
  id: number;
  platform_id: number;
  platform_slug: string;
  platform_display_name?: string;
  name: string;
  fs_name: string;
  fs_extension?: string;
  fs_size_bytes?: number;
  igdb_id?: number | null;
  ss_id?: number | null;
  moby_id?: number | null;
}

export interface RommConfig {
  enabled: boolean;
  url: string;
  username: string; // display only — auth uses apiToken
  apiToken: string;
  transferEnabled: boolean;
  libraryPath: string;
  downloadsPath: string;
  scanAfterTransfer: boolean;
}

const SYSTEM_CONFIG_KEYS = {
  enabled: "romm.enabled",
  url: "romm.url",
  username: "romm.username",
  apiToken: "romm.apiToken",
  transferEnabled: "romm.transferEnabled",
  libraryPath: "romm.libraryPath",
  downloadsPath: "romm.downloadsPath",
  scanAfterTransfer: "romm.scanAfterTransfer",
} as const;

// Default scopes the fork mints for itself when generating an API token from
// user/pass. Read-only over platforms+roms, plus tasks.run for triggering
// post-transfer rescans. No write scopes on roms — RomM's library is the
// source of truth; the fork only adds files via the filesystem.
const DEFAULT_MINTED_TOKEN_SCOPES = ["platforms.read", "roms.read", "tasks.run"];

export async function getRommConfig(): Promise<RommConfig> {
  const [enabled, url, username, apiToken, transferEnabled, libraryPath, downloadsPath, scan] =
    await Promise.all([
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.enabled),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.url),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.username),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.apiToken),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.transferEnabled),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.libraryPath),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.downloadsPath),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.scanAfterTransfer),
    ]);
  return {
    enabled: enabled === "true",
    url: (url || "").replace(/\/$/, ""),
    username: username ?? "",
    apiToken: apiToken ?? "",
    transferEnabled: transferEnabled !== "false",
    libraryPath: libraryPath || "/bulk-storage/games-library/roms",
    downloadsPath: downloadsPath || "/bulk-storage/downloads/games",
    scanAfterTransfer: scan !== "false",
  };
}

// Persistable fields. `password` is intentionally NOT in this type — the
// caller (route) is responsible for swapping a password for a minted
// apiToken before invoking setRommConfig.
type RommConfigUpdates = Partial<Omit<RommConfig, "username">> & { username?: string };

export async function setRommConfig(updates: RommConfigUpdates): Promise<RommConfig> {
  const map: Partial<Record<keyof typeof SYSTEM_CONFIG_KEYS, string | boolean | undefined>> = {
    enabled: updates.enabled,
    url: updates.url,
    username: updates.username,
    apiToken: updates.apiToken,
    transferEnabled: updates.transferEnabled,
    libraryPath: updates.libraryPath,
    downloadsPath: updates.downloadsPath,
    scanAfterTransfer: updates.scanAfterTransfer,
  };
  const writes: Promise<void>[] = [];
  for (const [k, v] of Object.entries(map) as [keyof typeof SYSTEM_CONFIG_KEYS, unknown][]) {
    if (v === undefined) continue;
    writes.push(storage.setSystemConfig(SYSTEM_CONFIG_KEYS[k], String(v)));
  }
  await Promise.all(writes);
  return getRommConfig();
}

/**
 * One-shot: trade username+password for a freshly-minted RomM API token.
 * The password is discarded immediately after the mint call.
 *
 * Returns the new `rmm_*` token, or null on any failure (log includes the
 * reason). The caller is expected to persist only the token via setRommConfig.
 */
export async function mintApiTokenFromUserPass(
  url: string,
  username: string,
  password: string,
  tokenName = "questarr-auto"
): Promise<string | null> {
  const base = url.replace(/\/$/, "");
  if (!base || !username || !password) return null;

  // Step 1: Basic-auth login → session cookie.
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  let cookie: string | null = null;
  try {
    const loginRes = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!loginRes.ok) {
      igdbLogger.warn(
        { status: loginRes.status, body: (await loginRes.text()).slice(0, 200) },
        "RomM mint: login step failed"
      );
      return null;
    }
    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
  } catch (err) {
    igdbLogger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "RomM mint: login network error"
    );
    return null;
  }
  if (!cookie) {
    igdbLogger.warn("RomM mint: login returned 200 but no Set-Cookie header");
    return null;
  }

  // Step 2: create a personal access token using the session cookie.
  try {
    const mintRes = await fetch(`${base}/api/client-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: `${tokenName}-${new Date().toISOString().slice(0, 10)}`,
        scopes: DEFAULT_MINTED_TOKEN_SCOPES,
        expires_in: null,
      }),
    });
    if (!mintRes.ok) {
      igdbLogger.warn(
        { status: mintRes.status, body: (await mintRes.text()).slice(0, 200) },
        "RomM mint: client-tokens POST failed"
      );
      return null;
    }
    const json = (await mintRes.json()) as { raw_token?: string };
    if (!json.raw_token) {
      igdbLogger.warn({ keys: Object.keys(json) }, "RomM mint: response missing raw_token");
      return null;
    }
    return json.raw_token;
  } catch (err) {
    igdbLogger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "RomM mint: client-tokens network error"
    );
    return null;
  }
}

// IGDB-canonical platform name (what we store in games.target_platform) →
// RomM/IGDB slug used in the on-disk directory and the platform_slug field.
export const IGDB_PLATFORM_TO_ROMM_SLUG: Readonly<Record<string, string>> = {
  PlayStation: "playstation",
  "PlayStation 2": "ps2",
  "PlayStation 3": "ps3",
  "PlayStation 4": "ps4--1",
  "PlayStation 5": "ps5",
  "PlayStation Portable": "psp",
  "PlayStation Vita": "psvita",
  SNES: "snes",
  NES: "nes",
  "Nintendo 64": "n64",
  GameCube: "ngc",
  Wii: "wii",
  "Wii U": "wiiu",
  "Nintendo Switch": "switch",
  "Game Boy": "gb",
  "Game Boy Color": "gbc",
  "Game Boy Advance": "gba",
  "Nintendo DS": "nds",
  "Nintendo 3DS": "3ds",
  Genesis: "genesis-slash-megadrive",
  "Master System": "sms",
  Dreamcast: "dc",
  "Sega Saturn": "saturn",
  Xbox: "xbox",
  "Xbox 360": "xbox360",
  "Xbox One": "xboxone",
  "Xbox Series X": "series-x-s",
  "Neo Geo": "neogeoaes",
  "Neo Geo Pocket": "neo-geo-pocket",
  "Neo Geo Pocket Color": "neo-geo-pocket-color",
  Arcade: "arcade",
  Atari2600: "atari2600",
  Atari5200: "atari5200",
  Atari7800: "atari7800",
  AtariJaguar: "jaguar",
  AtariLynx: "lynx",
  TurboGrafx16: "turbografx16--1",
  PC: "win",
};

export const ROMM_SLUG_TO_IGDB_PLATFORM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IGDB_PLATFORM_TO_ROMM_SLUG).map(([k, v]) => [v, k])
);

class RommClient {
  private async request<T = unknown>(
    cfg: RommConfig,
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<T | null> {
    if (!cfg.url || !cfg.apiToken) {
      igdbLogger.debug({ path }, "RomM request skipped: no url/apiToken configured");
      return null;
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${cfg.url}${path}${qs ? `?${qs}` : ""}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      if (!res.ok) {
        igdbLogger.warn(
          { method, url, status: res.status, body: (await res.text()).slice(0, 200) },
          "RomM API non-2xx"
        );
        return null;
      }
      if (res.status === 204) return null;
      return (await res.json()) as T;
    } catch (err) {
      igdbLogger.warn(
        { method, url, err: err instanceof Error ? err.message : String(err) },
        "RomM API network error"
      );
      return null;
    }
  }

  async listPlatforms(cfg: RommConfig): Promise<RommPlatform[]> {
    const data = await this.request<RommPlatform[]>(cfg, "GET", "/api/platforms");
    return Array.isArray(data) ? data : [];
  }

  async listRoms(
    cfg: RommConfig,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{ items: RommRom[]; total: number }> {
    const data = await this.request<{ items: RommRom[]; total: number }>(cfg, "GET", "/api/roms", {
      query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0 },
    });
    return data ?? { items: [], total: 0 };
  }

  async listAllRoms(cfg: RommConfig, hardCap = 50_000): Promise<RommRom[]> {
    const out: RommRom[] = [];
    const pageSize = 250;
    let offset = 0;
    while (out.length < hardCap) {
      const page = await this.listRoms(cfg, { limit: pageSize, offset });
      if (page.items.length === 0) break;
      out.push(...page.items);
      if (out.length >= (page.total || 0)) break;
      offset += pageSize;
    }
    return out;
  }

  async triggerScan(cfg: RommConfig, platformSlug?: string): Promise<boolean> {
    // RomM v4 renamed `/api/tasks/run/scan` to `/api/tasks/run/scan_library`.
    // The body shape (optional `platforms` array) is unchanged.
    const body = platformSlug ? { platforms: [platformSlug] } : {};
    const res = await this.request<{ task_id?: string }>(
      cfg,
      "POST",
      "/api/tasks/run/scan_library",
      { body }
    );
    return res !== null;
  }
}

export const rommClient = new RommClient();
