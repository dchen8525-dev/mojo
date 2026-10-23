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
const { createGoal } = await import("../src/goal.js");

beforeAll(async () => {
  await fs.rm(fakeHome, { recursive: true, force: true });
  await fs.mkdir(path.join(fakeHome, ".node-agent", "sessions"), { recursive: true });
});

describe("createSession / loadSession", () => {
  it("creates session files with owner-only permissions", async () => {
    const { id } = await session.createSession("x");
    if (process.platform === "win32") return;
    const dir = await fs.stat(path.join(fakeHome, ".node-agent", "sessions"));
    expect(dir.mode & 0o777).toBe(0o700);
    const file = await fs.stat(path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`));
    expect(file.mode & 0o777).toBe(0o600);
  });

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

  it("sees metadata and message changes immediately despite the parse cache", async () => {
    const { id } = await session.createSession("cache");
    expect((await session.loadSession(id))?.messages).toHaveLength(0); // warm the cache

    await session.appendMessages(id, [{ role: "user", content: "one" }]);
    expect((await session.loadSession(id))?.messages).toHaveLength(1);

    await session.renameSession(id, "Renamed");
    expect((await session.listSessions()).find((m) => m.id === id)?.title).toBe("Renamed");

    await session.tagSession(id, ["alpha"]);
    expect((await session.listSessions()).find((m) => m.id === id)?.tags).toEqual(["alpha"]);

    await session.deleteSession(id);
    expect(await session.loadSession(id)).toBeNull();
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

  it("persists subagent call records without polluting the message history", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "hi" }]);
    await session.appendSubCall(id, {
      toolUseId: "t1",
      name: "read_file",
      inputPreview: '{"path":"a.ts"}',
      ok: true,
      result: "body",
      round: 3,
    });

    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.subCalls).toEqual([
      { toolUseId: "t1", name: "read_file", inputPreview: '{"path":"a.ts"}', ok: true, result: "body", round: 3 },
    ]);
  });

  it("keeps subagent call records when the message log is rewritten", async () => {
    const { id } = await session.createSession("x");
    await session.appendSubCall(id, { toolUseId: "t1", name: "grep", inputPreview: "{}", ok: false });
    await session.rewriteMessages(id, [{ role: "user", content: "compacted" }]);

    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.subCalls.map((c) => c.name)).toEqual(["grep"]);
    expect(loaded?.subCalls[0].ok).toBe(false);
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

describe("atomic session rewrites", () => {
  it("replaces the file through rename and leaves no temp files", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "keep" }]);
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);
    const rename = vi.spyOn(fs, "rename");
    try {
      expect(await session.renameSession(id, "Atomic")).toBe(true);
      expect(rename).toHaveBeenCalled();
      expect(String(rename.mock.calls.at(-1)?.[0])).toMatch(/\.tmp$/);
      expect(String(rename.mock.calls.at(-1)?.[1])).toBe(file);
    } finally {
      rename.mockRestore();
    }

    const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"title":"Atomic"');
  });

  it("keeps the previous contents when the rename fails", async () => {
    const { id } = await session.createSession("x");
    expect(await session.renameSession(id, "Before")).toBe(true);
    const file = path.join(fakeHome, ".node-agent", "sessions", `${id}.jsonl`);

    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("rename failed"), { code: "ENOENT" }),
    );
    try {
      await expect(session.renameSession(id, "Broken")).rejects.toThrow("rename failed");
    } finally {
      rename.mockRestore();
    }

    expect((await session.loadSession(id))?.meta.title).toBe("Before");
    expect((await fs.readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a transient Windows rename failure", async () => {
    const { id } = await session.createSession("x");
    const original = fs.rename.bind(fs);
    let calls = 0;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (calls++ === 0) throw Object.assign(new Error("locked by scanner"), { code: "EPERM" });
      return original(from, to);
    });
    try {
      expect(await session.renameSession(id, "Retried")).toBe(true);
    } finally {
      rename.mockRestore();
    }
    expect(calls).toBe(2);
    expect((await session.loadSession(id))?.meta.title).toBe("Retried");
  });

  it("serializes concurrent meta updates and appends without losing data", async () => {
    const { id } = await session.createSession("race");
    const jobs: Array<Promise<unknown>> = Array.from({ length: 10 }, (_, i) =>
      session.appendMessages(id, [{ role: "user", content: `m${i}` }]),
    );
    jobs.push(session.renameSession(id, "Race"));
    jobs.push(session.tagSession(id, ["x"]));
    jobs.push(session.saveTodos(id, [{ id: "1", content: "todo", status: "pending" }]));
    await Promise.all(jobs);

    const loaded = await session.loadSession(id);
    expect(loaded?.messages.map((m) => m.content).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`).sort(),
    );
    expect(loaded?.meta.title).toBe("Race");
    expect(loaded?.meta.tags).toEqual(["x"]);
    expect(loaded?.meta.todos).toEqual([{ id: "1", content: "todo", status: "pending" }]);
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
    // The fork notice is appended after the inherited prefix.
    expect(loaded?.messages.map((m) => m.content)).toHaveLength(3);
    expect(loaded?.messages[0].content).toBe("q1");
    expect(String(loaded?.messages[2].content)).toContain('<system-reminder event="SessionFork">');
    expect(String(loaded?.messages[2].content)).toContain(parent.id);
    expect(loaded?.meta.forkedFrom).toBe(parent.id);
    expect(loaded?.meta.forkPoint).toBe(2);
    expect(fork.messages).toHaveLength(3);

    // The parent file is untouched.
    expect((await session.loadSession(parent.id))?.messages).toHaveLength(2);
  });

  it("carries a title alongside forkedFrom", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }], { title: "try light", fromId: "abc123" });
    const loaded = await session.loadSession(fork.id);
    expect(loaded?.meta.title).toBe("try light");
    expect(loaded?.meta.forkedFrom).toBe("abc123");
    expect(loaded?.meta.forkPoint).toBe(1);
  });

  it("creates an empty-titled fork when no title is given", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }]);
    const loaded = await session.loadSession(fork.id);
    expect(loaded?.meta.title).toBeUndefined();
    expect(loaded?.meta.forkedFrom).toBeUndefined();
  });

  it("adds no fork notice or forkPoint without a parent", async () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    const fork = await session.forkSession("D:\\proj", msgs, {});
    expect(fork.messages).toEqual(msgs);
    expect(fork.meta.forkPoint).toBeUndefined();
    const loaded = await session.loadSession(fork.id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.meta.forkPoint).toBeUndefined();
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

  it("tagSession persists tags, and search matches them", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "nothing searchable here" }]);
    expect(await session.tagSession(id, ["  bug ", "perf", "bug", "x".repeat(30)])).toEqual(["bug", "perf", "x".repeat(24)]);
    // tags survive a reload
    expect((await session.listSessions()).find((m) => m.id === id)?.tags).toEqual(["bug", "perf", "x".repeat(24)]);

    // a query that only hits a tag finds the session with zero message matches
    const hits = await session.searchSessions("BUG");
    const h = hits.find((x) => x.meta.id === id);
    expect(h?.tagMatch).toBe(true);
    expect(h?.matches).toBe(0);

    // more than 8 tags get capped; clearing removes the field
    const many = Array.from({ length: 10 }, (_, i) => "t" + i);
    expect(await session.tagSession(id, many)).toHaveLength(8);
    expect(await session.tagSession(id, [])).toEqual([]);
    expect((await session.listSessions()).find((m) => m.id === id)?.tags).toBeUndefined();
    expect(await session.tagSession("zzzzzzzz", ["a"])).toBeNull(); // unknown id
  });
});

