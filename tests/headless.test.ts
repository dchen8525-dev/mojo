import { describe, expect, it } from "vitest";
import { createNdjsonEvents } from "../src/headless.js";
import { parseArgs } from "../src/cliArgs.js";

function collect() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

describe("headless NDJSON contract", () => {
  it("emits system/init first with session identity", () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s1", cwd: "C:\\tmp", permissionMode: "auto", planMode: false }, write);
    expect(lines).toHaveLength(0);
    h.init("deepseek:deepseek-chat");
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]);
    expect(e).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "s1",
      cwd: "C:\\tmp",
      model: "deepseek:deepseek-chat",
      permission_mode: "auto",
      plan_mode: false,
    });
    expect(typeof e.ts).toBe("string");
  });

  it("maps every agent event onto a typed line", () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s", cwd: "c", permissionMode: "default", planMode: false }, write);
    h.init("m");

    h.events.onRoundStart?.(2);
    h.events.onTextDelta?.("he");
    h.events.onTextDelta?.("llo");
    h.events.onThinkingDelta?.("hmm");
    h.events.onToolStart?.("t1", "bash", "npm test", { command: "npm test" });
    h.events.onToolStart?.("t2", "read_file", "a.txt");
    h.events.onToolEnd?.("t1", "bash", true, "ok (2s)");
    h.events.onSubTool?.("t3", "grep", "pattern", false, "boom", 3);
    h.events.onUsage?.(120, 45);
    h.events.onCompacting?.();
    h.events.onCompacted?.(900, 400);
    h.events.onRetry?.({ attempt: 2, maxAttempts: 5, delayMs: 1500, reason: "server", status: 502 });
    h.events.onRetry?.({ attempt: 3, maxAttempts: 5, delayMs: 200, reason: "timeout" });
    h.events.onStreamRecovery?.({
      attempt: 1,
      maxAttempts: 4,
      mode: "restart",
      discardedChars: 12,
      delayMs: 500,
      reason: "connection",
    });
    h.events.onCostWarning?.("over budget");
    h.events.onHook?.("PostToolUse", "done");
    h.events.onGoalChanged?.(
      {
        objective: "ship the release",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 1_200,
        continuations: 2,
        maxContinuations: 6,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        nextAction: "run the tests",
      },
      "continuing toward the goal (2/6)",
    );
    h.events.onGoalChecking?.();
    h.events.onPlanApproved?.();

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.type)).toEqual([
      "system",
      "round_start",
      "text_delta",
      "text_delta",
      "thinking_delta",
      "tool_start",
      "tool_start",
      "tool_end",
      "sub_tool",
      "usage",
      "compacting",
      "compacted",
      "retry",
      "retry",
      "stream_recovery",
      "cost_warning",
      "hook",
      "goal_changed",
      "goal_checking",
      "plan_approved",
    ]);
    expect(parsed[5]).toMatchObject({ type: "tool_start", id: "t1", name: "bash", input_preview: "npm test", input: { command: "npm test" } });
    expect(parsed[6]).not.toHaveProperty("input");
    expect(parsed[7]).toMatchObject({ type: "tool_end", id: "t1", name: "bash", ok: true, preview: "ok (2s)" });
    expect(parsed[8]).toMatchObject({ type: "sub_tool", parent_id: "t3", name: "grep", ok: false, round: 3 });
    expect(parsed[8].input_preview).toBe("pattern");
    expect(parsed[9]).toEqual({ ts: expect.any(String), type: "usage", input: 120, output: 45 });
    expect(parsed[12]).toMatchObject({ type: "retry", attempt: 2, max_attempts: 5, delay_ms: 1500, reason: "server", status: 502 });
    expect(parsed[13]).not.toHaveProperty("status");
    expect(parsed[14]).toMatchObject({
      type: "stream_recovery",
      attempt: 1,
      max_attempts: 4,
      mode: "restart",
      discarded_chars: 12,
      delay_ms: 500,
      reason: "connection",
    });
    expect(parsed[17]).toMatchObject({
      type: "goal_changed",
      note: "continuing toward the goal (2/6)",
      goal: {
        objective: "ship the release",
        status: "active",
        token_budget: 50_000,
        tokens_used: 1_200,
        continuations: 2,
        max_continuations: 6,
        next_action: "run the tests",
      },
    });
    expect(parsed[18]).toMatchObject({ type: "goal_checking" });
  });

  it("emits null for a cleared goal", () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s", cwd: "c", permissionMode: "default", planMode: false }, write);
    h.events.onGoalChanged?.(null, "goal cleared");
    const e = JSON.parse(lines[0]);
    expect(e).toEqual({ ts: expect.any(String), type: "goal_changed", goal: null, note: "goal cleared" });
  });

  it("wraps permission asks so decisions are observable", async () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s", cwd: "c", permissionMode: "default", planMode: false }, write);
    h.init("m");
    const decision = await h.wrapPermission(async (desc) => {
      expect(desc).toBe("write src/x.ts");
      return "session";
    })("write src/x.ts", "medium", "@@ -1 +1 @@");
    expect(decision).toBe("session");
    const e = JSON.parse(lines[lines.length - 1]);
    expect(e).toMatchObject({ type: "permission", description: "write src/x.ts", risk: "medium", decision: "session" });
  });

  it("ends the stream with exactly one result line carrying turn stats", () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s", cwd: "c", permissionMode: "default", planMode: false }, write);
    h.init("m");
    h.result("success", "All done.", { durationMs: 4200, tokens: 3100, costUsd: 0.0123, provider: "deepseek", model: "deepseek-chat" });
    h.result("error", "", { durationMs: 10, tokens: 0, costUsd: 0, provider: "deepseek", model: "deepseek-chat" });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[1]).toMatchObject({
      type: "result",
      subtype: "success",
      text: "All done.",
      duration_ms: 4200,
      tokens: 3100,
      cost_usd: 0.0123,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(parsed[2].subtype).toBe("error");
    expect(parsed.filter((e) => e.type === "result")).toHaveLength(2);
  });

  it("keeps stdout JSON-only: every line parses and carries a timestamp", () => {
    const { lines, write } = collect();
    const h = createNdjsonEvents({ sessionId: "s", cwd: "c", permissionMode: "default", planMode: false }, write);
    h.init("m");
    h.events.onToolEnd?.("t", "bash", false, "multi\nline\npreview");
    h.result("aborted", "", { durationMs: 1, tokens: 0, costUsd: 0, provider: "p", model: "m" });
    for (const line of lines) {
      const e = JSON.parse(line); // throws on non-JSON noise
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(line).not.toContain("\n");
    }
  });
});

describe("cliArgs --output-format", () => {
  it("defaults to text and accepts stream-json", () => {
    expect(parseArgs([]).outputFormat).toBe("text");
    expect(parseArgs(["-p", "hi", "--output-format", "stream-json"]).outputFormat).toBe("stream-json");
    expect(parseArgs(["--output-format", "text"]).outputFormat).toBe("text");
  });

  it("passes unknown values through for cli-level validation", () => {
    expect(parseArgs(["--output-format", "yaml"]).outputFormat).toBe("yaml");
    expect(parseArgs(["--output-format"]).outputFormat).toBe("text");
  });
});
