import type { ContentBlockParam, MessageParam } from "./types.js";
import { estimateMessagesTokens } from "./tokens.js";

/**
 * Context compaction: turn the older part of the conversation into a single
 * structured summary produced by the model itself, then restart history with
 * [summary, ack] + a recent tail. Unlike plain truncation this preserves user
 * intent, decisions, file paths, and open tasks.
 *
 * All functions here are pure so they can be tested without an LLM.
 */

const MAX_TRANSCRIPT_CHARS = 60_000;

/** Render one message's content for the summarizer. */
function renderBlock(b: ContentBlockParam): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "thinking":
      return ""; // chain-of-thought is noise for a summary
    case "image":
      return "[image]";
    case "tool_use": {
      let inp = "";
      try {
        inp = JSON.stringify(b.input);
      } catch {
        inp = "{}";
      }
      return `[calls ${b.name} ${inp.slice(0, 300)}]`;
    }
    case "tool_result": {
      const text =
        typeof b.content === "string"
          ? b.content
          : (b.content ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join(" ");
      const firstLines = text.split("\n").slice(0, 6).join("\n").slice(0, 700);
      return `[${b.is_error ? "tool ERROR" : "tool result"}: ${firstLines}${text.length > firstLines.length ? " …" : ""}]`;
    }
    default:
      return "";
  }
}

export function renderTranscript(messages: MessageParam[]): string {
  const lines = messages.map((m) => {
    const c = m.content;
    const text = typeof c === "string" ? c : c.map(renderBlock).filter(Boolean).join(" ");
    const flat = text.replace(/\s+/g, " ").trim();
    return `${m.role === "user" ? "USER" : "ASSISTANT"}: ${flat.slice(0, 3000)}`;
  });
  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) out = out.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[… transcript truncated]";
  return out;
}

/* ---------------- pre-pruning ---------------- */

/** Tool results in the last N messages are recent enough to keep verbatim. */
export const PRUNE_PROTECT_LAST = 12;
/** Older tool results longer than this get their tail replaced by a marker. */
export const PRUNE_MAX_CHARS = 2_000;

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
  }
  return null;
}

/**
 * Cheap first pass before paying for an LLM summary: collapse the tail of old
 * tool_result blocks (file dumps, command output) to their first
 * `maxChars` plus a pruned marker. Recent messages (last `protectLast`) are
 * untouched - the model may still be working from that output. Returns how
 * much was saved so the caller can decide whether a real compaction is still
 * needed.
 */
export function pruneOldToolResults(
  messages: MessageParam[],
  protectLast = PRUNE_PROTECT_LAST,
  maxChars = PRUNE_MAX_CHARS,
): { messages: MessageParam[]; changed: number; savedChars: number } {
  const cutoff = messages.length - protectLast;
  let changed = 0;
  let savedChars = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff || m.role !== "user" || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      const text = toolResultText(b.content);
      if (text === null || text.length <= maxChars) return b;
      changed++;
      touched = true;
      savedChars += text.length - maxChars;
      const marker = `\n[... ${text.length - maxChars} chars of stale tool output pruned to save context]`;
      const head = text.slice(0, maxChars) + marker;
      return typeof b.content === "string" ? { ...b, content: head } : { ...b, content: [{ type: "text" as const, text: head }] };
    });
    return touched ? { ...m, content } : m;
  });
  return changed === 0 ? { messages, changed, savedChars } : { messages: out, changed, savedChars };
}

/* ---------------- incremental summary merging ---------------- */

/**
 * If the history begins with a previous handoff summary (from an earlier
 * compaction), extract it so it can be merged into the next summary instead
 * of being re-summarized from the transcript, and return the remaining
 * messages.
 */
export function extractPriorSummary(messages: MessageParam[]): { summary: string | null; rest: MessageParam[] } {
  const first = messages[0];
  if (first?.role === "user" && typeof first.content === "string" && first.content.startsWith("<context_compaction>")) {
    const m = /<context_compaction>[\s\S]*?summary:\n\n([\s\S]*?)\n<\/context_compaction>/.exec(first.content);
    let cut = 1;
    const second = messages[1];
    if (second?.role === "assistant" && typeof second.content === "string" && second.content.startsWith("I have the handoff summary")) {
      cut = 2;
    }
    return { summary: m ? m[1] : null, rest: messages.slice(cut) };
  }
  return { summary: null, rest: messages };
}

export function isPlainUser(m: MessageParam | undefined): boolean {
  if (!m || m.role !== "user") return false;
  const c = m.content;
  return !(Array.isArray(c) && c.some((b) => b.type === "tool_result"));
}