describe("session file hardening", () => {
  const dir = path.join(fakeHome, ".node-agent", "sessions");

  it("ignores path-like ids on every write path", async () => {
    const escape = path.join(fakeHome, ".node-agent", "escape.jsonl");
    await session.appendMessages("../../escape", [{ role: "user", content: "x" }]);
    await session.appendModel("../../escape", "anthropic:x");
    await session.appendSubCall("../../escape", { toolUseId: "t", name: "n", inputPreview: "" });
    await session.rewriteMessages("../../escape", [{ role: "user", content: "x" }]);
    await expect(fs.access(escape)).rejects.toThrow();
  });

  it("takes the id from the filename and caps metadata read from disk", async () => {
    const id = "abcd0001";
    const file = path.join(dir, `${id}.jsonl`);
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "meta",
        id: "ffffffff",
        cwd: "c",
        startedAt: "2026-01-01T00:00:00.000Z",
        title: "t".repeat(200),
        tags: [" " + "u".repeat(50), "ok", "ok"],
      }) + "\n",
    );
    const loaded = await session.loadSession(id);
    // The filename is what rename/delete use, so a meta line must not redirect them.
    expect(loaded?.meta.id).toBe(id);
    expect(loaded?.meta.title).toHaveLength(80);
    expect(loaded?.meta.tags).toEqual(["u".repeat(24), "ok"]);
  });

  it("skips malformed messages instead of exposing them to search or resume", async () => {
    const id = "abcd0002";
    await fs.writeFile(
      path.join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: "meta", cwd: "c", startedAt: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: null }),
        JSON.stringify({ type: "message", message: { role: "user" } }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [null, 42, { type: "text", text: "good zqx6" }] },
        }),
        JSON.stringify({ type: "model", model: { evil: true } }),
        "",
      ].join("\n"),
    );
    const loaded = await session.loadSession(id);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.meta.model).toBeUndefined();
    const hits = await session.searchSessions("zqx6");
    expect(hits.some((h) => h.meta.id === id)).toBe(true);
  });

  it("ignores non-session files and symlinks in the sessions directory", async () => {
    await fs.writeFile(path.join(dir, "notes.jsonl"), JSON.stringify({ type: "meta", cwd: "c", startedAt: "x" }) + "\n");
    const { id } = await session.createSession("x");
    expect((await session.listSessions()).some((m) => m.id === id)).toBe(true);
    expect((await session.listSessions()).some((m) => m.id === "notes")).toBe(false);

    if (process.platform !== "win32") {
      await fs.writeFile(path.join(fakeHome, "outside.jsonl"), JSON.stringify({ type: "meta", cwd: "c", startedAt: "x" }) + "\n");
      await fs.symlink(path.join(fakeHome, "outside.jsonl"), path.join(dir, "abcd0003.jsonl"));
      expect(await session.loadSession("abcd0003")).toBeNull();
    }
  });

  it("refuses absurdly long regex queries", async () => {
    const { id } = await session.createSession("x");
    await session.appendMessages(id, [{ role: "user", content: "abcdef" }]);
    expect(await session.searchSessions("a".repeat(201), { regex: true })).toEqual([]);
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

describe("todo persistence", () => {
  const items = [
    { id: "1", content: "plan", status: "in_progress" as const },
    { id: "2", content: "done", status: "completed" as const },
  ];

  it("saves todos into the meta header and reloads them", async () => {
    const { id } = await session.createSession("todos");
    expect(await session.saveTodos(id, items)).toBe(true);
    expect((await session.loadSession(id))?.meta.todos).toEqual(items);

    // Rewriting the header again must replace the list, not duplicate it.
    expect(await session.saveTodos(id, [items[0]])).toBe(true);
    expect((await session.loadSession(id))?.meta.todos).toEqual([items[0]]);
  });

  it("clears todos from the header when given an empty list", async () => {
    const { id } = await session.createSession("todos");
    await session.saveTodos(id, items);
    await session.saveTodos(id, []);
    expect((await session.loadSession(id))?.meta.todos).toBeUndefined();
  });

  it("drops malformed todo entries instead of failing", async () => {
    const { id } = await session.createSession("todos");
    await session.saveTodos(id, [
      { id: "ok", content: "kept", status: "pending" },
      { id: 1, content: "bad" },
      { id: "unknown", content: "status falls back", status: "strange" },
    ] as never);
    expect((await session.loadSession(id))?.meta.todos).toEqual([
      { id: "ok", content: "kept", status: "pending" },
      { id: "unknown", content: "status falls back", status: "pending" },
    ]);
  });

  it("carries todos into a fork", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }], {
      fromId: "abc123",
      todos: items,
    });
    expect(fork.meta.todos).toEqual(items);
    expect((await session.loadSession(fork.id))?.meta.todos).toEqual(items);
  });

  it("returns false for a missing session", async () => {
    expect(await session.saveTodos("deadbeef", items)).toBe(false);
  });
});

