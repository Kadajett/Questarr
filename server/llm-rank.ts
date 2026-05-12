// Retro fork: optional LLM-backed release ranker.
//
// Given a game (title + target platform + IGDB metadata) and a list of
// candidate releases returned by the indexers, asks an OpenRouter model to
// pick the best one and return its index plus a one-sentence reason.
//
// Default model is `google/gemini-2.5-flash` — cheap, fast, good at
// constrained JSON output. Override via env `LLM_MODEL`.
//
// All failure paths return null so the caller can fall back to its existing
// "first match" heuristic. We never throw out of this module.

import { config } from "./config.js";
import { igdbLogger } from "./logger.js";
import type { Game } from "../shared/schema.js";

export interface RankableRelease {
  title: string;
  group?: string | null;
  size?: number | null;
  seeders?: number | null;
  indexerName?: string | null;
  downloadType?: string | null;
}

export interface RankResult {
  index: number;
  reason: string;
  model: string;
}

const RANKER_TIMEOUT_MS = 25_000;

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function buildPrompt(
  game: Pick<Game, "title" | "targetPlatform" | "platforms" | "releaseDate" | "summary">,
  items: RankableRelease[]
): { system: string; user: string } {
  const system =
    "You are a release-quality auditor for a self-hosted game library. " +
    "Given a wanted game and a numbered list of candidate releases scraped " +
    "from torrent/usenet indexers, pick the SINGLE best release for the user. " +
    "Prefer: matching the requested target platform (especially for retro: " +
    "PSX vs PS3, SNES vs Switch remake), original/canonical release over " +
    "remakes/remasters when the request is platform-specific, well-known " +
    "scene/repack groups (FitGirl, DODI, RUNE, RAZOR1911, EMPRESS, GOG, TENOKE), " +
    "complete editions over partial, more seeders, larger size only when it " +
    "indicates completeness (DLC/updates included). Avoid: trainers/cheats, " +
    "language packs, soundtracks-only, broken release names, anything " +
    "obviously off-platform. Respond with ONLY a JSON object of shape " +
    '{"index": <0-based number>, "reason": "<one short sentence>"}. ' +
    "No prose, no markdown.";

  const platforms = game.platforms?.join(", ") ?? "unknown";
  const lines = items.map((it, i) => {
    const seeders = it.seeders != null ? `${it.seeders}s` : "?s";
    const size = formatBytes(it.size ?? null);
    const group = it.group ? ` [${it.group}]` : "";
    const typ = it.downloadType ? ` (${it.downloadType})` : "";
    const idx = it.indexerName ? ` via ${it.indexerName}` : "";
    return `${i}. ${it.title}${group} — ${size}, ${seeders}${typ}${idx}`;
  });
  const user =
    `Wanted game: ${game.title}\n` +
    `Target platform: ${game.targetPlatform ?? "any"}\n` +
    `IGDB platforms: ${platforms}\n` +
    (game.releaseDate ? `Release date: ${game.releaseDate}\n` : "") +
    "\nCandidates:\n" +
    lines.join("\n");

  return { system, user };
}

interface OpenRouterChoice {
  message?: { content?: string };
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
}

async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!config.llm.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RANKER_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
        "HTTP-Referer": "https://github.com/Kadajett/Questarr",
        "X-Title": "Questarr Retro",
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0,
        max_tokens: 200,
        // Coerce JSON-only output where the model supports it.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      igdbLogger.warn(
        { status: res.status, body: body.slice(0, 200) },
        "LLM ranker: openrouter call failed"
      );
      return null;
    }
    const json = (await res.json()) as OpenRouterResponse;
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    igdbLogger.warn({ err: err instanceof Error ? err.message : String(err) }, "LLM ranker: error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonResponse(raw: string): { index: number; reason: string } | null {
  // Be forgiving of stray prose around the JSON object.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as { index?: unknown; reason?: unknown };
    const index = typeof parsed.index === "number" ? parsed.index : Number(parsed.index);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    if (!Number.isFinite(index) || !Number.isInteger(index) || index < 0) return null;
    return { index, reason };
  } catch {
    return null;
  }
}

/**
 * Pick the best release with the LLM. Returns null if the ranker is disabled,
 * unavailable, or fails for any reason. Caller MUST fall back to its existing
 * heuristic in that case.
 */
export async function rankReleases(
  game: Pick<Game, "title" | "targetPlatform" | "platforms" | "releaseDate" | "summary">,
  items: RankableRelease[]
): Promise<RankResult | null> {
  if (!config.llm.enabled) return null;
  if (items.length === 0) return null;
  if (items.length === 1) {
    return { index: 0, reason: "only one candidate", model: config.llm.model };
  }

  const { system, user } = buildPrompt(game, items);
  const raw = await callOpenRouter(system, user);
  if (!raw) return null;
  const parsed = parseJsonResponse(raw);
  if (!parsed) {
    igdbLogger.warn({ raw: raw.slice(0, 200) }, "LLM ranker: could not parse response");
    return null;
  }
  if (parsed.index >= items.length) {
    igdbLogger.warn(
      { index: parsed.index, len: items.length },
      "LLM ranker: out-of-range index, ignoring"
    );
    return null;
  }
  igdbLogger.info(
    { game: game.title, pick: items[parsed.index].title, reason: parsed.reason },
    "LLM ranker pick"
  );
  return { index: parsed.index, reason: parsed.reason, model: config.llm.model };
}
