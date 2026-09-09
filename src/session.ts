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
