import type Anthropic from "@anthropic-ai/sdk";

export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
export type ImageBlockParam = Anthropic.Messages.ImageBlockParam;

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type Risk = "low" | "medium" | "high";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Ask the user to approve an operation. Returns true if allowed. */
  askPermission: (description: string, risk: Risk, preview?: string) => Promise<boolean>;
  /**
   * Copy the file's current content to the session checkpoint store before it
   * is modified (enables /undo). Best-effort: must never throw or block.
   */
  checkpoint?: (absPath: string, label: string) => Promise<void>;
  /** Report LLM token usage incurred by this tool (e.g. subagents) to the session cost tracker. */
  reportUsage?: (usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => void;
  /** True while the agent is in plan mode (read-only exploration before execution). */
  planMode?: boolean;
  /** Called by exit_plan when the user approves the plan; the agent leaves plan mode. */
  approvePlan?: () => void;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Anthropic.Messages.Tool["input_schema"];
  isReadOnly: boolean;
  /** Safe to run concurrently with other parallel-safe tools in the same turn (read-only, no shared state). */
  parallelSafe?: boolean;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function toAnthropicTool(t: Tool): Anthropic.Messages.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}
