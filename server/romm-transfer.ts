// Retro fork: when a Questarr download completes, move the resulting file(s)
// from SAB/qbit's downloads directory into RomM's per-platform library
// directory and (optionally) trigger a RomM rescan so it picks up the new
// roms immediately.
//
// File moves use rename when source+dest share a filesystem (typical when
// both live on the same PVC mount), falling back to copy+unlink otherwise.
//
// Failure semantics: any path here is best-effort. If the transfer fails,
// the Questarr game stays as 'owned' (the download did complete) and the
// file remains in the downloads dir for manual cleanup. We log loudly but
// never throw.

import { promises as fs } from "node:fs";
import path from "node:path";
import { igdbLogger } from "./logger.js";
import {
  rommClient,
  getRommConfig,
  IGDB_PLATFORM_TO_ROMM_SLUG,
  ROMM_SLUG_TO_IGDB_PLATFORM,
} from "./romm.js";
import { cleanRomFilenameWithLLM } from "./llm-rename.js";
import type { Game } from "../shared/schema.js";

/**
 * Normalise a rom filename to a No-Intro/Redump-ish form that RomM's
 * metadata scrapers (ScreenScraper, IGDB, Hasheous, etc.) can actually
 * match against. The transformations are deliberately conservative: only
 * strip cruft that's known to confuse the scraper, never modify the canonical
 * "Title (Region) (Disc N) (Lang)" core that scrapers key on.
 *
 * Strips:
 *   - "[Cocorico.PSX.Romset 224 of 1839] " or "[Cocorico.PSX.Hack ..] " or
 *     "[Cocorico.PSX.FanTrad ..] " — Cocorico's romset numbering prefix
 *   - "Sony PSX " — alternate repacker prefix sometimes appended to PSX rips
 *   - "[H.BugFix-4398]" / "[T.Eng-Ful-...]" — hack/translation patch tags
 *     embedded mid-filename
 *
 * Preserves:
 *   - Title core
 *   - "(USA)" / "(Europe)" / "(Japan)" region tags
 *   - "(Disc N)" / "(Disc N of M)" disc designators
 *   - "(En,Fr,De,Es,It)" language tags
 *   - File extension
 */
export function cleanRomFilename(name: string): string {
  const ext = path.extname(name);
  let stem = name.slice(0, name.length - ext.length);

  // 1. Strip leading "[Cocorico.<Cat>.<Sub> N of N] " prefix.
  stem = stem.replace(/^\[Cocorico\.[A-Za-z0-9]+\.[A-Za-z0-9]+\s+\d+\s+of\s+\d+\]\s+/, "");
  // Generic fallback for any "[X N of N] " bracketed numbering prefix.
  stem = stem.replace(/^\[[^\]]+\s+\d+\s+of\s+\d+\]\s+/, "");

  // 2. Strip "Sony PSX " prefix.
  stem = stem.replace(/^Sony PSX /, "");

  // 3. Strip hack/translation/patch tags like [H.BugFix-...] and
  //    [T.Eng-Ful-...]. These break scraper title matching.
  stem = stem.replace(/\s*\[[HT]\.[^\]]+\]/g, "");

  // 4. Collapse runs of whitespace.
  stem = stem.replace(/\s+/g, " ").trim();

  return stem + ext;
}

export interface TransferResult {
  attempted: boolean;
  moved: string[]; // dest paths actually moved
  skipped: string[]; // why-strings for items skipped
  scanTriggered: boolean;
}

