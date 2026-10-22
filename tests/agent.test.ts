import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";import type { ContentBlock, MessageParam, ToolUseBlock } from "../src/types.js";
import { CancelledStreamError } from "../src/llm/types.js";

// Scripted fake LLM: each send() pops the next canned turn.
const h = vi.hoisted(() => ({
  turns: [] as Array<{
    content: ContentBlock[];
    inputTokens: number;
    outputTokens: number;
  }>,
  calls: 0,
  model: "fake",
  sentMessages: [] as MessageParam[][],
  sentTools: [] as string[][],
  sentSystems: [] as string[],
  recalled: "",
  appended: [] as MessageParam[],
  savedTodos: [] as Array<{ id: string; todos: unknown }>,
  /** Test hook, invoked at the start of every fake send(). */
  onSend: null as null | (() => void),
}));

vi.mock("../src/llm.js", () => ({
  LLM: class FakeLLM {
    provider = "anthropic";
    get model() {
      return h.model;
    }
    get contextWindow() {
      return 100_000;
    }
    async send(messages: MessageParam[], system?: string | { stable: string; volatile?: string }, toolList?: Array<{ name: string }>) {
      h.onSend?.();
      h.sentMessages.push(structuredClone(messages));
      h.sentTools.push((toolList ?? []).map((t) => t.name));
      const sys =
        typeof system === "string" || !system ? (system ?? "") : `${system.stable}\n${system.volatile ?? ""}`;
      h.sentSystems.push(sys);
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
  appendMessages: async (_id: string, msgs: MessageParam[]) => {
    h.appended.push(...msgs);
  },
  appendModel: async () => {},
  rewriteMessages: async () => {},
  renameSession: async () => true,
  searchSessions: async () => [],
  renderSessionMarkdown: () => "",
  forkSession: async () => ({ id: "fork0000", meta: { id: "fork0000", cwd: "", startedAt: "", updatedAt: "" } }),
  saveTodos: async (id: string, todos: unknown) => {
    h.savedTodos.push({ id, todos });
    return true;
  },
}));

// Keep tests from reading/writing the real repo's memory.md.
vi.mock("../src/memory.js", () => ({
  renderMemory: async () => "",
  recallMemory: async () => h.recalled,
  appendMemoryNote: async () => null,
}));

// Keep tests from appending to the real ~/.node-agent/usage.jsonl ledger.
vi.mock("../src/usage.js", () => ({
  logUsage: async () => {},
  flushUsage: async () => {},
}));

// Deterministic skill discovery: one fake skill appears in every system prompt.
vi.mock("../src/skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills.js")>();
  return {
    ...actual,
    listSkills: async () => [
      { name: "fake-skill", description: "does fake things", file: "x", source: "project" as const },
    ],
  };
});

const { Agent } = await import("../src/agent.js");
const { registerTool, unregisterToolsByPrefix, todoStore } = await import("../src/tools/index.js");
const { subagentTasks } = await import("../src/taskRegistry.js");
const { HookManager } = await import("../src/hooks.js");

const permissions = { check: async () => true } as never;

function makeAgent(hooks?: HookManager, initialMessages?: MessageParam[]) {
  return new Agent(process.cwd(), "test-session", permissions, initialMessages, undefined, hooks);
}

function textTurn(text: string, input = 100, output = 10) {
  return { content: [{ type: "text", text } as ContentBlock], inputTokens: input, outputTokens: output };
}

function seedHistory(n: number): MessageParam[] {
  // ~2500 tokens per message, so 20 messages overflow the fake 100k window's
  // 50k compact budget and the truncation fallback has work to do.
  const filler = "x".repeat(10_000);
  const out: MessageParam[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `Q${i} ${filler}` });
    out.push({ role: "assistant", content: `A${i} ${filler}` });
  }
  return out;
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
  h.sentTools = [];
  h.sentSystems = [];
  h.recalled = "";
  h.appended = [];
  h.onSend = null;
  toolEvents.length = 0;
});

describe("Agent.chat memory recall", () => {
  it("appends recalled memory as a system reminder on the user message", async () => {
    h.recalled = 'Older long-term memory entries relevant to this request:\n<memory_entry source=".node-agent/memory.md" heading="SQLite">\nWAL mode is required.\n</memory_entry>';
    h.turns = [textTurn("ok")];
    await makeAgent().chat("why did we choose WAL?");
    const content = h.sentMessages[0][0].content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("why did we choose WAL?");
    expect(content[0].text).toContain('<system-reminder event="RecalledMemory">');
    expect(content[0].text).toContain("WAL mode is required.");
  });
});

