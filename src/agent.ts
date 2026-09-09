import os from "node:os";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ContentBlock, ImageBlockParam, MessageParam, ToolResultBlockParam, ToolUseBlock } from "./types.js";
import { LLM, type StreamEvents } from "./llm.js";
import { getTool, tools, todoStore } from "./tools/index.js";
import { exitPlanTool } from "./tools/exitPlan.js";
import type { PermissionManager } from "./permissions.js";
import type { HookManager } from "./hooks.js";
import { TokenCounter } from "./tokens.js";
import { CheckpointStore } from "./checkpoint.js";
import { CostTracker } from "./cost.js";
import { appendMemoryNote, renderMemory } from "./memory.js";
import { buildReviewPrompt, collectReview, REVIEW_SYSTEM } from "./review.js";
import { truncate } from "./tools/utils.js";
import { appendMessages, appendModel, rewriteMessages } from "./session.js";
import {
  buildAckMessage,
  buildSummarizerInput,
  buildSummaryMessage,
  extractPriorSummary,
  pickCompactBoundary,
  pruneOldToolResults,
  renderTranscript,
  SUMMARIZER_SYSTEM,
  truncateTo,
} from "./compact.js";

const MAX_TOOL_ITERATIONS = 40;
const MAX_CONTINUATIONS = 3; // auto-resume cap after output hits the token limit
const COMPACT_RATIO = 0.75; // compact when estimate exceeds this share of the model's window
const COMPACT_TARGET_RATIO = 0.5; // aim to land here so we don't re-compact next turn

export interface AgentEvents extends StreamEvents {
  onToolStart?: (id: string, name: string, inputPreview: string) => void;
  onToolEnd?: (id: string, name: string, ok: boolean, preview: string) => void;
  onUsage?: (input: number, output: number) => void;
  onCostWarning?: (message: string) => void;
  onCompacting?: () => void;
  onCompacted?: (before: number, after: number) => void;
  onHook?: (event: string, message: string) => void;
  onPlanApproved?: () => void;
}

export class Agent {
  private llm: LLM;
  private messages: MessageParam[] = [];
  private persisted = 0;
  private lastPersistedModel = "";
  private tokens = new TokenCounter();
  private checkpoints: CheckpointStore;
  readonly costs: CostTracker;
  cwd: string;
  sessionId: string;
  private permissions: PermissionManager;
  private hooks?: HookManager;
  /** Plan mode: only read-only tools + exit_plan are offered until the user approves a plan. */
  planMode = false;

  get model(): string {
    return this.llm.model;
  }
  get provider(): string {
    return this.llm.provider;
  }
  switchModel(spec: string): { provider: string; model: string } {
    return this.llm.switchModel(spec);
  }
  listModels(signal?: AbortSignal): Promise<string[]> {
    return this.llm.listModels(signal);
  }

  constructor(
    cwd: string,
    sessionId: string,
    permissions: PermissionManager,
    initialMessages?: MessageParam[],
    /** Model already recorded in the session file, as "provider:model". */
    initialModelSpec?: string,
    hooks?: HookManager,
  ) {
    this.cwd = cwd;
    this.llm = new LLM({ cwd });
    this.sessionId = sessionId;
    this.checkpoints = new CheckpointStore(sessionId);
    const budget = Number(process.env.AGENT_BUDGET_USD);
    this.costs = new CostTracker(Number.isFinite(budget) && budget > 0 ? budget : null);
    this.permissions = permissions;
    this.hooks = hooks;
    this.lastPersistedModel = initialModelSpec ?? "";
    if (initialMessages) {
      this.messages = initialMessages;
      this.persisted = initialMessages.length;
    }
  }

  setHooks(hooks: HookManager) {
    this.hooks = hooks;
  }

