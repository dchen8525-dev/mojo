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

// /cron reads the real ledger by default; keep tests off ~/.node-agent.
const cronLedger: { tasks: Array<Record<string, unknown>> } = { tasks: [] };
vi.mock("../src/cron.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cron.js")>("../src/cron.js");
  return {
    ...actual,
    loadCronTasks: async () => cronLedger.tasks as never,
    createCronTask: async (input: { name?: string; cron: string; prompt: string; cwd: string }) => ({
      id: "cr_aaa00001",
      name: input.name || input.prompt.slice(0, 20),
      cron: input.cron,
      prompt: input.prompt,
      cwd: input.cwd,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      runCount: 0,
    }),
    updateCronTask: async (id: string, patch: { enabled?: boolean }) => ({
      id,
      name: "daily",
      cron: "0 9 * * *",
      prompt: "p",
      cwd: "/tmp/repo",
      enabled: !!patch.enabled,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      runCount: 1,
    }),
    deleteCronTask: async (id: string) => id === "cr_aaa00001",
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
    debugMessages: () => [],
    fork: async () => null,
    ...overrides,
  } as unknown as Agent;
}

function fakePermissions(): PermissionManager {
  return {
    mode: "default",
    load: async () => {},
    getRules: () => [],
    getProjectRules: () => [],
    getSessionRules: () => [],
    clearRules: async () => ({ global: 0, project: 0 }),
    check: async () => true,
  } as unknown as PermissionManager;
}

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    agent: fakeAgent(),
    permissions: fakePermissions(),
    mcp: null,
    hooks: { list: () => [], untrustedProjectHooks: () => null } as never,
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

  it("/undo reports a conflict instead of claiming success", async () => {
    const entry = {
      id: 1,
      file: "/tmp/repo/a.ts",
      snapshot: "",
      existed: true,
      label: "edit_file",
      ts: "2026-10-22T00:00:00.000Z",
      restored: false,
    };
    const r = await runAgentCommand(
      "/undo -y",
      ctx({
        agent: fakeAgent({
          checkpointList: async () => [entry] as never,
          undoLastCheckpoint: async () => ({
            file: "/tmp/repo/a.ts",
            action: "refused",
            conflict: true,
            reason: "the file was modified after the agent's edit",
          }),
        }),
      }),
    );
    expect(r.kind).toBe("error");
    expect(r.text).toContain("undo refused");
    expect(r.text).toContain("modified after");
    expect(r.text).toContain("--force");
  });

  it("/undo -y --force forwards force to the checkpoint store", async () => {
    let forced: boolean | undefined;
    const entry = {
      id: 1,
      file: "/tmp/repo/a.ts",
      snapshot: "",
      existed: true,
      label: "edit_file",
      ts: "2026-10-22T00:00:00.000Z",
      restored: false,
    };
    const r = await runAgentCommand(
      "/undo -y --force",
      ctx({
        agent: fakeAgent({
          checkpointList: async () => [entry] as never,
          undoLastCheckpoint: async (force = false) => {
            forced = force;
            return { file: "/tmp/repo/a.ts", action: "restored previous content" };
          },
        }),
      }),
    );
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("undone");
    expect(forced).toBe(true);
  });

  it("/rewind with no checkpoints reports emptiness", async () => {
    const r = await runAgentCommand("/rewind", ctx());
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("no checkpoints");
  });

  it("/rewind lists checkpoints and previews an id before applying", async () => {
    const entry = {
      id: 2,
      file: "/tmp/repo/b.ts",
      snapshot: "",
      existed: true,
      label: "write_file",
      ts: "2026-10-22T01:00:00.000Z",
      restored: false,
    };
    const listR = await runAgentCommand("/rewind", ctx({ agent: fakeAgent({ checkpointList: async () => [entry] as never }) }));
    expect(listR.text).toContain("#2");
    expect(listR.text).toContain("/rewind <id>");

    const calls: Array<{ id: number; opts: unknown }> = [];
    const rewind = async (id: number, opts: { force?: boolean; dryRun?: boolean }) => {
      calls.push({ id, opts });
      return { targetId: id, applied: [{ file: "/tmp/repo/b.ts", action: "restored content from before #1" }], conflicts: [], entryIds: [id], dryRun: opts.dryRun };
    };
    const preview = await runAgentCommand("/rewind 2", ctx({ agent: fakeAgent({ checkpointList: async () => [entry] as never, rewindToCheckpoint: rewind as never }) }));
    expect(preview.kind).toBe("ok");
    expect(preview.text).toContain("would roll back 1 file(s)");
    expect(calls[0].opts).toMatchObject({ dryRun: true });

    const applied = await runAgentCommand("/rewind latest -y", ctx({ agent: fakeAgent({ checkpointList: async () => [entry] as never, rewindToCheckpoint: rewind as never }) }));
    expect(applied.text).toContain("rewound 1 file(s)");
    expect(calls[1]).toMatchObject({ id: 2, opts: { dryRun: false } });
  });

  it("/rewind surfaces conflicts and forwards force", async () => {
    const rewind = async (_id: number, opts: { force?: boolean }) =>
      opts.force
        ? { targetId: _id, applied: [{ file: "/tmp/repo/b.ts", action: "restored" }], conflicts: [], entryIds: [_id] }
        : { targetId: _id, applied: [], conflicts: [{ file: "/tmp/repo/b.ts", reason: "modified after the agent's edit" }], entryIds: [_id] };
    const agent = fakeAgent({
      checkpointList: async () => [{ id: 1, file: "/tmp/repo/b.ts", ts: "2026-10-22T01:00:00.000Z", label: "edit_file", restored: false }] as never,
      rewindToCheckpoint: rewind as never,
    });
    const refused = await runAgentCommand("/rewind 1 -y", ctx({ agent }));
    expect(refused.kind).toBe("error");
    expect(refused.text).toContain("rewind refused");
    expect(refused.text).toContain("--force");

    const forced = await runAgentCommand("/rewind 1 -y --force", ctx({ agent }));
    expect(forced.kind).toBe("ok");
    expect(forced.text).toContain("rewound 1 file(s)");
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

  it("/cron lists tasks and explains how to add one", async () => {
    cronLedger.tasks = [];
    const empty = await runAgentCommand("/cron", ctx());
    expect(empty.kind).toBe("ok");
    expect(empty.text).toContain("/cron add");

    cronLedger.tasks = [
      {
        id: "cr_aaa00001",
        name: "daily",
        cron: "0 9 * * *",
        prompt: "p",
        cwd: "/tmp/repo",
        enabled: true,
        createdAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
        runCount: 0,
      },
    ];
    const list = await runAgentCommand("/cron", ctx());
    expect(list.text).toContain("cr_aaa00001");
    expect(list.text).toContain("0 9 * * *");
    cronLedger.tasks = [];
  });

  it("/cron add parses five cron fields plus a prompt", async () => {
    const r = await runAgentCommand("/cron add 0 9 * * 1 每周总结提交", ctx());
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("created cr_aaa00001");
    expect(r.text).toContain("每周总结提交");
  });

  it("/cron add rejects bad expressions and missing prompt", async () => {
    const bad = await runAgentCommand("/cron add 60 9 * * 1 总结", ctx());
    expect(bad.kind).toBe("error");
    expect(bad.text).toContain("minute value 60");
    const noPrompt = await runAgentCommand("/cron add 0 9 * * 1", ctx());
    expect(noPrompt.kind).toBe("error");
    expect(noPrompt.text).toContain("usage: /cron add");
  });

  it("/cron toggles and deletes tasks", async () => {
    const off = await runAgentCommand("/cron off cr_aaa00001", ctx());
    expect(off.kind).toBe("ok");
    expect(off.text).toContain("paused");
    const on = await runAgentCommand("/cron on cr_aaa00001", ctx());
    expect(on.text).toContain("enabled");
    const rm = await runAgentCommand("/cron rm cr_aaa00001", ctx());
    expect(rm.kind).toBe("ok");
    const missing = await runAgentCommand("/cron rm nope", ctx());
    expect(missing.kind).toBe("error");
  });

  it("/cron run uses the host scheduler when present", async () => {
    const seen: string[] = [];
    const cronScheduler = {
      runNowDetached: async (id: string) => {
        seen.push(id);
        return { ok: true };
      },
    } as never;
    const r = await runAgentCommand("/cron run cr_aaa00001", ctx({ cronScheduler }));
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("started");
    expect(seen).toEqual(["cr_aaa00001"]);

    const absent = await runAgentCommand("/cron run cr_aaa00001", ctx());
    expect(absent.kind).toBe("error");
    expect(absent.text).toContain("scheduler");
  });
});

