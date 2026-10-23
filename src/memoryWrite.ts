import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import type { SendOptions } from "./llm/types.js";
import { auxiliarySendOptions } from "./auxiliary.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { projectMemoryPath, userMemoryPath } from "./memory.js";

/**
 * Memory write side. The read side (memory.ts) is injection + recall only;
 * this module adds three ways for facts to reach the memory files:
 *
 * - `saveMemoryTool`: the main agent's foreground save_memory tool (the
 *   subagent variant lives in subagentMemory.ts and writes per-identity files).
 * - post-turn auto-extraction (opt-in via AGENT_MEMORY_EXTRACTION=1): after a
 *   successful main turn, one background LLM call decides whether the exchange
 *   contained a durable fact; the reply is applied by deterministic section
 *   upsert, never by letting the model rewrite the file.
 * - `/dream` consolidation: a single LLM call proposes a reorganized memory
 *   file; nothing is applied until the user confirms.
 */

const MAX_NOTE_CHARS = 8_000;
const MAX_ENTRIES_PER_EXTRACTION = 5;
const MAX_HEADING_CHARS = 80;

export interface MemoryExtractEntry {
  heading: string;
  note: string;
}

/** Minimal view of the LLM backend the extraction/dream calls need. */
export interface LlmLite {
  send(
    messages: unknown[],
    system: string,
    tools: unknown[],
    signal?: AbortSignal,
    events?: unknown,
    opts?: SendOptions,
  ): Promise<{ content: Array<{ type: string; text?: string }>; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }>;
}

/* ---------- save_memory tool ---------- */

export const saveMemoryTool: Tool = {
  name: "save_memory",
  description:
    "Save one durable, reusable fact to long-term memory - it is loaded into your system prompt on future runs. " +
    "One focused note per call: user preferences, project conventions, verified commands, gotchas. " +
    "Never save secrets or task-ephemeral detail; skip when nothing durable happened.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      heading: { type: "string", description: 'Short topic heading (e.g. "build system layout"). Notes under the same heading are grouped.' },
      note: { type: "string", description: "The fact itself, dense markdown. Max ~8000 chars." },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description: '"project" (default) = this repo; "user" = machine-global.',
      },
    },
    required: ["note"],
  },
  async execute(input: Record<string, unknown>, ctx): Promise<{ content: string; isError?: boolean }> {
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!note) return { content: "Error: note must not be empty", isError: true };
    const scope = input.scope === "user" ? "user" : "project";
    const heading = typeof input.heading === "string" ? input.heading : "Note";
    const preview = `## ${heading}\n${note.slice(0, 2000)}`;
    const ok = await ctx.askPermission(`Save a note to ${scope} long-term memory ("${heading}")`, "low", preview);
    if (!ok) return { content: "Memory save declined; nothing was written.", isError: true };
    const p = await upsertMemorySection(scope === "user" ? userMemoryPath() : projectMemoryPath(ctx.cwd), heading, note);
    if (!p) return { content: "Error: memory write failed", isError: true };
    return { content: `Saved to ${p}. It will be loaded on your next run.` };
  },
};

/* ---------- section upsert ---------- */

function cleanHeading(heading: string): string {
  return heading.replace(/\s+/g, " ").trim().slice(0, MAX_HEADING_CHARS) || "Note";
}

/**
 * Append a note under `## <heading>` in the memory file, creating the section
 * when missing. Exact duplicates (same heading and note) are skipped. The
 * note is truncated; the file is trimmed from the front when it outgrows the
 * read-side budget. Returns the path written, or null on refusal/failure.
 */
export async function upsertMemorySection(file: string, heading: string, note: string): Promise<string | null> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let current = "";
    try {
      // Never write through a planted symlink (memory.md -> src/x.ts).
      if (!(await fs.lstat(file)).isFile()) return null;
      current = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const clean = cleanHeading(heading);
    const body = note.trim().slice(0, MAX_NOTE_CHARS);
    const lines = current.length ? current.split("\n") : [];
    // Find the section and reject exact duplicates.
    let sectionStart = -1;
    let sectionEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = /^##\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (!m) continue;
      if (sectionStart >= 0) {
        sectionEnd = i;
        break;
      }
      if (m[1].trim() === clean) sectionStart = i;
    }
    if (sectionStart >= 0) {
      for (let i = sectionStart + 1; i < sectionEnd; i++) {
        if (lines[i].trim() === body) return file; // exact duplicate
      }
      // Append after the section's last non-empty line, keeping the blank
      // separator line before the next heading.
      let insertAt = sectionEnd;
      while (insertAt > sectionStart + 1 && !lines[insertAt - 1].trim()) insertAt--;
      lines.splice(insertAt, 0, body);
    } else {
      if (lines.length && lines[lines.length - 1].trim()) lines.push("");
      lines.push(`## ${clean}`, body);
    }
    await atomicWriteFile(file, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
    return file;
  } catch {
    return null;
  }
}

/** Level-2 headings currently present in a memory file (missing file → []). */
export async function listMemoryHeadings(file: string): Promise<string[]> {
  try {
    if (!(await fs.lstat(file)).isFile()) return [];
    const raw = await fs.readFile(file, "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push(m[1].trim());
    }
    return out;
  } catch {
    return [];
  }
}

/* ---------- post-turn auto-extraction ---------- */

export function memoryExtractionEnabled(): boolean {
  return process.env.AGENT_MEMORY_EXTRACTION === "1";
}

/** Set by headless/print mode so cron and -p runs never write memory behind the user's back. */
let extractionDisabled = false;
export function disableMemoryExtraction(): void {
  extractionDisabled = true;
}
export function isMemoryExtractionDisabled(): boolean {
  return extractionDisabled;
}

