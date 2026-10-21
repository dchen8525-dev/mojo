import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { MessageParam } from "./types.js";
import { sanitizeTodos, type TodoItem } from "./tools/todo.js";

const SESSION_DIR = path.join(os.homedir(), ".node-agent", "sessions");

export interface SessionMeta {
  id: string;
  cwd: string;
  startedAt: string;
  /** Derived from the file's mtime, so it always reflects the last append. */
  updatedAt: string;
  /** Last model used in this session, as "provider:model" (restored on resume). */
  model?: string;
  /** Optional user-assigned name (shown in the GUI sidebar / /sessions). */
  title?: string;
  /** Optional user-assigned labels (set via /tag or the GUI sidebar). */
  tags?: string[];
  /** Session id this one was branched from (set by /fork). */
  forkedFrom?: string;
  /** Latest todo plan, so the GUI panel survives a restart or session switch. */
  todos?: TodoItem[];
}

function fileFor(id: string) {
  return path.join(SESSION_DIR, `${id}.jsonl`);
}

/** Session ids are hex; public entry points reject anything path-like. */
const ID_RE = /^[0-9a-f]{4,64}$/;

/**
 * Serialize writers per session file. Meta updates are read-modify-write:
 * without this, a concurrent append landing between the read and the rewrite
 * would be silently dropped.
 */
const fileLocks = new Map<string, Promise<void>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(file, tail);
  void tail.then(() => {
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  });
  return run;
}

/**
 * Replace a file via a sibling temp file + rename, so a crash mid-write leaves
 * the previous contents intact. rename() is atomic on POSIX; on Windows it
 * replaces the target too, but can transiently fail with EPERM/EBUSY while a
 * scanner or reader holds the file, hence the short retry loop.
 */
async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      // Some network/removable filesystems do not implement fsync; the
      // rename below still prevents torn files, so do not fail the write.
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/**
 * Parsed sessions keyed by file path, validated against mtime + size. The GUI
 * lists and searches sessions far more often than they change; re-parsing
 * every file on each call used to dominate those requests.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession | null;
}
const PARSE_CACHE_MAX = 32;
const parseCache = new Map<string, CacheEntry>();

function invalidateSession(id: string): void {
  if (ID_RE.test(id)) parseCache.delete(fileFor(id));
}

export async function createSession(cwd: string): Promise<{ id: string; meta: SessionMeta }> {
  const id = crypto.randomBytes(4).toString("hex");
  const now = new Date().toISOString();
  const meta: SessionMeta = { id, cwd, startedAt: now, updatedAt: now };
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(fileFor(id), JSON.stringify({ type: "meta", ...meta }) + "\n", "utf8");
  return { id, meta };
}

export async function appendMessages(id: string, messages: MessageParam[]) {
  const lines = messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n");
  if (!lines) return;
  await withFileLock(fileFor(id), async () => {
    await fs.appendFile(fileFor(id), lines + "\n", "utf8");
    invalidateSession(id);
  });
}

/**
 * Replace the whole message log (used after compaction, where the in-memory
 * history is shorter than what's on disk). Keeps the meta header; model
 * markers are dropped, so callers should re-append the current model.
 */
export async function rewriteMessages(id: string, messages: MessageParam[]) {
  const file = fileFor(id);
  await withFileLock(file, async () => {
    let metaLine = "";
    try {
      const raw = await fs.readFile(file, "utf8");
      metaLine = raw.split("\n").find((l) => l.trim().startsWith('{"type":"meta"')) ?? "";
    } catch {
      return; // no session file: nothing to rewrite
    }
    if (!metaLine) return;
    const lines = messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n");
    await atomicWrite(file, metaLine + "\n" + (lines ? lines + "\n" : ""));
    invalidateSession(id);
  });
}

/** Append a model marker; the last one in the file is the session's model. */
export async function appendModel(id: string, model: string) {
  await withFileLock(fileFor(id), async () => {
    await fs.appendFile(fileFor(id), JSON.stringify({ type: "model", model }) + "\n");
    invalidateSession(id);
  });
}

/**
 * Rewrite a session's meta header through `mutate`. `updatedAt` is derived from
 * the file's mtime, so it is stripped from the stored header.
 */
async function updateMeta(id: string, mutate: (meta: SessionMeta) => void): Promise<SessionMeta | null> {
  if (!ID_RE.test(id)) return null;
  const file = fileFor(id);
  return withFileLock(file, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    const idx = lines.findIndex((l) => l.trim().startsWith('{"type":"meta"'));
    if (idx === -1) return null;
    let meta: SessionMeta;
    try {
      meta = JSON.parse(lines[idx]);
    } catch {
      return null;
    }
    delete (meta as { updatedAt?: string }).updatedAt;
    mutate(meta);
    lines[idx] = JSON.stringify({ type: "meta", ...meta });
    await atomicWrite(file, lines.join("\n"));
    invalidateSession(id);
    return meta;
  });
}