describe("/doctor", () => {
  it("reports every subsystem without leaking the api key", async () => {
    const r = await runAgentCommand("/doctor", ctx());
    expect(r.kind).toBe("ok");
    for (const marker of ["api key", "model:", "context:", "session:", "permissions:", "mcp:", "hooks:", "cron:", "lsp:", "journal:"]) {
      expect(r.text).toContain(marker);
    }
    // The key is masked at best, never shown whole.
    expect(r.text).not.toMatch(/sk-[A-Za-z0-9]{8}/);
    expect(r.text).not.toMatch(/\x1b\[/);
  });

  it("surfaces degraded subsystems with warnings", async () => {
    const r = await runAgentCommand(
      "/doctor",
      ctx({
        mcp: {
          statuses: [
            { name: "good", connected: true, toolCount: 3, kind: "stdio" },
            { name: "bad", connected: false, error: "boom", toolCount: 0 },
          ],
        } as never,
        hooks: {
          list: () => [{ event: "PostToolUse", matcher: "*", command: "x" }],
          untrustedProjectHooks: () => ({ file: ".node-agent/hooks.json" }),
        } as never,
        cronScheduler: { isOwner: false, isStarted: true } as never,
      }),
    );
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("1/2 connected");
    expect(r.text).toContain("bad: boom");
    expect(r.text).toContain("NOT loaded (untrusted)");
    expect(r.text).toContain("standby");
  });

  it("flags a model override on the doctor model line", async () => {
    const r = await runAgentCommand("/doctor", ctx({ agent: fakeAgent({ provider: "openai", model: "gpt-4o" } as never) }));
    expect(r.text).toContain("openai:gpt-4o");
  });
});
