import type { Tool } from "../types.js";
import { readFileTool } from "./read.js";
import { writeFileTool, editFileTool } from "./write.js";
import { bashTool, bashOutputTool, bashKillTool } from "./bash.js";
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

export const tools: Tool[] = [
  readFileTool,
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
  writeFileTool,
  editFileTool,
  multiEditTool,
  getDiagnosticsTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  gitPrTool,
  webSearchTool,
  webFetchTool,
  skillTool,
  toolSearchTool,
];

const byName = new Map(tools.map((t) => [t.name, t]));

/**
 * Deferred tools that tool_search has exposed for this process. Exposure is
 * in-memory by design: a resumed session starts lean and re-discovers via
 * tool_search instead of paying for the full catalog every turn.
 */
const exposedDeferred = new Set<string>();

export function exposeTool(name: string): boolean {
  const t = byName.get(name);
  if (!t?.deferred) return false;
  exposedDeferred.add(name);
  return true;
}

export function isExposed(name: string): boolean {
  return exposedDeferred.has(name);
}

export function deferredTools(): Tool[] {
  return tools.filter((t) => t.deferred && !exposedDeferred.has(t.name));
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
      exposedDeferred.delete(name);
      const i = tools.indexOf(tool);
      if (i >= 0) tools.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

export { todoStore } from "./todo.js";
