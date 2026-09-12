import type { Tool, ToolContext, ToolResult, MessageParam } from "../types.js";
import { LLM } from "../llm.js";
import { Semaphore } from "../sync.js";
import { readFileTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webSearchTool, webFetchTool } from "./web.js";
import { writeFileTool, editFileTool } from "./write.js";
import { multiEditTool } from "./multiEdit.js";
import { bashTool } from "./bash.js";
import { describeError, truncate } from "./utils.js";

const SUB_MAX_ITERATIONS = 25;

/**
 * Bounds how many subagents run at once across the whole process. A single
 * parent turn can fire many `task` calls and Promise.all would launch them all
 * concurrently; this keeps that to a sane ceiling so we don't stampede the API
 * (rate limits) or the cost budget. Extra calls queue and start as slots free.
 */
const SUB_MAX_CONCURRENCY = 4;
const subSlots = new Semaphore(SUB_MAX_CONCURRENCY);

// Read-only toolset: the research sub-agent explores, it never modifies. Web
// tools are read-only too, so a research task can also consult docs.
const researchTools: Tool[] = [readFileTool, globTool, grepTool, webSearchTool, webFetchTool];

// Writable toolset for the coding sub-agent (implement a module, fix files).
const workerTools: Tool[] = [
  readFileTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  bashTool,
];

const RESEARCH_SYSTEM_PROMPT = `You are a research subagent spawned by a coding agent. Your only job is to answer the assigned question about this codebase accurately and fast.

Rules:
- Use glob_files/grep/read_file to explore the codebase; web_search/web_fetch for external docs or unfamiliar errors. You have NO write or shell access - never try.
- Prefer targeted searches over reading whole files. Batch independent tool calls.
- Do not speculate: every claim must come from a file you actually read.
- When you have the answer, stop exploring and write your final report.

Final report format (this is the ONLY thing your parent sees):
1. **Answer** - direct response to the question, with file:line references.
2. **Evidence** - the key snippets/locations you found.
3. **Caveats** - anything you could not verify or looked past.
Be dense. No preamble.`;

const WORKER_SYSTEM_PROMPT = `You are a coding subagent spawned by a parent coding agent. You implement the assigned task by editing files and running commands, then report what you did.

Rules:
- Stay strictly inside the scope of the assigned task. Do not refactor, rename, or "improve" anything beyond it.
- Read a file before editing it; use edit_file for targeted changes and write_file only for new files.
- Every write/shell operation asks the USER for approval - keep descriptions honest so they can decide fast.
- Run tests or builds when the task says to, and report failures truthfully - never claim success you did not verify.
- Batch independent tool calls. Keep going until the task is done, then write your final report.

Final report format (this is the ONLY thing your parent sees):
1. **Done** - what was accomplished, with file paths.
2. **Verification** - commands you ran and their real results.
3. **Issues** - anything unfinished, failing, or needing the parent's attention.
Be dense. No preamble.`;

