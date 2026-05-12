# Retro multi-platform fork

This is a public personal fork of [Doezer/Questarr](https://github.com/Doezer/Questarr).
The upstream project is a great PC-games tracker. This fork extends it into a
**multi-platform retro game tracker** — think *Sonarr/Radarr but for SNES,
PS1, GBA, etc.* — alongside the existing PC use case.

It is not currently intended to be merged upstream. If any change here turns
out to be generally useful, a clean PR will be opened separately.

## Why this fork exists

Upstream Questarr has three design choices that block multi-platform retro
use:

1. **`user_settings.preferred_platform` is a single global string.** Setting
   it to "PlayStation" silently filters every other platform out of
   auto-search. There is no per-game or multi-platform allow-list.
2. **`POST /api/games/match-and-add` ignores platform.** It hardcodes
   `platform: "PC"` and grabs the first IGDB result, which sorts by
   popularity. So `Metal Gear Solid` resolves to a PC port,
   `Gran Turismo 2` to `Gran Turismo Sport: Spec II`, `Threads of Fate` to
   `Fated Thread`, etc.
3. **`igdbClient.searchGames` accepts no platform filter.** All three
   internal search approaches omit `where platforms = (X);`, so IGDB
   returns whichever modern release is most popular for that title.

Together those make it impossible to reliably bulk-add a list like
"top 50 PS1 games" — most resolve to the wrong record, and even when they
resolve correctly, the global preferred-platform setting can't accommodate
"I track PS1 *and* SNES *and* GBA".

## What this fork changes (planned)

See [`RETRO_FORK_PLAN.md`](./RETRO_FORK_PLAN.md) for the full plan. High level:

### Phase 1 — per-game target platform (MVP)

- Add `target_platform` text column to the `games` table (nullable).
- `igdbClient.searchGames(query, limit, platformId?)` — when a platform id
  is provided, prepend `where platforms = (X);` to the query.
- A `PLATFORM_NAME_TO_IGDB_ID` constant covering the common retro
  platforms (PS1, SNES, NES, GBA, GBC, Genesis, N64, NeoGeo, 3DS, Switch,
  GameCube, DS, PS2, Game Boy, Arcade).
- `POST /api/games/match-and-add` accepts `{title, platform?}` and writes
  `target_platform` instead of the hardcoded `platform: "PC"`.
- `POST /api/games` accepts `targetPlatform`.
- `PATCH /api/games/:id/target-platform` for after-the-fact changes.
- `GET /api/games?targetPlatform=X` filter.
- `GET /api/igdb/search?platform=X` platform filter.
- Auto-search filter switches from the global `preferred_platform` to the
  per-game `target_platform`. The old column stays for back-compat but is
  no longer read.
- A small `<Select>` for platform in the add-game modal, a platform badge
  on game cards, a platform filter on the library page.

### Phase 2 — UX

- "Enabled platforms" multi-select in Settings (drives the dropdown).
- Tabbed library view by platform.
- Platform-aware quick-add that shows top 3 IGDB matches and lets you
  pick, instead of auto-picking #1.

### Phase 3 — RomM integration

- Settings: RomM URL + API token.
- `POST /api/romm/sync` walks RomM's library and either matches existing
  Questarr games (setting `status=owned`) or creates owned entries with
  the right `target_platform`.
- Nightly resync cron.

## Status

| Phase | Status |
|-------|--------|
| Phase 1 — MVP | not started |
| Phase 2 — UX  | not started |
| Phase 3 — RomM | not started |

## Branch model

- `retro-fork` — active branch for this fork's changes.
- `main` — left as-is for now to make rebasing from upstream easier.
  Periodically merged from `upstream/main`.

## Credit

All credit for the underlying app goes to
[Doezer](https://github.com/Doezer) and the
[Questarr contributors](https://github.com/Doezer/Questarr/graphs/contributors).
This fork only changes the platform model.