  private async systemPrompt(): Promise<string> {
    let gitStatus = "(not a git repo)";
    try {
      gitStatus = execSync("git status --short --branch", {
        cwd: this.cwd,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || "(clean)";
      if (gitStatus.length > 2000) gitStatus = gitStatus.slice(0, 2000) + "\n[...]";
    } catch {
      /* not a repo */
    }
    let projectInstructions = "";
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        projectInstructions += `\n<project_instructions file="${f}">\n${await fs.readFile(path.join(this.cwd, f), "utf8")}\n</project_instructions>\n`;
        break;
      } catch {
        /* optional */
      }
    }
    const memory = await renderMemory(this.cwd);
    const planRules = this.planMode
      ? `
PLAN MODE is active. You may ONLY explore and plan - the user has NOT approved any changes yet.
- You have read-only tools plus exit_plan. Do not attempt any modification; none will be possible.
- Investigate the codebase thoroughly: read the relevant files, trace the flows the task touches, and check tests/builds expectations.
- When your understanding is solid, call exit_plan with a complete, concrete plan: the goal, ordered steps naming exact files, risks/trade-offs, and how the result will be verified.
- If the user rejects the plan, ask what to adjust, revise, and call exit_plan again. Do not start executing without approval.`
      : "";
    return `You are an interactive coding agent, similar to Claude Code, running in a terminal.

Environment:
- Working directory: ${this.cwd}
- Platform: ${os.platform()} ${os.arch()}
- Today: ${new Date().toISOString().slice(0, 10)}
- Git status:\n${gitStatus}
${projectInstructions}${memory}
Rules:
1. Use tools to do the work; never pretend to have run something. If a tool fails, read the error, adjust, and retry - do not give up after one failure.
2. Before editing a file, read it. edit_file works best with EXACT text copied from read_file output (the "N\\t" prefixes are line numbers, not content); whitespace differences are tolerated as a fallback but indentation may shift, so verify with the diff it returns.
3. Do not use bash for things read_file/glob_files/grep can do. For long-running commands (dev servers, watchers) use bash with run_in_background and poll with bash_output; never block on them or use interactive editors/REPLs.
4. write_file/edit_file results include <diagnostics> from the language server for the file you touched. Fix every error before declaring the task done; use get_diagnostics to re-check.
5. Explore before acting when the task is unclear; act directly when it is not.
6. Use todo_write for multi-step tasks; keep exactly one item in_progress.
7. For open-ended codebase investigation (where is X defined, how does Y flow, survey this module), delegate to the task tool in research mode - it explores in its own context and reports back. For a well-scoped chunk of implementation you want done in parallel (fix a module, write tests for one file), delegate in worker mode. Read a known file directly instead of delegating single reads.
8. When the user's request is done, stop calling tools and give a short summary. Do not invent extra work.
9. Never commit, push, delete files, or touch credentials unless the user explicitly asks. When they do, use git_status to check state and git_commit / git_pr for those operations instead of raw bash git - they enforce branch and secret safety and show you what will change.
10. Be concise in replies: results and decisions, not narration.${planRules}`;
  }

  /**
   * Token footprint: exact API usage as an anchor plus a CJK-aware estimate
   * for anything appended since the last response.
   */
  tokenEstimate(): number {
    return this.tokens.count(this.messages);
  }

  get contextWindow(): number {
    return this.llm.contextWindow;
  }

  /** Force a compaction now (the /compact command). Returns false if history is too small. */
  async compactNow(events?: AgentEvents, signal?: AbortSignal): Promise<boolean> {
    if (this.messages.length < 6) return false;
    await this.compact(events, signal);
    return true;
  }

  /** Test/debug view of the current history. */
  debugMessages(): MessageParam[] {
    return this.messages;
  }

  /**
   * /review: LLM code review of uncommitted changes or a branch range.
   * Read-only; the call's cost is recorded like any other.
   */
  async review(target?: string, focus?: string, signal?: AbortSignal): Promise<string> {
    const bundle = await collectReview(this.cwd, target, signal);
    const res = await this.llm.send(
      [{ role: "user", content: buildReviewPrompt(bundle, focus) }],
      REVIEW_SYSTEM,
      [],
      signal,
    );
    this.costs.record(`${this.llm.provider}:${this.llm.model}`, {
      input: res.inputTokens,
      output: res.outputTokens,
      cacheRead: res.cacheReadTokens,
      cacheWrite: res.cacheWriteTokens,
    });
    const review = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    if (!review.trim()) throw new Error("the reviewer model returned no findings");
    return truncate(review, 20_000);
  }

