import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateMessageTokens, estimateMessagesTokens, TokenCounter } from "../src/tokens.js";
import type { MessageParam } from "../src/types.js";

describe("estimateTextTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  it("estimates latin text at ~4 chars/token", () => {
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
  });

  it("estimates CJK at >1 token per char", () => {
    const cjk = "你好世界测试文本"; // 8 chars
    expect(estimateTextTokens(cjk)).toBe(Math.ceil(8 * 1.15));
    expect(estimateTextTokens(cjk)).toBeGreaterThan(cjk.length);
  });

  it("handles mixed text without double counting", () => {
    const mixed = "你好 hello"; // 2 CJK + 6 rest (incl. space)
    expect(estimateTextTokens(mixed)).toBe(Math.ceil(2 * 1.15 + 6 / 4));
  });
});

describe("estimateMessageTokens", () => {
  it("adds framing overhead to string content", () => {
    const plain = estimateTextTokens("hi");
    expect(estimateMessageTokens({ role: "user", content: "hi" })).toBe(4 + plain);
  });

  it("bills images as large blocks", () => {
    const m = {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
    } as unknown as MessageParam;
    expect(estimateMessageTokens(m)).toBeGreaterThanOrEqual(1600);
  });

  it("counts tool_use input JSON", () => {
    const m: MessageParam = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } } as never],
    };
    expect(estimateMessageTokens(m)).toBeGreaterThan(12);
  });
});

describe("TokenCounter", () => {
  const msg = (text: string): MessageParam => ({ role: "user", content: text });

  it("returns the exact anchor when nothing was appended", () => {
    const c = new TokenCounter();
    const messages = [msg("one"), msg("two")];
    c.setAnchor(messages.length, 1000, 50);
    messages.push({ role: "assistant", content: "reply" }); // the reply the anchor covers
    expect(c.count(messages)).toBe(1050);
  });

  it("estimates only the delta after the anchor", () => {
    const c = new TokenCounter();
    const messages = [msg("one")];
    c.setAnchor(1, 100, 10);
    messages.push({ role: "assistant", content: "reply" });
    const extra = msg("a".repeat(400)); // ~100 tokens
    messages.push(extra);
    expect(c.count(messages)).toBe(110 + estimateMessageTokens(extra));
  });

  it("ignores anchors with zero input tokens (gateways without usage)", () => {
    const c = new TokenCounter();
    c.setAnchor(1, 0, 0);
    const messages = [msg("one"), msg("two")];
    // pure estimate, not anchored
    expect(c.count(messages)).toBe(estimateMessagesTokens(messages));
  });

  it("invalidates when history shrinks (compaction)", () => {
    const c = new TokenCounter();
    c.setAnchor(2, 5000, 100);
    const compacted = [msg("summary")];
    expect(c.count(compacted)).toBe(estimateMessagesTokens(compacted));
  });

  it("invalidate() resets to pure estimation", () => {
    const c = new TokenCounter();
    const messages = [msg("one"), msg("two")];
    c.setAnchor(1, 9999, 9999);
    c.invalidate();
    expect(c.count(messages)).toBe(estimateMessagesTokens(messages));
  });
});
