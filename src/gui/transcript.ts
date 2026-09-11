import type { ContentBlockParam, MessageParam } from "../types.js";

/**
 * Server-side derivation of the persisted Anthropic-format history into
 * renderable UI items, plus the shape of an in-flight turn. Kept as pure
 * functions so the mapping is unit-testable and the browser stays dumb.
 */

export interface UiTool {
  id: string;
  name: string;
  inputPreview: string;
  result?: string;
  ok?: boolean;
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
}

function blocksToText(content: string | ContentBlockParam[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Flatten a message history into UI items. Consecutive tool_use blocks and
 * their tool_result blocks are paired into a single tool card keyed by id.
 */
export function toUiTranscript(messages: readonly MessageParam[]): UiItem[] {
  const out: UiItem[] = [];
  const toolsById = new Map<string, UiTool>();

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim()) out.push({ kind: "user", text: content });
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
            tool.result = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            tool.ok = !b.is_error;
          }
        } else if (b.type === "text") {
          const t = (b as { text: string }).text;
          if (t.trim()) out.push({ kind: "user", text: t });
        } else if (b.type === "image") {
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
              inputPreview: JSON.stringify(b.input ?? {}).slice(0, 200),
            };
            toolsById.set(b.id, tool);
            out.push({ kind: "tool", tool });
          }
        }
      }
    }
  }
  return out;
}
