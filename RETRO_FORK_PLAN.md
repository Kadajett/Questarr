# Questarr → Retro fork: implementation plan

## Goal

Turn Questarr from a "PC-game tracker that happens to use IGDB" into a
**multi-platform retro game tracker** where each game has a *target platform*
(SNES, PS1, GBA, etc.) and auto-search / IGDB matching are platform-aware.

## Non-goals (for now)

- Replacing RomM as the ROM library / file scanner.
- Sonarr-style file import / renaming flows.
- Sending the changes upstream as a PR. This is a personal fork.

## Root causes in upstream Questarr

1. **`user_settings.preferred_platform` is a single global string.** Setting
   it to "PlayStation" silently filters every other platform out of
   auto-search. There is no per-game or per-platform allow-list.
2. **`POST /api/games/match-and-add` ignores platform.** It hardcodes
   `platform: "PC"` and grabs the first IGDB result, which sorts by
   popularity. Result: "Metal Gear Solid" → PC port, "Gran Turismo 2" →
   "Gran Turismo Sport: Spec II", "Threads of Fate" → "Fated Thread", etc.
3. **`igdbClient.searchGames` accepts no platform filter.** It runs three
   IGDB query approaches all without `where platforms = (X)`.
4. **`games` table has no per-game target-platform field** — only a
   descriptive `platforms` JSON array from IGDB.

## Fork strategy

- Repo: clone of `Doezer/Questarr` already at `~/dev/Questarr`.
- Push to: **`github.com/kadajett/Questarr`** (private fork for now). Keep
  the name "Questarr" for v0.1 to minimize cognitive overhead; rebrand later
  if it sticks (suggested name: **Retroarr**).
- Branch model: `main` tracks our changes; periodically rebase from upstream
  `Doezer/Questarr/main` if useful changes land there.
- Container image: build via existing GH Action, push to **local registry
  at `registry.local`** (192.168.88.200, per `MEMORY.md`). Falls back to
  `ghcr.io/kadajett/questarr-retro` if local registry has issues.
- K8s deployment: update `image:` in
  `~/dev/plexPod/manifests/questarr/deployment.yaml`, point at the new tag.
  Keep the gluetun sidecar + DNS workaround as-is.

## Phase 1 — MVP: per-game target platform (≈1 day)

### Schema

Add to `shared/schema.ts` (`games` table):
```ts
targetPlatform: text("target_platform"),  // null = unspecified, e.g. "PlayStation", "SNES"
```

Migration via `npm run db:generate` → new file in `migrations/`.
Backfill: existing rows stay null until the user (or the migration script)
sets them. The 50 games I added get their target_platform set to "PlayStation"
via the migration script.

Drop the `preferred_platform` semantics for filtering (keep the column for
back-compat — just stop reading it in `applyPreferredPlatformFilter`).

### Server

- `server/igdb.ts`: extend `searchGames(query, limit, platformId?)` — when
  `platformId` set, prepend `where platforms = (${platformId});` to all three
  search-approach queries.
- `server/igdb.ts`: add a constant `PLATFORM_NAME_TO_IGDB_ID` mapping the
  platforms we care about. Seed with the 14 RomM-populated platforms:
  ```ts
  const PLATFORM_NAME_TO_IGDB_ID = {
    "PlayStation": 7,
    "Super Nintendo Entertainment System": 19,
    "Game Boy Advance": 24,
    "Game Boy Color": 22,
    "Nintendo Entertainment System": 18,
    "Sega Mega Drive/Genesis": 29,
    "Nintendo 64": 4,
    "Neo Geo Pocket Color": 119,
    "Nintendo 3DS": 37,
    "Neo Geo MVS": 79,
    "Arcade": 52,
    "Nintendo Switch": 130,
    "PlayStation 2": 8,
    "Nintendo DS": 20,
    "GameCube": 21,
    "Game Boy": 33,
  };
  ```
- `server/routes.ts` `POST /api/games/match-and-add`:
  - Accept `{title, platform?}`. If platform set, lookup IGDB id and pass
    to `searchGames`. Set `targetPlatform: platform` on the new row instead
    of hardcoded `platform: "PC"`.
- `server/routes.ts` `POST /api/games`: accept `targetPlatform`.
- `server/routes.ts` new: `PATCH /api/games/:id/target-platform`
  `{platform: string|null}`.
