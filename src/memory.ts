import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-session memory: a plain markdown file (project-level
 * `.node-agent/memory.md`, plus a user-level `~/.node-agent/memory.md`) that
 * is injected into the system prompt of every session and appended to
 * automatically when a context compaction produces a handoff summary. Facts,
 * decisions and gotchas therefore survive across restarts without the model
 * having to do anything.
 *
 * The stable prompt only carries the newest entries that fit its budget. When
 * older entries are trimmed, a deterministic lexical selector recalls the ones
 * that match the current request and injects them into that turn's user
 * message, so the cached system prefix stays identical across turns.
 */

const MAX_INJECT_CHARS = 24_000; // keep prompt injection bounded
const RECALL_MAX_ENTRIES = 3;
const RECALL_MAX_CHARS = 2_400;
const RECALL_MIN_SCORE = 2;

export interface RecallOptions {
  maxEntries?: number;
  maxChars?: number;
  minScore?: number;
}

export interface RecallEntry {
  source: "user" | "project";
  file: string;
  heading: string;
  text: string;
  order: number;
}

export function projectMemoryPath(cwd: string): string {
  return path.join(cwd, ".node-agent", "memory.md");
}

export function userMemoryPath(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "memory.md");
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const text = raw.replace(/^\uFEFF/, "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

interface MemoryDoc {
  entries: RecallEntry[];
  /** Entries before this index were trimmed; they are eligible for recall. */
  omittedEnd: number;
  recent: string;
  ellipsis: boolean;
}

/** Split markdown into level-2+ sections, keeping each heading with its body. */
function splitSections(text: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = [];
  let heading = "";
  let body: string[] = [];
  let fenced = false;
  const flush = () => {
    const joined = body.join("\n").trim();
    if (joined) out.push({ heading, text: joined });
    body = [];
  };
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trimStart())) fenced = !fenced;
    const m = fenced ? null : /^#{2,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
      body = [line];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

async function loadMemoryDocs(cwd: string, home?: string): Promise<MemoryDoc[]> {
  const [user, project] = await Promise.all([readIfExists(userMemoryPath(home)), readIfExists(projectMemoryPath(cwd))]);
  const sources = [
    { source: "user" as const, file: "~/.node-agent/memory.md", text: user },
    { source: "project" as const, file: ".node-agent/memory.md", text: project },
  ].filter((s): s is { source: "user" | "project"; file: string; text: string } => !!s.text);

  const per = Math.floor(MAX_INJECT_CHARS / 2);
  const docs: MemoryDoc[] = [];
  let order = 0;
  for (const source of sources) {
    const entries: RecallEntry[] = splitSections(source.text).map((sec) => ({
      source: source.source,
      file: source.file,
      heading: sec.heading,
      text: sec.text,
      order: order++,
    }));
    let start = entries.length;
    let used = 0;
    while (start > 0) {
      const size = entries[start - 1].text.length + (used ? 1 : 0);
      if (used + size > per) break;
      used += size;
      start--;
    }
    if (!entries.length) continue;
    if (start === entries.length) {
      // The newest entry alone exceeds the budget: keep its tail rather than
      // dropping memory, and leave the older entries recallable.
      const last = entries[entries.length - 1];
      docs.push({
        entries,
        omittedEnd: entries.length - 1,
        ellipsis: true,
        recent: last.text.slice(Math.max(0, last.text.length - per)),
      });
      continue;
    }
    docs.push({
      entries,
      omittedEnd: start,
      ellipsis: start > 0,
      recent: entries.slice(start).map((e) => e.text).join("\n"),
    });
  }
  return docs;
}

/**
 * Render the memory block for the system prompt. Both files are optional;
 * returns "" when neither exists.
 */