const ROM_FILE_EXTENSIONS = new Set([
  // Disc-based
  ".iso",
  ".bin",
  ".cue",
  ".chd",
  ".pbp",
  ".cso",
  ".m3u",
  // Cartridge-based
  ".nes",
  ".sfc",
  ".smc",
  ".gen",
  ".md",
  ".smd",
  ".gb",
  ".gbc",
  ".gba",
  ".n64",
  ".z64",
  ".v64",
  ".nds",
  ".3ds",
  ".cia",
  ".nsp",
  ".xci",
  // Archive containers (RomM auto-extracts)
  ".zip",
  ".7z",
  ".rar",
  // Misc
  ".gcm",
  ".rvz",
  ".wbfs",
  ".wad",
]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Walk a directory recursively and return all rom-extension files. Returns
// a flat list of absolute paths.
async function findRomFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(root, {
      withFileTypes: true,
    })) as unknown as import("node:fs").Dirent[];
  } catch {
    return [];
  }
  for (const e of entries) {
    const name = String(e.name);
    const p = path.join(root, name);
    if (e.isDirectory()) {
      const nested = await findRomFiles(p);
      out.push(...nested);
    } else if (e.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (ROM_FILE_EXTENSIONS.has(ext)) out.push(p);
    }
  }
  return out;
}

// Move one file. Tries rename first (atomic, same-fs) and falls back to
// copy + unlink for cross-filesystem moves.
async function moveFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/**
 * Transfer the completed downloads for `game` into the RomM library and
 * optionally trigger a RomM scan for that platform.
 *
 * `downloadTitleHints` is the list of release titles that landed in the
 * downloads dir for this game (typically from gameDownloads.downloadTitle).
 * We scan those subdirectories for rom-shaped files.
 */
