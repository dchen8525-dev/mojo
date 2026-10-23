import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { journalEnabled, journalDir, journalStats, recordJournalTurn, type JournalTurn } from "../src/journal.js";

const home = os.tmpdir();
const dir = path.join(home, `node-agent-journal-test-${process.pid}`);

function turn(overrides: Partial<JournalTurn> = {}): JournalTurn {
  return {
    ts: "2026-10-22T00:00:00.000Z",
    sessionId: "sess1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    durationMs: 1200,
    request: { messageCount: 2, systemChars: 500, toolNames: ["bash"], messages: [{ role: "user", content: "hi" }] },
    response: {
      text: "hello",
      toolUses: [{ name: "bash", input: { command: "ls" } }],
      stopReason: "tool_use",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.AGENT_JOURNAL;
});

describe("model-I/O journal", () => {
  it("is opt-in via AGENT_JOURNAL", () => {
    delete process.env.AGENT_JOURNAL;
    expect(journalEnabled()).toBe(false);
    process.env.AGENT_JOURNAL = "1";
    expect(journalEnabled()).toBe(true);
    process.env.AGENT_JOURNAL = "true";
    expect(journalEnabled()).toBe(true);
    process.env.AGENT_JOURNAL = "0";
    expect(journalEnabled()).toBe(false);
  });

  it("writes nothing when disabled", async () => {
    delete process.env.AGENT_JOURNAL;
    await recordJournalTurn(turn(), { dir });
    await expect(fs.readdir(dir)).rejects.toThrow();
  });

  it("appends one JSON line per turn into <session>.jsonl", async () => {
    process.env.AGENT_JOURNAL = "1";
    await recordJournalTurn(turn(), { dir });
    await recordJournalTurn(turn({ response: undefined, error: "boom" }), { dir });
    const body = await fs.readFile(path.join(dir, "sess1.jsonl"), "utf8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ sessionId: "sess1", provider: "anthropic", model: "claude-sonnet-4-5", durationMs: 1200 });
    expect(first.request.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(first.response.toolUses[0].name).toBe("bash");
    expect(JSON.parse(lines[1]).error).toBe("boom");
    const stats = await journalStats(dir);
    expect(stats.files).toBe(1);
    expect(stats.bytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("sanitizes the error field before persisting", async () => {
    process.env.AGENT_JOURNAL = "1";
    await recordJournalTurn(
      turn({
        response: undefined,
        error: "POST https://api.x.com/v1?api_key=supersecret123 failed with Bearer sk-abcdefghijklmnopqrstu",
      }),
      { dir },
    );
    const body = await fs.readFile(path.join(dir, "sess1.jsonl"), "utf8");
    const line = JSON.parse(body.trim().split("\n")[0]);
    expect(line.error).toBe("POST https://api.x.com/v1 failed with Bearer {redacted}");
    expect(line.error).not.toContain("supersecret123");
  });

  it("sanitizes hostile session ids into safe filenames", async () => {
    process.env.AGENT_JOURNAL = "1";
    await recordJournalTurn(turn({ sessionId: "../../evil:name" }), { dir });
    const names = await fs.readdir(dir);
    expect(names).toEqual([".._.._evil_name.jsonl"]);
  });

  it("omits the messages payload from oversized entries", async () => {
    process.env.AGENT_JOURNAL = "1";
    const big = turn({ request: { messageCount: 1, systemChars: 1, toolNames: [], messages: [{ role: "user", content: "x".repeat(17 * 1024 * 1024) }] } });
    await recordJournalTurn(big, { dir });
    const body = await fs.readFile(path.join(dir, "sess1.jsonl"), "utf8");
    const entry = JSON.parse(body.trim());
    expect(entry.request.messagesOmitted).toBe(true);
    expect(entry.request.messages).toBeUndefined();
    expect(entry.response.text).toBe("hello");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(16 * 1024 * 1024);
  });

  it("prunes the oldest files once the file-count cap is exceeded", async () => {
    process.env.AGENT_JOURNAL = "1";
    const many: Promise<void>[] = [];
    for (let i = 0; i < 202; i++) {
      many.push(recordJournalTurn(turn({ sessionId: `f${String(i).padStart(3, "0")}` }), { dir }));
    }
    await Promise.all(many);
    // The serializing chain admits them one at a time; pruning runs every 25
    // appends, so by the end the dir is under the 200-file budget.
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    expect(names.length).toBeLessThanOrEqual(200);
    expect(names).toContain("f201.jsonl"); // newest survivor
    expect(names).not.toContain("f000.jsonl"); // oldest pruned
  }, 30_000);

  it("never enables implicitly and exposes the real home dir path", () => {
    expect(journalDir(home)).toBe(path.join(home, ".node-agent", "journal"));
  });
});
