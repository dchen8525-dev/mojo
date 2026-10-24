import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killTree } from "./background.js";
import { boundedResult } from "../artifacts.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { num, str } from "./utils.js";

/**
 * A persistent JavaScript kernel per session. The kernel is a separate Node
 * process (so a crash, `process.exit()` or a runaway loop cannot take the
 * agent down) that evaluates each call with vm.runInThisContext, which keeps
 * top-level const/let/function/class bindings alive between calls.
 *
 * Protocol: one JSON request per line on stdin; results come back as a single
 * sentinel-prefixed line on stdout. Everything else the program prints is
 * captured as logs and returned to the model.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 30_000;
/** Streamed output beyond this kills the kernel instead of buffering forever. */
const HARD_OUTPUT_CAP = 200_000;
const DEFAULT_IDLE_MS = 10 * 60_000;

const WORKER_SOURCE = String.raw`
const vm = require("node:vm");
const util = require("node:util");
const { createRequire } = require("node:module");
const TOKEN = process.env.NODE_REPL_TOKEN || "";
const MARKER = "\u0001NODE_REPL:" + TOKEN + ":";
const send = (msg) => process.stdout.write("\n" + MARKER + JSON.stringify(msg) + "\n");
process.stdout.on("error", () => process.exit(0));
globalThis.require = createRequire(process.cwd() + "/");
// One inspected value can dwarf every log line combined (nested arrays of long
// strings), and it travels as a single protocol line. Bound it at the source.
const MAX_VALUE_CHARS = 100000;
const formatValue = (v) => {
  if (v === undefined) return "";
  let text;
  try {
    text = util.inspect(v, { depth: 3, maxArrayLength: 100, maxStringLength: 20000, breakLength: 100 });
  } catch {
    text = String(v);
  }
  return text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) + "\n[... value truncated]" : text;
};
const formatError = (e) => {
  if (e && typeof e === "object") {
    return {
      name: String(e.name || "Error"),
      message: String(e.message === undefined ? e : e.message),
      stack: typeof e.stack === "string" ? e.stack : "",
    };
  }
  return { name: "Error", message: String(e), stack: "" };
};
process.on("unhandledRejection", (e) => process.stderr.write("[unhandled rejection] " + formatError(e).message + "\n"));
process.on("uncaughtException", (e) => process.stderr.write("[uncaught exception] " + formatError(e).message + "\n"));
async function execute(msg) {
  try {
    let value;
    let script;
    try {
      script = new vm.Script(msg.code, { filename: "node_repl.js" });
    } catch (e) {
      if (!(e instanceof SyntaxError) || !/only valid in async functions/.test(e.message)) throw e;
      // Top-level await: prefer an expression wrapper so the final value is
      // still returned; multi-statement async code falls back to a body.
      let expression = null;
      try {
        expression = new vm.Script("(async () => (\n" + msg.code + "\n))()", { filename: "node_repl.js" });
      } catch {
        expression = null;
      }
      if (expression) {
        value = await expression.runInThisContext();
      } else {
        const statements = new vm.Script("(async () => {\n" + msg.code + "\n})()", { filename: "node_repl.js" });
        await statements.runInThisContext();
        value = undefined;
      }
    }
    if (script) value = script.runInThisContext();
    if (value && typeof value.then === "function") value = await value;
    send({ id: msg.id, ok: true, result: formatValue(value) });
  } catch (e) {
    send({ id: msg.id, ok: false, error: formatError(e) });
  }
}
let chain = Promise.resolve();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const id = msg && msg.id;
    chain = chain.then(() => execute(msg)).catch((e) => {
      try {
        send({ id: id, ok: false, error: formatError(e) });
      } catch {}
    });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface KernelError {
  name: string;
  message: string;
  stack?: string;
}

interface KernelResult {
  ok: boolean;
  result?: string;
  error?: KernelError;
  logs: string[];
  stderr: string[];
}

interface Pending {
  id: number;
  logs: string[];
  stderr: string[];
  chars: number;
  errChars: number;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (result: KernelResult) => void;
}

class NodeReplKernel {
  private child?: ChildProcessWithoutNullStreams;
  private marker = "";
  private outBuf = "";
  private errBuf = "";
  private nextId = 1;
  private pending?: Pending;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly idleMs: number,
    private readonly onIdle: () => void,
  ) {}

  exec(code: string, timeoutMs: number, signal?: AbortSignal): Promise<KernelResult> {
    // Serialize calls: the kernel has one global scope, so concurrent writes
    // would interleave output and completions.
    const run = () => this.runOnce(code, timeoutMs, signal);
    const promise = this.chain.then(run, run);
    this.chain = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.failPending("The Node kernel was stopped; its state was cleared.");
    this.restartKernel();
  }

  private spawnKernel(): ChildProcessWithoutNullStreams {
    const token = randomBytes(8).toString("hex");
    this.marker = `\u0001NODE_REPL:${token}:`;
    const child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
      cwd: this.cwd,
      env: { ...process.env, NODE_REPL_TOKEN: token },
      windowsHide: true,
      // POSIX needs its own group so killTree can stop the whole tree.
      detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdin.on("error", () => {
      /* EPIPE when the kernel dies mid-request; the request path reports it */
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("error", (err) => {
      if (this.child === child) {
        this.child = undefined;
        this.failPending(`Failed to start the Node kernel: ${err.message}`);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failPending(
        `The Node kernel exited unexpectedly (code ${code ?? "?"}${signal ? `, ${signal}` : ""}); ` +
          "it will restart with fresh state on the next call.",
      );
    });
    this.touch();
    return child;
  }

  private ensureKernel(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error("The Node kernel was disposed");
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) return child;
    return this.spawnKernel();
  }

  private runOnce(code: string, timeoutMs: number, signal?: AbortSignal): Promise<KernelResult> {
    if (signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: { name: "AbortError", message: "Execution aborted; the Node kernel was not started." },
        logs: [],
        stderr: [],
      });
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureKernel();
    } catch (err) {
      return Promise.resolve({
        ok: false,
        error: { name: "Error", message: err instanceof Error ? err.message : String(err) },
        logs: [],
        stderr: [],
      });
    }
    const id = this.nextId++;
    return new Promise<KernelResult>((resolve) => {
      const timer = setTimeout(() => {
        this.failPending(
          `Execution timed out after ${timeoutMs}ms; the Node kernel was restarted and its state was lost.`,
        );
        this.restartKernel();
      }, timeoutMs);
      const onAbort = () => {
        this.failPending("Execution aborted; the Node kernel was restarted and its state was lost.");
        this.restartKernel();
      };
      this.pending = { id, logs: [], stderr: [], chars: 0, errChars: 0, timer, signal, onAbort, resolve };
      signal?.addEventListener("abort", onAbort, { once: true });
      // spawnKernel re-armed the idle timer; a request is now in flight, so it
      // must not fire mid-execution on a loaded machine.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      try {
        child.stdin.write(JSON.stringify({ id, code }) + "\n");
      } catch (err) {
        this.failPending(`Failed to send code to the Node kernel: ${err instanceof Error ? err.message : String(err)}`);
        this.restartKernel();
      }
    });
  }

  private onStdout(chunk: string): void {
    this.outBuf += chunk;
    for (;;) {
      const nl = this.outBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.outBuf.slice(0, nl);
      this.outBuf = this.outBuf.slice(nl + 1);
      if (line.startsWith(this.marker)) {
        let msg: { id?: number; ok?: boolean; result?: string; error?: KernelError };
        try {
          msg = JSON.parse(line.slice(this.marker.length));
        } catch {
          continue;
        }
        const pending = this.pending;
        if (!pending || msg.id !== pending.id) continue;
        this.settlePending();
        pending.resolve({
          ok: !!msg.ok,
          result: typeof msg.result === "string" ? msg.result : "",
          error: msg.error,
          logs: pending.logs,
          stderr: pending.stderr,
        });
        this.touch();
      } else if (line.length) {
        this.pushLog(line);
      }
    }
    if (this.outBuf.length > HARD_OUTPUT_CAP) {
      this.onOverflow(
        `Output exceeded ${HARD_OUTPUT_CAP.toLocaleString()} chars without a line break; the Node kernel was restarted.`,
      );
    }
  }

  private onStderr(chunk: string): void {
    this.errBuf += chunk;
    for (;;) {
      const nl = this.errBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.errBuf.slice(0, nl);
      this.errBuf = this.errBuf.slice(nl + 1);
      const pending = this.pending;
      if (!line.length || !pending) continue;
      pending.stderr.push(line);
      pending.errChars += line.length + 1;
      if (pending.errChars > HARD_OUTPUT_CAP) {
        this.onOverflow(
          `stderr exceeded ${HARD_OUTPUT_CAP.toLocaleString()} chars; the Node kernel was restarted. ` +
            "Write less to stderr (filter or summarize in code).",
        );
        return;
      }
    }
    if (this.errBuf.length > HARD_OUTPUT_CAP) {
      this.onOverflow(
        `stderr exceeded ${HARD_OUTPUT_CAP.toLocaleString()} chars; the Node kernel was restarted. ` +
          "Write less to stderr (filter or summarize in code).",
      );
    }
  }

  /**
   * Bound the stream buffers. With a request in flight this fails it and
   * restarts the kernel; without one (late output from an async task), the
   * buffer is dropped so a background spammer cannot grow it forever.
   */
  private onOverflow(message: string): void {
    if (this.pending) {
      this.failPending(message);
      this.restartKernel();
      return;
    }
    this.outBuf = "";
    this.errBuf = "";
  }

  private pushLog(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    pending.logs.push(line);
    pending.chars += line.length + 1;
    if (pending.chars > HARD_OUTPUT_CAP) {
      this.failPending(
        `Output exceeded ${HARD_OUTPUT_CAP.toLocaleString()} chars; the Node kernel was restarted. ` +
          "Write less to stdout (filter or summarize in code).",
      );
      this.restartKernel();
    }
  }

  private settlePending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private failPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.settlePending();
    pending.resolve({ ok: false, error: { name: "Error", message }, logs: pending.logs, stderr: pending.stderr });
  }

  private restartKernel(): void {
    const child = this.child;
    this.child = undefined;
    this.outBuf = "";
    this.errBuf = "";
    if (child) killTree(child, process.platform === "win32");
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleMs <= 0 || this.pending) return;
    this.idleTimer = setTimeout(() => {
      this.dispose();
      this.onIdle();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}

const kernels = new Map<string, NodeReplKernel>();

function idleMs(): number {
  const raw = Number(process.env.AGENT_REPL_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_IDLE_MS;
}

function timeoutDefault(): number {
  const raw = Number(process.env.AGENT_REPL_TIMEOUT_MS);
  const n = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

function kernelKey(ctx: ToolContext): string {
  return ctx.sessionId ? `session:${ctx.sessionId}` : `cwd:${ctx.cwd}`;
}

/** Stop the kernel owned by a session (session reset/clear/fork). */
export function disposeNodeReplSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  const key = `session:${sessionId}`;
  const kernel = kernels.get(key);
  if (!kernel) return;
  kernel.dispose();
  kernels.delete(key);
}

/** Stop every kernel; used by tests and process exit. */
export function disposeAllNodeRepl(): void {
  for (const kernel of kernels.values()) kernel.dispose();
  kernels.clear();
}

process.once("exit", () => {
  try {
    disposeAllNodeRepl();
  } catch {
    // best-effort cleanup during shutdown
  }
});

function formatStack(error: KernelError): string {
  if (!error.stack) return "";
  const lines = error.stack.split("\n").slice(1);
  const useful = lines.filter((line) => !line.includes("node:internal") && !line.includes("node_repl.js"));
  return useful.slice(0, 8).join("\n");
}

function render(result: KernelResult, maxOutput: number): string {
  const parts: string[] = [];
  if (result.logs.length) parts.push(result.logs.join("\n"));
  if (result.ok) {
    if (result.result) parts.push(`=> ${result.result}`);
    if (result.stderr.length) parts.push(`[stderr]\n${result.stderr.join("\n")}`);
    if (!parts.length) parts.push("(no output)");
  } else {
    if (result.stderr.length) parts.push(`[stderr]\n${result.stderr.join("\n")}`);
    const error = result.error;
    if (error) {
      const head = `${error.name}: ${error.message}`.slice(0, maxOutput);
      const stack = formatStack(error);
      parts.push(stack ? `${head}\n${stack}` : head);
    } else {
      parts.push("Execution failed");
    }
  }
  return parts.join("\n\n");
}

export const nodeReplTool: Tool = {
  name: "node_repl",
  description:
    "Run JavaScript in a persistent Node.js REPL for this session. Top-level const/let/var, function and " +
    "class declarations persist across calls, as does anything assigned to globalThis, so you can load data " +
    "once and keep computing on it. Top-level await works for a single expression; for multi-statement async " +
    "code, store what you need on globalThis. `require(...)` resolves against the working directory and " +
    "`await import(...)` is available. The last expression's value and everything printed to stdout/stderr " +
    "are returned; large output spills to a readable temp file. The kernel runs in a separate process with " +
    "the working directory as its cwd; it is restarted with fresh state after a timeout, an abort, a crash " +
    "or an idle period (AGENT_REPL_IDLE_MS). Use bash instead for shell commands, and bash run_in_background " +
    "for servers or watch loops - never start those here.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript to evaluate. May span multiple statements; the last expression is the result.",
      },
      timeout_ms: {
        type: "number",
        description: `Kill and restart the kernel after this many ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
      },
      max_output: {
        type: "number",
        description: "Truncate the returned output to this many characters (default 30000); the full text is saved to a temp file.",
      },
    },
    required: ["code"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const code = str(input, "code");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, num(input, "timeout_ms") ?? timeoutDefault()));
    const maxOutput = Math.min(HARD_OUTPUT_CAP, Math.max(1_000, num(input, "max_output") ?? DEFAULT_MAX_OUTPUT));

    // High risk on purpose: this is arbitrary code execution. The description
    // is stable so one session/project approval can cover the kernel, while
    // the code itself is shown in the preview.
    const allowed = await ctx.askPermission(
      "Run JavaScript in the persistent Node REPL (arbitrary code execution in this workspace)",
      "high",
      code.length > 4_000 ? `${code.slice(0, 4_000)}\n…` : code,
    );
    if (!allowed) {
      return { content: "The user rejected this JavaScript execution. Do not retry it unchanged.", isError: true };
    }

    const key = kernelKey(ctx);
    let kernel = kernels.get(key);
    if (!kernel) {
      const created = new NodeReplKernel(ctx.cwd, idleMs(), () => {
        if (kernels.get(key) === created) kernels.delete(key);
      });
      kernel = created;
      kernels.set(key, created);
    }
    const result = await kernel.exec(code, timeoutMs, ctx.signal);
    return {
      content: await boundedResult(render(result, maxOutput), maxOutput, "node-repl-output"),
      isError: !result.ok,
    };
  },
};
