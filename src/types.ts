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

type PropSchema = { type?: string; description?: string };
interface ObjectSchema {
  type?: string;
  properties?: Record<string, PropSchema>;
  required?: string[];
}

/** Lightweight check of a model-supplied tool input against the tool's schema.
 * Handles only the subset mojo's tools actually use: object root, `required`
 * presence, and primitive `type` checking. Returns null when valid, otherwise
 * a short, actionable message the model can act on.
 */
export function validateToolInput(schema: Anthropic.Messages.Tool["input_schema"], input: Record<string, unknown>): string | null {
  const s = schema as ObjectSchema | undefined;
  if (!s || !s.properties) return null; // no declared constraints to enforce
  for (const key of s.required ?? []) {
    if (input[key] === undefined || input[key] === null) {
      return `Missing required parameter "${key}".`;
    }
  }
  for (const [key, prop] of Object.entries(s.properties)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    const want = prop.type;
    const ok =
      want === "string" ? typeof v === "string" :
      want === "boolean" ? typeof v === "boolean" :
      want === "number" ? typeof v === "number" :
      want === "integer" ? Number.isInteger(v) :
      want === "array" ? Array.isArray(v) :
      want === "object" ? typeof v === "object" && !Array.isArray(v) :
      true;
    if (!ok) {
      return `Parameter "${key}" must be ${want}, got ${Array.isArray(v) ? "array" : typeof v}.`;
    }
  }
  return null;
}
