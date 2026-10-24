import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeAllNodeRepl, disposeNodeReplSession, nodeReplTool } from "../src/tools/nodeRepl.js";

function makeCtx(sessionId: string, opts: { allow?: boolean; signal?: AbortSignal } = {}) {
  const askPermission = vi.fn(async () => opts.allow !== false);
  return {
    ctx: { cwd: process.cwd(), sessionId, askPermission, signal: opts.signal } as never,
    askPermission,
  };
}

async function run(sessionId: string, code: string, extra: Record<string, unknown> = {}) {
  const { ctx } = makeCtx(sessionId);
  return nodeReplTool.execute({ code, ...extra }, ctx);
}

afterEach(() => {
  disposeAllNodeRepl();
});

describe("node_repl", () => {
  it("keeps top-level bindings across calls in one session", async () => {
    const first = await run("repl-persist", "const x = 41; let steps = 1; x + 1");
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain("=> 42");

    const second = await run("repl-persist", "steps += 1; x + steps");
    expect(second.content).toContain("=> 43");
  });

  it("returns logs and the final expression together", async () => {
    const result = await run("repl-logs", 'console.log("loading"); console.log(2); 2 + 2');
    expect(result.content).toContain("loading");
    expect(result.content).toContain("=> 4");
  });

  it("reports errors but keeps the bindings declared before them", async () => {
    const failed = await run("repl-error", 'const keep = 5; throw new Error("boom")');
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("Error: boom");

    const after = await run("repl-error", "keep");
    expect(after.content).toContain("=> 5");
  });

  it("supports top-level await for a single expression", async () => {
    const result = await run("repl-await", "await Promise.resolve(7)");
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("=> 7");
  });

  it("keeps globalThis state from multi-statement async code", async () => {
    const first = await run("repl-await-state", "globalThis.later = await Promise.resolve(9); later");
    expect(first.isError).toBeFalsy();
    const second = await run("repl-await-state", "later * 2");
    expect(second.content).toContain("=> 18");
  });

  it("exposes require for Node modules", async () => {
    const result = await run("repl-require", 'const os = require("node:os"); typeof os.platform()');
    expect(result.content).toContain("'string'");
  });

  it("isolates kernels by session", async () => {
    await run("repl-a", "const privateValue = 1");
    const other = await run("repl-b", "typeof privateValue");
    expect(other.content).toContain("'undefined'");
    const same = await run("repl-a", "privateValue");
    expect(same.content).toContain("=> 1");
  });

  it("serializes concurrent calls in one session", async () => {
    const { ctx } = makeCtx("repl-serial");
    const first = nodeReplTool.execute({ code: "const order = 1" }, ctx);
    const second = nodeReplTool.execute({ code: "order + 1" }, ctx);
    const [, after] = await Promise.all([first, second]);
    expect(after.content).toContain("=> 2");
  });

  it("restarts with fresh state after a timeout", async () => {
    await run("repl-timeout", "const mark = 1");
    const timedOut = await run("repl-timeout", "while (true) {}", { timeout_ms: 1_000 });
    expect(timedOut.isError).toBe(true);
    expect(timedOut.content).toContain("timed out");
    expect(timedOut.content).toContain("state was lost");

    const after = await run("repl-timeout", "typeof mark");
    expect(after.content).toContain("'undefined'");
  });

  it("restarts with fresh state after an abort", async () => {
    const controller = new AbortController();
    const { ctx } = makeCtx("repl-abort", { signal: controller.signal });
    const pending = nodeReplTool.execute({ code: "await new Promise(() => {})" }, ctx);
    setTimeout(() => controller.abort(), 200);
    const aborted = await pending;
    expect(aborted.isError).toBe(true);
    expect(aborted.content).toContain("aborted");

    const after = await run("repl-abort", "1 + 1");
    expect(after.content).toContain("=> 2");
  });

  it("asks for high-risk approval and stops when rejected", async () => {
    const { ctx, askPermission } = makeCtx("repl-deny", { allow: false });
    const result = await nodeReplTool.execute({ code: "1 + 1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
    expect(askPermission).toHaveBeenCalledWith(
      expect.stringContaining("arbitrary code execution"),
      "high",
      "1 + 1",
    );
  });

  it("stops an idle kernel and starts fresh on the next call", async () => {
    process.env.AGENT_REPL_IDLE_MS = "120";
    try {
      await run("repl-idle", "const idleMark = 1");
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Under heavy load the idle timer can fire mid-call, which surfaces as
      // "kernel was stopped"; the tool's contract is to retry, so do that once.
      let after = await run("repl-idle", "typeof idleMark");
      if (!after.content.includes("'undefined'")) {
        after = await run("repl-idle", "typeof idleMark");
      }
      expect(after.content).toContain("'undefined'");
    } finally {
      delete process.env.AGENT_REPL_IDLE_MS;
    }
  });

  it("drops state when the session kernel is disposed", async () => {
    await run("repl-dispose", "const gone = 1");
    disposeNodeReplSession("repl-dispose");
    const after = await run("repl-dispose", "typeof gone");
    expect(after.content).toContain("'undefined'");
  });

  it("bounds huge output and points at the saved full text", async () => {
    const result = await run("repl-output", 'console.log("x".repeat(100000))', { max_output: 1_000 });
    expect(result.content.length).toBeLessThan(5_000);
    expect(result.content).toContain("characters omitted");
    expect(result.content).toContain("saved to");
  });

  it("truncates an oversized single value without losing the kernel", async () => {
    const result = await run("repl-value", 'Array.from({ length: 100 }, () => "x".repeat(20000))', {
      max_output: 200_000,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("[... value truncated]");
    expect(result.content.length).toBeLessThan(150_000);
    const after = await run("repl-value", "1 + 1");
    expect(after.content).toContain("=> 2");
  });

  it("caps a stderr flood and restarts the kernel", async () => {
    const flooded = await run("repl-stderr", 'console.error("e".repeat(300000))');
    expect(flooded.isError).toBe(true);
    expect(flooded.content).toContain("stderr exceeded");
    const after = await run("repl-stderr", "2 + 2");
    expect(after.content).toContain("=> 4");
  });

  it("caps a stdout line with no newline and restarts the kernel", async () => {
    const flooded = await run("repl-line", 'process.stdout.write("y".repeat(300000))');
    expect(flooded.isError).toBe(true);
    expect(flooded.content).toContain("without a line break");
    const after = await run("repl-line", "3 + 3");
    expect(after.content).toContain("=> 6");
  });
});
