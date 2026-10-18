import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { MessageParam } from "./types.js";

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
}

function fileFor(id: string) {
  return path.join(SESSION_DIR, `${id}.jsonl`);
}

/** Session ids are hex; public entry points reject anything path-like. */
const ID_RE = /^[0-9a-f]{4,64}$/;

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
  if (lines) await fs.appendFile(fileFor(id), lines + "\n", "utf8");
}

/**
 * Replace the whole message log (used after compaction, where the in-memory
 * history is shorter than what's on disk). Keeps the meta header; model
 * markers are dropped, so callers should re-append the current model.
 */
export async function rewriteMessages(id: string, messages: MessageParam[]) {
  const file = fileFor(id);
  let metaLine = "";
  try {
    const raw = await fs.readFile(file, "utf8");
    metaLine = raw.split("\n").find((l) => l.trim().startsWith('{"type":"meta"')) ?? "";
  } catch {
    return; // no session file: nothing to rewrite
  }
  if (!metaLine) return;
  const lines = messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n");
  await fs.writeFile(file, metaLine + "\n" + (lines ? lines + "\n" : ""), "utf8");
}

/** Append a model marker; the last one in the file is the session's model. */
export async function appendModel(id: string, model: string) {
  await fs.appendFile(fileFor(id), JSON.stringify({ type: "model", model }) + "\n");
}

/**
 * Set (or clear, with an empty title) a session's display name by rewriting
 * its meta header line. Returns false when the session does not exist.
 */
export async function renameSession(id: string, title: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const file = fileFor(id);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => l.trim().startsWith('{"type":"meta"'));
  if (idx === -1) return false;
  let meta: SessionMeta;
  try {
    meta = JSON.parse(lines[idx]);
  } catch {
    return false;
  }
  const clean = title.trim().slice(0, 80);
  if (clean) meta.title = clean;
  else delete meta.title;
  delete (meta as { updatedAt?: string }).updatedAt; // not part of the stored header
  lines[idx] = JSON.stringify({ type: "meta", ...meta });
  await fs.writeFile(file, lines.join("\n"), "utf8");
  return true;
}

/**
 * Replace a session's tags. Tags are trimmed, deduped, capped at 24 chars and
 * 8 per session; an empty list removes the field. Returns the stored tags, or
 * null when the session does not exist / its meta line is corrupt.
 */
export async function tagSession(id: string, tags: string[]): Promise<string[] | null> {
  if (!ID_RE.test(id)) return null;
  const file = fileFor(id);
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
  const clean = [...new Set(tags.map((t) => t.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);
  if (clean.length) meta.tags = clean;
  else delete meta.tags;
  delete (meta as { updatedAt?: string }).updatedAt; // not part of the stored header
  lines[idx] = JSON.stringify({ type: "meta", ...meta });
  await fs.writeFile(file, lines.join("\n"), "utf8");
  return clean;
}

/**
 * Create a new session that starts as a copy of `messages`, optionally titled and
 * recorded as branched from `fromId`. Used by /fork to continue from a point in
 * history without disturbing the original session file.
 */
export async function forkSession(
  cwd: string,
  messages: MessageParam[],
  opts: { title?: string; fromId?: string } = {},
): Promise<{ id: string; meta: SessionMeta }> {
  const { id } = await createSession(cwd);
  const clean = opts.title?.trim().slice(0, 80);
  if (clean || opts.fromId) {
    // Rewrite the meta header once, carrying both fields, before any appends.
    const file = fileFor(id);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n");
    const idx = lines.findIndex((l) => l.trim().startsWith('{"type":"meta"'));
    if (idx !== -1) {
      const meta = JSON.parse(lines[idx]) as SessionMeta;
      if (clean) meta.title = clean;
      if (opts.fromId) meta.forkedFrom = opts.fromId;
      lines[idx] = JSON.stringify({ type: "meta", ...meta });
      await fs.writeFile(file, lines.join("\n"), "utf8");
    }
  }
  if (messages.length) await appendMessages(id, messages);
  const now = new Date().toISOString();
  return { id, meta: { id, cwd, startedAt: now, updatedAt: now, ...(clean ? { title: clean } : {}), ...(opts.fromId ? { forkedFrom: opts.fromId } : {}) } };
}

/** Delete a session file. Returns false when it did not exist. */
export async function deleteSession(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

interface ParsedSession {
  meta: SessionMeta;
  messages: MessageParam[];
}

/** Single-pass parse of a session file; updatedAt comes from the file mtime. */
async function parseSessionFile(full: string): Promise<ParsedSession | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await fs.readFile(full, "utf8");
    mtimeMs = (await fs.stat(full)).mtimeMs;
  } catch {
    return null;
  }
  let meta: SessionMeta | null = null;
  const messages: MessageParam[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "meta")
        meta = {
          id: obj.id,
          cwd: obj.cwd,
          startedAt: obj.startedAt,
          updatedAt: new Date(mtimeMs).toISOString(),
          ...(typeof obj.title === "string" && obj.title ? { title: obj.title } : {}),
          ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t: unknown) => typeof t === "string" && t.trim()).slice(0, 8) } : {}),
          ...(typeof obj.forkedFrom === "string" && obj.forkedFrom ? { forkedFrom: obj.forkedFrom } : {}),
        };
      else if (obj.type === "model" && meta) meta.model = obj.model; // last marker wins
      else if (obj.type === "message" && meta) messages.push(obj.message);
    } catch {
      /* skip corrupt line */
    }
  }
  return meta ? { meta, messages } : null;
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
