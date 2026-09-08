import os from "node:os";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ContentBlock, ImageBlockParam, MessageParam, ToolResultBlockParam, ToolUseBlock } from "./types.js";
import { LLM, type StreamEvents } from "./llm.js";
import { getTool, tools, todoStore } from "./tools/index.js";
import type { PermissionManager } from "./permissions.js";
import type { HookManager } from "./hooks.js";
import { TokenCounter } from "./tokens.js";
import { appendMessages, appendModel } from "./session.js";

const MAX_TOOL_ITERATIONS = 40;
const MAX_CONTINUATIONS = 3; // auto-resume cap after output hits the token limit
const COMPACT_RATIO = 0.75; // compact when estimate exceeds this share of the model's window

export interface AgentEvents extends StreamEvents {
  onToolStart?: (id: string, name: string, inputPreview: string) => void;
  onToolEnd?: (id: string, name: string, ok: boolean, preview: string) => void;
  onUsage?: (input: number, output: number) => void;
  onCompacting?: () => void;
  onHook?: (event: string, message: string) => void;
}

export class Agent {
  private llm = new LLM();
  private messages: MessageParam[] = [];
  private persisted = 0;
  private lastPersistedModel = "";
  private tokens = new TokenCounter();
  cwd: string;
  sessionId: string;
  private permissions: PermissionManager;
  private hooks?: HookManager;

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
    this.sessionId = sessionId;
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
    return `You are an interactive coding agent, similar to Claude Code, running in a terminal.

Environment:
- Working directory: ${this.cwd}
- Platform: ${os.platform()} ${os.arch()}
- Today: ${new Date().toISOString().slice(0, 10)}
- Git status:\n${gitStatus}
${projectInstructions}
Rules:
1. Use tools to do the work; never pretend to have run something. If a tool fails, read the error, adjust, and retry - do not give up after one failure.
2. Before editing a file, read it. edit_file needs EXACT text; copy indentation from read_file output (the "N\\t" prefixes are line numbers, not content).
3. Do not use bash for things read_file/glob_files/grep can do. Avoid interactive/long-running commands.
4. Explore before acting when the task is unclear; act directly when it is not.
5. Use todo_write for multi-step tasks; keep exactly one item in_progress.
6. For open-ended codebase investigation (where is X defined, how does Y flow, survey this module), delegate to the task tool with a self-contained prompt - it explores in its own context and reports back. Read a known file directly instead; never delegate edits or command runs.
7. When the user's request is done, stop calling tools and give a short summary. Do not invent extra work.
8. Never commit, push, delete files, or touch credentials unless the user explicitly asks.
9. Be concise in replies: results and decisions, not narration.`;
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

  /** Summarize old messages into one system-ish user message to stay under budget. */
  private async compact(events?: AgentEvents) {
    if (this.messages.length < 6) return;
    events?.onCompacting?.();
    const keep = 6;
    const old = this.messages.slice(0, this.messages.length - keep);
    const transcript = old
      .map((m) => {
        const c = m.content;
        const text =
          typeof c === "string"
            ? c
            : c
                .map((b) =>
                  b.type === "text" ? b.text : b.type === "tool_use" ? `[tool ${b.name}]` : b.type === "tool_result" ? "[tool result]" : "",
                )
                .join(" ");
        return `${m.role}: ${text.slice(0, 4000)}`;
      })
      .join("\n");
    try {
      const res = await this.llm.send(
        [{ role: "user", content: `Summarize this agent transcript in <=30 bullet points, preserving: user intent, files touched, decisions, open tasks, gotchas.\n\n${transcript}` }],
        "You are a summarizer. Output terse notes only.",
        [],
      );
      const summary = res.content.find((b) => b.type === "text")?.type === "text"
        ? (res.content.find((b) => b.type === "text") as { text: string }).text
        : "";
      this.messages = [
        { role: "user", content: `<context_compaction>\nEarlier conversation summary:\n${summary}\n</context_compaction>` },
        { role: "assistant", content: "Understood, I have the summary of the earlier work." },
        ...this.messages.slice(this.messages.length - keep),
      ];
      this.tokens.invalidate();
    } catch {
      // If compaction fails, drop the oldest third rather than crash.
      this.messages.splice(0, Math.floor(this.messages.length / 3));
      this.tokens.invalidate();
    }
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
      if (this.tokenEstimate() > this.llm.contextWindow * COMPACT_RATIO) await this.compact(events);

      const sent = this.messages.length;
      const turn = await this.llm.send(this.messages, await this.systemPrompt(), tools, signal, events);
      this.tokens.setAnchor(sent, turn.inputTokens, turn.outputTokens);
      events?.onUsage?.(turn.inputTokens, turn.outputTokens);
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

    if (this.persisted <= this.messages.length) {
      await appendMessages(this.sessionId, this.messages.slice(this.persisted));
    } else {
      await appendMessages(this.sessionId, this.messages); // history was compacted; rewrite
    }
    this.persisted = this.messages.length;
    const spec = `${this.llm.provider}:${this.llm.model}`;
    if (spec !== this.lastPersistedModel) {
      await appendModel(this.sessionId, spec);
      this.lastPersistedModel = spec;
    }
    return finalText;
  }

  private async runTool(tu: ToolUseBlock, signal: AbortSignal | undefined, events?: AgentEvents): Promise<ToolResultBlockParam> {
    const tool = getTool(tu.name);
    const preview = JSON.stringify(tu.input).slice(0, 160);
    events?.onToolStart?.(tu.id, tu.name, preview);
    if (!tool) {
      return { type: "tool_result", tool_use_id: tu.id, content: `Unknown tool "${tu.name}".`, is_error: true };
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
        askPermission: (desc, risk) => this.permissions.check(desc, risk, tool.isReadOnly),
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

  resetSession(sessionId: string, history?: MessageParam[], modelSpec?: string) {
    this.sessionId = sessionId;
    this.messages = history ?? [];
    this.persisted = this.messages.length;
    this.lastPersistedModel = modelSpec ?? "";
    this.tokens.invalidate();
  }
}
