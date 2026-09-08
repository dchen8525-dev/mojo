import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num, truncate, describeError } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Commands that are destructive enough to always require explicit approval,
 * even in "accept edits" mode.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\b|\s)/i,
  /\bdel\b|\berase\b/i,
  /\bsudo\b/i,
  /\bchmod\b|\bchown\b/i,
  /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-)/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,
  /\bmkfs\b|\bdiskpart\b/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bshutdown\b|\breboot\b/i,
  />\s*\/dev\/(sd|disk)/i,
  /\bnpm\s+publish\b|\bcargo\s+publish\b/i,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command and return combined stdout/stderr. Pass workdir to run in a specific " +
    "directory (the default is the working directory; it is NOT guaranteed to persist between " +
    "calls). Output is " +
    "truncated if too long, so prefer commands with bounded output (head, tail, grep). " +
    "Do NOT use this for file reading/searching when read_file/glob_files/grep exist. " +
    "Avoid interactive commands (no editors, no watch flags).",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      workdir: { type: "string", description: "Directory to run in (defaults to working directory)." },
      timeout_ms: { type: "number", description: `Kill the process after this many ms (default ${DEFAULT_TIMEOUT_MS}).` },
    },
    required: ["command"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = str(input, "command");
    const timeout = Math.min(600_000, Math.max(1_000, num(input, "timeout_ms") ?? DEFAULT_TIMEOUT_MS));

    const ok = await ctx.askPermission(
      `Run command: ${command.length > 200 ? command.slice(0, 200) + "..." : command}` +
        (isDangerousCommand(command) ? "  [matches a dangerous pattern]" : ""),
      isDangerousCommand(command) ? "high" : "medium",
    );
    if (!ok) return { content: "The user rejected this command. Do not retry it unchanged.", isError: true };

    return new Promise<ToolResult>((resolve) => {
      const isWin = process.platform === "win32";
      let workdir = ctx.cwd;
      if (typeof input.workdir === "string" && input.workdir) {
        workdir = path.isAbsolute(input.workdir) ? path.normalize(input.workdir) : path.resolve(ctx.cwd, input.workdir);
      }
      // On Windows, Node's default argument escaping (\" ...\") is not understood
      // by cmd.exe, which breaks any command containing quotes. Pass the command
      // line verbatim instead; /s makes cmd strip only the outermost quotes.
      const child = spawn(isWin ? "cmd.exe" : "/bin/bash", isWin ? ["/d", "/s", "/c", command] : ["-lc", command], {
        cwd: workdir,
        env: process.env,
        windowsHide: true,
        windowsVerbatimArguments: isWin,
      });

      let out = "";
      let killed: string | null = null;
      const timer = setTimeout(() => {
        killed = `timed out after ${timeout}ms`;
        child.kill(isWin ? undefined : "SIGKILL");
      }, timeout);

      const onData = (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > 200_000) {
          killed = "output exceeded 200KB";
          child.kill(isWin ? undefined : "SIGKILL");
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const onAbort = () => {
        killed = "aborted by user";
        child.kill(isWin ? undefined : "SIGKILL");
      };
      ctx.signal?.addEventListener("abort", onAbort);

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ content: `Error spawning process: ${describeError(err)}`, isError: true });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const status = killed
          ? `[process ${killed}; exit code ${code ?? "?"}]`
          : code === 0
            ? ""
            : `[exit code ${code}]`;
        const body = out.trim() || "(no output)";
        resolve({
          content: truncate(status ? `${body}\n${status}` : body),
          isError: !!killed || (code !== 0 && code !== null),
        });
      });
    });
  },
};
