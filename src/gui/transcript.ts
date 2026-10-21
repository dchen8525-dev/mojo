import type { ContentBlockParam, MessageParam } from "../types.js";

/**
 * Server-side derivation of the persisted Anthropic-format history into
 * renderable UI items, plus the shape of an in-flight turn. Kept as pure
 * functions so the mapping is unit-testable and the browser stays dumb.
 */

export interface UiSubCall {
  name: string;
  /** Short JSON preview of the subagent call's arguments. */
  inputPreview: string;
  ok?: boolean;
  result?: string;
  /** The subagent's own model round (1-based), for the call-stack tree. */
  round?: number;
}

export interface UiTool {
  id: string;
  name: string;
  /** 1-based model round (one model response + the tools it asked for). */
  round: number;
  inputPreview: string;
  /** Structured arguments, long strings clipped — the card renders them field by field. */
  input?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  /** Only for the `task` tool: what the subagent did inside. */
  subCalls?: UiSubCall[];
}

export interface UiItem {
  kind: "user" | "assistant" | "tool" | "system" | "thinking";
  text?: string;
  images?: number; // count of image blocks (content redacted to a placeholder)
  tool?: UiTool;
}

/** A live (in-progress) assistant turn accumulated from SSE events. */
export interface UiTurn {
  turnId: number;
  text: string;
  thinking: string;
  tools: UiTool[];
  /** Current model round (1-based), updated by `round_start`. */
  round?: number;
  /** Per-round text/thinking, so a reconnecting tab redraws in stream order. */
  rounds?: Array<{ round: number; text: string; thinking: string }>;
}

function blocksToText(content: string | ContentBlockParam[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("");
}

/** Longest a single argument string may be before the UI clips it. */
export const ARG_CLIP = 600;
/** Longest tool result shipped to the browser. */
export const RESULT_CLIP = 8000;

export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（共 ${text.length} 字符，已截断）` : text;
}

/** Shallow copy of tool arguments with long strings shortened — cheap to ship, enough to render. */
export function clipInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > ARG_CLIP ? `${v.slice(0, ARG_CLIP)}…（共 ${v.length} 字符）` : v;
  }
  return out;
}

/**
 * Flatten a message history into UI items. Consecutive tool_use blocks and
 * their tool_result blocks are paired into a single tool card keyed by id.
 * Each assistant message starts a new round (`UiTool.round`).
 */
export function toUiTranscript(messages: readonly MessageParam[]): UiItem[] {
  const out: UiItem[] = [];
  const toolsById = new Map<string, UiTool>();
  let round = 1;

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim()) {
          round = 1; // a real user turn restarts the round numbering
          out.push({ kind: "user", text: content });
        }
        continue;
      }
      // tool_result blocks close the matching tool card; text blocks are user turns.
      let sawToolResult = false;
      for (const block of content) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type === "tool_result") {
          sawToolResult = true;
          const tool = toolsById.get(b.tool_use_id ?? "");
          if (tool) {
            tool.result = clipText(
              typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
              RESULT_CLIP,
            );
            tool.ok = !b.is_error;
          }
        } else if (b.type === "text") {
          const t = (b as { text: string }).text;
          if (t.trim()) {
            round = 1;
            out.push({ kind: "user", text: t });
          }
        } else if (b.type === "image") {
          round = 1;
          out.push({ kind: "user", text: "", images: 1 });
        }
      }
      if (sawToolResult) continue;
    } else {
      // assistant: thinking cards + text bubble + one card per tool_use
      const content = msg.content;
      const text = typeof content === "string" ? content : blocksToText(content as ContentBlockParam[]);
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; thinking?: string };
          if (b.type === "thinking" && (b.thinking ?? "").trim()) {
            out.push({ kind: "thinking", text: b.thinking });
          }
        }
      }
      if (text.trim()) out.push({ kind: "assistant", text });
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; id?: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.id) {
            const tool: UiTool = {
              id: b.id,
              name: b.name ?? "",
              round,
              inputPreview: JSON.stringify(b.input ?? {}).slice(0, 200),
              input: clipInput(b.input),
            };
            toolsById.set(b.id, tool);
            out.push({ kind: "tool", tool });
          }
        }
      }
      round += 1;
    }
  }
  return out;
}