  /**
   * LLM-summary compaction. Three stages:
   * 1. pre-prune stale tool_result output (free, no LLM call) - often this
   *    alone brings the history back under budget;
   * 2. summarize the old prefix with the model, merging in the previous
   *    handoff summary when this is a repeat compaction so nothing decays;
   * 3. restart history as [summary, ack] + recent tail. Falls back to
   *    exchange-group truncation if the summary call fails.
   */
  private async compact(events?: AgentEvents, signal?: AbortSignal) {
    if (this.messages.length < 6) return;
    events?.onCompacting?.();
    const budget = Math.floor(this.llm.contextWindow * COMPACT_TARGET_RATIO);

    // Stage 1: cheap pre-pruning of stale tool output before spending tokens.
    const original = this.tokenEstimate();
    const pruned = pruneOldToolResults(this.messages);
    if (pruned.changed > 0) {
      this.messages = pruned.messages;
      this.tokens.invalidate();
    }
    const before = this.tokenEstimate();
    if (before <= budget) {
      // Pruning alone was enough - no LLM call needed.
      events?.onCompacted?.(original, before);
      return;
    }

    const cut = pickCompactBoundary(this.messages);
    if (cut < 2) {
      // No meaningful prefix to summarize (history is one giant tool loop):
      // trim whole exchanges instead.
      this.messages = truncateTo(this.messages, budget);
      this.tokens.invalidate();
      events?.onCompacted?.(before, this.tokenEstimate());
      return;
    }
    const old = this.messages.slice(0, cut);
    const tail = this.messages.slice(cut);
    // Fold the previous handoff summary into the next one instead of letting
    // it fall out of the transcript untouched.
    const { summary: prior, rest } = extractPriorSummary(old);
    try {
      const res = await this.llm.send(
        [{ role: "user", content: buildSummarizerInput(renderTranscript(rest), prior) }],
        SUMMARIZER_SYSTEM,
        [],
        signal,
      );
      this.costs.record(`${this.llm.provider}:${this.llm.model}`, {
        input: res.inputTokens,
        output: res.outputTokens,
        cacheRead: res.cacheReadTokens,
        cacheWrite: res.cacheWriteTokens,
      });
      const summary = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      if (!summary.trim()) throw new Error("empty summary");
      this.messages = [buildSummaryMessage(summary), buildAckMessage(), ...tail];
      // Persist the handoff summary so decisions/gotchas outlive this session.
      const note = await appendMemoryNote(this.cwd, summary, new Date().toISOString().slice(0, 10));
      if (note) events?.onHook?.("compact", `handoff summary saved to ${note}`);
    } catch (err) {
      if (signal?.aborted) throw err; // user cancelled: leave history alone
      // Summarizer failed (or produced nothing): truncate whole exchanges
      // until the history comfortably fits the budget.
      this.messages = truncateTo(this.messages, budget);
    }
    this.tokens.invalidate();
    const after = this.tokenEstimate();
    if (after >= before) {
      // Summary didn't help (e.g. tiny history, huge tail): hard-trim the
      // oldest exchanges so we never loop compacting without progress.
      this.messages = truncateTo(this.messages, budget);
      this.tokens.invalidate();
    }
    events?.onCompacted?.(before, this.tokenEstimate());
  }

