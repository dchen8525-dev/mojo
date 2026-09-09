import type { Tool } from "../types.js";
import { readFileTool } from "./read.js";
import { writeFileTool, editFileTool } from "./write.js";
import { bashTool, bashOutputTool, bashKillTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { todoWriteTool } from "./todo.js";
import { taskTool } from "./task.js";
import { getDiagnosticsTool } from "../lsp.js";
import { gitStatusTool, gitCommitTool, gitPrTool } from "./git.js";
import { webSearchTool, webFetchTool } from "./web.js";
import { multiEditTool } from "./multiEdit.js";

export const tools: Tool[] = [
  readFileTool,
  globTool,
  grepTool,
  todoWriteTool,
  taskTool,
  bashTool,
  bashOutputTool,
  bashKillTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  getDiagnosticsTool,
  gitStatusTool,
  gitCommitTool,
  gitPrTool,
  webSearchTool,
  webFetchTool,
];

const byName = new Map(tools.map((t) => [t.name, t]));

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
  return removed;
}

export { todoStore } from "./todo.js";
