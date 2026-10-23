import type Anthropic from "@anthropic-ai/sdk";
import type { FileStateStore } from "./fileState.js";

export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
export type ImageBlockParam = Anthropic.Messages.ImageBlockParam;

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Images decoded from tool output (e.g. a data-URL screenshot on bash
   * stdout). Attached to the tool_result as content blocks alongside text.
   */
  images?: ImageBlockParam[];
}

export type Risk = "low" | "medium" | "high";

/** Handle returned by a checkpoint capture, finalized after the write lands. */
export interface CheckpointHandle {
  finalize: () => Promise<void>;
}

export interface ToolContext {
  cwd: string;
  /** Session that owns this tool call; used to route background-task notifications. */
  sessionId?: string;
  signal?: AbortSignal;
  /** Ask the user to approve an operation. Returns true if allowed. */
  askPermission: (description: string, risk: Risk, preview?: string) => Promise<boolean>;
  /**
   * Copy the file's current content to the session checkpoint store before it
   * is modified (enables /undo). Best-effort: must never throw or block. The
   * returned handle records the post-edit hash when finalize() is called.
   */
  checkpoint?: (absPath: string, label: string) => Promise<CheckpointHandle | void>;
  /** Report LLM token usage incurred by this tool (e.g. subagents) to the session cost tracker. */
  reportUsage?: (usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => void;
  /**
   * Report one tool call a tool itself performed on the user's behalf (the
   * `task` tool uses this so the GUI can show the subagent's call chain).
   * `round` is the subagent's own model round, for a call-stack style tree.
   */
  onSubTool?: (name: string, inputPreview: string, ok: boolean, preview: string, round?: number) => void;
  /**
   * Announce a subagent tool call the moment it starts, so a live viewer shows
   * the running row before the result exists (onSubTool then closes it).
   */
  onSubToolStart?: (name: string, inputPreview: string, round?: number) => void;
  /** True while the agent is in plan mode (read-only exploration before execution). */
  planMode?: boolean;
  /** Called by exit_plan when the user approves the plan; the agent leaves plan mode. May persist the plan asynchronously. */
  approvePlan?: (plan?: string) => void | Promise<void>;
  /**
   * Per-session read/write record. When present, edit_file/write_file refuse
   * files that were never read or changed on disk after the read.
   */
  fileState?: FileStateStore;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Anthropic.Messages.Tool["input_schema"];
  isReadOnly: boolean;
  /** Safe to run concurrently with other parallel-safe tools in the same turn (read-only, no shared state). */
  parallelSafe?: boolean;
  /**
   * Hidden from the model's tool list; discoverable via tool_search, which
   * exposes matches so they become callable. Used for bulky MCP servers.
   */
  deferred?: boolean;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function toAnthropicTool(t: Tool): Anthropic.Messages.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}

type PropSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: { type?: string };
};
interface ObjectSchema {
  type?: string;
  properties?: Record<string, PropSchema>;
  required?: string[];
}

function valueType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** Short JSON preview so the model sees exactly what it sent. */
function valuePreview(v: unknown): string {
  const json = JSON.stringify(v);
  if (json === undefined) return String(v);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

/** Edit distance, used only to suggest the intended key on a typo. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function closestKey(key: string, allowed: string[]): string | null {
  if (key.length < 3) return null;
  let best: string | null = null;
  let bestDist = 4; // suggestions only for distance <= 3
  for (const cand of allowed) {
    const d = editDistance(key.toLowerCase(), cand.toLowerCase());
    if (d < bestDist) {
      best = cand;
      bestDist = d;
    }
  }
  return best;
}

function matchesType(v: unknown, want: string | undefined): boolean {
  switch (want) {
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "number": return typeof v === "number";
    case "integer": return Number.isInteger(v);
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    default: return true;
  }
}

/** Lightweight check of a model-supplied tool input against the tool's schema.
 * Handles the subset mojo's tools actually use: object root, `required`
 * presence, primitive `type`, `enum`, and homogeneous `items`. Returns null
 * when valid, otherwise an actionable message naming the parameter, what was
 * expected, and what was received.
 */
export function validateToolInput(schema: Anthropic.Messages.Tool["input_schema"], input: Record<string, unknown>): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return `Tool input must be a JSON object, got ${valueType(input)}.`;
  }
  const s = schema as ObjectSchema | undefined;
  if (!s || !s.properties) return null; // no declared constraints to enforce
  const allowed = Object.keys(s.properties);

  for (const key of s.required ?? []) {
    if (input[key] === undefined || input[key] === null) {
      const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
      const hints: string[] = [];
      for (const k of unknown.slice(0, 3)) {
        const guess = closestKey(k, allowed);
        hints.push(guess ? `"${k}" (did you mean "${guess}"?)` : `"${k}"`);
      }
      const unknownNote = hints.length
        ? ` Unknown parameter${hints.length === 1 ? "" : "s"}: ${hints.join(", ")}.`
        : "";
      return `Missing required parameter "${key}".${unknownNote} Available parameters: ${allowed.join(", ")}.`;
    }
  }

  for (const [key, prop] of Object.entries(s.properties)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (!matchesType(v, prop.type)) {
      return `Parameter "${key}" must be ${prop.type}, got ${valueType(v)} (${valuePreview(v)}).`;
    }
    if (prop.enum && !prop.enum.some((e) => e === v)) {
      return `Parameter "${key}" must be one of: ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}; got ${valuePreview(v)}.`;
    }
    if (prop.type === "array" && prop.items?.type && Array.isArray(v)) {
      const bad = v.findIndex((item) => !matchesType(item, prop.items!.type));
      if (bad >= 0) {
        return `Parameter "${key}" must be an array of ${prop.items.type}; item ${bad} is ${valueType(v[bad])} (${valuePreview(v[bad])}).`;
      }
    }
  }
  return null;
}