  /**
   * Run one user turn. `images` are base64 PNG/JPEG blocks pasted by the
   * user; they ride along in the first user message.
   */
  async chat(userText: string, signal?: AbortSignal, events?: AgentEvents, images?: ImageBlockParam[]): Promise<string> {
    let prompt = userText;
    if (this.hooks) {
      const hr = await this.hooks.run("UserPromptSubmit", { cwd: this.cwd, session_id: this.sessionId, prompt }, undefined);
      if (hr.blocked) throw new Error(`prompt blocked by hook: ${hr.reason}`);
      if (hr.context) prompt += `\n\n<hook_context>\n${hr.context}\n</hook_context>`;
      if (hr.reason) events?.onHook?.("UserPromptSubmit", hr.reason);
    }

    const content: Array<{ type: "text"; text: string } | ImageBlockParam> = [];
    if (prompt) content.push({ type: "text", text: prompt });
    for (const img of images ?? []) content.push(img);
    this.messages.push({ role: "user", content });
    let iterations = 0;
    let continuations = 0;
    const segments: string[] = [];

    while (iterations < MAX_TOOL_ITERATIONS) {
      if (signal?.aborted) throw new Error("aborted");
      if (this.tokenEstimate() > this.llm.contextWindow * COMPACT_RATIO) await this.compact(events, signal);

      const sent = this.messages.length;
      const activeTools = this.planMode ? [...tools.filter((t) => t.isReadOnly), exitPlanTool] : tools;
      const turn = await this.llm.send(this.messages, await this.systemPrompt(), activeTools, signal, events);
      this.tokens.setAnchor(sent, turn.inputTokens, turn.outputTokens);
      events?.onUsage?.(turn.inputTokens, turn.outputTokens);
      const spec = `${this.llm.provider}:${this.llm.model}`;
      this.costs.record(spec, {
        input: turn.inputTokens,
        output: turn.outputTokens,
        cacheRead: turn.cacheReadTokens,
        cacheWrite: turn.cacheWriteTokens,
      });
      const budget = this.costs.checkBudget();
      if (budget) {
        events?.onCostWarning?.(budget.message);
        if (budget.stop) {
          // End the turn cleanly: every tool_use still needs a tool_result or
          // the history would be invalid for the next request.
          this.messages.push({ role: "assistant", content: turn.content });
          if (turn.toolUses.length) {
            this.messages.push({
              role: "user",
              content: turn.toolUses.map((tu) => ({
                type: "tool_result" as const,
                tool_use_id: tu.id,
                content: "Not executed: the session's cost budget is exhausted.",
                is_error: true,
              })),
            });
          }
          segments.push(`\n\n[stopped: ${budget.message}]`);
          break;
        }
      }
      this.messages.push({ role: "assistant", content: turn.content });
      if (turn.text) segments.push(turn.text);

      if (turn.toolUses.length === 0) {
        // Output hit the per-response token cap: ask for the rest instead of
        // leaving the user with a half-finished answer.
        const truncated = turn.stopReason === "max_tokens" || turn.stopReason === "length";
        if (truncated && continuations < MAX_CONTINUATIONS) {
          continuations++;
          this.messages.push({
            role: "user",
            content: "Your previous message was cut off by the output token limit. Continue exactly where you left off, with no preamble or apology.",
          });
          continue;
        }
        if (truncated) segments.push("\n\n[stopped: output still truncated after continuing]");
        break;
      }
      iterations++;
      continuations = 0;

      // Run independent read-only tools concurrently; mutating tools stay
      // sequential so file edits and shell commands never interleave.
      const results: ToolResultBlockParam[] = new Array(turn.toolUses.length);
      const parallel = turn.toolUses.map((tu, i) => ({ tu, i })).filter(({ tu }) => getTool(tu.name)?.parallelSafe);
      const serial = turn.toolUses.map((tu, i) => ({ tu, i })).filter(({ tu }) => !getTool(tu.name)?.parallelSafe);

      await Promise.all(
        parallel.map(async ({ tu, i }) => {
          results[i] = await this.runTool(tu, signal, events);
        }),
      );
      for (const { tu, i } of serial) {
        results[i] = await this.runTool(tu, signal, events);
      }
      this.messages.push({ role: "user", content: results });
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      segments.push("\n\n[stopped: reached the tool-iteration limit]");
    }
    const finalText = segments.join("");

    if (this.hooks) {
      const hr = await this.hooks.run("Stop", { cwd: this.cwd, session_id: this.sessionId }, undefined);
      if (hr.context) events?.onHook?.("Stop", hr.context.slice(0, 500));
      if (hr.reason) events?.onHook?.("Stop", hr.reason);
    }

    let rewrote = false;
    if (this.persisted <= this.messages.length) {
      await appendMessages(this.sessionId, this.messages.slice(this.persisted));
    } else {
      await rewriteMessages(this.sessionId, this.messages); // history was compacted; rewrite
      rewrote = true;
    }
    this.persisted = this.messages.length;
    const spec = `${this.llm.provider}:${this.llm.model}`;
    if (rewrote || spec !== this.lastPersistedModel) {
      await appendModel(this.sessionId, spec);
      this.lastPersistedModel = spec;
    }
    return finalText;
  }