export const EXTRACTION_SYSTEM =
  "You curate a long-term memory file for a coding agent. Given one exchange, decide whether it revealed a " +
  "durable, reusable fact worth remembering: user preferences, project conventions, verified commands, " +
  "gotchas, decisions and their reasons. Never save secrets, task-ephemeral state, or anything already " +
  "listed in the current headings. Reply with ONLY a JSON array (no prose, no code fence): " +
  '[{"heading": "<short topic>", "note": "<dense markdown fact>"}] - or [] when there is nothing worth saving.';

export function buildExtractionPrompt(userText: string, assistantText: string, headings: string[]): string {
  const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "\n…[truncated]" : s);
  return (
    "Current memory headings (do not duplicate these):\n" +
    (headings.length ? headings.map((h) => `- ${h}`).join("\n") : "(memory is empty)") +
    "\n\nThe exchange to analyze:\n\n<user>\n" +
    clip(userText, 6000) +
    "\n</user>\n\n<assistant>\n" +
    clip(assistantText, 6000) +
    "\n</assistant>"
  );
}

/** Parse the extraction reply leniently: a JSON array anywhere in the text. */
export function parseExtractionReply(text: string): MemoryExtractEntry[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MemoryExtractEntry[] = [];
  for (const item of parsed.slice(0, MAX_ENTRIES_PER_EXTRACTION)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const note = typeof rec.note === "string" ? rec.note.trim() : "";
    if (!note) continue;
    out.push({
      heading: typeof rec.heading === "string" ? rec.heading : "Note",
      note,
    });
  }
  return out;
}

/** Apply extracted entries to the project memory file. Returns descriptions of what was written. */
export async function applyExtraction(cwd: string, entries: MemoryExtractEntry[], when: string): Promise<string[]> {
  const applied: string[] = [];
  for (const e of entries.slice(0, MAX_ENTRIES_PER_EXTRACTION)) {
    const p = await upsertMemorySection(projectMemoryPath(cwd), cleanHeading(e.heading), e.note.trim().slice(0, MAX_NOTE_CHARS));
    if (p) applied.push(`${path.relative(cwd, p) || p} → ## ${cleanHeading(e.heading)} (${when})`);
  }
  return applied;
}

/* ---------- scheduler: one running, latest pending ---------- */

let jobRunning = false;
let jobPending: (() => Promise<void>) | null = null;

/** Fire-and-forget scheduling: never more than one extraction runs; a new request while busy replaces any queued one. */
export function scheduleMemoryJob(job: () => Promise<void>): void {
  if (jobRunning) {
    jobPending = job;
    return;
  }
  jobRunning = true;
  void job()
    .catch(() => {})
    .finally(() => {
      jobRunning = false;
      const next = jobPending;
      jobPending = null;
      if (next) scheduleMemoryJob(next);
    });
}

export function memoryJobIdle(): boolean {
  return !jobRunning && !jobPending;
}

/** Test hook: wait until the scheduler has drained. */
export async function waitForMemoryJobs(): Promise<void> {
  while (!memoryJobIdle()) await new Promise((r) => setTimeout(r, 5));
}

/* ---------- /dream consolidation ---------- */

export const DREAM_SYSTEM =
  "You consolidate the long-term memory file of a coding agent. Merge duplicate or overlapping sections under " +
  "one heading, resolve contradictions in favor of the newer dated note, convert relative dates to absolute " +
  "ones, drop ephemeral task state and facts that no longer matter, and keep everything else verbatim in " +
  "meaning. Output ONLY the full new markdown file (level-2 sections, one topic per heading) - no prose, no " +
  "code fence. Never invent facts that are not in the input.";

/**
 * Propose a consolidated rewrite of the project memory file. The proposal is
 * written to `.node-agent/memory.dream.md`; nothing else changes until
 * `applyDream` moves it into place. Returns the proposal path, or null when
 * there is nothing to consolidate or the model failed.
 */
export async function proposeDream(cwd: string, llm: LlmLite): Promise<string | null> {
  try {
    const file = projectMemoryPath(cwd);
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (!current.trim()) return null;
    const res = await llm.send([{ role: "user", content: `Consolidate this memory file:\n\n${current.slice(0, 300_000)}` }], DREAM_SYSTEM, [], undefined, undefined, auxiliarySendOptions());
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n")
      .trim();
    if (!text || text.length < 8) return null;
    const proposal = path.join(cwd, ".node-agent", "memory.dream.md");
    await fs.mkdir(path.dirname(proposal), { recursive: true });
    await atomicWriteFile(proposal, text + "\n");
    return proposal;
  } catch {
    return null;
  }
}

/**
 * Apply a pending dream proposal: the current file is backed up to
 * memory.md.bak (one generation) and replaced atomically. Returns a short
 * report, or null when no proposal is pending.
 */
export async function applyDream(cwd: string): Promise<string | null> {
  try {
    const file = projectMemoryPath(cwd);
    const proposal = path.join(cwd, ".node-agent", "memory.dream.md");
    const text = await fs.readFile(proposal, "utf8");
    await fs.copyFile(file, file + ".bak").catch(() => {});
    await atomicWriteFile(file, text);
    await fs.rm(proposal, { force: true });
    return `dream applied: ${file} (previous content kept at ${file}.bak)`;
  } catch {
    return null;
  }
}

/** Human-facing preview of a pending proposal, or null when none is pending. */
export async function peekDream(cwd: string): Promise<{ path: string; lines: number; preview: string } | null> {
  try {
    const proposal = path.join(cwd, ".node-agent", "memory.dream.md");
    const text = await fs.readFile(proposal, "utf8");
    const lines = text.split("\n");
    return {
      path: proposal,
      lines: lines.length,
      preview: lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n… (${lines.length - 40} more lines)` : ""),
    };
  } catch {
    return null;
  }
}