describe("Agent.chat media budget", () => {
  afterEach(() => {
    delete process.env.AGENT_MAX_IMAGES_PER_MESSAGE;
    delete process.env.AGENT_MAX_SESSION_IMAGES;
  });

  function img(): ContentBlock {
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(1024) },
    } as unknown as ContentBlock;
  }

  it("rejects inbound images past the per-message cap before recording anything", async () => {
    process.env.AGENT_MAX_IMAGES_PER_MESSAGE = "1";
    const agent = makeAgent();
    await expect(agent.chat("hi", undefined, undefined, [img(), img()] as never)).rejects.toThrow(/limit 1 per message/);
    expect(h.appended).toHaveLength(0);
  });

  it("elides oldest resident images when the session cap trips, before the next send", async () => {
    process.env.AGENT_MAX_SESSION_IMAGES = "1";
    h.turns = [textTurn("a"), textTurn("b")];
    const agent = makeAgent();
    await agent.chat("one", undefined, undefined, [img()] as never);
    await agent.chat("two", undefined, undefined, [img()] as never);
    // Second chat's send sees the first chat's image elided; only the
    // current turn's image is still live (cap 1).
    const sent = JSON.stringify(h.sentMessages[1]);
    expect(sent).toContain("[image removed: session media budget]");
    expect((sent.match(/"type":"image"/g) ?? []).length).toBe(1);
  });
});

