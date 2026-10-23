import type { MessageParam, Tool } from "./types.js";

/**
 * Token accounting.
 *
 * The provider's own tokenizer is the only source of truth, and every API
 * response reports the exact input token count for the messages we sent. So
 * we keep that as an anchor and only estimate the *delta* - the messages
 * appended after the last response (tool results, new user turns). The delta
 * estimate is CJK-aware, which removes the ~20% error a plain chars/3.5 rule
 * has on Chinese text.
 */

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_GLOBAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** CJK-aware token estimate for a chunk of text. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_GLOBAL) || []).length;
  const rest = text.length - cjk;
  // CJK: ~1 token per char (Claude's tokenizer sometimes splits to 2, so add
  // a small safety factor). Latin/code: ~4 chars per token.
  return Math.ceil(cjk * 1.15 + rest / 4);
}

/** Estimate tokens contributed by one message's content. */
export function estimateMessageTokens(m: MessageParam): number {
  let total = 4; // per-message framing overhead
  const c = m.content as unknown;
  if (typeof c === "string") return total + estimateTextTokens(c);
  for (const b of c as Array<Record<string, unknown>>) {
    switch (b.type) {
      case "text":
        total += estimateTextTokens(String(b.text ?? ""));
        break;
      case "thinking":
        total += estimateTextTokens(String(b.thinking ?? ""));
        break;
      case "tool_use": {
        total += estimateTextTokens(String(b.name ?? "")) + 12;
        try {
          total += estimateTextTokens(JSON.stringify(b.input ?? {}));
        } catch {
          total += 32;
        }
        break;
      }
      case "tool_result": {
        total += 8;
        const rc = b.content;
        if (typeof rc === "string") total += estimateTextTokens(rc);
        else if (Array.isArray(rc))
          for (const part of rc as Array<Record<string, unknown>>) {
            if (part.type === "text") total += estimateTextTokens(String(part.text ?? ""));
            else if (part.type === "image") total += 1600; // images are billed as large blocks
          }
        break;
      }
      case "image":
        total += 1600;
        break;
      default:
        total += estimateTextTokens(JSON.stringify(b));
    }
  }
  return total;
}

export function estimateMessagesTokens(messages: MessageParam[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/** Same units as the request body: name, description and the JSON schema. */
export function estimateToolTokens(tools: readonly Tool[]): number {
  let n = 0;
  for (const tool of tools) {
    n += 12 + estimateTextTokens(tool.name) + estimateTextTokens(tool.description ?? "");
    try {
      n += estimateTextTokens(JSON.stringify(tool.inputSchema ?? {}));
    } catch {
      n += 64;
    }
  }
  return n;
}

export interface HistoryBreakdown {
  total: number;
  userText: number;
  assistantText: number;
  thinking: number;
  toolUse: number;
  toolResult: number;
  images: number;
  other: number;
}

/**
 * Per-category estimate of the history (what /context shows under the
 * anchored footprint). Category sums are estimates and need not equal the
 * provider's exact input count.
 */
export function estimateHistoryBreakdown(messages: MessageParam[]): HistoryBreakdown {
  const out: HistoryBreakdown = {
    total: 0,
    userText: 0,
    assistantText: 0,
    thinking: 0,
    toolUse: 0,
    toolResult: 0,
    images: 0,
    other: 0,
  };
  const add = (key: keyof Omit<HistoryBreakdown, "total">, n: number) => {
    out[key] += n;
    out.total += n;
  };
  for (const m of messages) {
    add("other", 4); // per-message framing
    const content = m.content as unknown;
    if (typeof content === "string") {
      add(m.role === "assistant" ? "assistantText" : "userText", estimateTextTokens(content));
      continue;
    }
    for (const block of content as Array<Record<string, unknown>>) {
      switch (block.type) {
        case "text":
          add(m.role === "assistant" ? "assistantText" : "userText", estimateTextTokens(String(block.text ?? "")));
          break;
        case "thinking":
          add("thinking", estimateTextTokens(String(block.thinking ?? "")));
          break;
        case "tool_use":
          add("toolUse", estimateTextTokens(String(block.name ?? "")) + 12);
          try {
            add("toolUse", estimateTextTokens(JSON.stringify(block.input ?? {})));
          } catch {
            add("toolUse", 32);
          }
          break;
        case "tool_result": {
          add("toolResult", 8);
          const inner = block.content;
          if (typeof inner === "string") add("toolResult", estimateTextTokens(inner));
          else if (Array.isArray(inner))
            for (const part of inner as Array<Record<string, unknown>>) {
              if (part.type === "text") add("toolResult", estimateTextTokens(String(part.text ?? "")));
              else if (part.type === "image") add("images", 1600);
            }
          break;
        }
        case "image":
          add("images", 1600);
          break;
        default:
          add("other", estimateTextTokens(JSON.stringify(block)));
      }
    }
  }
  return out;
}

/**
 * Tracks an exact anchor reported by the API and estimates only what has been
 * appended since. Invalidated whenever history is rewritten (compaction,
 * resume, clear).
 */
export class TokenCounter {
  private anchorTokens = 0;
  private anchorCount = 0;

  /** True when a provider-reported usage anchor is driving the count. */
  get anchored(): boolean {
    return this.anchorCount > 0;
  }

  invalidate() {
    this.anchorTokens = 0;
    this.anchorCount = 0;
  }

  /**
   * Record the provider's exact count for `messagesSent` as they were sent.
   * The anchor covers the assistant reply that is about to be appended, so
   * `messagesSent + 1` becomes the anchored prefix length.
   */
  setAnchor(messagesSent: number, inputTokens: number, outputTokens: number) {
    if (inputTokens <= 0) return; // some gateways omit usage; keep the estimate
    this.anchorTokens = inputTokens + outputTokens;
    this.anchorCount = messagesSent + 1;
  }

  /** Current token footprint of the whole history. */
  count(messages: MessageParam[]): number {
    if (this.anchorCount > messages.length) this.invalidate(); // history rewritten
    if (this.anchorCount === messages.length) return this.anchorTokens;
    const delta = messages.slice(this.anchorCount);
    return this.anchorTokens + estimateMessagesTokens(delta);
  }
}
