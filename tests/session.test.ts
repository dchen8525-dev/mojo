import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Redirect the session store into a temp "home" so tests never touch the
// real ~/.node-agent directory. The mock must be installed before session.js
// computes SESSION_DIR at import time, hence the dynamic import below.
const fakeHome = path.join(os.tmpdir(), "node-agent-test-home");

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => fakeHome };
  return { ...patched, default: patched };
});

const session = await import("../src/session.js");

beforeAll(async () => {
  await fs.rm(fakeHome, { recursive: true, force: true });
  await fs.mkdir(path.join(fakeHome, ".node-agent", "sessions"), { recursive: true });
});

describe("createSession / loadSession", () => {
  it("round-trips meta and messages", async () => {
    const { id, meta } = await session.createSession("D:\\proj");
    expect(meta.id).toBe(id);
    expect(meta.model).toBeUndefined();

    await session.appendMessages(id, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.meta.cwd).toBe("D:\\proj");
  });

  it("updatedAt reflects the file mtime, not creation time", async () => {
    const { id } = await session.createSession("x");
    await new Promise((r) => setTimeout(r, 1100)); // mtime granularity
    await session.appendMessages(id, [{ role: "user", content: "later" }]);
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);
    const mtime = (await fs.stat(file)).mtimeMs;
    const loaded = await session.loadSession(id);
    expect(loaded!.meta.updatedAt).toBe(new Date(mtime).toISOString());
    expect(Date.parse(loaded!.meta.updatedAt)).toBeGreaterThan(Date.parse(loaded!.meta.startedAt));
  });

  it("last model marker wins", async () => {
    const { id } = await session.createSession("x");
    await session.appendModel(id, "anthropic:claude-sonnet-4-5");
    await session.appendModel(id, "openai:gpt-4o");
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.model).toBe("openai:gpt-4o");
  });

  it("skips corrupt lines instead of failing", async () => {
    const { id } = await session.createSession("x");
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);
    await fs.appendFile(file, "not json\n{also broken\n");
    await session.appendMessages(id, [{ role: "user", content: "ok" }]);
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
  });

  it("returns null for unknown sessions", async () => {
    expect(await session.loadSession("deadbeef")).toBeNull();
  });

  it("rewriteMessages replaces the log but keeps the meta header", async () => {
    const { id, meta } = await session.createSession("D:\\proj");
    await session.appendMessages(id, [
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: "old3" },
    ]);
    await session.appendModel(id, "anthropic:claude-sonnet-4-5");
    await session.rewriteMessages(id, [
      { role: "user", content: "summary" },
      { role: "assistant", content: "ack" },
    ]);
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.id).toBe(id);
    expect(loaded?.meta.cwd).toBe("D:\\proj");
    expect(loaded?.meta.model).toBeUndefined(); // model markers dropped by the rewrite
    expect(loaded?.messages.map((m) => m.content)).toEqual(["summary", "ack"]);
    // Appending afterwards still works.
    await session.appendMessages(id, [{ role: "user", content: "next" }]);
    expect((await session.loadSession(id))?.messages).toHaveLength(3);
  });
});

describe("renameSession / deleteSession", () => {
  it("sets, replaces, and clears a title", async () => {
    const { id } = await session.createSession("x");
    expect(await session.renameSession(id, "重构计划")).toBe(true);
    expect((await session.loadSession(id))?.meta.title).toBe("重构计划");
    expect(await session.renameSession(id, "新名字")).toBe(true);
    expect((await session.loadSession(id))?.meta.title).toBe("新名字");
    expect(await session.renameSession(id, "   ")).toBe(true);
    expect((await session.loadSession(id))?.meta.title).toBeUndefined();
  });

  it("keeps messages intact when renaming", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "keep me" }]);
    await session.renameSession(id, "titled");
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.meta.title).toBe("titled");
  });

  it("truncates long titles", async () => {
    const { id } = await session.createSession("x");
    await session.renameSession(id, "x".repeat(200));
    expect((await session.loadSession(id))?.meta.title).toHaveLength(80);
  });

  it("returns false for unknown or path-like ids", async () => {
    expect(await session.renameSession("deadbeef", "x")).toBe(false);
    expect(await session.renameSession("../../etc/passwd", "x")).toBe(false);
    expect(await session.deleteSession("../../etc/passwd")).toBe(false);
  });

  it("deletes a session and reports missing ones", async () => {
    const { id } = await session.createSession("x");
    expect(await session.deleteSession(id)).toBe(true);
    expect(await session.loadSession(id)).toBeNull();
    expect(await session.deleteSession(id)).toBe(false);
  });

  it("listSessions surfaces titles", async () => {
    const { id } = await session.createSession("x");
    await session.renameSession(id, "listed");
    const found = (await session.listSessions()).find((s) => s.id === id);
    expect(found?.title).toBe("listed");
  });
});