describe("goal persistence", () => {
  const goal = createGoal("finish the migration", {
    tokenBudget: 20_000,
    maxContinuations: 5,
    now: new Date("2026-10-23T00:00:00.000Z"),
  })!;

  it("saves the goal into the meta header and reloads it", async () => {
    const { id } = await session.createSession("goals");
    expect(await session.saveGoal(id, goal)).toBe(true);
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.goal).toEqual(goal);

    const updated = { ...goal, status: "paused" as const, tokensUsed: 1_200, note: "user paused" };
    expect(await session.saveGoal(id, updated)).toBe(true);
    expect((await session.loadSession(id))?.meta.goal).toEqual(updated);
  });

  it("clears the goal when passed null", async () => {
    const { id } = await session.createSession("goals");
    await session.saveGoal(id, goal);
    expect(await session.saveGoal(id, null)).toBe(true);
    expect((await session.loadSession(id))?.meta.goal).toBeUndefined();
  });

  it("drops a malformed goal instead of failing the load", async () => {
    const { id } = await session.createSession("goals");
    await session.saveGoal(id, { objective: "", status: "active" } as never);
    expect((await session.loadSession(id))?.meta.goal).toBeUndefined();
  });

  it("carries an active goal into a fork", async () => {
    const fork = await session.forkSession("D:\\proj", [{ role: "user", content: "hi" }], {
      fromId: "abc123",
      goal,
    });
    expect(fork.meta.goal).toEqual(goal);
    expect((await session.loadSession(fork.id))?.meta.goal).toEqual(goal);
  });

  it("returns false for a missing session", async () => {
    expect(await session.saveGoal("deadbeef", goal)).toBe(false);
  });
});

