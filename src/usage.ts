import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-session usage ledger. Every recorded API turn appends one line to
 * ~/.node-agent/usage.jsonl; /cost reads it back to aggregate spend by session,
 * model, or day and to export CSV. This is deliberately separate from the
 * session .jsonl files: cost control wants a single append-only stream that
 * spans every session, not history you have to open one at a time.
 */

export const USAGE_FILE = path.join(os.homedir(), ".node-agent", "usage.jsonl");

export interface UsageEntry {
  /** ISO timestamp of the turn. */
  t: string;
  /** Owning session id ("" when unknown). */
  s: string;
  /** "provider:model" spec. */
  m: string;
  /** Best-effort USD for this turn; 0 when the model is unpriced. */
  u: number;
  /** False when `m` has no price entry (so `u` is meaningless). */
  p: boolean;
  /** Tokens (short keys keep the ledger lines small). */
  i: number; // input
  o: number; // output
  cr?: number; // cache read
  cw?: number; // cache write
}

export interface UsageAggregate {
  key: string;
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  /** True when at least one contributing turn had a price. */
  priced: boolean;
}

/**
 * Append one turn to the ledger. Best-effort and fire-safe: a write error must
 * never break the agent loop, so failures are swallowed. Serialized through a
 * module-level promise so concurrent turns can't interleave partial lines.
 */
let writeChain: Promise<void> = Promise.resolve();
export function logUsage(entry: UsageEntry, file: string = USAGE_FILE): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* never block the turn on a ledger write */
    }
  });
  return writeChain;
}

/** Await every queued ledger write (before reading the log back, or on exit). */
export function flushUsage(): Promise<void> {
  return writeChain;
}

/** Read the whole ledger, skipping blank/corrupt lines. Empty when the file is absent. */
export async function readUsageLog(file: string = USAGE_FILE): Promise<UsageEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as UsageEntry;
      if (typeof e.i === "number" && typeof e.o === "number") out.push(e);
    } catch {
      /* tolerate a torn last line */
    }
  }
  return out;
}

export type UsageGroup = "session" | "model" | "day";

/**
 * Roll the ledger up by dimension. `day` buckets on the local date of the
 * timestamp; `session`/`model` group on their exact keys. Results sort by USD
 * descending (unpriced groups fall back to request count) so the biggest
 * spenders surface first.
 */
export function aggregateUsage(entries: UsageEntry[], group: UsageGroup): UsageAggregate[] {
  const map = new Map<string, UsageAggregate>();
  for (const e of entries) {
    const key = group === "session" ? e.s || "(unknown)" : group === "model" ? e.m : dayOf(e.t);
    const a =
      map.get(key) ??
      { key, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, priced: false };
    a.input += e.i;
    a.output += e.o;
    a.cacheRead += e.cr ?? 0;
    a.cacheWrite += e.cw ?? 0;
    a.usd += e.u ?? 0;
    a.requests += 1;
    a.priced = a.priced || e.p;
    map.set(key, a);
  }
  return [...map.values()].sort((x, y) => y.usd - x.usd || y.requests - x.requests);
}

function dayOf(iso: string): string {
  // A full ISO timestamp "2026-09-12T10:30:00.000Z" -> "2026-09-12".
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : "(unknown)";
}

/** Render the ledger as CSV (header + one row per turn) for spreadsheet pivots. */
export function usageToCsv(entries: UsageEntry[]): string {
  const header = "timestamp,session_id,model,input,output,cache_read,cache_write,usd,priced";
  const rows = entries.map((e) =>
    [
      csvCell(e.t),
      csvCell(e.s),
      csvCell(e.m),
      String(e.i),
      String(e.o),
      String(e.cr ?? 0),
      String(e.cw ?? 0),
      (e.u ?? 0).toFixed(6),
      e.p ? "yes" : "no",
    ].join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Human-readable rollup table for /cost by. */
export function formatAggregates(rows: UsageAggregate[], group: UsageGroup): string {
  if (!rows.length) return "no usage recorded yet (the ledger opens at ~/.node-agent/usage.jsonl)";
  const label = group === "session" ? "session" : group === "model" ? "model" : "day";
  const width = Math.max(label.length, ...rows.map((r) => r.key.length));
  const lines = rows.map((r) => {
    const cost = r.priced ? `$${r.usd.toFixed(4)}` : "(unpriced)";
    return `${r.key.padEnd(width)}  ${cost.padStart(11)}  ${String(r.requests).padStart(4)} req  in ${fmtK(r.input)} / out ${fmtK(r.output)}`;
  });
  const totalUsd = rows.reduce((t, r) => t + r.usd, 0);
  const totalReq = rows.reduce((t, r) => t + r.requests, 0);
  return [
    `${rows.length} ${label} group(s) · total $${totalUsd.toFixed(4)} · ${totalReq} requests`,
    ...lines,
  ].join("\n");
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