/** Persist the current todo plan in the session header (an empty list clears it). */
export async function saveTodos(id: string, todos: TodoItem[]): Promise<boolean> {
  const clean = sanitizeTodos(todos) ?? [];
  try {
    const meta = await updateMeta(id, (m) => {
      if (clean.length) m.todos = clean;
      else delete m.todos;
    });
    return meta !== null;
  } catch {
    return false; // a failed metadata write must not fail the tool call
  }
}

/**
 * Set (or clear, with an empty title) a session's display name by rewriting
 * its meta header line. Returns false when the session does not exist.
 */
export async function renameSession(id: string, title: string): Promise<boolean> {
  const clean = title.trim().slice(0, 80);
  const meta = await updateMeta(id, (m) => {
    if (clean) m.title = clean;
    else delete m.title;
  });
  return meta !== null;
}

/**
 * Replace a session's tags. Tags are trimmed, deduped, capped at 24 chars and
 * 8 per session; an empty list removes the field. Returns the stored tags, or
 * null when the session does not exist / its meta line is corrupt.
 */
export async function tagSession(id: string, tags: string[]): Promise<string[] | null> {
  const clean = [...new Set(tags.map((t) => t.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);
  const meta = await updateMeta(id, (m) => {
    if (clean.length) m.tags = clean;
    else delete m.tags;
  });
  return meta ? clean : null;
}

/**
 * Create a new session that starts as a copy of `messages`, optionally titled and
 * recorded as branched from `fromId`. Used by /fork to continue from a point in
 * history without disturbing the original session file.
 */
export async function forkSession(
  cwd: string,
  messages: MessageParam[],
  opts: { title?: string; fromId?: string; todos?: TodoItem[] } = {},
): Promise<{ id: string; meta: SessionMeta }> {
  const { id } = await createSession(cwd);
  const clean = opts.title?.trim().slice(0, 80);
  const todos = sanitizeTodos(opts.todos ?? []) ?? [];
  if (clean || opts.fromId || todos.length) {
    // Rewrite the meta header once, carrying all fields, before any appends.
    await updateMeta(id, (meta) => {
      if (clean) meta.title = clean;
      if (opts.fromId) meta.forkedFrom = opts.fromId;
      if (todos.length) meta.todos = todos;
    });
  }
  if (messages.length) await appendMessages(id, messages);
  const now = new Date().toISOString();
  return { id, meta: { id, cwd, startedAt: now, updatedAt: now, ...(clean ? { title: clean } : {}), ...(opts.fromId ? { forkedFrom: opts.fromId } : {}), ...(todos.length ? { todos } : {}) } };
}

/** Delete a session file. Returns false when it did not exist. */
export async function deleteSession(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const file = fileFor(id);
  return withFileLock(file, async () => {
    invalidateSession(id);
    try {
      await fs.unlink(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

interface ParsedSession {
  meta: SessionMeta;
  messages: MessageParam[];
}

/** Single-pass parse of a session file; updatedAt comes from the file mtime. */
async function parseSessionFile(full: string): Promise<ParsedSession | null> {
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    parseCache.delete(full);
    return null;
  }
  const cached = parseCache.get(full);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    parseCache.delete(full); // LRU touch
    parseCache.set(full, cached);
    return cached.parsed;
  }

  let raw: string;
  try {
    raw = await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
  const mtimeMs = stat.mtimeMs;
  let meta: SessionMeta | null = null;
  const messages: MessageParam[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "meta") {
        const todos = sanitizeTodos(obj.todos);
        meta = {
          id: obj.id,
          cwd: obj.cwd,
          startedAt: obj.startedAt,
          updatedAt: new Date(mtimeMs).toISOString(),
          ...(typeof obj.title === "string" && obj.title ? { title: obj.title } : {}),
          ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t: unknown) => typeof t === "string" && t.trim()).slice(0, 8) } : {}),
          ...(typeof obj.forkedFrom === "string" && obj.forkedFrom ? { forkedFrom: obj.forkedFrom } : {}),
          ...(todos?.length ? { todos } : {}),
        };
      } else if (obj.type === "model" && meta) meta.model = obj.model; // last marker wins
      else if (obj.type === "message" && meta) messages.push(obj.message);
    } catch {
      /* skip corrupt line */
    }
  }

  const parsed = meta ? { meta, messages } : null;
  parseCache.delete(full);
  parseCache.set(full, { mtimeMs, size: stat.size, parsed });
  while (parseCache.size > PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    parseCache.delete(oldest);
  }
  return parsed;
}

export async function loadSession(id: string): Promise<ParsedSession | null> {
  if (!ID_RE.test(id)) return null;
  return parseSessionFile(fileFor(id));
}

