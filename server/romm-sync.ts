// Retro fork: pull RomM's library and reconcile against Questarr.
//
// For each rom in RomM:
//   - find a matching Questarr game (by igdbId first, then by normalised
//     title + matching target_platform / IGDB platforms array)
//   - if matched, set status='owned' and target_platform to the IGDB name
//     for the rom's platform_slug
//   - if no match AND createMissing=true, create a new owned entry with
//     metadata pulled from IGDB via Questarr's existing igdbClient
//
// Returns a summary suitable for the API response and logs.

import { storage } from "./storage.js";
import { igdbLogger } from "./logger.js";
import { igdbClient, getIgdbPlatformId } from "./igdb.js";
import { normalizeTitle } from "../shared/title-utils.js";
import { rommClient, getRommConfig, ROMM_SLUG_TO_IGDB_PLATFORM } from "./romm.js";
import type { RommRom } from "./romm.js";
import type { Game, InsertGame } from "../shared/schema.js";

export interface RommSyncSummary {
  totalRomsScanned: number;
  matchedExisting: number;
  alreadyOwned: number;
  flippedToOwned: number;
  createdNew: number;
  noMatch: number;
  unknownPlatform: number;
  errors: number;
}

const OWNED_STATUSES = new Set(["owned", "completed", "downloading"]);

export async function syncFromRomm(
  userId: string,
  options: { createMissing?: boolean } = {}
): Promise<RommSyncSummary> {
  const summary: RommSyncSummary = {
    totalRomsScanned: 0,
    matchedExisting: 0,
    alreadyOwned: 0,
    flippedToOwned: 0,
    createdNew: 0,
    noMatch: 0,
    unknownPlatform: 0,
    errors: 0,
  };

  const cfg = await getRommConfig();
  if (!cfg.enabled || !cfg.url || !cfg.username) {
    igdbLogger.info("RomM sync skipped — not enabled or missing creds");
    return summary;
  }

  const roms = await rommClient.listAllRoms(cfg);
  summary.totalRomsScanned = roms.length;
  if (roms.length === 0) {
    igdbLogger.warn("RomM sync: 0 roms returned (auth or empty library)");
    return summary;
  }

  // Pre-fetch the user's full library once for fast in-memory matching.
  const userGames = await storage.getUserGames(userId, true);
  const byIgdb = new Map<number, Game>();
  const byNormTitle = new Map<string, Game>();
  for (const g of userGames) {
    if (g.igdbId != null) byIgdb.set(g.igdbId, g);
    byNormTitle.set(normalizeTitle(g.title), g);
  }

  for (const rom of roms) {
    try {
      const igdbPlatform = ROMM_SLUG_TO_IGDB_PLATFORM[rom.platform_slug];
      if (!igdbPlatform) {
        summary.unknownPlatform++;
        igdbLogger.debug(
          { slug: rom.platform_slug, name: rom.name },
          "RomM sync: unmapped platform slug, skipping rom"
        );
        continue;
      }

      // Match priority: 1) IGDB id, 2) normalised title.
      let game: Game | undefined = rom.igdb_id != null ? byIgdb.get(rom.igdb_id) : undefined;
      if (!game) {
        const norm = normalizeTitle(rom.name);
        game = byNormTitle.get(norm);
      }

      if (game) {
        summary.matchedExisting++;
        const wantsFlip = !OWNED_STATUSES.has(game.status) || game.targetPlatform !== igdbPlatform;
        if (!wantsFlip) {
          summary.alreadyOwned++;
          continue;
        }
        await storage.updateGame(game.id, {
          status: "owned",
          targetPlatform: igdbPlatform,
        });
        summary.flippedToOwned++;
        // Update local map so further roms in this loop see the new state.
        game.status = "owned";
        game.targetPlatform = igdbPlatform;
      } else if (options.createMissing) {
        const created = await createOwnedFromRom(userId, rom, igdbPlatform);
        if (created) {
          summary.createdNew++;
          byIgdb.set(created.igdbId ?? -1, created);
          byNormTitle.set(normalizeTitle(created.title), created);
        } else {
          summary.errors++;
        }
      } else {
        summary.noMatch++;
      }
    } catch (err) {
      summary.errors++;
      igdbLogger.warn(
        { rom: rom.name, err: err instanceof Error ? err.message : String(err) },
        "RomM sync: row error"
      );
    }
  }

  igdbLogger.info(summary, "RomM sync complete");
  return summary;
}

async function createOwnedFromRom(
  userId: string,
  rom: RommRom,
  targetPlatform: string
): Promise<Game | null> {
  // Try IGDB platform-scoped search to enrich metadata. Fall back to bare
  // title-only fields when IGDB returns nothing (so the entry still lands).
  let igdbData: Record<string, unknown> | null = null;
  try {
    const platformId = getIgdbPlatformId(targetPlatform);
    const results = await igdbClient.searchGames(rom.name, 1, platformId);
    if (results.length > 0) {
      igdbData = igdbClient.formatGameData(results[0]);
    }
  } catch (err) {
    igdbLogger.debug(
      { rom: rom.name, err: err instanceof Error ? err.message : String(err) },
      "RomM sync: IGDB enrichment failed, creating bare entry"
    );
  }

  const insertData: Partial<InsertGame> = {
    userId,
    title: (igdbData?.title as string) ?? rom.name,
    status: "owned",
    targetPlatform,
    source: "manual",
    igdbId: (igdbData?.igdbId as number | null | undefined) ?? rom.igdb_id ?? null,
    coverUrl: (igdbData?.coverUrl as string | undefined) ?? null,
    summary: (igdbData?.summary as string | undefined) ?? null,
    releaseDate: (igdbData?.releaseDate as string | undefined) ?? null,
    rating: (igdbData?.rating as number | null | undefined) ?? null,
    platforms: (igdbData?.platforms as string[] | undefined) ?? [targetPlatform],
    genres: (igdbData?.genres as string[] | undefined) ?? [],
    publishers: (igdbData?.publishers as string[] | undefined) ?? [],
    developers: (igdbData?.developers as string[] | undefined) ?? [],
  };

  try {
    return await storage.addGame(insertData as InsertGame);
  } catch (err) {
    igdbLogger.warn(
      { rom: rom.name, err: err instanceof Error ? err.message : String(err) },
      "RomM sync: addGame failed"
    );
    return null;
  }
}