describe("session titles", () => {
  it("stores a generated title once and never overwrites it", async () => {
    const { id } = await session.createSession("titles");
    expect(await session.setGeneratedTitle(id, "自动生成的标题")).toBe(true);
    const first = await session.loadSession(id);
    expect(first?.meta.title).toBe("自动生成的标题");
    expect(first?.meta.titleSource).toBe("generated");

    expect(await session.setGeneratedTitle(id, "第二个标题")).toBe(false);
    expect((await session.loadSession(id))?.meta.title).toBe("自动生成的标题");
  });

  it("a user rename is custom and wins over a later generated title", async () => {
    const { id } = await session.createSession("titles");
    await session.renameSession(id, "我的名字");
    expect((await session.loadSession(id))?.meta.titleSource).toBe("custom");

    expect(await session.setGeneratedTitle(id, "自动标题")).toBe(false);
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.title).toBe("我的名字");
    expect(loaded?.meta.titleSource).toBe("custom");

    await session.renameSession(id, "");
    expect((await session.loadSession(id))?.meta.title).toBeUndefined();
    // Clearing a custom title re-opens the door for the generator.
    expect(await session.setGeneratedTitle(id, "之后生成的")).toBe(true);
  });

  it("returns false for a missing session", async () => {
    expect(await session.setGeneratedTitle("deadbeef", "x")).toBe(false);
  });

  it("derives a preview from the first real user request, skipping injected context", async () => {
    const { id } = await session.createSession("preview");
    await session.appendMessages(id, [
      { role: "user", content: '<system-reminder event="SessionFork">forked</system-reminder>' },
      { role: "assistant", content: "noted" },
      { role: "user", content: "  请帮我\n检查构建配置  " },
    ]);
    const loaded = await session.loadSession(id);
    expect(loaded?.meta.preview).toBe("请帮我 检查构建配置");
    // The screenshot-style reminder at the very start is also skipped.
    const { id: id2 } = await session.createSession("preview2");
    await session.appendMessages(id2, [
      { role: "user", content: `<context_compaction>\nsummary\n</context_compaction>` },
      { role: "user", content: "x".repeat(100) },
    ]);
    expect((await session.loadSession(id2))?.meta.preview).toBe(`${"x".repeat(59)}…`);
  });
});

const { readSessionTool } = await import("../src/tools/readSession.js");
const { sessionReferenceIds } = await import("../src/sessionRefs.js");

