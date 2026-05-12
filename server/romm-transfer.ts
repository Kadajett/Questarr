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
import { rommClient, getRommConfig, IGDB_PLATFORM_TO_ROMM_SLUG } from "./romm.js";
import type { Game } from "../shared/schema.js";

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
      const dest = path.join(destDir, path.basename(src));
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
