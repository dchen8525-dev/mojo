import type { Tool } from "../types.js";
import { readFileTool } from "./read.js";
import { readSessionTool } from "./readSession.js";
import { askUserTool } from "./askUser.js";
import { writeFileTool, editFileTool } from "./write.js";
import { applyPatchTool } from "./patch.js";
import { bashTool, bashOutputTool, bashKillTool } from "./bash.js";
import { nodeReplTool } from "./nodeRepl.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { todoWriteTool } from "./todo.js";
import { cronCreateTool, cronListTool, cronDeleteTool } from "./cron.js";
import { taskTool, taskOutputTool, sendMessageTool } from "./task.js";
import { getDiagnosticsTool } from "../lsp.js";
import { gitStatusTool, gitCommitTool, gitPrTool, gitDiffTool } from "./git.js";
import { webSearchTool, webFetchTool } from "./web.js";
import { multiEditTool } from "./multiEdit.js";
import { skillTool } from "./skill.js";
import { toolSearchTool } from "./toolSearch.js";
import { saveMemoryTool } from "../memoryWrite.js";

export const tools: Tool[] = [
  readFileTool,
  readSessionTool,
  askUserTool,
  globTool,
  grepTool,
  todoWriteTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  taskTool,
  taskOutputTool,
  sendMessageTool,
  bashTool,
  bashOutputTool,
  bashKillTool,
  nodeReplTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  applyPatchTool,
  getDiagnosticsTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPrTool,
  webSearchTool,
  webFetchTool,
  skillTool,
  toolSearchTool,
  saveMemoryTool,
];

const byName = new Map(tools.map((t) => [t.name, t]));

/**
 * Deferred tools that tool_search has exposed, keyed by session. The registry
 * is process-global (MCP servers connect once), but discovery is not: two
 * sessions in one GUI process - or two chats served by the MCP server - must
 * not inherit each other's exposed catalog. "": callers without a session.
 */
const exposedBySession = new Map<string, Set<string>>();

function bucket(sessionId: string | undefined, create: boolean): Set<string> | undefined {
  const key = sessionId ?? "";
  let set = exposedBySession.get(key);
  if (!set && create) {
    set = new Set();
    exposedBySession.set(key, set);
  }
  return set;
}

export function exposeTool(name: string, sessionId?: string): boolean {
  const t = byName.get(name);
  if (!t?.deferred) return false;
  bucket(sessionId, true)!.add(name);
  return true;
}

export function isExposed(name: string, sessionId?: string): boolean {
  return bucket(sessionId, false)?.has(name) ?? false;
}

/** Names currently exposed in a session (for session-meta persistence). */
export function exposedToolNames(sessionId?: string): string[] {
  return [...(bucket(sessionId, false) ?? [])];
}

/** Deferred tools still hidden in this session. */
export function deferredTools(sessionId?: string): Tool[] {
  const set = bucket(sessionId, false);
  return tools.filter((t) => t.deferred && !set?.has(t.name));
}

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

/** Register an extra tool (e.g. from an MCP server). Returns false if the name is taken. */
export function registerTool(tool: Tool): boolean {
  if (byName.has(tool.name)) return false;
  byName.set(tool.name, tool);
  tools.push(tool);
  return true;
}

/** Remove all tools whose name starts with the given prefix (used on MCP disconnect). */
export function unregisterToolsByPrefix(prefix: string): number {
  let removed = 0;
  for (const name of [...byName.keys()]) {
    if (name.startsWith(prefix)) {
      const tool = byName.get(name)!;
      byName.delete(name);
      const i = tools.indexOf(tool);
      if (i >= 0) tools.splice(i, 1);
      removed++;
    }
  }
  for (const [key, set] of exposedBySession) {
    for (const name of [...set]) if (name.startsWith(prefix)) set.delete(name);
    if (!set.size) exposedBySession.delete(key);
  }
  return removed;
}

export { todoStore } from "./todo.js";
