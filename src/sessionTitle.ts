import type { LLM } from "./llm.js";

/** Longest slice of the user's first message we send for titling. */
export const MAX_TITLE_INPUT = 1_200;
/** Stored/display cap (matches the session store's 80-char title limit). */
export const MAX_TITLE_CHARS = 80;
/** Short first messages ("hi", "修一下") make better titles verbatim than via a model. */
export const MIN_TITLE_INPUT = 10;
export const TITLE_TIMEOUT_MS = 60_000;

export const TITLE_SYSTEM =
  "You name coding-agent conversations for a session list. Read the user's first request and write a " +
  "short, specific display title: 3-7 words, same language as the user, no quotes, no emoji, no trailing " +
  "punctuation, no prefix like \"Title:\". Describe what the session is about (area + intent), not a " +
  "generic greeting. Never answer the request or add commentary. Output ONLY a JSON object " +
  '{"title":"..."} and nothing else.';

// Titles cost an extra LLM call, so tests (which script every send) disable
// them by default; production is on unless explicitly switched off. Print
// mode opts out through disableSessionTitles().
let titlesDisabled = process.env.VITEST === "true";

/** Titles are on by default; AGENT_SESSION_TITLES=0 opts out. */
export function sessionTitlesEnabled(): boolean {
  return !titlesDisabled && process.env.AGENT_SESSION_TITLES !== "0";
}

/** Set by headless/print mode: cron and -p sessions should not spend a title call. */
export function disableSessionTitles(): void {
  titlesDisabled = true;
}

/** Test hook: exercise the default-on behavior after the module forced it off. */
export function enableSessionTitlesForTests(): void {
  titlesDisabled = false;
}

/** Collapse whitespace and bound the input sent to the model. */
export function normalizeTitleInput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_INPUT);
}

function jsonTitle(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const src of fence ? [fence[1], text] : [text]) {
    const start = src.indexOf("{");
    const end = src.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(src.slice(start, end + 1)) as { title?: unknown };
      if (typeof obj.title === "string" && obj.title.trim()) return obj.title;
    } catch {
      /* not JSON - try the next candidate */
    }
  }
  return null;
}

/**
 * Turn a model reply into a display title: JSON first (the requested shape),
 * fenced JSON second, first non-empty line as the lenient fallback. Returns
 * null for anything that cannot make a meaningful title.
 */
export function cleanGeneratedTitle(raw: string): string | null {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  if (!stripped) return null;
  const parsed = jsonTitle(stripped);
  const firstLine = stripped.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  // A JSON-shaped reply without a usable title must not become the title.
  const picked = parsed ?? (firstLine.startsWith("{") ? "" : firstLine);
  let title = picked
    .replace(/^#{1,6}\s*/, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。!！?？;；:：,，、…\s]+$/g, "")
    .trim();
  if (!title) return null;
  // A title made only of punctuation/symbols helps nobody.
  if (!/[A-Za-z0-9\u3400-\u9fff]/.test(title)) return null;
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
  return title;
}

/** Prompt pair for the titling call, or null when the input is too short to title. */
export function buildTitlePrompt(firstInput: string): { system: string; user: string } | null {
  const input = normalizeTitleInput(firstInput);
  if (input.length < MIN_TITLE_INPUT) return null;
  return { system: TITLE_SYSTEM, user: `User's first request:\n"""\n${input}\n"""\n\nWrite the title.` };
}

/** One sidecar call: generate a title for the session's first request. */
export async function generateSessionTitle(
  llm: LLM,
  firstInput: string,
): Promise<{ title: string; usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } } | null> {
  const prompt = buildTitlePrompt(firstInput);
  if (!prompt) return null;
  const res = await llm.send(
    [{ role: "user", content: prompt.user }],
    prompt.system,
    [],
    AbortSignal.timeout(TITLE_TIMEOUT_MS),
  );
  const text = res.content
    .filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n");
  const title = cleanGeneratedTitle(text);
  if (!title) return null;
  return {
    title,
    usage: {
      input: res.inputTokens,
      output: res.outputTokens,
      cacheRead: res.cacheReadTokens,
      cacheWrite: res.cacheWriteTokens,
    },
  };
}