/**
 * Choose the split point: keep the last `keepMin` messages, then walk the
 * boundary back to the nearest plain user message. A tail that starts mid
 * tool-loop would orphan tool_result blocks (API error) or begin with an
 * assistant message (breaks role alternation after the summary/ack pair);
 * a plain user boundary is safe on both counts, and everything dropped was
 * tool_use-before-tool_result ordered, so no pair is split.
 */
export function pickCompactBoundary(messages: MessageParam[], keepMin = 6): number {
  let cut = Math.max(0, messages.length - keepMin);
  while (cut > 0 && !isPlainUser(messages[cut])) cut--;
  return isPlainUser(messages[cut]) ? cut : 0;
}

/**
 * A kept fork prefix is safe to continue from only if it ends on a completed
 * assistant turn: an assistant message that carries no tool_use (whose result
 * would live in the discarded tail, orphaning it) and, by ending on the
 * assistant side, keeps role alternation intact when the user sends the next
 * message. A prefix ending on a user message would collide with that next turn.
 */
function endsOnCleanAssistantTurn(m: MessageParam | undefined): boolean {
  if (!m || m.role !== "assistant") return false;
  const c = m.content;
  return !(Array.isArray(c) && c.some((b) => b.type === "tool_use"));
}

/**
 * Choose how many messages to keep when forking at `keep`: walk the cut back to
 * the nearest completed assistant turn. Returns 0..messages.length; 0 means no
 * safe boundary exists (there is nothing meaningful to fork).
 */
export function pickForkBoundary(messages: MessageParam[], keep: number): number {
  let cut = Math.max(0, Math.min(keep, messages.length));
  while (cut > 0 && !endsOnCleanAssistantTurn(messages[cut - 1])) cut--;
  return cut;
}

export const SUMMARIZER_SYSTEM =
  "You compress an AI coding-agent transcript into a handoff summary. Be factual and terse; " +
  "never invent anything not in the transcript.";

export const SUMMARIZER_PROMPT = `Summarize the agent transcript below so a fresh agent can continue the work without re-reading history. Use exactly these sections, empty ones as "- none":

## Task & intent
What the user asked for, in order, including corrections they made along the way.

## Decisions
Choices made and WHY (approach, libraries, patterns, rejected alternatives).

## Files & locations
Every file/path touched or referenced, each with one clause on what was done to it.

## Current state
Where the work stands right now: completed, in progress, failing tests, unapplied edits.

## Open tasks
Concrete next steps the agent should take.

## Gotchas
Errors hit and fixes found, environment quirks, user preferences (language, style, do-not-touch areas).

Transcript:
`;

/**
 * Build the summarizer user message. When a previous handoff summary exists
 * (this is the Nth compaction), it is folded in as a base to carry forward and
 * update, so facts from the very oldest turns survive across many compactions
 * instead of decaying each round.
 */
export function buildSummarizerInput(transcript: string, priorSummary: string | null): string {
  if (!priorSummary) return SUMMARIZER_PROMPT + transcript;
  return (
    `You are UPDATING a handoff summary. The "Existing summary" below covers the oldest part of ` +
    `this session; the "New transcript" covers what happened since. Produce one merged summary in ` +
    `the same six sections, carrying forward everything still relevant from the existing summary, ` +
    `updating Current state / Open tasks to reflect the new transcript, and dropping details that ` +
    `are now obsolete. Never invent anything absent from both inputs.\n\n` +
    `## Existing summary\n${priorSummary.trim()}\n\n` +
    `${SUMMARIZER_PROMPT}New transcript:\n${transcript}`
  );
}

export function buildSummaryMessage(summary: string): MessageParam {
  return {
    role: "user",
    content:
      `<context_compaction>\n` +
      `The conversation before this point was compacted to save context. Here is the summary:\n\n` +
      `${summary.trim() || "(summary unavailable)"}\n` +
      `</context_compaction>`,
  };
}

export function buildAckMessage(): MessageParam {
  return { role: "assistant", content: "I have the handoff summary and will continue from there." };
}

/**
 * Last-resort compaction when the summarizer call fails: drop whole
 * user/assistant exchange groups from the front until the history fits the
 * budget. Exchanges are delimited by plain user messages, so a dropped group
 * always contains a tool_use together with its tool_result - nothing is ever
 * orphaned, and the kept history always starts on a plain user message.
 */
export function truncateTo(messages: MessageParam[], budgetTokens: number): MessageParam[] {
  const out = [...messages];
  const est = () => estimateMessagesTokens(out);
  while (out.length > 2 && est() > budgetTokens) {
    const start = out.findIndex(isPlainUser);
    if (start < 0) break;
    let end = start + 1;
    while (end < out.length && !isPlainUser(out[end])) end++;
    if (end >= out.length) break; // only one exchange left; keep it whole
    out.splice(start, end - start);
  }
  return out;
}