describe("forkSession", () => {
  it("copies messages into a new session and records the parent", async () => {
    const parent = await session.createSession("D:\\proj");
    await session.appendMessages(parent.id, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], { fromId: parent.id });
    expect(fork.id).not.toBe(parent.id);

    const loaded = await session.loadSession(fork.id);
    expect(loaded?.messages.map((m) => m.content)).toEqual(["q1", "a1"]);
    expect(loaded?.meta.forkedFrom).toBe(parent.id);

    // The parent file is untouched.
    expect((await session.loadSession(parent.id))?.messages).toHaveLength(2);
  });

  it("carries a title alongside forkedFrom", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }], { title: "try light", fromId: "abc123" });
    const loaded = await session.loadSession(fork.id);
    expect(loaded?.meta.title).toBe("try light");
    expect(loaded?.meta.forkedFrom).toBe("abc123");
  });

  it("creates an empty-titled fork when no title is given", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }]);
    const loaded = await session.loadSession(fork.id);
    expect(loaded?.meta.title).toBeUndefined();
    expect(loaded?.meta.forkedFrom).toBeUndefined();
  });
});

describe("listSessions", () => {
  it("lists sessions sorted by updatedAt descending", async () => {
    const a = await session.createSession("a");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await session.createSession("b");
    await new Promise((r) => setTimeout(r, 1100));
    const c = await session.createSession("c");

    const list = await session.listSessions();
    const ids = list.map((s) => s.id);
    expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(b.id));
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});

describe("searchSessions", () => {
  it("finds sessions by message text, case-insensitively, with a snippet", async () => {
    const { id } = await session.createSession("D:\\search-proj");
    await session.appendMessages(id, [
      { role: "user", content: "how do I configure the WebSocket TIMEOUT properly" },
      { role: "assistant", content: "set WS_TIMEOUT_MS" },
    ]);
    const hits = await session.searchSessions("websocket timeout");
    const hit = hits.find((h) => h.meta.id === id);
    expect(hit).toBeDefined();
    expect(hit!.matches).toBe(1); // only the first message holds the full phrase
    expect(hit!.snippet.toLowerCase()).toContain("websocket");
    expect(hit!.titleMatch).toBe(false);
  });

  it("searches tool calls and titles too", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "grep", input: { pattern: "zqx-uniqueterm" } }] },
    ]);
    const bodyHits = await session.searchSessions("zqx-uniqueterm");
    expect(bodyHits.find((h) => h.meta.id === id)?.matches).toBe(1);

    await session.renameSession(id, "discuss zqx-titleterm");
    const titleHits = await session.searchSessions("zqx-titleterm");
    const th = titleHits.find((h) => h.meta.id === id);
    expect(th?.titleMatch).toBe(true);
    expect(th?.matches).toBe(0);
  });

  it("supports regex mode and tolerates invalid patterns", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "error code 4213 happened" }]);
    const hits = await session.searchSessions("error code \\d{4}", { regex: true });
    expect(hits.some((h) => h.meta.id === id)).toBe(true);
    expect(await session.searchSessions("([unclosed", { regex: true })).toEqual([]);
  });

  it("honors excludeId and returns nothing for a no-match query", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "kw-excludeme-9x" }]);
    const hits = await session.searchSessions("kw-excludeme-9x", { excludeId: id });
    expect(hits.some((h) => h.meta.id === id)).toBe(false);
    expect(await session.searchSessions("kw-never-written-7z")).toEqual([]);
    expect(await session.searchSessions("   ")).toEqual([]);
  });
});

describe("renderSessionMarkdown", () => {
  const meta = { id: "abc123", cwd: "D:\\proj", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", model: "anthropic:claude-sonnet-4-5" };

  it("renders a header with meta and roles", () => {
    const out = session.renderSessionMarkdown(meta, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ]);
    expect(out).toContain("session `abc123`");
    expect(out).toContain("D:\\proj");
    expect(out).toContain("claude-sonnet-4-5");
    expect(out).toContain("**messages**: 2");
    expect(out).toContain("## 👤 User");
    expect(out).toContain("## 🤖 Assistant");
  });

  it("expands tool calls and results", () => {
    const out = session.renderSessionMarkdown(meta, [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          { type: "text", text: "done" },
        ],
      },
    ]);
    expect(out).toContain("read_file");
    expect(out).toContain('"path": "a.ts"');
  });

  it("marks tool results and errors", () => {
    const out = session.renderSessionMarkdown(meta, [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42", is_error: true }] },
    ]);
    expect(out).toContain("(error)");
    expect(out).toContain("42");
  });
});
