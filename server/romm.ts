// Retro fork: RomM HTTP client.
//
// RomM exposes a session-cookie-authenticated REST API. We log in once via
// POST /api/login (basic-auth header) which sets a session cookie; the
// cookie is reused for subsequent calls. Tokens are NOT supported by
// RomM v4.8.x for the API surface we need (rom listing + upload).
//
// All methods return null/undefined on failure; the sync orchestrator
// decides whether to retry, log, or surface to the user.

import { storage } from "./storage.js";
import { igdbLogger } from "./logger.js";

export interface RommPlatform {
  id: number;
  slug: string; // canonical RomM/IGDB slug, e.g. "playstation", "snes"
  name: string;
  category?: string;
  rom_count?: number;
}

export interface RommRom {
  id: number;
  platform_id: number;
  platform_slug: string;
  platform_name: string;
  name: string; // display name
  fs_name: string; // filename on disk
  fs_extension?: string;
  fs_size_bytes?: number;
  igdb_id?: number | null;
  ss_id?: number | null;
  moby_id?: number | null;
}

export interface RommConfig {
  enabled: boolean;
  url: string; // base URL, e.g. http://romm.romm.svc.cluster.local:8080
  username: string;
  password: string;
  transferEnabled: boolean;
  libraryPath: string; // host path mounted into questarr where roms go
  downloadsPath: string; // host path mounted into questarr where SAB/qbit drop completed downloads
  scanAfterTransfer: boolean;
}

const SYSTEM_CONFIG_KEYS = {
  enabled: "romm.enabled",
  url: "romm.url",
  username: "romm.username",
  password: "romm.password",
  transferEnabled: "romm.transferEnabled",
  libraryPath: "romm.libraryPath",
  downloadsPath: "romm.downloadsPath",
  scanAfterTransfer: "romm.scanAfterTransfer",
} as const;

export async function getRommConfig(): Promise<RommConfig> {
  const [enabled, url, username, password, transferEnabled, libraryPath, downloadsPath, scan] =
    await Promise.all([
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.enabled),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.url),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.username),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.password),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.transferEnabled),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.libraryPath),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.downloadsPath),
      storage.getSystemConfig(SYSTEM_CONFIG_KEYS.scanAfterTransfer),
    ]);
  return {
    enabled: enabled === "true",
    url: (url || "").replace(/\/$/, ""),
    username: username ?? "",
    password: password ?? "",
    transferEnabled: transferEnabled !== "false", // default true
    libraryPath: libraryPath || "/bulk-storage/games-library/roms",
    downloadsPath: downloadsPath || "/bulk-storage/downloads/games",
    scanAfterTransfer: scan !== "false", // default true
  };
}

export async function setRommConfig(updates: Partial<RommConfig>): Promise<RommConfig> {
  const writes: Promise<void>[] = [];
  const map: Record<keyof typeof SYSTEM_CONFIG_KEYS, string | boolean | undefined> = {
    enabled: updates.enabled,
    url: updates.url,
    username: updates.username,
    password: updates.password,
    transferEnabled: updates.transferEnabled,
    libraryPath: updates.libraryPath,
    downloadsPath: updates.downloadsPath,
    scanAfterTransfer: updates.scanAfterTransfer,
  };
  for (const [k, v] of Object.entries(map) as [keyof typeof SYSTEM_CONFIG_KEYS, unknown][]) {
    if (v === undefined) continue;
    writes.push(storage.setSystemConfig(SYSTEM_CONFIG_KEYS[k], String(v)));
  }
  await Promise.all(writes);
  return getRommConfig();
}

// IGDB-canonical platform name (as we store in games.target_platform) →
// RomM/IGDB slug used in the on-disk directory and the platform_slug field.
// Slugs must match what RomM auto-discovers; see /api/heartbeat → FS_PLATFORMS.
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

// Reverse lookup: RomM slug → IGDB-canonical name.
export const ROMM_SLUG_TO_IGDB_PLATFORM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IGDB_PLATFORM_TO_ROMM_SLUG).map(([k, v]) => [v, k])
);

class RommClient {
  private cookie: string | null = null;
  private cookieExpiresAt = 0;

  private async ensureSession(cfg: RommConfig): Promise<boolean> {
    if (this.cookie && Date.now() < this.cookieExpiresAt) return true;
    if (!cfg.url || !cfg.username) return false;

    const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
    try {
      const res = await fetch(`${cfg.url}/api/login`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
      });
      if (!res.ok) {
        igdbLogger.warn(
          { status: res.status, body: (await res.text()).slice(0, 200) },
          "RomM login failed"
        );
        return false;
      }
      const setCookie = res.headers.get("set-cookie");
      if (!setCookie) {
        igdbLogger.warn("RomM login returned 200 but no Set-Cookie header");
        return false;
      }
      // Take the first cookie pair only (RomM's session_id=...).
      this.cookie = setCookie.split(";")[0];
      // RomM sessions are long-lived; refresh hourly to be safe.
      this.cookieExpiresAt = Date.now() + 60 * 60 * 1000;
      return true;
    } catch (err) {
      igdbLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "RomM login network error"
      );
      return false;
    }
  }

  private async request<T = unknown>(
    cfg: RommConfig,
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<T | null> {
    if (!(await this.ensureSession(cfg))) return null;
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
          Cookie: this.cookie!,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      if (res.status === 401 || res.status === 403) {
        // Session expired — drop and retry once.
        this.cookie = null;
        if (!(await this.ensureSession(cfg))) return null;
        return this.request<T>(cfg, method, path, init);
      }
      if (!res.ok) {
        igdbLogger.warn(
          { method, url, status: res.status, body: (await res.text()).slice(0, 200) },
          "RomM API non-200"
        );
        return null;
      }
      // Some endpoints (scan trigger) return 204.
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

  // RomM /api/roms is paginated; the response shape is
  // { items: RommRom[], total: number, limit, offset }.
  async listRoms(
    cfg: RommConfig,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<{
    items: RommRom[];
    total: number;
  }> {
    const data = await this.request<{ items: RommRom[]; total: number }>(cfg, "GET", "/api/roms", {
      query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0 },
    });
    return data ?? { items: [], total: 0 };
  }

  // Pull every rom in the library, page by page. Caps at hardCap items.
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
    // RomM v4 exposes /api/tasks/run/scan with optional platforms[] body.
    const body = platformSlug ? { platforms: [platformSlug] } : {};
    const res = await this.request<{ task_id?: string }>(cfg, "POST", "/api/tasks/run/scan", {
      body,
    });
    return res !== null;
  }
}

export const rommClient = new RommClient();
