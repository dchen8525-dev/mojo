import type { ToolUseBlock } from "../types.js";
import type { StreamEvents } from "./types.js";

/**
 * Parse arguments that arrived as a stream of JSON fragments. `undefined`
 * means the JSON is incomplete/broken (nothing may run); a parsed non-object
 * becomes `{}` so the tool reports a validation error instead of crashing.
 */
export function parseToolInput(json: string): Record<string, unknown> | undefined {
  if (!json.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/**
 * Anthropic closes every content block with `content_block_stop`, so a
 * tool_use call is fully known before the rest of the response streams. Keep
 * one entry per block index and announce it when the block closes.
 */
export class ToolBlockAccumulator {
  private pending = new Map<number, { id: string; name: string; json: string }>();

  constructor(private readonly events?: StreamEvents) {}

  start(index: number, block: { id: string; name: string }) {
    this.pending.set(index, { id: block.id, name: block.name, json: "" });
  }

  append(index: number, partialJson: string) {
    const call = this.pending.get(index);
    if (call) call.json += partialJson;
  }

  stop(index: number): ToolUseBlock | undefined {
    const call = this.pending.get(index);
    if (!call) return undefined;
    this.pending.delete(index);
    const input = parseToolInput(call.json);
    if (!input) return undefined;
    const block: ToolUseBlock = { type: "tool_use", id: call.id, name: call.name, input, caller: { type: "direct" } };
    this.events?.onToolReady?.(block);
    return block;
  }
}

/**
 * OpenAI has no block-stop event. A call is complete once the next call
 * index starts (parallel calls stream sequentially), so the caller flushes
 * every earlier call at that point. A call without an id is not announced:
 * the backend assigns ids later and matching would be ambiguous.
 */
export function readyToolCall(call: { id: string; name: string; args: string }): ToolUseBlock | undefined {
  if (!call.id || !call.name) return undefined;
  const input = parseToolInput(call.args);
  if (!input) return undefined;
  return { type: "tool_use", id: call.id, name: call.name, input, caller: { type: "direct" } };
}
