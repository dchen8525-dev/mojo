import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, MessageParam, ToolUseBlock } from "../src/types.js";

// Scripted fake LLM: each send() pops the next canned turn.
const h = vi.hoisted(() => ({
  turns: [] as Array<{
    content: ContentBlock[];
    inputTokens: number;
    outputTokens: number;
  }>,
  calls: 0,
  sentMessages: [] as MessageParam[][],
}));

vi.mock("../src/llm.js", () => ({
  LLM: class FakeLLM {
    provider = "anthropic";
    model = "fake";
    get contextWindow() {
      return 100_000;
    }
    async send(messages: MessageParam[]) {
      h.sentMessages.push(structuredClone(messages));
      const t = h.turns[h.calls++];
      if (!t) throw new Error("fake LLM ran out of scripted turns");
      const toolUses = t.content.filter(
        (b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use",
      );
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
    switchModel() {
      return { provider: "anthropic" as const, model: "fake" };
    }
    listModels() {
      return Promise.resolve<string[]>([]);
    }
  },
}));

// Keep tests from writing real session files.
vi.mock("../src/session.js", () => ({
  appendMessages: async () => {},
  appendModel: async () => {},
}));

const { Agent } = await import("../src/agent.js");
const { registerTool } = await import("../src/tools/index.js");
const { HookManager } = await import("../src/hooks.js");

const permissions = { check: async () => true } as never;

function makeAgent(hooks?: HookManager) {
  return new Agent(process.cwd(), "test-session", permissions, undefined, undefined, hooks);
}

function textTurn(text: string, input = 100, output = 10) {
  return { content: [{ type: "text", text } as ContentBlock], inputTokens: input, outputTokens: output };
}

function toolTurn(calls: Array<[string, Record<string, unknown>]>, input = 100, output = 10) {
  return {
    content: calls.map(
      ([name, inp], i) => ({ type: "tool_use", id: `tu${i}`, name, input: inp }) as ContentBlock,
    ),
    inputTokens: input,
    outputTokens: output,
  };
}

/** The message array sent on the final LLM call; its last entry carries tool results. */
function lastSentContent() {
  const messages = h.sentMessages[h.sentMessages.length - 1];
  return messages[messages.length - 1].content as Array<Record<string, unknown>>;
}

let toolEvents: string[] = [];

beforeAll(() => {
  // Instrumented tools: parallel-safe ones sleep; event order proves scheduling.
  toolEvents = [];
  registerTool({
    name: "t_parallel",
    description: "test",
    isReadOnly: true,
    parallelSafe: true,
    inputSchema: { type: "object", properties: {} },
    async execute(input) {
      toolEvents.push(`p-start ${input.n}`);
      await new Promise((r) => setTimeout(r, 60));
      toolEvents.push(`p-end ${input.n}`);
      return { content: `P${input.n}` };
    },
  });
  registerTool({
    name: "t_serial",
    description: "test",
    isReadOnly: false,
    inputSchema: { type: "object", properties: {} },
    async execute(input) {
      toolEvents.push(`s-run ${input.n}`);
      await new Promise((r) => setTimeout(r, 10));
      return { content: `S${input.n}` };
    },
  });
});

beforeEach(() => {
  // reset scripted turns between tests
  h.turns = [];
  h.calls = 0;
  h.sentMessages = [];
  toolEvents.length = 0;
});

describe("Agent.chat tool scheduling", () => {
  it("runs parallel-safe tools concurrently and serial tools after them", async () => {
    h.turns = [
      toolTurn([
        ["t_parallel", { n: 1 }],
        ["t_serial", { n: 1 }],
        ["t_parallel", { n: 2 }],
        ["t_serial", { n: 2 }],
      ]),
      textTurn("done"),
    ];
    const out = await makeAgent().chat("go");
    expect(out).toBe("done");
    // Overlapping start/end proves concurrency of the parallel pair.
    expect(toolEvents.indexOf("p-start 2")).toBeLessThan(toolEvents.indexOf("p-end 1"));
    // Serial tools run one at a time, after the parallel batch completes.
    expect(toolEvents.indexOf("s-run 1")).toBeGreaterThan(toolEvents.indexOf("p-end 2"));
    expect(toolEvents.indexOf("s-run 2")).toBeGreaterThan(toolEvents.indexOf("s-run 1"));
  });

  it("backfills tool results in call order", async () => {
    h.turns = [
      toolTurn([
        ["t_parallel", { n: 1 }],
        ["t_serial", { n: 9 }],
        ["t_parallel", { n: 2 }],
      ]),
      textTurn("done"),
    ];
    await makeAgent().chat("go");
    const results = lastSentContent() as Array<{ tool_use_id: string; content: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu0", "tu1", "tu2"]);
    expect(results.map((r) => r.content)).toEqual(["P1", "S9", "P2"]);
  });
});

describe("Agent.chat token accounting", () => {
  it("anchors on exact API usage for the sent history", async () => {
    h.turns = [textTurn("hi", 5000, 200)];
    const agent = makeAgent();
    await agent.chat("hello");
    // 1 user + 1 assistant message, fully covered by the anchor.
    expect(agent.tokenEstimate()).toBe(5200);
  });

  it("re-anchors after every turn", async () => {
    h.turns = [
      toolTurn([["t_parallel", { n: 1 }]], 4000, 50),
      textTurn("done", 4100, 5),
    ];
    const agent = makeAgent();
    await agent.chat("go");
    // Second turn re-anchored exactly; nothing appended since.
    expect(agent.tokenEstimate()).toBe(4105);
  });
});

describe("Agent.chat hooks integration", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hookint-"));
    await fs.writeFile(path.join(dir, "block.js"), 'console.error("nope");process.exit(2);');
    await fs.writeFile(path.join(dir, "ctx.js"), "console.log('extra context');");
  });

  function hookManager(event: string, file: string, matcher?: string) {
    const hm = new HookManager();
    (hm as unknown as { hooks: Record<string, unknown[]> }).hooks[event] = [
      { command: `node "${path.join(dir, file)}"`, matcher },
    ];
    return hm;
  }

  it("UserPromptSubmit block aborts the turn", async () => {
    const agent = makeAgent(hookManager("UserPromptSubmit", "block.js"));
    await expect(agent.chat("hi")).rejects.toThrow(/blocked by hook/);
    expect(h.calls).toBe(0); // LLM never called
  });

  it("PreToolUse block turns the tool call into an error result", async () => {
    h.turns = [toolTurn([["t_parallel", { n: 1 }]]), textTurn("recovered")];
    const agent = makeAgent(hookManager("PreToolUse", "block.js", "t_parallel"));
    const out = await agent.chat("go");
    expect(out).toBe("recovered");
    const result = (lastSentContent() as Array<{ content: string; is_error?: boolean }>)[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Blocked by PreToolUse hook");
  });

  it("PostToolUse stdout context is appended to the tool result", async () => {
    h.turns = [toolTurn([["t_parallel", { n: 1 }]]), textTurn("done")];
    await makeAgent(hookManager("PostToolUse", "ctx.js")).chat("go");
    const result = (lastSentContent() as Array<{ content: string }>)[0];
    expect(result.content).toContain("P1");
    expect(result.content).toContain("extra context");
  });
});
