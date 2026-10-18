import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent } from "../agent.js";
import type { SlashCommand } from "../commands.js";
import type { HookManager } from "../hooks.js";
import type { McpManager } from "../mcp.js";
import type { PermissionManager } from "../permissions.js";

/**
 * Everything scoped to one working directory. The GUI keeps a single mutable
 * instance: switching projects builds a fresh context and copies its fields
 * into the existing object, so the HTTP handler keeps seeing the current one.
 */
export interface ProjectContext {
  cwd: string;
  agent: Agent;
  permissions: PermissionManager;
  hooks: HookManager;
  customCommands: Map<string, SlashCommand>;
  mcp: McpManager | null;
}

export type SwitchResult = { ok: true; cwd: string; sessionId: string } | { ok: false; error: string };

/** Windows paths are case-insensitive; resolve both before comparing. */
export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Validate a user-supplied project path and return its canonical absolute form.
 * Relative input resolves against the current process cwd (the open project).
 */
export async function resolveProjectDir(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("missing path");
  const abs = path.resolve(trimmed);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new Error(`directory not found: ${abs}`);
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${real}`);
  return real;
}
