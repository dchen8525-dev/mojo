import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num } from "./utils.js";
import { deferredTools, exposeTool } from "./index.js";

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

/** Score a deferred tool against the query: name hits weigh far more than description hits. */
function score(tool: Tool, qTokens: string[]): number {
  const name = tool.name.toLowerCase();
  const descTokens = new Set(tokenize(tool.description));
  let s = 0;
  for (const q of qTokens) {
    if (name.includes(q)) s += 8;
    if (descTokens.has(q)) s += 2;
  }
  return s;
}

export const toolSearchTool: Tool = {
  name: "tool_search",
  description:
    "Search the hidden (deferred) tool catalog - mainly tools from large MCP servers - and " +
    "expose the matches so they become directly callable. Use it when a capability you need " +
    "is not in your tool list: query by server name, capability, or keywords (e.g. " +
    "\"sites database\", \"deploy\"). \"select:name1,name2\" exposes tools by exact name. " +
    "Exposed tools stay available for the rest of the session.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'Keywords to search for, or "select:name1,name2" to expose by exact name.',
      },
      limit: { type: "number", description: "Max matches to expose (default 8)." },
    },
    required: ["query"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = str(input, "query");
    const limit = Math.min(25, Math.max(1, num(input, "limit") ?? 8));
    const available = deferredTools();

    if (!available.length) {
      return { content: "No deferred tools are hidden right now - every tool is already in your tool list." };
    }

    if (query.startsWith("select:")) {
      const names = query
        .slice("select:".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const found: string[] = [];
      const missing: string[] = [];
      for (const n of names) (exposeTool(n) ? found : missing).push(n);
      const lines = [
        found.length ? `Exposed: ${found.join(", ")} - now directly callable.` : "",
        missing.length ? `Not found or not deferred: ${missing.join(", ")}.` : "",
      ].filter(Boolean);
      return { content: lines.join("\n") || "Nothing selected." };
    }

    const qTokens = tokenize(query);
    if (!qTokens.length) {
      return { content: `Empty query. ${available.length} tools are hidden; try keywords or select:name1,name2.` };
    }
    const ranked = available
      .map((t) => ({ tool: t, s: score(t, qTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);

    if (!ranked.length) {
      return {
        content:
          `No hidden tool matches "${query}" (${available.length} tools are hidden). ` +
          `Try the MCP server name or broader capability words, or select: an exact tool name.`,
      };
    }

    const exposed: string[] = [];
    for (const { tool } of ranked) exposeTool(tool.name) && exposed.push(tool.name);
    return {
      content:
        `Exposed ${exposed.length} tool(s), now directly callable:\n` +
        ranked.map(({ tool }) => `- ${tool.name}: ${tool.description}`).join("\n") +
        `\n(Ask with different keywords to expose more of the ${available.length} hidden tools.)`,
    };
  },
};
