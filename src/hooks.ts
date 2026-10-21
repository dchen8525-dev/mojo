import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Claude Code-style hooks: shell commands invoked at lifecycle points.
 * Config lives in ~/.node-agent/hooks.json (global) and .node-agent/hooks.json
 * (project). Each hook receives a JSON payload on stdin; exit code 2 blocks
 * the action with stderr as the reason, other non-zero codes are warnings,
 * exit 0 stdout may carry extra context.
 *
 * Project hooks are repo-controlled shell commands, so they are untrusted by
 * default: they load only after the user approves the exact file contents for
 * this workspace (`/hooks trust`). Approval is pinned to a SHA-256 digest, so
 * any later edit revokes it until re-approved. Global hooks are authored by
 * the user and always load.
 */

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "PreCompact";

interface HookDef {
  /** Tool name pattern (Pre/PostToolUse only); omit or "*" for all. */
  matcher?: string;
  command: string;
  timeout?: number; // ms, default 30s
  /**
   * Fire-and-forget: the agent does not wait for the hook and its output can
   * neither block nor inject context. Use for notifications/logging.
   */
  async?: boolean;
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
  /** SessionStart: "startup" for a fresh session, "resume" when history was loaded. */
  source?: string;
  /** PreCompact: "auto" (context budget) or "manual" (/compact). */
  trigger?: string;
}

export interface HookResult {
  blocked: boolean;
  reason: string;
  /** stdout context to inject into the conversation. */
  context: string;
}

const OK: HookResult = { blocked: false, reason: "", context: "" };

/* ---------------- project hook trust store ---------------- */

interface TrustEntry {
  digest: string;
  approvedAt: string;
}

interface TrustStore {
  workspaces: Record<string, TrustEntry>;
}

export function projectHooksFile(cwd: string): string {
  return path.join(cwd, ".node-agent", "hooks.json");
}

function trustStoreFile(home = os.homedir()): string {
  return path.join(home, ".node-agent", "hook-trust.json");
}

function workspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readTrustStore(home?: string): Promise<TrustStore> {
  try {
    const raw = (await fs.readFile(trustStoreFile(home), "utf8")).replace(/^\uFEFF/, "");
    const obj = JSON.parse(raw) as Partial<TrustStore>;
    if (obj && typeof obj.workspaces === "object" && obj.workspaces) return { workspaces: obj.workspaces };
  } catch {
    /* missing or corrupt: fail closed (nothing trusted) */
  }
  return { workspaces: {} };
}

async function writeTrustStore(store: TrustStore, home?: string): Promise<void> {
  const file = trustStoreFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** SHA-256 of the project hooks file, or null when it does not exist. */
export async function hookFileDigest(file: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(file);
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export async function isHooksTrusted(cwd: string, digest: string, home?: string): Promise<boolean> {
  const store = await readTrustStore(home);
  return store.workspaces[workspaceKey(cwd)]?.digest === digest;
}

export async function trustHooksFile(cwd: string, digest: string, home?: string): Promise<void> {
  const store = await readTrustStore(home);
  store.workspaces[workspaceKey(cwd)] = { digest, approvedAt: new Date().toISOString() };
  await writeTrustStore(store, home);
}

export async function revokeHooksTrust(cwd: string, home?: string): Promise<boolean> {
  const store = await readTrustStore(home);
  const key = workspaceKey(cwd);
  if (!(key in store.workspaces)) return false;
  delete store.workspaces[key];
  await writeTrustStore(store, home);
  return true;
}

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
    SessionStart: [],
    PreCompact: [],
  };
  /** Project hooks file that exists but has not been trusted at this digest. */
  private untrusted: { file: string; digest: string } | null = null;

  /**
   * Load global hooks (always trusted) and project hooks (only when the
   * workspace approved this exact file). Safe to call again after a trust
   * change: every call rebuilds the hook lists from scratch.
   */
  async load(cwd: string, home?: string) {
    this.hooks = {
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      Stop: [],
      SessionStart: [],
      PreCompact: [],
    };
    this.untrusted = null;
    await this.loadFile(path.join(home ?? os.homedir(), ".node-agent", "hooks.json"));
    const projectFile = projectHooksFile(cwd);
    const digest = await hookFileDigest(projectFile);
    if (digest === null) return this.count();
    if (await isHooksTrusted(cwd, digest, home)) await this.loadFile(projectFile);
    else this.untrusted = { file: projectFile, digest };
    return this.count();
  }

  private async loadFile(f: string) {
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

  /** The skipped project hooks, when present; null when trusted or absent. */
  untrustedProjectHooks(): { file: string; digest: string } | null {
    return this.untrusted;
  }

  /** Approve the current project hooks file for this workspace and load it. */
  async trustProjectHooks(cwd: string, home?: string): Promise<number> {
    const file = projectHooksFile(cwd);
    const digest = await hookFileDigest(file);
    if (digest === null) return 0;
    await trustHooksFile(cwd, digest, home);
    return this.load(cwd, home);
  }

  /** Revoke approval (project hooks stop loading) and reload. */
  async revokeProjectHooks(cwd: string, home?: string): Promise<boolean> {
    const removed = await revokeHooksTrust(cwd, home);
    await this.load(cwd, home);
    return removed;
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
    // Matchers only make sense for tool events; on SessionStart/PreCompact/etc.
    // a matcher must not silently disable the hook.
    const toolEvent = event === "PreToolUse" || event === "PostToolUse";
    const defs = this.hooks[event].filter((d) => !toolEvent || matches(d, toolName));
    let result: HookResult = { ...OK };
    for (const def of defs) {
      if (def.async) {
        // Fire-and-forget: never awaited, output can't block or inject context.
        void this.runOne(def, { ...payload, hook_event_name: event, tool_name: toolName });
        continue;
      }
      const r = await this.runOne(def, { ...payload, hook_event_name: event, tool_name: toolName });
      if (r.blocked) return r;
      if (r.reason) result.reason += r.reason + "\n";
      if (r.context) result.context += r.context + "\n";
    }
    return result;
  }
}