export async function listSessions(): Promise<SessionMeta[]> {
  try {
    const files = await fs.readdir(SESSION_DIR);
    const out: SessionMeta[] = [];
    for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
      const parsed = await parseSessionFile(path.join(SESSION_DIR, f));
      if (parsed) out.push(parsed.meta);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export interface SessionHit {
  meta: SessionMeta;
  /** Number of messages that matched. */
  matches: number;
  /** The first matching message's plain text, trimmed to a snippet. */
  snippet: string;
  /** true when the query also appears in the session title. */
  titleMatch: boolean;
  /** true when the query appears in one of the session's tags. */
  tagMatch: boolean;
}

/**
 * Full-text search across saved sessions for a case-insensitive substring (or
 * regex, when `opts.regex`). Returns the most recently-updated sessions that
 * contain the term, each with a snippet of the first match. Skips the current
 * session when `excludeId` is set. Corrupt lines are tolerated like the loader.
 */
export async function searchSessions(
  query: string,
  opts: { limit?: number; excludeId?: string; regex?: boolean } = {},
): Promise<SessionHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 15;
  let re: RegExp;
  try {
    re = opts.regex ? new RegExp(q, "i") : new RegExp(escapeRegExp(q), "i");
  } catch {
    return []; // invalid regex — treat as no results rather than crash
  }
  let files: string[];
  try {
    files = (await fs.readdir(SESSION_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const hits: SessionHit[] = [];
  for (const f of files) {
    const parsed = await parseSessionFile(path.join(SESSION_DIR, f));
    if (!parsed) continue;
    if (opts.excludeId && parsed.meta.id === opts.excludeId) continue;
    const titleMatch = re.test(parsed.meta.title ?? "");
    const tagMatch = (parsed.meta.tags ?? []).some((t) => re.test(t));
    let matches = 0;
    let snippet = "";
    for (const m of parsed.messages) {
      const text = messageToPlainText(m.content);
      if (!re.test(text)) continue;
      matches++;
      if (!snippet) snippet = makeSnippet(text, re);
    }
    if (!matches && !titleMatch && !tagMatch) continue;
    hits.push({ meta: parsed.meta, matches, snippet, titleMatch, tagMatch });
  }
  hits.sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt));
  return hits.slice(0, limit);
}

/** Flatten a message's content blocks into searchable plain text. */
function messageToPlainText(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content as Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }>) {
    if (b.type === "text" && b.text) parts.push(b.text);
    else if (b.type === "tool_use") parts.push(`${b.name ?? ""} ${safeJson(b.input)}`);
    else if (b.type === "tool_result") {
      parts.push(typeof b.content === "string" ? b.content : safeJson(b.content));
    }
  }
  return parts.join("\n");
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Grab ~120 chars of context around the first match, on a single line. */
function makeSnippet(text: string, re: RegExp): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = re.exec(flat);
  if (!m) return flat.slice(0, 120);
  const start = Math.max(0, m.index - 50);
  const snip = flat.slice(start, start + 170).trim();
  return (start > 0 ? "…" : "") + snip + (start + 170 < flat.length ? "…" : "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Plain-text serialization of a content block (for export / review). */
function contentToMarkdown(content: MessageParam["content"]): string {
  const parts: string[] = [];
  const text = typeof content === "string" ? content : "";
  if (typeof content === "string") return content;
  for (const b of content as Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }>) {
    if (b.type === "text" && b.text) parts.push(b.text);
    else if (b.type === "image") parts.push("[image]");
    else if (b.type === "tool_use") {
      parts.push(`> 🔧 **${b.name}**\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\``);
    } else if (b.type === "tool_result") {
      const text2 = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      parts.push(`> ${b.is_error ? "⚠️" : "📄"} tool result${b.is_error ? " (error)" : ""}\n\`\`\`\n${text2}\n\`\`\``);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Render a whole session to a shareable Markdown transcript. Pure so it can be
 * tested without touching disk.
 */
export function renderSessionMarkdown(meta: SessionMeta, messages: MessageParam[]): string {
  const lines: string[] = [`# mojo session \`${meta.id}\``, ""];
  lines.push(`- **cwd**: \`${meta.cwd}\``);
  lines.push(`- **started**: ${meta.startedAt}`);
  lines.push(`- **updated**: ${meta.updatedAt}`);
  lines.push(`- **model**: \`${meta.model ?? "default"}\``);
  lines.push(`- **messages**: ${messages.length}`);
  lines.push("");
  for (const m of messages) {
    const name = m.role === "user" ? "👤 User" : m.role === "assistant" ? "🤖 Assistant" : m.role;
    lines.push(`## ${name}`, "", contentToMarkdown(m.content), "");
  }
  return lines.join("\n");
}
