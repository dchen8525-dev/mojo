import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, ToolUseBlock } from "../src/types.js";

// Scripted fake LLM for the detached subagent loop.
const h = vi.hoisted(() => ({
  turns: [] as Array<{ content: ContentBlock[]; inputTokens: number; outputTokens: number }>,
  calls: 0,
}));

vi.mock("../src/llm.js", () => ({
  LLM: class FakeLLM {
    provider = "anthropic";
    model = "fake";
    async send() {
      const t = h.turns[h.calls++];
      if (!t) throw new Error("fake LLM ran out of scripted turns");
      const toolUses = t.content.filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use");
      const text = t.content
        .filter((b) => (b as { type?: string }).type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      return {
        text,
        toolUses,
        content: t.content,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        stopReason: toolUses.length ? "tool_use" : "end_turn",
      };
    }
  },
}));

const { taskTool, taskOutputTool } = await import("../src/tools/task.js");
const { subagentTasks } = await import("../src/taskRegistry.js");

const ctx = {
  cwd: process.cwd(),
  planMode: false,
  askPermission: async () => true,
} as never;

function textTurn(text: string) {
  return { content: [{ type: "text", text } as ContentBlock], inputTokens: 10, outputTokens: 5 };
}

afterEach(() => {
  h.turns = [];
  h.calls = 0;
  subagentTasks.reset();
});

describe("task run_in_background", () => {
  it("returns a task id immediately and stores the report when done", async () => {
    h.turns = [textTurn("findings: everything checks out")];
    const r = await taskTool.execute({ description: "dig", prompt: "find things", run_in_background: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("sub-1");
    expect(r.content).toContain("task_output");

    await subagentTasks.whenDone("sub-1");
    const t = subagentTasks.get("sub-1")!;
    expect(t.status).toBe("done");
    expect(t.report).toContain("findings: everything checks out");
    expect(t.report).toContain("finished after 0 tool calls");
  });

  it("does not occupy the parent: a second start gets the next id", async () => {
    h.turns = [textTurn("a"), textTurn("b")];
    const r1 = await taskTool.execute({ description: "one", prompt: "p", run_in_background: true }, ctx);
    const r2 = await taskTool.execute({ description: "two", prompt: "p", run_in_background: true }, ctx);
    expect(r1.content).toContain("sub-1");
    expect(r2.content).toContain("sub-2");
    await Promise.all([subagentTasks.whenDone("sub-1"), subagentTasks.whenDone("sub-2")]);
  });
});

describe("task_output", () => {
  it("lists tasks without id and reports unknown ids", async () => {
    expect((await taskOutputTool.execute({}, ctx)).content).toContain("No background subagents");
    h.turns = [textTurn("report body")];
    await taskTool.execute({ description: "dig", prompt: "p", run_in_background: true }, ctx);
    await subagentTasks.whenDone("sub-1");

    const list = await taskOutputTool.execute({}, ctx);
    expect(list.content).toContain("sub-1 [done]");
    const rep = await taskOutputTool.execute({ id: "sub-1" }, ctx);
    expect(rep.content).toContain("report body");
    const bad = await taskOutputTool.execute({ id: "nope" }, ctx);
    expect(bad.isError).toBe(true);
  });

  it("reports running tasks and failed tasks distinctly", async () => {
    const id = subagentTasks.start("slow", "research", () => new Promise<string>(() => {}));
    const running = await taskOutputTool.execute({ id }, ctx);
    expect(running.content).toContain("still running");

    const failId = subagentTasks.start("boom", "research", async () => {
      throw new Error("kaboom");
    });
    await subagentTasks.whenDone(failId);
    const failed = await taskOutputTool.execute({ id: failId }, ctx);
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("kaboom");
  });

  it("drainCompleted delivers each task exactly once", async () => {
    const id = subagentTasks.start("t", "research", async () => "done-report");
    await subagentTasks.whenDone(id);
    const first = subagentTasks.drainCompleted();
    expect(first.map((t) => t.id)).toEqual([id]);
    expect(subagentTasks.drainCompleted()).toEqual([]);
  });
});

describe("subagent hardening", () => {
  it("keeps descriptions single-line and bounded", async () => {
    h.turns = [textTurn("report")];
    await taskTool.execute({ description: "line one\nline two ".repeat(20), prompt: "p", run_in_background: true }, ctx);
    await subagentTasks.whenDone("sub-1");
    const t = subagentTasks.get("sub-1")!;
    expect(t.description).not.toContain("\n");
    expect(t.description.length).toBeLessThanOrEqual(60);
  });

  it("scopes tasks and reports to the session that spawned them", async () => {
    const id = subagentTasks.start("t", "research", async () => "secret-report", "session-a");
    await subagentTasks.whenDone(id);
    expect(subagentTasks.list("session-b")).toEqual([]);
    expect(subagentTasks.get(id, "session-b")).toBeUndefined();
    expect(subagentTasks.drainCompleted("session-b")).toEqual([]);
    expect(subagentTasks.drainCompleted("session-a").map((t) => t.id)).toEqual([id]);

    const leaked = await taskOutputTool.execute({ id }, { sessionId: "session-b" } as never);
    expect(leaked.isError).toBe(true);
  });

  it("enforces read-before-edit inside a worker subagent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sub-worker-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "precious", "utf8");
      h.turns = [
        {
          content: [{ type: "tool_use", id: "w1", name: "write_file", input: { path: "a.txt", content: "clobbered" } } as ContentBlock],
          inputTokens: 10,
          outputTokens: 5,
        },
        textTurn("done"),
      ];
      const r = await taskTool.execute({ description: "impl", prompt: "p", mode: "worker" }, {
        ...ctx,
        cwd: dir,
      } as never);
      expect(r.isError).toBeFalsy();
      expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("precious");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