  private async runTool(tu: ToolUseBlock, signal: AbortSignal | undefined, events?: AgentEvents): Promise<ToolResultBlockParam> {
    // exit_plan is injected only in plan mode and lives outside the global registry.
    const tool = getTool(tu.name) ?? (tu.name === exitPlanTool.name ? exitPlanTool : undefined);
    const preview = JSON.stringify(tu.input).slice(0, 160);
    events?.onToolStart?.(tu.id, tu.name, preview);
    if (!tool) {
      return { type: "tool_result", tool_use_id: tu.id, content: `Unknown tool "${tu.name}".`, is_error: true };
    }
    if (this.planMode && !tool.isReadOnly && tool.name !== "exit_plan") {
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `Blocked: plan mode is active and "${tu.name}" modifies state. Explore read-only, then call exit_plan with your plan.`,
        is_error: true,
      };
    }
    if (this.hooks) {
      const hr = await this.hooks.run("PreToolUse", { cwd: this.cwd, session_id: this.sessionId, tool_input: tu.input as Record<string, unknown> }, tu.name);
      if (hr.reason) events?.onHook?.("PreToolUse", hr.reason);
      if (hr.blocked) {
        events?.onToolEnd?.(tu.id, tu.name, false, `blocked by hook: ${hr.reason}`);
        return { type: "tool_result", tool_use_id: tu.id, content: `Blocked by PreToolUse hook: ${hr.reason}`, is_error: true };
      }
    }
    try {
      const result = await tool.execute(tu.input as Record<string, unknown>, {
        cwd: this.cwd,
        signal,
        askPermission: (desc, risk, preview) => this.permissions.check(desc, risk, tool.isReadOnly, preview),
        checkpoint: (absPath, label) => this.checkpoints.capture(absPath, label).then(() => undefined),
        reportUsage: (usage) => this.costs.record(`${this.llm.provider}:${this.llm.model}`, usage),
        planMode: this.planMode,
        approvePlan: () => {
          this.planMode = false;
          events?.onPlanApproved?.();
        },
      });
      events?.onToolEnd?.(tu.id, tu.name, !result.isError, result.content.slice(0, 200));
      if (this.hooks) {
        const hr = await this.hooks.run("PostToolUse", {
          cwd: this.cwd,
          session_id: this.sessionId,
          tool_input: tu.input as Record<string, unknown>,
          tool_response: result.content.slice(0, 8000),
        }, tu.name);
        if (hr.reason) events?.onHook?.("PostToolUse", hr.reason);
        if (hr.context) result.content += `\n\n<hook_context>\n${hr.context}\n</hook_context>`;
      }
      return { type: "tool_result", tool_use_id: tu.id, content: result.content, is_error: result.isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      events?.onToolEnd?.(tu.id, tu.name, false, msg);
      return { type: "tool_result", tool_use_id: tu.id, content: `Tool crashed: ${msg}`, is_error: true };
    }
  }

  currentTodos() {
    return todoStore.items;
  }

  /** Read-only view of the conversation history (for UIs rendering transcripts). */
  getMessages(): readonly MessageParam[] {
    return this.messages;
  }

  /** Files the agent has modified so far this session (newest last). */
  checkpointList() {
    return this.checkpoints.list();
  }
  /** Roll back the most recent not-yet-undone file modification. */
  undoLastCheckpoint() {
    return this.checkpoints.undoLast();
  }

  resetSession(sessionId: string, history?: MessageParam[], modelSpec?: string) {
    this.sessionId = sessionId;
    this.checkpoints = new CheckpointStore(sessionId);
    this.messages = history ?? [];
    this.persisted = this.messages.length;
    this.lastPersistedModel = modelSpec ?? "";
    this.tokens.invalidate();
  }
}