describe("readSessionContext", () => {
  async function seedConversation(cwd = "D:\\proj") {
    const { id } = await session.createSession(cwd);
    await session.appendMessages(id, [
      { role: "user", content: "How do we deploy the widget service?" },
      { role: "assistant", content: "Run scripts/deploy-widget.sh." },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "deployed" }] },
      { role: "user", content: '<system-reminder event="RecalledMemory">old context</system-reminder>' },
      { role: "assistant", content: "Deployment done." },
      { role: "user", content: "What timeout should the timer use?" },
      { role: "assistant", content: "Use 30 seconds for the timer." },
    ]);
    return id;
  }

  it("returns null for a missing session", async () => {
    expect(await session.readSessionContext("deadbeef")).toBeNull();
  });

  it("selects the most relevant turn for a query and labels it as untrusted history", async () => {
    const id = await seedConversation();
    const result = await session.readSessionContext(id, { query: "timer" });
    expect(result).not.toBeNull();
    expect(result!.matched).toBe(true);
    expect(result!.content).toContain("Historical transcript");
    expect(result!.content).toContain("untrusted data");
    expect(result!.content).toContain("Use 30 seconds for the timer.");
    expect(result!.content).not.toContain("deploy-widget");
  });

  it("groups injected reminders and tool results with the turn that produced them", async () => {
    const id = await seedConversation();
    const result = await session.readSessionContext(id, { query: "widget" });
    expect(result!.content).toContain("How do we deploy the widget service?");
    expect(result!.content).toContain("[tool result]");
    expect(result!.content).toContain("[context]");
  });

  it("shows the newest exchanges, in order, when no query is given", async () => {
    const id = await seedConversation();
    const result = await session.readSessionContext(id);
    expect(result!.matched).toBe(true);
    expect(result!.messageCount).toBe(7);
    expect(result!.content).toContain("no query: showing the most recent exchanges");
    const early = result!.content.indexOf("widget");
    const late = result!.content.indexOf("timer");
    expect(early).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(early);
  });

  it("falls back to recent exchanges when nothing matches the query", async () => {
    const id = await seedConversation();
    const result = await session.readSessionContext(id, { query: "zebra" });
    expect(result!.matched).toBe(false);
    expect(result!.content).toContain("No excerpt matched the query strongly");
    expect(result!.content).toContain("timer");
  });

  it("respects the character budget and reports truncation", async () => {
    const { id } = await session.createSession("budget");
    await session.appendMessages(id, [
      { role: "user", content: "a".repeat(3000) },
      { role: "assistant", content: "b".repeat(3000) },
      { role: "user", content: "c".repeat(3000) },
    ]);
    const result = await session.readSessionContext(id, { maxChars: 1000 });
    expect(result!.truncated).toBe(true);
    expect(result!.content).toContain("[excerpts truncated to fit 1,000 characters]");
    expect(result!.content.length).toBeLessThan(2500);
  });

  it("clips a single oversized message at 6000 characters", async () => {
    const { id } = await session.createSession("clip");
    await session.appendMessages(id, [{ role: "user", content: `start-${"x".repeat(7000)}-end` }]);
    const result = await session.readSessionContext(id);
    expect(result!.truncated).toBe(true);
    expect(result!.content).toContain("start-");
    expect(result!.content).not.toContain("-end");
    expect(result!.content).toContain("…");
  });

  it("handles a session with no transcript messages", async () => {
    const { id } = await session.createSession("empty");
    const result = await session.readSessionContext(id);
    expect(result!.messageCount).toBe(0);
    expect(result!.content).toContain("no transcript messages");
  });
});

describe("read_session tool", () => {
  it("reads a stored session by id, accepting #sess_ and sess_ prefixes", async () => {
    const { id } = await session.createSession("tool");
    await session.appendMessages(id, [
      { role: "user", content: "remember the port number" },
      { role: "assistant", content: "the port is 4611" },
    ]);
    for (const ref of [id, `#sess_${id}`, `sess_${id.toUpperCase()}`]) {
      const result = await readSessionTool.execute(
        { session_id: ref },
        { cwd: "D:\\proj", sessionId: "abcd1234", askPermission: async () => true },
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("the port is 4611");
    }
  });

  it("refuses to read the current session", async () => {
    const { id } = await session.createSession("current");
    const result = await readSessionTool.execute(
      { session_id: id },
      { cwd: "D:\\proj", sessionId: id, askPermission: async () => true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("current session");
  });

  it("reports missing ids and unknown sessions", async () => {
    const blank = await readSessionTool.execute(
      { session_id: "#sess_" },
      { cwd: "D:\\proj", sessionId: "abcd1234", askPermission: async () => true },
    );
    expect(blank.isError).toBe(true);
    expect(blank.content).toMatch(/session_id is required/);

    const missing = await readSessionTool.execute(
      { session_id: "deadbeef" },
      { cwd: "D:\\proj", sessionId: "abcd1234", askPermission: async () => true },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/was not found/);
  });
});

describe("sessionReferenceIds", () => {
  it("finds, lowercases, dedupes and caps #sess_ references", () => {
    expect(sessionReferenceIds("look at #sess_ABCD1234 and #sess_abcd1234")).toEqual(["abcd1234"]);
    expect(sessionReferenceIds("no references here")).toEqual([]);
    expect(sessionReferenceIds("#sess_abc #sess_xyz1 #sess_0011aabb")).toEqual(["0011aabb"]);
    expect(sessionReferenceIds("#sess_aaaa #sess_bbbb #sess_cccc #sess_dddd")).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});

