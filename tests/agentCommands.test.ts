import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAgentCommand, type CommandContext } from "../src/agentCommands.js";
import type { Agent } from "../src/agent.js";
import type { PermissionManager } from "../src/permissions.js";

// Keep tests from touching real session files.
const searchLedger: { hits: unknown[] } = { hits: [] };
const sessionLedger: { metas: Array<Record<string, unknown>> } = { metas: [] };
vi.mock("../src/session.js", () => ({
  createSession: async () => ({ id: "new1234", meta: { id: "new1234", cwd: "/tmp", startedAt: "", updatedAt: "" } }),
  listSessions: async () => sessionLedger.metas,
  loadSession: async (id: string) =>
    id === "abc"
      ? { meta: { id, cwd: "/tmp", startedAt: "", updatedAt: "", model: "anthropic:fake" }, messages: [] }
      : id === "sess1"
        ? { meta: { id, cwd: "/tmp", startedAt: "", updatedAt: "", tags: ["old"] }, messages: [{ role: "user", content: "hello export" }] }
        : null,
  renameSession: async (id: string, title: string) => id === "sess1" && !!title.trim(),
  tagSession: async (_id: string, tags: string[]) => [...new Set(tags.map((t) => t.trim().slice(0, 24)).filter(Boolean))].slice(0, 8),
  searchSessions: async () => searchLedger.hits as never,
  renderSessionMarkdown: () => "# exported",
  forkSession: async (_cwd: string, messages: unknown[], opts: { title?: string; fromId?: string }) => ({
    id: "fork9999",
    meta: { id: "fork9999", cwd: _cwd, startedAt: "", updatedAt: "", title: opts.title, forkedFrom: opts.fromId, messages: messages.length },
  }),
}));

// /cost subcommands read the usage ledger; fake it so tests never touch ~/.node-agent.
const usageLedger: { entries: unknown[] } = { entries: [] };
vi.mock("../src/usage.js", async () => {
  const actual = await vi.importActual<typeof import("../src/usage.js")>("../src/usage.js");
  return {
    ...actual,
    flushUsage: async () => {},
    readUsageLog: async () => usageLedger.entries as never,
  };
});

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  const costs = { budgetUsd: null as number | null, format: () => "$0.00 total" };
  return {
    sessionId: "sess1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    contextWindow: 200_000,
    planMode: false,
    costs: costs as never,
    switchModel: (spec: string) => ({ provider: "anthropic", model: spec }),
    listModels: async () => ["m1", "m2"],
    tokenEstimate: () => 1234,
    compactNow: async () => false,
    review: async () => "review output",
    currentTodos: () => [],
    checkpointList: async () => [],
    undoLastCheckpoint: async () => null,
    resetSession: () => {},
    getMessages: () => [],
    fork: async () => null,
    ...overrides,
  } as unknown as Agent;
}

function fakePermissions(): PermissionManager {
  return {
    mode: "default",
    load: async () => {},
    getRules: () => [],
    clearRules: async () => ({ global: 0, project: 0 }),
    check: async () => true,
  } as unknown as PermissionManager;
}

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    agent: fakeAgent(),
    permissions: fakePermissions(),
    mcp: null,
    hooks: { list: () => [] } as never,
    customCommands: new Map(),
    cwd: "/tmp/repo",
    ...overrides,
  };
}

