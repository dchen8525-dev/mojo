import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Claude Code-style hooks: shell commands invoked at lifecycle points.
 * Config lives in ~/.node-agent/hooks.json (global) and .node-agent/hooks.json
 * (project). Each hook receives a JSON payload on stdin; exit code 2 blocks
 * the action with stderr as the reason, other non-zero codes are warnings,
 * exit 0 stdout may carry extra context.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

interface HookDef {
  /** Tool name pattern (Pre/PostToolUse only); omit or "*" for all. */
  matcher?: string;
  command: string;
  timeout?: number; // ms, default 30s
}

export interface HookPayload {
  /** Injected by HookManager.run(); callers omit it. */
  hook_event_name?: HookEvent;
  session_id?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  prompt?: string;
}

export interface HookResult {
  blocked: boolean;
  reason: string;
  /** stdout context to inject into the conversation. */
  context: string;
}

const OK: HookResult = { blocked: false, reason: "", context: "" };

function matches(def: HookDef, toolName?: string) {
  if (!def.matcher || def.matcher === "*") return true;
  if (!toolName) return false;
  // Comma-separated list or regex, like Claude Code.
  if (def.matcher.includes("|") || /[\^$.*+?()[\]{}]/.test(def.matcher)) {
    try {
      return new RegExp(def.matcher).test(toolName);
    } catch {
      return false;
    }
  }
  return def.matcher
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === toolName);
}

export class HookManager {
  private hooks: Record<HookEvent, HookDef[]> = {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
  };

  async load(cwd: string) {
    const files = [
      path.join(os.homedir(), ".node-agent", "hooks.json"),
      path.join(cwd, ".node-agent", "hooks.json"),
    ];
    for (const f of files) {
      try {
        const raw = (await fs.readFile(f, "utf8")).replace(/^\uFEFF/, "");
        const obj = JSON.parse(raw) as Partial<Record<HookEvent, HookDef[]>>;
        for (const ev of Object.keys(this.hooks) as HookEvent[]) {
          if (Array.isArray(obj[ev])) this.hooks[ev].push(...obj[ev]!);
        }
      } catch {
        /* optional file */
      }
    }
    return this.count();
  }

  count(): number {
    return Object.values(this.hooks).reduce((n, a) => n + a.length, 0);
  }

  list(): Array<{ event: HookEvent; matcher: string; command: string }> {
    return Object.entries(this.hooks).flatMap(([event, defs]) =>
      defs.map((d) => ({ event: event as HookEvent, matcher: d.matcher ?? "*", command: d.command })),
    );
  }

  private async runOne(def: HookDef, payload: HookPayload): Promise<HookResult> {
    return new Promise((resolve) => {
      const isWin = process.platform === "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(isWin ? "cmd.exe" : "/bin/bash", isWin ? ["/d", "/s", "/c", def.command] : ["-c", def.command], {
          cwd: payload.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsVerbatimArguments: isWin,
        });
      } catch (err) {
        resolve({ blocked: false, reason: `hook failed to start: ${String(err)}`, context: "" });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (r: HookResult) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(r);
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ blocked: false, reason: `hook timed out: ${def.command}`, context: "" });
      }, def.timeout ?? 30_000);

      child.stdout?.on("data", (c) => (stdout += c));
      child.stderr?.on("data", (c) => (stderr += c));
      child.on("error", (err) => finish({ blocked: false, reason: String(err), context: "" }));
      child.on("close", (code) => {
        if (code === 2) finish({ blocked: true, reason: stderr.trim() || stdout.trim() || "blocked by hook", context: "" });
        else if (code !== 0) finish({ blocked: false, reason: `[hook warning] ${stderr.trim().slice(0, 400)}`, context: "" });
        else finish({ blocked: false, reason: "", context: stdout.trim() });
      });
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  /** Run all hooks for an event; first blocker wins. Errors never crash the agent. */
  async run(event: HookEvent, payload: HookPayload, toolName?: string): Promise<HookResult> {
    const defs = this.hooks[event].filter((d) => matches(d, toolName));
    let result: HookResult = { ...OK };
    for (const def of defs) {
      const r = await this.runOne(def, { ...payload, hook_event_name: event, tool_name: toolName });
      if (r.blocked) return r;
      if (r.reason) result.reason += r.reason + "\n";
      if (r.context) result.context += r.context + "\n";
    }
    return result;
  }
}
