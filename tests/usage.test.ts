import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateUsage,
  flushUsage,
  formatAggregates,
  logUsage,
  readUsageLog,
  usageToCsv,
  type UsageEntry,
} from "../src/usage.js";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    t: "2026-09-12T10:00:00.000Z",
    s: "sess01",
    m: "anthropic:claude-sonnet-4-5",
    u: 0.0123,
    p: true,
    i: 1000,
    o: 200,
    cr: 0,
    cw: 0,
    ...overrides,
  };
}

describe("usage ledger", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mojo-usage-"));
    file = path.join(dir, "usage.jsonl");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips entries through appendFile and skips corrupt lines", async () => {
    await logUsage(entry(), file);
    await logUsage(entry({ s: "sess02", u: 0.05 }), file);
    await flushUsage();
    // A torn line (as if the process died mid-write) must not poison the read.
    await writeFile(file, "corrupt-no-json\n\n", { flag: "a" });
    const entries = await readUsageLog(file);
    expect(entries).toHaveLength(2);
    expect(entries[1].s).toBe("sess02");
  });

  it("reads an absent ledger as empty", async () => {
    expect(await readUsageLog(path.join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("aggregates by session, model, and day", async () => {
    const entries = [
      entry({ s: "a", m: "anthropic:claude-haiku-4-5", u: 0.01, t: "2026-09-11T01:00:00.000Z" }),
      entry({ s: "a", m: "anthropic:claude-haiku-4-5", u: 0.02, t: "2026-09-12T01:00:00.000Z" }),
      entry({ s: "b", m: "openai:gpt-4o-mini", u: 0.03, t: "2026-09-12T02:00:00.000Z" }),
    ];
    const bySession = aggregateUsage(entries, "session");
    expect(bySession.map((r) => r.key)).toEqual(["a", "b"]); // USD tie -> request count desc
    expect(bySession[0].requests).toBe(2);
    expect(bySession[0].usd).toBeCloseTo(0.03, 6);

    const byModel = aggregateUsage(entries, "model");
    expect(byModel).toHaveLength(2);

    const byDay = aggregateUsage(entries, "day");
    expect(byDay.map((r) => r.key)).toEqual(["2026-09-12", "2026-09-11"]);
  });

  it("marks unpriced groups and sorts them by request count", () => {
    const rows = aggregateUsage([entry({ p: false, u: 0 }), entry({ p: false, u: 0, s: "z" })], "session");
    expect(rows.every((r) => !r.priced)).toBe(true);
    const text = formatAggregates(rows, "session");
    expect(text).toContain("(unpriced)");
  });

  it("formats an empty aggregate with a pointer to the ledger", () => {
    expect(formatAggregates([], "model")).toContain("usage.jsonl");
  });

  it("exports CSV with header and quoting", () => {
    const csv = usageToCsv([entry({ m: 'weird,"model"' })]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("timestamp,session_id,model,input,output,cache_read,cache_write,usd,priced");
    expect(lines[1]).toContain('"weird,""model"""');
    expect(lines[1]).toContain("0.012300");
  });
});
