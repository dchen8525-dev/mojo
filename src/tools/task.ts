import type { Tool, ToolContext, ToolResult, MessageParam } from "../types.js";
import { LLM } from "../llm.js";
import { readFileTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { describeError, truncate } from "./utils.js";

const SUB_MAX_ITERATIONS = 25;

// Read-only toolset: the sub-agent explores, it never modifies.
const subTools: Tool[] = [readFileTool, globTool, grepTool];

const SUB_SYSTEM_PROMPT = `You are a research subagent spawned by a coding agent. Your only job is to answer the assigned question about this codebase accurately and fast.

Rules:
- Use glob_files/grep/read_file to explore. You have NO write or shell access - never try.
- Prefer targeted searches over reading whole files. Batch independent tool calls.
- Do not speculate: every claim must come from a file you actually read.
- When you have the answer, stop exploring and write your final report.

Final report format (this is the ONLY thing your parent sees):
1. **Answer** - direct response to the question, with file:line references.
2. **Evidence** - the key snippets/locations you found.
3. **Caveats** - anything you could not verify or looked past.
Be dense. No preamble.`;

export const taskTool: Tool = {
  name: "task",
  description:
    "Spawn a read-only research subagent with a fresh context to investigate the codebase " +
    "(find where something is defined, trace a flow, survey a module, answer 'how does X work'). " +
    "It explores with glob/grep/read and returns only its final report, keeping your own context " +
    "clean. Use it for multi-step exploration; do NOT use it for a single known file read, and do " +
    "NOT use it for edits or commands - it cannot write or run anything. " +
    "Pass a self-contained prompt: the subagent sees no conversation history.",
  isReadOnly: true,
  parallelSafe: true, // multiple subagents may research concurrently
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "3-5 word label for what the subagent will do." },
      prompt: {
        type: "string",
        description: "Self-contained research question with enough detail to act on without context.",
      },
    },
    required: ["description", "prompt"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) return { content: "Error: prompt must not be empty", isError: true };

    const llm = new LLM();
    const messages: MessageParam[] = [{ role: "user", content: prompt }];
    let report = "";
    let iterations = 0;
    let toolCalls = 0;

    try {
      while (iterations < SUB_MAX_ITERATIONS) {
        if (ctx.signal?.aborted) return { content: "Subagent was interrupted.", isError: true };
        iterations++;

        const turn = await llm.send(messages, SUB_SYSTEM_PROMPT, subTools, ctx.signal);
        messages.push({ role: "assistant", content: turn.content });
        if (turn.text) report = turn.text;

        if (turn.toolUses.length === 0) break;
        toolCalls += turn.toolUses.length;

        const results = [];
        for (const tu of turn.toolUses) {
          const tool = subTools.find((t) => t.name === tu.name);
          if (!tool) {
            results.push({
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: `Unknown tool "${tu.name}" - you only have glob_files, grep, read_file.`,
              is_error: true,
            });
            continue;
          }
          try {
            const r = await tool.execute(tu.input as Record<string, unknown>, {
              ...ctx,
              askPermission: async () => true, // read-only tools never prompt anyway
            });
            results.push({ type: "tool_result" as const, tool_use_id: tu.id, content: r.content, is_error: r.isError });
          } catch (err) {
            results.push({
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: `Tool crashed: ${describeError(err)}`,
              is_error: true,
            });
          }
        }
        messages.push({ role: "user", content: results });
      }

      if (iterations >= SUB_MAX_ITERATIONS) {
        report += "\n\n[subagent hit its iteration limit - findings may be partial]";
      }
      if (!report.trim()) {
        return { content: "Subagent finished without producing a report.", isError: true };
      }
      return { content: truncate(`[subagent "${String(input.description ?? "task")}" finished after ${toolCalls} tool calls]\n\n${report}`, 20_000) };
    } catch (err) {
      const msg = describeError(err);
      if (msg === "aborted") return { content: "Subagent was interrupted.", isError: true };
      return { content: `Subagent failed: ${msg}`, isError: true };
    }
  },
};
