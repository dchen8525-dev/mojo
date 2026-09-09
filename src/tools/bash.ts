import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num, bool, truncate, describeError } from "./utils.js";
import { backgroundManager } from "./background.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Output beyond this is killed; the full capture is spilled to a file. */
const HARD_OUTPUT_CAP = 200_000;

/**
 * Commands that are destructive enough to always require explicit approval,
 * even in "accept edits" mode. Patterns are shell-agnostic: they cover cmd
 * (del/erase/taskkill), bash (rm) and PowerShell (Remove-Item, Stop-Process,
 * Set-MpPreference, ...) spellings because on Windows the command may run in
 * any of the three.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\b|\s)/i,
  /\bdel\b|\berase\b/i,
  /\bremove-item\b|\brm\b.*\s-(r|recurse|force)|\s-(r|rec)\b.*\bforce\b/i, // Remove-Item -Recurse -Force
  /\btaskkill\b\s+\/(f|im)|\bstop-process\b|\bkill\s+-9\b/i,
  /\bsudo\b/i,
  /\bchmod\b|\bchown\b/i,
  /\bcacls\b|\bicacls\b/i,
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-)/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr)\b[^|]*\|\s*[\w.-]*\b(bash|sh|zsh|ksh|dash|pwsh|powershell|iex)\b/i,
  /\bmkfs\b|\bdiskpart\b/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bshutdown\b|\breboot\b/i,
  />\s*\/dev\/(sd|disk)/i,
  /\bset-mppreference\b|\badd-mppreference\b/i, // tampering with Windows Defender
  /\bnpm\s+publish\b|\bcargo\s+publish\b/i,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

/**
 * PowerShell is the default interactive shell on modern Windows and many
 * users set it as their agent shell. Honor AGENT_SHELL / COMSPEC so bash
 * syntax mistakes (e.g. `&&` in Windows PowerShell 5.1) fail loudly inside
 * the shell the user actually configured, instead of silently running in
 * cmd.exe.
 */
export function pickWin32Shell(env: NodeJS.ProcessEnv = process.env): { exe: string; prefix: string[] } {
  const cmd = { exe: "cmd.exe", prefix: ["/d", "/s", "/c"] };
  const psPrefix = ["-NoProfile", "-NonInteractive", "-Command"];
  const forced = (env.AGENT_SHELL ?? "").trim().toLowerCase();
  if (forced.endsWith("pwsh.exe") || forced === "pwsh") return { exe: "pwsh.exe", prefix: psPrefix };
  if (forced.endsWith("powershell.exe") || forced === "powershell") return { exe: "powershell.exe", prefix: psPrefix };
  if (forced.endsWith("cmd.exe") || forced === "cmd") return cmd;
  const comspec = (env.COMSPEC ?? "").toLowerCase();
  if (comspec.includes("powershell") || comspec.includes("pwsh")) {
    return { exe: comspec.includes("pwsh") ? "pwsh.exe" : "powershell.exe", prefix: psPrefix };
  }
  return cmd;
}

/** Kill a process and, on Windows, its whole child tree (cmd → node → ...). */
function killTree(child: ReturnType<typeof spawn>, isWin: boolean) {
  if (isWin && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill(isWin ? undefined : "SIGKILL");
  }
}