describe("Agent.chat tool scheduling", () => {
  it("runs tools in waves: adjacent parallel calls overlap, mutating calls run alone", async () => {
    h.turns = [
      toolTurn([
        ["t_parallel", { n: 1 }],
        ["t_serial", { n: 1 }],
        ["t_parallel", { n: 2 }],
        ["t_parallel", { n: 3 }],
        ["t_serial", { n: 2 }],
      ]),
      textTurn("done"),
    ];
    const out = await makeAgent().chat("go");
    expect(out).toBe("done");
    // Adjacent parallel tools overlap; a serial tool breaks the wave.
    expect(toolEvents.indexOf("p-start 3")).toBeLessThan(toolEvents.indexOf("p-end 2"));
    expect(toolEvents.indexOf("s-run 1")).toBeLessThan(toolEvents.indexOf("p-start 2"));
    expect(toolEvents.indexOf("s-run 2")).toBeGreaterThan(toolEvents.indexOf("p-end 3"));
    // Serial tools never overlap anything.
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

describe("Agent.chat repetition detection", () => {
  it("injects a system-reminder after the third identical call in a row", async () => {
    h.turns = [
      toolTurn([["t_parallel", { n: 7 }]]),
      toolTurn([["t_parallel", { n: 7 }]]),
      toolTurn([["t_parallel", { n: 7 }]]),
      textTurn("done"),
    ];
    const out = await makeAgent().chat("loop on it");
    expect(out).toBe("done");
    const finalMessages = h.sentMessages[3];
    const reminder = finalMessages
      .map((m) => m.content)
      .find((c) => typeof c === "string" && c.includes("RepetitionDetected"));
    expect(reminder).toContain("identical input 3 times");
    expect(reminder).toContain("t_parallel");
  });

  it("does not warn when the input changes each round", async () => {
    h.turns = [
      toolTurn([["t_parallel", { n: 1 }]]),
      toolTurn([["t_parallel", { n: 2 }]]),
      toolTurn([["t_parallel", { n: 3 }]]),
      textTurn("done"),
    ];
    await makeAgent().chat("vary it");
    expect(JSON.stringify(h.sentMessages)).not.toContain("RepetitionDetected");
  });
});

describe("Agent.chat deferred tools / tool_search", () => {
  afterEach(() => {
    unregisterToolsByPrefix("t_deferred");
  });

  it("hides deferred tools until tool_search exposes them", async () => {
    registerTool({
      name: "t_deferred",
      description: "hidden tool for testing",
      isReadOnly: true,
      deferred: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { content: "secret-work" };
      },
    });
    h.turns = [
      toolTurn([["t_deferred", {}]]),
      toolTurn([["tool_search", { query: "select:t_deferred" }]]),
      toolTurn([["t_deferred", {}]]),
      textTurn("done"),
    ];
    const out = await makeAgent().chat("go");
    expect(out).toBe("done");
    // Before exposure: absent from the tool list, calling it is refused.
    expect(h.sentTools[0]).not.toContain("t_deferred");
    expect(h.sentTools[0]).toContain("tool_search");
    expect(JSON.stringify(h.sentMessages[1].at(-1))).toContain("Call tool_search");
    expect(h.sentTools[1]).not.toContain("t_deferred");
    // After select: exposure the tool is listed and runs.
    expect(h.sentTools[2]).toContain("t_deferred");
    expect(JSON.stringify(h.sentMessages[3].at(-1))).toContain("secret-work");
  });
});

describe("Agent.chat background task delivery", () => {
  afterEach(() => {
    subagentTasks.reset();
  });

  it("delivers finished background task reports as a system-reminder", async () => {
    const id = subagentTasks.start("survey", "research", async () => "BG-REPORT-CONTENT");
    await subagentTasks.whenDone(id);
    h.turns = [textTurn("a")];
    const agent = makeAgent();
    await agent.chat("go");
    // The reminder joined the history before the first model call.
    const first = JSON.stringify(h.sentMessages[0]);
    expect(first).toContain("BackgroundTaskComplete");
    expect(first).toContain("BG-REPORT-CONTENT");
    // Delivered once: the follow-up turn's history contains the same single
    // reminder, with no duplicate injected.
    h.turns.push(textTurn("b"));
    await agent.chat("again");
    const count = (s: string) => (s.match(/BackgroundTaskComplete/g) ?? []).length;
    expect(count(JSON.stringify(h.sentMessages.at(-1)))).toBe(1);
  });
  it("delivers detached subagent replies as a SubagentMessage reminder", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const id = subagentTasks.start("long dig", "research", async () => {
      await gate;
      return "done";
    });
    expect(subagentTasks.queueReply(id, "early finding")).toBe(true);
    h.turns = [textTurn("a")];
    const agent = makeAgent();
    await agent.chat("go");
    const first = JSON.stringify(h.sentMessages[0]);
    expect(first).toContain("SubagentMessage");
    expect(first).toContain("early finding");
    // Delivered once: the follow-up turn has no duplicate.
    h.turns.push(textTurn("b"));
    await agent.chat("again");
    const count = (s: string) => (s.match(/SubagentMessage/g) ?? []).length;
    expect(count(JSON.stringify(h.sentMessages.at(-1)))).toBe(1);
    release();
    await subagentTasks.whenDone(id);
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

describe("Agent.compactNow (LLM-summary compaction)", () => {
  it("replaces old history with summary + ack + recent tail", async () => {
    const agent = makeAgent(undefined, seedHistory(10));
    h.turns = [textTurn("## Task\n- shipped the thing\n\n## Files\n- src/a.ts")];
    const events = { onCompacting: () => {}, onCompacted: vi.fn() };
    const did = await agent.compactNow(events);
    expect(did).toBe(true);

    const sent = h.sentMessages[0]; // summarizer call
    expect(sent).toHaveLength(1);
    expect(String(sent[0].content)).toContain("Summarize the agent transcript");
    expect(String(sent[0].content)).toContain("Q0");

    const after = agent.debugMessages();
    expect(after).toHaveLength(8); // summary + ack + last 6 seeded (Q7..A9)
    expect(String(after[0].content)).toContain("<context_compaction>");
    expect(String(after[0].content)).toContain("shipped the thing");
    expect(after[1].role).toBe("assistant");
    expect(String(after[2].content)).toContain("Q7"); // tail kept verbatim
    expect(String(after[after.length - 1].content)).toContain("A9");
    expect(events.onCompacted).toHaveBeenCalledOnce();
  });

  it("falls back to truncation when the summarizer call fails", async () => {
    const agent = makeAgent(undefined, seedHistory(10));
    // No scripted turns: the summarizer send() throws.
    const did = await agent.compactNow();
    expect(did).toBe(true);
    const after = agent.debugMessages();
    expect(after.length).toBeLessThan(20);
    expect(after.length).toBeGreaterThanOrEqual(2);
    // Truncation keeps whole exchanges: history still starts with a user msg.
    expect(after[0].role).toBe("user");
    // The newest exchange survived.
    expect(String(after[after.length - 1].content)).toContain("A9");
  });

  it("is a no-op for tiny histories", async () => {
    const agent = makeAgent(undefined, seedHistory(2));
    expect(await agent.compactNow()).toBe(false);
    expect(agent.debugMessages()).toHaveLength(4);
  });

  it("invalidates the token anchor so the estimate reflects the new history", async () => {
    const agent = makeAgent(undefined, seedHistory(10));
    h.turns = [textTurn("summary", 1, 1)];
    const before = agent.tokenEstimate();
    await agent.compactNow();
    expect(agent.tokenEstimate()).toBeLessThan(before);
  });
});

describe("Agent microcompact (prune-only pass at 0.70)", () => {
  it("prunes stale tool results without a summarizer call and protects the last 6", async () => {
    // 30k (old tool_result) + ~39k (6 filler msgs) + 2.5k (recent tool_result)
    // ≈ 72k tokens: above MICROCOMPACT_RATIO 0.70, below COMPACT_RATIO 0.75.
    const filler = "x".repeat(23_000);
    const messages: MessageParam[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "y".repeat(120_000) } as ContentBlock] },
      { role: "assistant", content: "done with the tool" },
      { role: "user", content: `q1 ${filler}` },
      { role: "assistant", content: `a1 ${filler}` },
      { role: "user", content: `q2 ${filler}` },
      { role: "assistant", content: `a2 ${filler}` },
      // Last 6 messages are protected: this big recent result must survive.
      { role: "user", content: [{ type: "tool_result", tool_use_id: "new", content: "z".repeat(10_000) } as ContentBlock] },
      { role: "assistant", content: `a3 ${filler}` },
      { role: "user", content: `q3 ${filler}` },
      { role: "assistant", content: `a4 ${filler}` },
    ];
    h.turns = [textTurn("ok")];
    const agent = makeAgent(undefined, messages);
    const before = agent.tokenEstimate();
    expect(before).toBeGreaterThan(70_000);
    expect(before).toBeLessThan(75_000);

    const compacted: Array<[number, number]> = [];
    await agent.chat("continue", undefined, { onCompacted: (b, a) => compacted.push([b, a]) });

    expect(h.calls).toBe(1); // one send only - no summarizer LLM call happened
    const sent = h.sentMessages[0];
    const oldResult = (sent[0].content as Array<Record<string, unknown>>)[0];
    const oldText = String(oldResult.content);
    expect(oldText.length).toBeLessThan(120_000);
    expect(oldText).toContain("chars of stale tool output pruned");
    // The protected recent tool result is untouched.
    const newResult = (sent[6].content as Array<Record<string, unknown>>)[0];
    expect(String(newResult.content)).toHaveLength(10_000);
    // No compaction summary message was prepended.
    expect(JSON.stringify(sent)).not.toContain("<context_compaction>");
    expect(compacted).toHaveLength(1);
    expect(compacted[0][0]).toBeGreaterThan(before);
    expect(compacted[0][0]).toBeLessThan(75_000);
    expect(compacted[0][1]).toBeLessThan(70_000);
  });

  it("does not prune when the estimate is below the microcompact threshold", async () => {
    h.turns = [textTurn("ok")];
    const agent = makeAgent();
    const compacted: Array<[number, number]> = [];
    await agent.chat("hello", undefined, { onCompacted: (b, a) => compacted.push([b, a]) });
    expect(compacted).toEqual([]);
    expect(agent.tokenEstimate()).toBeLessThan(70_000);
  });
});

describe("Agent auto-compact decision layer", () => {
  it("compacts below the raw threshold when the output reserve pushes the projection over", async () => {
    // 14 pairs ≈ 70.1k tokens: under the old 75k trigger but over
    // 75k - 8192 (fake model's maxOutput) ≈ 66.8k, so the reserve fires it.
    const agent = makeAgent(undefined, seedHistory(14));
    h.turns = [textTurn("## Task\n- handoff"), textTurn("ok")];
    await agent.chat("continue");
    expect(String(h.sentMessages[0][0].content)).toContain("Summarize the agent transcript");
    expect(String(agent.debugMessages()[0].content)).toContain("<context_compaction>");
    expect(agent.tokenEstimate()).toBeLessThan(66_808);
  });

  it("does not compact while the projection stays under the reserve-adjusted budget", async () => {
    // 13 pairs ≈ 65.1k: over nothing, under 66.8k.
    const agent = makeAgent(undefined, seedHistory(13));
    h.turns = [textTurn("ok")];
    await agent.chat("hello");
    expect(h.calls).toBe(1);
    expect(String(agent.debugMessages()[0].content)).not.toContain("<context_compaction>");
  });

  it("suspends auto-compact after three consecutive attempts without progress", async () => {
    // A giant single user message is one whole exchange that the truncateTo
    // fallback can never drop (only-exchange rule) and microcompact cannot
    // prune (it is not a tool_result), so every round's attempt leaves the
    // projection over budget.
    const huge = "x".repeat(320_000); // ≈ 80k tokens, window 100k
    h.turns = [textTurn("r1"), textTurn("r2"), textTurn("r3"), textTurn("r4")];
    const agent = makeAgent();
    const hookEvents: Array<[string, string]> = [];
    await agent.chat(huge, undefined, { onHook: (e, m) => hookEvents.push([e, m]) });
    await agent.chat(huge, undefined, { onHook: (e, m) => hookEvents.push([e, m]) });
    await agent.chat(huge, undefined, { onHook: (e, m) => hookEvents.push([e, m]) });
    await agent.chat(huge, undefined, { onHook: (e, m) => hookEvents.push([e, m]) });

    expect(h.calls).toBe(4);
    const suspends = hookEvents.filter(([, m]) => m.includes("auto-compact suspended"));
    expect(suspends).toHaveLength(2); // the breaker trip + the once-per-turn warning
    expect(suspends[0][1]).toContain("3 attempts failed");
    expect(suspends[1][1]).toContain("without progress");
  });

  it("a manual /compact resets the circuit breaker", async () => {
    const huge = "x".repeat(320_000);
    h.turns = [textTurn("r1"), textTurn("r2"), textTurn("r3"), textTurn("r4")];
    const agent = makeAgent();
    const tripEvents: Array<[string, string]> = [];
    for (let i = 0; i < 4; i++) await agent.chat(huge, undefined, { onHook: (e, m) => tripEvents.push([e, m]) });
    expect(tripEvents.some(([, m]) => m.includes("3 attempts failed"))).toBe(true);

    // compactNow (as /compact runs) resets the breaker by design, so the next
    // giant turn may attempt again - and only accumulates one more failure.
    // Giant turns keep the projection over budget, so every attempt may invoke
    // the summarizer; script generously and assert only the breaker behavior.
    h.turns = Array.from({ length: 10 }, (_, i) => textTurn(`out ${i}`));
    await agent.compactNow();
    const again: Array<[string, string]> = [];
    await agent.chat(huge, undefined, { onHook: (e, m) => again.push([e, m]) });
    await agent.chat(huge, undefined, { onHook: (e, m) => again.push([e, m]) });
    expect(again.every(([, m]) => !m.includes("auto-compact suspended"))).toBe(true);
  });
});

describe("Agent system prompt assembly", () => {
  it("lists available skills for progressive disclosure", async () => {
    h.turns = [textTurn("ok")];
    const agent = makeAgent();
    await agent.chat("go");
    expect(h.sentSystems[0]).toContain("<available_skills>");
    expect(h.sentSystems[0]).toContain("- fake-skill: does fake things");
  });

  it("includes the turn-completion contract and tool-gated guidance", async () => {
    h.turns = [textTurn("ok")];
    await makeAgent().chat("go");
    const sys = h.sentSystems[0];
    expect(sys).toContain("Completing a turn:");
    expect(sys).toContain("Shell (bash):");
    expect(sys).toContain("Editing files:");
    expect(sys).toContain("Subagents (task):");
    expect(sys).toContain("<session_status>");
    expect(sys).toContain("- Today:");
  });
});

describe("Agent system prompt tool gating", () => {
  it("omits guidance for tools the turn cannot call (plan mode)", async () => {
    h.turns = [textTurn("planning")];
    const agent = new Agent(process.cwd(), "test-session", { check: async () => true } as never);
    agent.planMode = true;
    await agent.chat("plan this");
    const sys = h.sentSystems[0];
    expect(sys).toContain("PLAN MODE is active");
    expect(sys).not.toContain("Shell (bash):");
    expect(sys).not.toContain("Editing files:");
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

  it("SessionStart stdout is injected into the system prompt for the whole session", async () => {
    const agent = makeAgent(hookManager("SessionStart", "ctx.js"));
    await agent.startSession("startup");
    h.turns = [textTurn("ok"), textTurn("ok2")];
    await agent.chat("go");
    await agent.chat("again");
    // Both turns see the hook context, not just the first.
    expect(h.sentSystems.at(-2)).toContain('<system-reminder event="SessionStart">');
    expect(h.sentSystems.at(-2)).toContain("extra context");
    expect(h.sentSystems.at(-1)).toContain("extra context");
  });

  it("PreCompact block cancels the compaction and leaves history untouched", async () => {
    const agent = makeAgent(hookManager("PreCompact", "block.js"), seedHistory(20));
    h.turns = [textTurn("done")];
    let compacting = false;
    const out = await agent.chat("go", undefined, { onCompacting: () => (compacting = true) });
    expect(out).toBe("done");
    expect(compacting).toBe(false); // never entered the compaction pipeline
    // 40 seeded + user + assistant: nothing was summarized away.
    expect(agent.debugMessages().length).toBe(42);
  });
});

describe("Agent.chat cost budget", () => {
  it("stops the turn when the budget is exhausted and backfills tool results", async () => {
    h.model = "claude-sonnet-4-5"; // priced: $15/M output
    const agent = makeAgent();
    agent.costs.budgetUsd = 0.5;
    // First turn asks for a tool; its output alone blows the budget.
    h.turns = [toolTurn([["t_parallel", { n: 1 }]], 0, 40_000)]; // 40k*15/M = $0.60
    const warnings: string[] = [];
    const out = await agent.chat("go", undefined, { onCostWarning: (m) => warnings.push(m) });
    expect(warnings.join("\n")).toContain("exhausted");
    expect(out).toContain("[stopped:");
    // The tool never ran; its tool_use still got an error tool_result so the
    // history stays valid for the next request.
    const history = agent.debugMessages();
    const last = history[history.length - 1].content as Array<{ type: string; is_error?: boolean; content: string }>;
    expect(last[0].type).toBe("tool_result");
    expect(last[0].is_error).toBe(true);
    expect(last[0].content).toContain("budget is exhausted");
    // Only one LLM call happened.
    expect(h.calls).toBe(1);
  });

  it("records usage into the session cost snapshot", async () => {
    h.model = "claude-sonnet-4-5";
    const agent = makeAgent();
    h.turns = [textTurn("hi", 1000, 200)];
    await agent.chat("hello");
    const snap = agent.costs.snapshot();
    expect(snap.byModel["anthropic:claude-sonnet-4-5"].requests).toBe(1);
    expect(snap.totalUsd).toBeCloseTo((1000 * 3 + 200 * 15) / 1e6, 8);
  });
});

describe("Agent plan mode", () => {
  function agentWithPermissions(check: (...args: unknown[]) => Promise<boolean>) {
    const a = new Agent(process.cwd(), "test-session", { check } as never);
    a.planMode = true;
    return a;
  }

  it("offers only read-only tools plus exit_plan and injects plan rules", async () => {
    h.turns = [textTurn("planning"), textTurn("planning again")];
    await makeAgent().chat("x"); // baseline (normal mode)
    const baselineTools = h.sentTools[h.sentTools.length - 1];
    h.calls = 0;
    h.sentTools = [];
    h.sentSystems = [];
    const agent = agentWithPermissions(async () => true);
    await agent.chat("plan this");
    const sent = h.sentTools[0];
    expect(sent).toContain("exit_plan");
    expect(sent).toContain("read_file");
    expect(sent).not.toContain("edit_file");
    expect(sent).not.toContain("write_file");
    expect(sent).not.toContain("bash");
    expect(sent).not.toContain("git_commit");
    expect(h.sentSystems[0]).toContain("PLAN MODE is active");
    // The baseline normal-mode call did have write tools.
    expect(baselineTools).toContain("edit_file");
    expect(baselineTools).not.toContain("exit_plan");
  });

  it("runTool blocks a write tool called during plan mode", async () => {
    h.turns = [toolTurn([["t_serial", { n: 1 }]]), textTurn("ok")];
    const agent = agentWithPermissions(async () => true);
    await agent.chat("go");
    const blocked = lastSentContent()[0] as { content: string; is_error?: boolean };
    expect(blocked.is_error).toBe(true);
    expect(blocked.content).toContain("plan mode is active");
    expect(toolEvents).not.toContain("s-run 1"); // never executed
  });

  it("exit_plan approval leaves plan mode and notifies events", async () => {
    h.turns = [toolTurn([["exit_plan", { plan: "1. edit src/a.ts" }]]), textTurn("executing")];
    const approved: unknown[][] = [];
    let planApprovedEvents = 0;
    const agent = agentWithPermissions(async (desc, _risk, _readOnly, preview) => {
      approved.push([desc, preview]);
      return true;
    });
    const out = await agent.chat("go", undefined, { onPlanApproved: () => planApprovedEvents++ });
    expect(out).toBe("executing");
    expect(agent.planMode).toBe(false);
    expect(planApprovedEvents).toBe(1);
    expect(approved[0][0]).toContain("Execute this plan");
    expect(String(approved[0][1])).toContain("edit src/a.ts");
    const result = lastSentContent()[0] as { content: string };
    expect(result.content).toContain("Plan approved");
  });

  it("exit_plan rejection keeps plan mode", async () => {
    h.turns = [toolTurn([["exit_plan", { plan: "bad plan" }]]), textTurn("revising")];
    const agent = agentWithPermissions(async () => false);
    await agent.chat("go");
    expect(agent.planMode).toBe(true);
    const result = lastSentContent()[0] as { content: string; is_error?: boolean };
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("rejected the plan");
  });

  it("normal mode can use write tools again after the plan is approved", async () => {
    h.turns = [
      toolTurn([["exit_plan", { plan: "do it" }]]),
      toolTurn([["t_serial", { n: 7 }]]),
      textTurn("finished"),
    ];
    const agent = agentWithPermissions(async () => true);
    await agent.chat("go");
    expect(agent.planMode).toBe(false);
    expect(toolEvents).toContain("s-run 7");
  });
});

describe("Agent.fork", () => {
  it("branches the history into a new session and keeps working there", async () => {
    const history: MessageParam[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const agent = makeAgent(undefined, history);
    const id = await agent.fork(4);
    expect(id).toBe("fork0000");
    expect(agent.sessionId).toBe("fork0000");
    expect(agent.getMessages()).toHaveLength(4);
    // The next turn persists to the fork, not the original.
    h.turns = [textTurn("next")];
    h.calls = 0;
    await agent.chat("continue");
    expect(agent.getMessages()).toHaveLength(6);
  });

  it("rounds a mid-loop keep back to a clean assistant boundary", async () => {
    const history: MessageParam[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" }, // index 1 - the last clean assistant turn
      { role: "user", content: "q2" },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "x", input: {} } as ContentBlock] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "r" } as ContentBlock] },
    ];
    const agent = makeAgent(undefined, history);
    // keep 5 would end on a dangling tool_use; walk back over it and the
    // preceding user turn to index 1, so only the first exchange is kept.
    const id = await agent.fork(5);
    expect(id).toBe("fork0000");
    expect(agent.getMessages()).toHaveLength(2);
  });

  it("returns null when no clean boundary exists", async () => {
    const agent = makeAgent(undefined, [{ role: "user", content: "q1" }]);
    expect(await agent.fork(1)).toBeNull();
    expect(agent.sessionId).toBe("test-session"); // unchanged
  });
});

describe("todo list lifecycle", () => {
  const items = [
    { id: "1", content: "first", status: "completed" as const },
    { id: "2", content: "second", status: "in_progress" as const },
  ];

  beforeEach(() => {
    todoStore.items = [];
  });
  afterEach(() => {
    todoStore.items = [];
  });

  it("restores the plan handed to a session start", async () => {
    const agent = makeAgent();
    await agent.startSession("startup", undefined, items);
    expect(agent.currentTodos()).toEqual(items);
  });

  it("drops the previous job's plan when a session starts without one", async () => {
    todoStore.items = [...items];
    const agent = makeAgent();
    await agent.startSession("startup");
    expect(agent.currentTodos()).toEqual([]);
  });

  it("restores the plan handed to resetSession", async () => {
    const agent = makeAgent();
    todoStore.items = [...items];
    await agent.resetSession("another-session", undefined, undefined, items);
    expect(agent.currentTodos()).toEqual(items);
  });

  it("persists a successful todo_write to the session", async () => {
    const agent = makeAgent();
    h.turns = [toolTurn([["todo_write", { todos: items }]]), textTurn("done")];
    h.savedTodos = [];
    await agent.chat("plan");
    expect(h.savedTodos).toEqual([{ id: "test-session", todos: items }]);
  });

  it("keeps the plan across a fork, which continues the same job", async () => {
    const history: MessageParam[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const agent = makeAgent(undefined, history);
    todoStore.items = [...items];
    await agent.fork(2);
    expect(agent.sessionId).toBe("fork0000");
    expect(agent.currentTodos()).toEqual(items);
  });
});

describe("Agent mid-turn steering", () => {
  it("delivers input queued during a tool call at the next round boundary", async () => {
    let target: InstanceType<typeof Agent> | null = null;
    registerTool({
      name: "t_steer_trigger",
      description: "test",
      isReadOnly: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        expect(target!.steer("prefer the blue module")).toBe(true);
        return { content: "steered" };
      },
    });
    const agent = makeAgent();
    target = agent;
    const queued: string[] = [];
    agent.onSteerQueued = (text) => queued.push(text);

    h.turns = [toolTurn([["t_steer_trigger", {}]]), textTurn("going blue")];
    const out = await agent.chat("go");
    expect(out).toBe("going blue");
    expect(queued).toEqual(["prefer the blue module"]);
    // The steered message joined the history before the second model round.
    const second = h.sentMessages[1];
    expect(second[second.length - 1]).toMatchObject({ role: "user", content: [{ type: "text", text: "prefer the blue module" }] });
  });

  it("continues the turn when steering lands while the model is writing", async () => {
    // Steer during the model's final round (no tool uses): the queued input
    // must keep the turn alive instead of being left for the next one.
    const agent = makeAgent();
    let sends = 0;
    h.onSend = () => {
      if (++sends === 1) agent.steer("one more thing");
    };

    h.turns = [textTurn("first answer"), textTurn("second answer")];
    const out = await agent.chat("go");
    expect(out).toBe("first answersecond answer");
    expect(h.calls).toBe(2);
  });

  it("refuses to queue when no turn is running", () => {
    expect(makeAgent().steer("hi")).toBe(false);
  });
});

describe("subagent permission wiring", () => {
  it("asks the real permission layer for worker subagents (no read-only shortcut)", async () => {
    const calls: Array<{ desc: string; readOnly: boolean }> = [];
    const perms = {
      check: async (desc: string, _risk: string, readOnly: boolean) => {
        calls.push({ desc, readOnly });
        return false;
      },
    } as never;
    const agent = new Agent(process.cwd(), "test-session", perms, undefined, undefined);
    h.turns = [
      toolTurn([["task", { description: "impl", prompt: "edit x", mode: "worker" }]]),
      textTurn("declined"),
    ];
    await agent.chat("go");
    const spawn = calls.find((c) => c.desc.includes("WRITING subagent"));
    expect(spawn).toBeTruthy();
    expect(spawn!.readOnly).toBe(false);
  });
});

describe("cancelled-stream salvage", () => {
  it("persists the partial streamed text when the user aborts mid-stream", async () => {
    h.appended = [];
    h.onSend = () => {
      throw new CancelledStreamError("partial answer survived");
    };
    const a = makeAgent();
    await expect(a.chat("hi")).rejects.toThrow("aborted");
    const asst = h.appended.find((m) => m.role === "assistant");
    expect(asst).toBeDefined();
    expect(JSON.stringify(asst!.content)).toContain("partial answer survived");
    expect(h.appended.some((m) => m.role === "user")).toBe(true);

    // A blank partial salvages nothing: history keeps only the user turn.
    h.appended = [];
    h.onSend = () => {
      throw new CancelledStreamError("");
    };
    const b = makeAgent();
    await expect(b.chat("hi")).rejects.toThrow("aborted");
    expect(h.appended.some((m) => m.role === "assistant")).toBe(false);
    h.onSend = null;
  });
});
