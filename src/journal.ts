import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { MessageParam } from "./types.js";

/**
 * Opt-in model-I/O journal (AGENT_JOURNAL=1): every LLM request/response pair
 * is appended as one JSON line to ~/.node-agent/journal/<session>.jsonl.
 * Debugging aid for prompt assembly and tool-loop misbehavior — it records the
 * full prompt including tool results, so it is off by default and never
 * enabled implicitly. API keys are never part of any entry.
 */

export function journalEnabled(): boolean {
  const v = process.env.AGENT_JOURNAL;
  return v === "1" || v === "true";
}

export function journalDir(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "journal");
}

export interface JournalTurn {
  ts: string;
  sessionId: string;
  provider: string;
  model: string;
  durationMs: number;
  request: {
    messageCount: number;
    systemChars: number;
    toolNames: string[];
    /** The full prompt as sent — omitted when the entry would be oversized. */
    messages?: MessageParam[];
    messagesOmitted?: boolean;
  };
  response?: {
    text: string;
    toolUses: Array<{ name: string; input: unknown }>;
    stopReason: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  error?: string;
}

/** Entries past this size lose the messages payload instead of filling the disk. */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** Pruning targets: keep the newest files under both caps. */
const DIR_BUDGET_BYTES = 64 * 1024 * 1024;
const DIR_BUDGET_FILES = 200;
const PRUNE_EVERY = 25;

let chain: Promise<unknown> = Promise.resolve();
let appends = 0;

function sanitizeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown";
}

/**
 * Append one turn. Serialized through a module-level chain so interleaved
 * requests cannot interleave half-written lines; never rejects (journaling
 * must not be able to break the turn it is recording).
 */
export async function recordJournalTurn(turn: JournalTurn, opts: { dir?: string } = {}): Promise<void> {
  if (!journalEnabled()) return;
  const dir = opts.dir ?? journalDir();
  chain = chain.then(async () => {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${sanitizeId(turn.sessionId)}.jsonl`);
      let line = JSON.stringify(turn);
      if (Buffer.byteLength(line, "utf8") > MAX_ENTRY_BYTES) {
        const { messages, ...rest } = turn.request;
        void messages;
        line = JSON.stringify({ ...turn, request: { ...rest, messagesOmitted: true } });
      }
      await fs.appendFile(file, line + "\n", { mode: 0o600 });
      if (++appends % PRUNE_EVERY === 0) await pruneJournal(dir);
    } catch {
      /* journaling is best-effort */
    }
  });
  return chain as Promise<void>;
}

async function pruneJournal(dir: string): Promise<void> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  if (!names.length) return;
  const files = await Promise.all(
    names.map(async (n) => {
      const p = path.join(dir, n);
      const st = await fs.stat(p);
      return { p, mtime: st.mtimeMs, size: st.size };
    }),
  );
  files.sort((a, b) => b.mtime - a.mtime);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  // Keep headroom of one pruning interval so the dir never grows past the cap
  // between prunes (pruning runs every PRUNE_EVERY appends).
  for (const f of files.slice(DIR_BUDGET_FILES - PRUNE_EVERY)) {
    await fs.rm(f.p, { force: true });
    total -= f.size;
  }
  for (const f of files.slice(0, DIR_BUDGET_FILES)) {
    if (total <= DIR_BUDGET_BYTES) break;
    await fs.rm(f.p, { force: true });
    total -= f.size;
  }
}

export interface JournalStats {
  files: number;
  bytes: number;
}

export async function journalStats(dir: string = journalDir()): Promise<JournalStats> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { files: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const n of names) {
    try {
      bytes += (await fs.stat(path.join(dir, n))).size;
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return { files: names.length, bytes };
}
