import { describe, expect, it, vi } from "vitest";
import { runAgentCommand, type CommandContext } from "../src/agentCommands.js";
import type { Agent } from "../src/agent.js";
import type { PermissionManager } from "../src/permissions.js";

// Keep tests from touching real session files.
vi.mock("../src/session.js", () => ({
  createSession: async () => ({ id: "new1234", meta: { id: "new1234", cwd: "/tmp", startedAt: "", updatedAt: "" } }),
  listSessions: async () => [],
  loadSession: async (id: string) => (id === "abc" ? { meta: { id, cwd: "/tmp", startedAt: "", updatedAt: "", model: "anthropic:fake" }, messages: [] } : null),
  renameSession: async (id: string, title: string) => id === "sess1" && !!title.trim(),
  forkSession: async (_cwd: string, messages: unknown[], opts: { title?: string; fromId?: string }) => ({
    id: "fork9999",
    meta: { id: "fork9999", cwd: _cwd, startedAt: "", updatedAt: "", title: opts.title, forkedFrom: opts.fromId, messages: messages.length },
  }),
}));

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
    clearRules: async () => 0,
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
