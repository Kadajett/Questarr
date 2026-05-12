// Retro fork: LLM-backed ROM filename cleaner.
//
// Used by romm-transfer.ts when normalising rom filenames before they land
// in RomM's library. The deterministic regex cleaner in
// `cleanRomFilename` handles ~90% of cases (mostly the Cocorico romset
// numbering); this LLM fallback handles the long tail of repacker styles
// (Sony PSX dot-separated, GoodSet, redump partial dumps, etc.) the regex
// can't match.
//
// Activated only when the global LLM kill-switch is on. Returns null on any
// failure (caller falls back to the regex cleaner). NEVER throws.

import { config } from "./config.js";
import { igdbLogger } from "./logger.js";
import path from "node:path";

const RENAMER_TIMEOUT_MS = 15_000;

interface OpenRouterChoice {
  message?: { content?: string };
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
}

function buildPrompt(
  filename: string,
  platformName: string | null
): { system: string; user: string } {
  const system =
    "You are a ROM-filename normaliser. " +
    "Given a messy ROM filename, output ONLY the canonical No-Intro / Redump style " +
    "filename, preserving the file extension. " +
    'Format: "Title (Region) (Disc N) (Lang) [Tag].ext". ' +
    "Rules: " +
    "1) Strip repacker prefixes like '[Cocorico.PSX.Romset N of N]', 'Sony PSX', 'GoodSet', etc. " +
    "2) Strip catalog numbers like SLUS-00543, NPUB-12345. " +
    "3) Strip translation/hack tags like [T.Eng-Ful-...] and [H.BugFix-...]. " +
    "4) Convert dot-separated tokens to spaces (e.g. 'Colony.Wars.Disc1of2' → 'Colony Wars (Disc 1)'). " +
    "5) Use the canonical English title when an obvious abbreviation is used (e.g. 'CTR' → 'Crash Team Racing'). " +
    "6) Wrap regions in parens: USA, Europe, Japan, France, Germany, Italy, Spain, World. " +
    "7) Wrap discs as '(Disc N)' or '(Disc N of M)'. " +
    "8) Keep language tags as '(En,Fr,De,Es,It)' if present. " +
    "9) Do NOT invent metadata. If unsure, leave the title unchanged. " +
    "Respond with ONLY the cleaned filename. No prose, no quotes, no markdown.";

  const user = `Platform: ${platformName ?? "unknown"}\n` + `Filename: ${filename}`;

  return { system, user };
}

async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!config.llm.apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENAMER_TIMEOUT_MS);
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
        max_tokens: 120,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      igdbLogger.warn(
        { status: res.status, body: (await res.text()).slice(0, 200) },
        "LLM rename: openrouter call failed"
      );
      return null;
    }
    const json = (await res.json()) as OpenRouterResponse;
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    igdbLogger.warn({ err: err instanceof Error ? err.message : String(err) }, "LLM rename: error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Sanity-check the LLM's output before trusting it. Reject if:
// - empty / whitespace
// - contains newlines or surrounding quotes
// - extension changed (we only want a different stem, not a different file type)
// - extension lost entirely
// - contains path separators (shouldn't happen but defends against jailbreaks)
function validateLlmFilename(original: string, candidate: string): string | null {
  const c = candidate.trim().replace(/^["']|["']$/g, "");
  if (!c || c.includes("\n") || c.includes("/") || c.includes("\\")) return null;
  const origExt = path.extname(original).toLowerCase();
  const newExt = path.extname(c).toLowerCase();
  if (!origExt || !newExt) return null;
  if (origExt !== newExt) return null;
  // Length sanity: don't accept absurdly long replacements (a "creative" LLM).
  if (c.length > original.length * 2 + 20) return null;
  return c;
}

/**
 * Try to clean a rom filename with the LLM. Returns null when:
 *   - the LLM is disabled / unconfigured
 *   - the API call fails or times out
 *   - the response fails sanity checks
 *
 * Caller should fall back to the deterministic regex cleaner in that case.
 */
export async function cleanRomFilenameWithLLM(
  filename: string,
  platformName: string | null
): Promise<string | null> {
  if (!config.llm.enabled) return null;
  const { system, user } = buildPrompt(filename, platformName);
  const raw = await callOpenRouter(system, user);
  if (!raw) return null;
  const valid = validateLlmFilename(filename, raw);
  if (!valid) {
    igdbLogger.warn(
      { filename, raw: raw.slice(0, 120) },
      "LLM rename: response failed validation, falling back"
    );
    return null;
  }
  if (valid !== filename) {
    igdbLogger.info({ from: filename, to: valid }, "LLM cleaned rom filename");
  }
  return valid;
}