export const taskTool: Tool = {
  name: "task",
  description:
    "Spawn a subagent with a fresh context. mode: \"research\" (default) is read-only " +
    "investigation (find definitions, trace flows, survey modules); mode: \"worker\" can " +
    "edit files and run commands to implement a well-scoped task (fix a module, write " +
    "tests) - useful for parallelizing independent pieces of work. The subagent sees NO " +
    "conversation history: pass a fully self-contained prompt (files, constraints, " +
    "definition of done). Worker mode asks the user's consent once before starting, and " +
    "every write/shell it performs still needs per-operation approval. " +
    "PARALLELISM: emit several task calls in ONE response to run them concurrently " +
    "(up to 4 at once; the rest queue). Only do that for genuinely independent pieces " +
    "that touch DISJOINT files - two workers editing the same file will conflict, since " +
    "each reads the file before the other's writes land. When tasks depend on each " +
    "other's output, issue them in separate turns. " +
    "Do NOT use research mode for edits (it cannot write), and do NOT use a subagent for " +
    "a single known file read.",
  // Research mode never modifies anything; worker mode gates itself with an
  // explicit consent prompt below, so the framework does not need to.
  isReadOnly: true,
  parallelSafe: true, // multiple subagents may work concurrently
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "3-5 word label for what the subagent will do." },
      prompt: {
        type: "string",
        description: "Self-contained task/question with enough detail to act on without context.",
      },
      mode: {
        type: "string",
        enum: ["research", "worker"],
        description: '"research" = read-only exploration (default); "worker" = may edit files and run commands.',
      },
    },
    required: ["description", "prompt"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) return { content: "Error: prompt must not be empty", isError: true };
    const worker = input.mode === "worker";
    if (worker && ctx.planMode) {
      return {
        content:
          "Error: worker subagents cannot be spawned in plan mode (they modify files). Use mode: \"research\" to explore, or exit plan mode first.",
        isError: true,
      };
    }
    const tools = worker ? workerTools : researchTools;
    const system = worker ? WORKER_SYSTEM_PROMPT : RESEARCH_SYSTEM_PROMPT;

    // Worker mode can modify the repo: ask the user once up front, in addition
    // to the per-operation approvals the subagent's tools still trigger.
    if (worker) {
      const label = String(input.description ?? "worker");
      const ok = await ctx.askPermission(
        `Spawn a WRITING subagent "${label}" that may edit files and run commands:\n` +
          prompt.slice(0, 500) + (prompt.length > 500 ? "…" : ""),
        "high",
      );
      if (!ok) return { content: "The user declined to start this writing subagent.", isError: true };
    }

    const llm = new LLM({ cwd: ctx.cwd });
    const messages: MessageParam[] = [{ role: "user", content: prompt }];
    let report = "";
    let iterations = 0;
    let toolCalls = 0;
    // A plan-mode research subagent must stay read-only even if the parent
    // forgets to pass mode: "research".
    const forceResearch = ctx.planMode;
    const subTools = forceResearch ? researchTools : tools;
    const subSystem = forceResearch ? RESEARCH_SYSTEM_PROMPT : system;
    const kind = forceResearch ? "research" : worker ? "worker" : "research";

    // Take a concurrency slot only after consent, so a prompt the user has not
    // answered yet never occupies a running slot.
    const release = await subSlots.acquire();
    try {
      while (iterations < SUB_MAX_ITERATIONS) {
        if (ctx.signal?.aborted) return { content: "Subagent was interrupted.", isError: true };
        iterations++;

        const turn = await llm.send(messages, subSystem, subTools, ctx.signal);
        ctx.reportUsage?.({
          input: turn.inputTokens,
          output: turn.outputTokens,
          cacheRead: turn.cacheReadTokens,
          cacheWrite: turn.cacheWriteTokens,
        });
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
              content: `Unknown tool "${tu.name}" - you only have: ${subTools.map((t) => t.name).join(", ")}.`,
              is_error: true,
            });
            continue;
          }
          try {
            const r = await tool.execute(tu.input as Record<string, unknown>, {
              cwd: ctx.cwd,
              signal: ctx.signal,
              checkpoint: ctx.checkpoint,
              reportUsage: ctx.reportUsage,
              // Worker writes/shell go through the USER's normal approval flow
              // (tagged so the prompt says who is asking); research tools never
              // prompt anyway.
              askPermission: worker
                ? (desc, risk, preview) => ctx.askPermission(`[subagent ${String(input.description ?? "worker")}] ${desc}`, risk, preview)
                : async () => true,
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
      return { content: truncate(`[${kind} subagent "${String(input.description ?? "task")}" finished after ${toolCalls} tool calls]\n\n${report}`, 20_000) };
    } catch (err) {
      const msg = describeError(err);
      if (msg === "aborted") return { content: "Subagent was interrupted.", isError: true };
      return { content: `Subagent failed: ${msg}`, isError: true };
    } finally {
      release();
    }
  },
};