export async function transferToRomm(
  game: Pick<Game, "id" | "title" | "targetPlatform">,
  downloadTitleHints: string[]
): Promise<TransferResult> {
  const result: TransferResult = {
    attempted: false,
    moved: [],
    skipped: [],
    scanTriggered: false,
  };

  const cfg = await getRommConfig();
  if (!cfg.enabled || !cfg.transferEnabled) {
    result.skipped.push("romm transfer disabled");
    return result;
  }
  if (!game.targetPlatform) {
    result.skipped.push("game has no target_platform");
    return result;
  }
  const slug = IGDB_PLATFORM_TO_ROMM_SLUG[game.targetPlatform];
  if (!slug) {
    result.skipped.push(`no RomM slug mapped for ${game.targetPlatform}`);
    return result;
  }
  result.attempted = true;

  const destDir = path.join(cfg.libraryPath, slug);
  await fs.mkdir(destDir, { recursive: true }).catch(() => {});

  // Collect candidate source directories from the download titles. Fall back
  // to scanning the whole downloadsPath if no hints provided (rare).
  const candidates: string[] = [];
  for (const hint of downloadTitleHints) {
    if (!hint) continue;
    const candidate = path.join(cfg.downloadsPath, hint);
    if (await pathExists(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    result.skipped.push(
      `no source dir found in ${cfg.downloadsPath} for hints: ${downloadTitleHints.join(", ")}`
    );
    return result;
  }

  for (const srcDir of candidates) {
    const files = await findRomFiles(srcDir);
    if (files.length === 0) {
      result.skipped.push(`no rom-shaped files in ${srcDir}`);
      continue;
    }
    for (const src of files) {
      // Use the cleaned filename so RomM's metadata scrapers match the rom
      // against ScreenScraper/IGDB/etc. instead of choking on the
      // "[Cocorico.PSX.Romset N of N]" prefix or hack-tag noise. LLM is
      // tried first when configured (handles long-tail repacker styles);
      // the deterministic regex is the always-available fallback.
      const platformName = game.targetPlatform ?? null;
      const llmCleaned = await cleanRomFilenameWithLLM(path.basename(src), platformName);
      const cleanedName = llmCleaned ?? cleanRomFilename(path.basename(src));
      const dest = path.join(destDir, cleanedName);
      try {
        await moveFile(src, dest);
        result.moved.push(dest);
      } catch (err) {
        igdbLogger.warn(
          { src, dest, err: err instanceof Error ? err.message : String(err) },
          "RomM transfer: file move failed"
        );
        result.skipped.push(`move failed: ${src} → ${dest}`);
      }
    }
    // Best-effort cleanup of an empty source directory.
    try {
      const remaining = await fs.readdir(srcDir);
      if (remaining.length === 0) await fs.rmdir(srcDir);
    } catch {
      /* ignore */
    }
  }

  if (result.moved.length > 0 && cfg.scanAfterTransfer) {
    const scanned = await rommClient.triggerScan(cfg, slug);
    result.scanTriggered = scanned;
  }

  igdbLogger.info(
    { gameId: game.id, title: game.title, slug, ...result },
    "RomM transfer complete"
  );
  return result;
}

export interface RenameLibraryResult {
  scanned: number;
  renamed: { from: string; to: string }[];
  alreadyClean: number;
  errors: { path: string; error: string }[];
  scanTriggeredFor: string[];
}

/**
 * Walk the configured RomM library and rename any rom files whose name
 * cleanRomFilename() would alter, then trigger a per-platform scan so
 * RomM picks up the new names and re-runs metadata matching against
 * them. Idempotent — skips files whose name is already clean. Skips
 * collisions silently (logs at warn) rather than overwriting.
 */
export async function renameRommLibraryFiles(
  options: { dryRun?: boolean } = {}
): Promise<RenameLibraryResult> {
  const result: RenameLibraryResult = {
    scanned: 0,
    renamed: [],
    alreadyClean: 0,
    errors: [],
    scanTriggeredFor: [],
  };
  const cfg = await getRommConfig();
  if (!cfg.enabled || !cfg.libraryPath) {
    result.errors.push({ path: "<config>", error: "romm.enabled or libraryPath missing" });
    return result;
  }

  let platformDirs: import("node:fs").Dirent[];
  try {
    platformDirs = (await fs.readdir(cfg.libraryPath, {
      withFileTypes: true,
    })) as unknown as import("node:fs").Dirent[];
  } catch (err) {
    result.errors.push({
      path: cfg.libraryPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  const platformsTouched = new Set<string>();

  for (const pd of platformDirs) {
    if (!pd.isDirectory()) continue;
    const slug = String(pd.name);
    const platformDir = path.join(cfg.libraryPath, slug);
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(platformDir, {
        withFileTypes: true,
      })) as unknown as import("node:fs").Dirent[];
    } catch {
      continue;
    }
    const platformName = ROMM_SLUG_TO_IGDB_PLATFORM[slug] ?? null;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fname = String(e.name);
      result.scanned++;
      // LLM-first when configured, regex fallback otherwise.
      const llmCleaned = await cleanRomFilenameWithLLM(fname, platformName);
      const cleaned = llmCleaned ?? cleanRomFilename(fname);
      if (cleaned === fname) {
        result.alreadyClean++;
        continue;
      }
      const from = path.join(platformDir, fname);
      const to = path.join(platformDir, cleaned);
      // Refuse to clobber.
      try {
        await fs.access(to);
        result.errors.push({ path: from, error: `target already exists: ${to}` });
        continue;
      } catch {
        /* good — target doesn't exist */
      }
      if (options.dryRun) {
        result.renamed.push({ from, to });
        platformsTouched.add(slug);
        continue;
      }
      try {
        await fs.rename(from, to);
        result.renamed.push({ from, to });
        platformsTouched.add(slug);
      } catch (err) {
        result.errors.push({
          path: from,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Trigger a per-platform RomM rescan so metadata refreshes for the new
  // filenames. Best-effort; failures don't fail the whole rename pass.
  if (!options.dryRun && platformsTouched.size > 0 && cfg.scanAfterTransfer) {
    for (const slug of Array.from(platformsTouched)) {
      const ok = await rommClient.triggerScan(cfg, slug);
      if (ok) result.scanTriggeredFor.push(slug);
    }
  }

  igdbLogger.info(
    {
      scanned: result.scanned,
      renamed: result.renamed.length,
      alreadyClean: result.alreadyClean,
      errors: result.errors.length,
      scanTriggeredFor: result.scanTriggeredFor,
      dryRun: !!options.dryRun,
    },
    "RomM library rename complete"
  );
  return result;
}