describe("runAgentCommand", () => {
  it("returns help text without ANSI codes", async () => {
    const r = await runAgentCommand("/help", ctx());
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("/model");
    expect(r.text).not.toMatch(/\x1b\[/);
  });

  it("bare /model shows current model", async () => {
    const r = await runAgentCommand("/model", ctx());
    expect(r.text).toContain("anthropic:claude-sonnet-4-5");
  });

  it("/model switches model", async () => {
    const r = await runAgentCommand("/model gpt", ctx());
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("switched to");
  });

  it("/model list returns endpoint models", async () => {
    const r = await runAgentCommand("/model list", ctx());
    expect(r.text).toContain("m1");
  });

  it("/model list reports errors as kind=error without ANSI", async () => {
    const agent = fakeAgent({ listModels: async () => { throw new Error("nope"); } } as never);
    const r = await runAgentCommand("/model list", ctx({ agent }));
    expect(r.kind).toBe("error");
    expect(r.text).toContain("nope");
    expect(r.text).not.toMatch(/\x1b\[/);
  });

  it("/auto toggles permission mode", async () => {
    const permissions = fakePermissions();
    await runAgentCommand("/auto on", ctx({ permissions }));
    expect(permissions.mode).toBe("auto");
    await runAgentCommand("/auto off", ctx({ permissions }));
    expect(permissions.mode).toBe("default");
  });

  it("/yolo toggles yolo mode", async () => {
    const permissions = fakePermissions();
    const r = await runAgentCommand("/yolo", ctx({ permissions }));
    expect(permissions.mode).toBe("yolo");
    expect(r.text).toContain("ON");
  });

  it("/plan toggles plan mode", async () => {
    const agent = fakeAgent();
    await runAgentCommand("/plan", ctx({ agent }));
    expect(agent.planMode).toBe(true);
    await runAgentCommand("/plan off", ctx({ agent }));
    expect(agent.planMode).toBe(false);
  });

  it("/mcp with no manager reports disabled", async () => {
    const r = await runAgentCommand("/mcp", ctx({ mcp: null }));
    expect(r.text).toContain("disabled");
  });

  it("/cost sets budget and rejects bad values", async () => {
    const agent = fakeAgent();
    const r = await runAgentCommand("/cost 5", ctx({ agent }));
    expect(r.text).toContain("$5.00");
    expect((agent.costs as unknown as { budgetUsd: number }).budgetUsd).toBe(5);
    const bad = await runAgentCommand("/cost abc", ctx({ agent }));
    expect(bad.kind).toBe("error");
  });

  it("/cost all aggregates the cross-session ledger", async () => {
    usageLedger.entries = [
      { t: "2026-09-11T10:00:00.000Z", s: "aaa1", m: "anthropic:claude-sonnet-4-5", u: 0.02, p: true, i: 1000, o: 200, cr: 0, cw: 0 },
      { t: "2026-09-12T10:00:00.000Z", s: "bbb2", m: "anthropic:claude-sonnet-4-5", u: 0.03, p: true, i: 1500, o: 300, cr: 0, cw: 0 },
    ];
    const r = await runAgentCommand("/cost all", ctx());
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("$0.0500");
    expect(r.text).toContain("2 requests");
    expect(r.text).toContain("2 sessions");
    expect(r.text).toContain("2 days");
    usageLedger.entries = [];
  });

  it("/cost by groups the ledger by dimension", async () => {
    usageLedger.entries = [
      { t: "2026-09-12T10:00:00.000Z", s: "aaa1", m: "anthropic:claude-haiku-4-5", u: 0.01, p: true, i: 500, o: 100, cr: 0, cw: 0 },
      { t: "2026-09-12T11:00:00.000Z", s: "bbb2", m: "anthropic:claude-haiku-4-5", u: 0.02, p: true, i: 700, o: 150, cr: 0, cw: 0 },
    ];
    const byModel = await runAgentCommand("/cost by model", ctx());
    expect(byModel.text).toContain("anthropic:claude-haiku-4-5");
    expect(byModel.text).toContain("1 model group");
    const byDay = await runAgentCommand("/cost by day", ctx());
    expect(byDay.text).toContain("2026-09-12");
    const badDim = await runAgentCommand("/cost by nonsense", ctx());
    expect(badDim.kind).toBe("error");
    usageLedger.entries = [];
  });

  it("/cost by reports an empty ledger", async () => {
    usageLedger.entries = [];
    const r = await runAgentCommand("/cost by session", ctx());
    expect(r.text).toContain("no usage recorded");
  });

  it("/search lists matching sessions with snippets", async () => {
    searchLedger.hits = [
      { meta: { id: "abcd1234", cwd: "D:\\proj", startedAt: "", updatedAt: "2026-09-10T10:00:00.000Z", title: "ws bug" }, matches: 3, snippet: "…the WebSocket times out…", titleMatch: false },
    ];
    const r = await runAgentCommand("/search websocket", ctx());
    expect(r.text).toContain("1 session(s) match");
    expect(r.text).toContain("abcd1234");
    expect(r.text).toContain('"ws bug"');
    expect(r.text).toContain("3 msgs");
    expect(r.text).toContain("/resume");
    searchLedger.hits = [];
    const none = await runAgentCommand("/search nothinghere", ctx());
    expect(none.text).toContain("no sessions match");
    const bad = await runAgentCommand("/search", ctx());
    expect(bad.kind).toBe("error");
  });

  it("/export writes the transcript to disk", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "mojo-export-"));
    try {
      const out = path.join(dir, "chat.md");
      const r = await runAgentCommand(`/export md ${out}`, ctx());
      expect(r.kind).toBe("ok");
      expect(r.text).toContain("exported 1 messages");
      expect(await readFile(out, "utf8")).toBe("# exported");
      const bad = await runAgentCommand("/export html", ctx());
      expect(bad.kind).toBe("error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/tag add/remove/clear flows through tagSession", async () => {
    const ctx0 = ctx();
    const shown = await runAgentCommand("/tag", ctx0);
    expect(shown.text).toBe("tags: old");

    const add = await runAgentCommand("/tag +bug perf", ctx0);
    expect(add.text).toBe("tags: old, bug, perf");

    // the loadSession mock is stateless (always tags:["old"]), so this call
    // re-derives from ["old"]: -old -perf removes, +new adds.
    const swap = await runAgentCommand("/tag +new -old -perf", ctx0);
    expect(swap.text).toBe("tags: new");

    const drain = await runAgentCommand("/tag -old", ctx0); // removing the only tag
    expect(drain.text).toBe("(no tags)");

    const clear = await runAgentCommand("/tag clear", ctx0);
    expect(clear.text).toBe("cleared tags on session sess1");
  });

  it("/sessions --tag filters by tag", async () => {
    sessionLedger.metas = [
      { id: "aaaa1111", cwd: "D:\\web", updatedAt: "2026-09-10T10:00:00.000Z", tags: ["bug", "perf"] },
      { id: "bbbb2222", cwd: "D:\\web", updatedAt: "2026-09-11T10:00:00.000Z" },
    ];
    const tagged = await runAgentCommand("/sessions --tag bug", ctx());
    expect(tagged.text).toContain("aaaa1111");
    expect(tagged.text).toContain("[bug,perf]");
    expect(tagged.text).not.toContain("bbbb2222");
    sessionLedger.metas = [];
  });

  it("/todos empty and filled", async () => {
    const empty = await runAgentCommand("/todos", ctx());
    expect(empty.text).toBe("(empty)");
    const agent = fakeAgent({ currentTodos: () => [{ status: "in_progress", content: "do it" }] } as never);
    const r = await runAgentCommand("/todos", ctx({ agent }));
    expect(r.text).toContain("[>] do it");
  });

  it("/sessions with none", async () => {
    const r = await runAgentCommand("/sessions", ctx());
    expect(r.text).toBe("(no sessions)");
  });

  it("/sessions filters by --cwd / --title and caps with a limit", async () => {
    sessionLedger.metas = [
      { id: "aaaa1111", cwd: "D:\\web", updatedAt: "2026-09-10T10:00:00.000Z", model: "anthropic:x", title: "ws bug" },
      { id: "bbbb2222", cwd: "D:\\web", updatedAt: "2026-09-11T10:00:00.000Z", model: "openai:y" },
      { id: "cccc3333", cwd: "D:\\cli", updatedAt: "2026-09-12T10:00:00.000Z", model: "anthropic:x" },
    ];
    const byCwd = await runAgentCommand("/sessions --cwd web", ctx());
    expect(byCwd.text).toContain("2 match");
    expect(byCwd.text).not.toContain("cccc3333");

    const byTitle = await runAgentCommand("/sessions --title WS", ctx()); // case-insensitive
    expect(byTitle.text).toContain("aaaa1111");
    expect(byTitle.text).toContain('title~"ws"');

    const limited = await runAgentCommand("/sessions 1", ctx());
    expect(limited.text).toContain("1 shown / 3 total");
    expect(limited.text).toContain("aaaa1111"); // first row of the (mocked) list
    expect(limited.text).not.toContain("cccc3333");

    const none = await runAgentCommand("/sessions --title zzz", ctx());
    expect(none.text).toBe('(no sessions match title~"zzz")');
    sessionLedger.metas = [];
  });

  it("/search flags the query for highlighting", async () => {
    searchLedger.hits = [
      { meta: { id: "abcd1234", cwd: "D:\\proj", startedAt: "", updatedAt: "2026-09-10T10:00:00.000Z" }, matches: 2, snippet: "the WebSocket times out", titleMatch: false },
    ];
    const r = await runAgentCommand("/search websocket", ctx());
    expect(r.highlight).toBe("websocket");
    searchLedger.hits = [];
    const none = await runAgentCommand("/search nothing", ctx());
    expect(none.highlight).toBeUndefined();
  });

  it("/resume loads a session and restores its model", async () => {
    const agent = fakeAgent();
    const r = await runAgentCommand("/resume abc", ctx({ agent }));
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("resumed abc");
  });

  it("/resume without id is an error", async () => {
    const r = await runAgentCommand("/resume", ctx());
    expect(r.kind).toBe("error");
  });

  it("/undo with no checkpoints", async () => {
    const r = await runAgentCommand("/undo -y", ctx());
    expect(r.text).toContain("nothing to undo");
  });

  it("/clear creates a new session", async () => {
    const agent = fakeAgent();
    const spy = vi.spyOn(agent, "resetSession");
    const r = await runAgentCommand("/clear", ctx({ agent }));
    expect(r.text).toContain("new session new1234");
    expect(spy).toHaveBeenCalledWith("new1234");
  });

  it("/quit returns the quit sentinel", async () => {
    const r = await runAgentCommand("/quit", ctx());
    expect(r.quit).toBe(true);
    expect(r.text).toBeNull();
  });

  it("unknown command is an error", async () => {
    const r = await runAgentCommand("/frobnicate", ctx());
    expect(r.kind).toBe("error");
    expect(r.text).toContain("unknown command");
  });

  it("/review notifies progress via ctx.notify", async () => {
    const notes: string[] = [];
    const r = await runAgentCommand("/review main 安全", ctx({ notify: (m) => notes.push(m) }));
    expect(r.text).toContain("review output");
    expect(notes.some((n) => n.includes("main...HEAD"))).toBe(true);
  });

  it("/rename names the current session", async () => {
    const agent = fakeAgent({ sessionId: "sess1" });
    const r = await runAgentCommand("/rename my nice chat", ctx({ agent }));
    expect(r.kind).toBe("ok");
    expect(r.text).toContain('renamed session sess1 to "my nice chat"');
  });

  it("/rename without a title clears the name (false from renameSession is an error)", async () => {
    const r = await runAgentCommand("/rename", ctx());
    expect(r.kind).toBe("error");
    expect(r.text).toContain("session not found");
  });

  it("/permissions clear reports global and project counts separately", async () => {
    const permissions = {
      mode: "default",
      getRules: () => [],
      clearRules: async () => ({ global: 2, project: 1 }),
      check: async () => true,
    } as unknown as PermissionManager;
    const r = await runAgentCommand("/permissions clear", ctx({ permissions }));
    expect(r.text).toContain("removed 2 global rule(s)");
    expect(r.text).toContain("cleared 1 project rule(s)");
  });

  it("/fork on an empty conversation is an error", async () => {
    const r = await runAgentCommand("/fork", ctx());
    expect(r.kind).toBe("error");
    expect(r.text).toContain("empty");
  });

  it("/fork branches and reports the kept count", async () => {
    const agent = fakeAgent({
      sessionId: "orig1",
      getMessages: () => Array.from({ length: 6 }, () => ({ role: "user", content: "x" })) as never,
      fork: async () => "fork9999",
    } as never);
    const r = await runAgentCommand("/fork", ctx({ agent }));
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("forked into session fork9999");
    expect(r.text).toContain("kept 6/6");
    expect(r.text).toContain("/resume orig1");
  });

  it("/fork parses a leading count and a title", async () => {
    let seenKeep = -1;
    let seenTitle: string | undefined;
    const agent = fakeAgent({
      sessionId: "orig1",
      getMessages: () => Array.from({ length: 6 }, () => ({ role: "user", content: "x" })) as never,
      fork: async (keep: number, title?: string) => {
        seenKeep = keep;
        seenTitle = title;
        return "fork9999";
      },
    } as never);
    await runAgentCommand("/fork 4 try light theme", ctx({ agent }));
    expect(seenKeep).toBe(4);
    expect(seenTitle).toBe("try light theme");
  });

  it("/fork reports when nothing was kept", async () => {
    const agent = fakeAgent({
      sessionId: "orig1",
      getMessages: () => Array.from({ length: 3 }, () => ({ role: "user", content: "x" })) as never,
      fork: async () => null,
    } as never);
    const r = await runAgentCommand("/fork 1", ctx({ agent }));
    expect(r.kind).toBe("error");
    expect(r.text).toContain("would drop the whole history");
  });
});