export async function renderMemory(cwd: string, home?: string): Promise<string> {
  const docs = await loadMemoryDocs(cwd, home);
  if (!docs.length) return "";
  const sections = docs.map((doc) => {
    const body = doc.ellipsis ? `…\n${doc.recent}` : doc.recent;
    return doc.entries[0].source === "user"
      ? `<user_memory file="~/.node-agent/memory.md">\n${body}\n</user_memory>`
      : `<project_memory file=".node-agent/memory.md">\n${body}\n</project_memory>`;
  });
  const trimmed = docs.some((d) => d.ellipsis);
  return (
    "\nLong-term memory from earlier sessions (facts, decisions, gotchas). Trust it over guesswork, follow recorded user preferences, and update it via edit_file when the user asks you to remember something:" +
    (trimmed ? " Older entries were trimmed here and are recalled per request when relevant." : "") +
    "\n" +
    sections.join("\n") +
    "\n"
  );
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what", "when", "where",
  "which", "how", "why", "please", "should", "could", "would", "about", "have", "has",
  "are", "was", "were", "you", "your", "our", "not", "but", "all", "any", "can", "may",
  "will", "just", "now", "then", "than", "them", "they", "there", "their", "its",
]);

/** CJK runs become bigrams; latin words are matched whole. */
function queryTerms(query: string): Set<string> {
  const terms = new Set<string>();
  const lower = query.toLowerCase();
  for (const run of lower.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  const latin = lower.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, " ");
  for (const word of latin.match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) {
    if (word.length >= 2 && !STOPWORDS.has(word)) terms.add(word);
  }
  return terms;
}

/**
 * Pick the omitted entries most related to the query. Pure and deterministic:
 * longer matched terms score higher, heading hits count double, and newer
 * entries win ties.
 */
export function selectMemoryEntries(entries: RecallEntry[], query: string, opts: RecallOptions = {}): RecallEntry[] {
  const maxEntries = Math.max(1, opts.maxEntries ?? RECALL_MAX_ENTRIES);
  const maxChars = Math.max(1, opts.maxChars ?? RECALL_MAX_CHARS);
  const minScore = Math.max(1, opts.minScore ?? RECALL_MIN_SCORE);
  const terms = queryTerms(query);
  if (!terms.size) return [];

  const scored = entries
    .map((entry) => {
      const heading = entry.heading.toLowerCase();
      const body = entry.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (heading.includes(term)) score += term.length * 2;
        else if (body.includes(term)) score += term.length;
      }
      return { entry, score };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || b.entry.order - a.entry.order);

  const picked: RecallEntry[] = [];
  let used = 0;
  for (const { entry } of scored) {
    if (picked.length >= maxEntries) break;
    if (used + entry.text.length > maxChars) {
      if (!picked.length) {
        picked.push({ ...entry, text: entry.text.slice(0, Math.max(0, maxChars - 1)) + "…" });
        used = maxChars;
      }
      continue;
    }
    picked.push(entry);
    used += entry.text.length;
  }
  return picked;
}

/**
 * Return a formatted block of older entries relevant to this request, or ""
 * when nothing was trimmed or nothing matches. Read failures are silent:
 * recall must never break a turn.
 */
export async function recallMemory(cwd: string, query: string, home?: string, opts: RecallOptions = {}): Promise<string> {
  if (!query.trim()) return "";
  let docs: MemoryDoc[];
  try {
    docs = await loadMemoryDocs(cwd, home);
  } catch {
    return "";
  }
  const omitted = docs.flatMap((doc) => doc.entries.slice(0, doc.omittedEnd));
  const picked = selectMemoryEntries(omitted, query, opts);
  if (!picked.length) return "";
  const entries = picked
    .map((entry) => {
      const heading = entry.heading ? ` heading="${entry.heading.replace(/"/g, "&quot;")}"` : "";
      return `<memory_entry source="${entry.file}"${heading}>\n${entry.text}\n</memory_entry>`;
    })
    .join("\n");
  return (
    "Older long-term memory entries relevant to this request (they were trimmed from the system prompt; " +
    `update them with edit_file if they are stale):\n${entries}`
  );
}

/**
 * Append a compaction handoff summary to the project memory file so its
 * decisions and gotchas outlive the session. Best-effort: memory must never
 * break compaction. Returns the path written, or null on failure.
 */
export async function appendMemoryNote(cwd: string, note: string, when: string): Promise<string | null> {
  try {
    const p = projectMemoryPath(cwd);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const body = `\n## Session note (${when})\n${note.trim()}\n`;
    await fs.appendFile(p, body, "utf8");
    return p;
  } catch {
    return null;
  }
}