- `server/routes.ts` `GET /api/games`: accept `?targetPlatform=X` filter.
- `server/cron.ts` `applyPreferredPlatformFilter`: replace `preferredPlatform`
  argument with the per-game `targetPlatform`. The auto-search loop already
  iterates per game, so it has the value.
- `server/routes.ts` `GET /api/igdb/search`: accept `&platform=X`.

### Client

Smallest useful change for Phase 1:
- Game card: show a target-platform badge (use the existing `<Badge>` component).
- Add-game modal: add a Platform `<Select>` populated from the constant
  above. Default = the last-used platform (localStorage).
- Library page: add a platform filter dropdown that hits
  `GET /api/games?targetPlatform=X`.

### Backfill / migration

Standalone script `scripts/migrate-target-platform.ts` that:
1. Sets `target_platform = "PlayStation"` for the 50 games already added.
2. For the 22 misresolved games, re-queries IGDB with platform=7 filter,
   updates `igdb_id`, `platforms`, `cover_url`, `summary`, `release_date`
   in place. No delete + re-add — preserve the row IDs and `added_at`.
3. Idempotent — safe to re-run.

## Phase 2 — UX polish (≈1 day)

- Settings page: "Enabled platforms" multi-select. Drives the platform
  dropdown in the add-game modal so it doesn't show all 200+ IGDB platforms.
- Library: tabbed view by platform (`All | PS1 | SNES | GBA | …`).
- Discover: platform filter (already partially exists for search results).
- Quick-add UX: when pasting a name, show top 3 IGDB matches *for the
  selected platform* and let user pick, instead of auto-picking #1.

## Phase 3 — RomM integration (≈1–2 days)

- Settings: RomM URL + API token.
- `POST /api/romm/sync`: walks RomM's library API, for each ROM:
  - Match against existing Questarr games (by IGDB id if RomM exposes it,
    else by title + platform).
  - If found: set `status = "owned"`, `target_platform = <RomM platform>`.
  - If not found: create a new game with `status = "owned"`,
    `target_platform = <RomM platform>`, IGDB lookup for metadata.
- Cron: nightly RomM resync.

## Build & deploy

### Local dev loop
```sh
cd ~/dev/Questarr
docker compose up -d   # uses upstream's docker-compose.yml, IGDB creds via .env
# Hot-reload front+back via `npm run dev` for fast iteration
```

### CI (GitHub Actions)
- Modify `.github/workflows/ci.yml` to also build and push to
  `registry.local/questarr:${git-sha}` and `:latest` on push to `main`.
- Need to surface a registry credential as a GH secret OR self-host the
  runner on the cluster (preferred — local-only registry, no public push).

### Cluster rollout
- Update `image:` in
  `~/dev/plexPod/manifests/questarr/deployment.yaml` to
  `registry.local/questarr:<sha>`.
- `kubectl apply` + `kubectl rollout status`.
- Pre-existing PVC `questarr-data` carries the SQLite DB; migrations
  auto-run on container start (already wired via `entrypoint.sh`).

## Risks / open questions

1. **Upstream sync vs hard fork.** If upstream Questarr makes major schema
   changes, our fork has to merge. Hard fork avoids merge pain at the cost
   of missing upstream features (RSS scrapers, indexer integrations, etc.).
   I recommend tracking upstream loosely — rebase only when something we
   want lands.

2. **IGDB platform IDs are stable** but new console releases may need adding
   to the constant. Trivial to update.

3. **Indexer category mapping.** Auto-search only works if Prowlarr returns
   results tagged with a usable platform/category. We may need to also wire
   up per-platform indexer config (e.g., "use this indexer only for SNES")
   in Phase 2/3. Defer until we see what Prowlarr returns in practice.

4. **"PC" defaults.** Right now `match-and-add` writes `platform: "PC"`
   even though the column doesn't exist in the schema (silently dropped).
   Need to remove that and any other "PC"-isms in the UI copy.

5. **Naming.** "Questarr" is recognizably an *arr; "Retroarr" is more
   accurate. Defer rename until v0.2 when the UI changes are visible.

## What I need from you to start

- **Confirm fork target.** `github.com/kadajett/Questarr` private repo OK?
- **Confirm container registry.** Local (`registry.local`) or ghcr.io?
- **Naming.** Stay "Questarr" for now or rename to "Retroarr" from the start?
- **Phase 1 scope.** All of it, or just the schema + match-and-add platform
  filter (the bare minimum to fix the matching + filtering bug)?