/** Spill the full capture so `truncate`'s "read the saved output" hint is real. */
async function spillToDisk(text: string): Promise<string | null> {
  try {
    const dir = path.join(os.tmpdir(), "node-agent-output");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await fs.writeFile(file, text, "utf8");
    return file;
  } catch {
    return null; // best-effort; truncation still works without it
  }
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command and return combined stdout/stderr. On Windows this runs cmd.exe by " +
    "default (or PowerShell if AGENT_SHELL/COMSPEC points at it) - use cmd syntax there, not " +
    "bash-isms like `$(...)` or `&&` in PowerShell 5.1. Pass workdir to run in a specific " +
    "directory (the default is the working directory; it is NOT guaranteed to persist between " +
    "calls). Long output is truncated head+tail and the full capture is saved to a temp file " +
    "you can read; prefer commands with bounded output (findstr, more). Do NOT use this for " +
    "file reading/searching when read_file/glob_files/grep exist. For long-running commands " +
    "(dev servers, watchers) pass run_in_background instead of blocking; never use this for " +
    "editors or REPLs.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      workdir: { type: "string", description: "Directory to run in (defaults to working directory)." },
      timeout_ms: { type: "number", description: `Kill the process after this many ms (default ${DEFAULT_TIMEOUT_MS}).` },
      max_output: { type: "number", description: "Truncate the returned output to this many characters (default 30000)." },
      run_in_background: {
        type: "boolean",
        description:
          "Start the command in the background and return immediately with a task id " +
          "(use bash_output to poll its log, bash_kill to stop it). For dev servers, watch " +
          "modes and other long-running commands - never set timeout_ms for these.",
      },
    },
    required: ["command"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = str(input, "command");
    const timeout = Math.min(600_000, Math.max(1_000, num(input, "timeout_ms") ?? DEFAULT_TIMEOUT_MS));
    const maxOutput = Math.min(HARD_OUTPUT_CAP, Math.max(1_000, num(input, "max_output") ?? 30_000));

    const ok = await ctx.askPermission(
      `Run command${bool(input, "run_in_background") ? " in background" : ""}: ` +
        `${command.length > 200 ? command.slice(0, 200) + "..." : command}` +
        (isDangerousCommand(command) ? "  [matches a dangerous pattern]" : ""),
      isDangerousCommand(command) ? "high" : "medium",
    );
    if (!ok) return { content: "The user rejected this command. Do not retry it unchanged.", isError: true };

    let workdir = ctx.cwd;
    if (typeof input.workdir === "string" && input.workdir) {
      workdir = path.isAbsolute(input.workdir) ? path.normalize(input.workdir) : path.resolve(ctx.cwd, input.workdir);
    }

    if (bool(input, "run_in_background")) {
      try {
        const task = await backgroundManager.start(command, workdir);
        return {
          content:
            `Started background task ${task.id} (pid ${task.child.pid ?? "?"}). ` +
            `It keeps running across turns; its output is NOT shown here. ` +
            `Check on it with bash_output {id: "${task.id}", since: 0} and stop it with bash_kill.`,
        };
      } catch (err) {
        return { content: `Error starting background task: ${describeError(err)}`, isError: true };
      }
    }

    return new Promise<ToolResult>((resolve) => {
      const isWin = process.platform === "win32";
      const shell = isWin ? pickWin32Shell() : { exe: "/bin/bash", prefix: ["-lc"] };
      // On Windows, Node's default argument escaping (\" ...\") is not understood
      // by cmd.exe, which breaks any command containing quotes. Pass the command
      // line verbatim instead; /s makes cmd strip only the outermost quotes.
      const child = spawn(shell.exe, [...shell.prefix, command], {
        cwd: workdir,
        env: process.env,
        windowsHide: true,
        windowsVerbatimArguments: isWin,
      });

      let out = "";
      let killed: string | null = null;
      const timer = setTimeout(() => {
        killed = `timed out after ${timeout}ms`;
        killTree(child, isWin);
      }, timeout);

      const onData = (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > HARD_OUTPUT_CAP) {
          killed = `output exceeded ${(HARD_OUTPUT_CAP / 1000) | 0}KB`;
          killTree(child, isWin);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const onAbort = () => {
        killed = "aborted by user";
        killTree(child, isWin);
      };
      ctx.signal?.addEventListener("abort", onAbort);

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ content: `Error spawning process: ${describeError(err)}`, isError: true });
      });

      child.on("close", async (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const status = killed
          ? `[process ${killed}; exit code ${code ?? "?"}]`
          : code === 0
            ? ""
            : `[exit code ${code}]`;
        const body = out.trim() || "(no output)";
        // The spill note goes LAST so head+tail truncation always keeps it
        // (the interesting part of a huge capture is its tail).
        let note = "";
        if (out.length > maxOutput) {
          const file = await spillToDisk(out);
          note = file
            ? `\n[Output truncated: full ${out.length.toLocaleString()} chars saved to ${file} - read it with read_file offset/limit.]`
            : `\n[Output truncated after ${out.length.toLocaleString()} chars (could not save to disk).]`;
        }
        const combined = `${body}${status ? `\n${status}` : ""}${note}`;
        resolve({
          content: truncate(combined, maxOutput),
          isError: !!killed || (code !== 0 && code !== null),
        });
      });
    });
  },
};

/* ---------------- background task tools ---------------- */

export const bashOutputTool: Tool = {
  name: "bash_output",
  description:
    "Poll the output of a background task started with bash run_in_background. " +
    "Pass the id and the byte offset from the previous call (since: 0 the first " +
    "time) to get only NEW output - do not re-read the whole log each turn. The " +
    "result reports whether the task is still running or has exited (with its " +
    "exit code), plus the next offset to pass.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id returned by bash run_in_background (e.g. bg1)." },
      since: { type: "number", description: "Byte offset to read from (default 0)." },
    },
    required: ["id"],
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const id = str(input, "id");
    const since = Math.max(0, num(input, "since") ?? 0);
    const task = backgroundManager.get(id);
    if (!task) {
      return { content: `Error: no background task "${id}". Started tasks: ${backgroundManager.list().map((t) => t.id).join(", ") || "(none)"}`, isError: true };
    }
    const { text, nextOffset } = backgroundManager.readLog(task, since);
    const status = task.done
      ? task.killed
        ? `[task ${id} was killed]`
        : `[task ${id} exited with code ${task.exitCode ?? "?"}]`
      : `[task ${id} still running (${Math.round((Date.now() - task.startedAt) / 1000)}s so far)]`;
    const body = text.trim() || (nextOffset === 0 ? "(no output yet)" : "(no new output)");
    return { content: truncate(`${body}\n${status}\n[next_offset=${nextOffset}]`, 20_000) };
  },
};

export const bashKillTool: Tool = {
  name: "bash_kill",
  description:
    "Stop a running background task (and its whole process tree). Use this when " +
    "you started a dev server or watch process and no longer need it. Idempotent: " +
    "killing an already-exited task reports that it is gone.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task id returned by bash run_in_background." },
    },
    required: ["id"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = str(input, "id");
    const task = backgroundManager.get(id);
    if (!task) return { content: `Error: no background task "${id}".`, isError: true };
    if (task.done) return { content: `Task ${id} already exited (code ${task.exitCode ?? "?"}); nothing to kill.` };
    const ok = await ctx.askPermission(
      `Kill background task ${id}: ${task.command.slice(0, 200)}`,
      "medium",
    );
    if (!ok) return { content: "The user rejected killing this task.", isError: true };
    backgroundManager.kill(id);
    await task.closePromise;
    return { content: `Killed background task ${id}.` };
  },
};

