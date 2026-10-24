import { describe, expect, it } from "vitest";
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateHistoryBreakdown,
  estimateToolTokens,
  TokenCounter,
} from "../src/tokens.js";
import type { MessageParam, Tool } from "../src/types.js";

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

describe("estimateToolTokens", () => {
  const tool = {
    name: "read_file",
    description: "Read a file from disk",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  } as unknown as Tool;

  it("returns 0 for an empty tool list", () => {
    expect(estimateToolTokens([])).toBe(0);
  });

  it("charges name, description, and schema per tool", () => {
    expect(estimateToolTokens([tool])).toBeGreaterThan(20);
    expect(estimateToolTokens([tool, tool])).toBe(estimateToolTokens([tool]) * 2);
  });
});

describe("estimateHistoryBreakdown", () => {
  it("agrees with estimateMessagesTokens while splitting categories", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file body" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    ] as unknown as MessageParam[];
    const b = estimateHistoryBreakdown(messages);
    expect(b.total).toBe(estimateMessagesTokens(messages));
    expect(b.total).toBe(
      b.userText + b.assistantText + b.thinking + b.toolUse + b.toolResult + b.images + b.other,
    );
    expect(b.userText).toBeGreaterThan(0);
    expect(b.assistantText).toBeGreaterThan(0);
    expect(b.toolUse).toBeGreaterThan(0);
    expect(b.toolResult).toBeGreaterThan(0);
    expect(b.images).toBe(1600);
    expect(b.thinking).toBe(0);
  });

  it("counts images nested inside tool results", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
          },
        ],
      },
    ] as unknown as MessageParam[];
    const b = estimateHistoryBreakdown(messages);
    expect(b.images).toBe(1600);
    expect(b.toolResult).toBe(8);
  });
});

describe("TokenCounter", () => {
  const msg = (text: string): MessageParam => ({ role: "user", content: text });

  it("returns the exact anchor when nothing was appended", () => {
    const c = new TokenCounter();
    const messages = [msg("one"), msg("two")];
    expect(c.anchored).toBe(false);
    c.setAnchor(messages.length, 1000, 50);
    expect(c.anchored).toBe(true);
    messages.push({ role: "assistant", content: "reply" }); // the reply the anchor covers
    expect(c.count(messages)).toBe(1050);
  });

  it("counts cache read/write tokens as context footprint", () => {
    const c = new TokenCounter();
    const messages = [msg("one"), msg("two"), { role: "assistant", content: "reply" } as MessageParam];
    // Providers report cached prompt tokens outside inputTokens, but they
    // still occupy the context window.
    c.setAnchor(2, 1000, 50, 3000);
    expect(c.count(messages)).toBe(4050);
    expect(c.snapshot()).toEqual({ count: 3, tokens: 4050 });
  });

  it("anchors when every prompt token was served from cache", () => {
    const c = new TokenCounter();
    const messages = [msg("one"), { role: "assistant", content: "reply" } as MessageParam];
    c.setAnchor(1, 0, 40, 2000); // no fresh input, but usage was reported
    expect(c.anchored).toBe(true);
    expect(c.count(messages)).toBe(2040);
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

  it("snapshot() reports the live anchor or null", () => {
    const c = new TokenCounter();
    expect(c.snapshot()).toBeNull();
    c.setAnchor(2, 500, 50);
    expect(c.snapshot()).toEqual({ count: 3, tokens: 550 });
    c.invalidate();
    expect(c.snapshot()).toBeNull();
  });

  it("restoreAnchor() re-attaches a persisted anchor", () => {
    const c = new TokenCounter();
    const messages = [msg("one")]; // anchor covers message 0 + its reply
    c.restoreAnchor(1, 4321);
    expect(c.anchored).toBe(true);
    expect(c.count(messages)).toBe(4321);
    expect(c.snapshot()).toEqual({ count: 1, tokens: 4321 });
    // Invalid inputs are ignored, not fatal.
    c.restoreAnchor(0, 100);
    c.restoreAnchor(-3, 100);
    c.restoreAnchor(1, 0);
    expect(c.snapshot()).toEqual({ count: 1, tokens: 4321 });
  });

  it("a restored anchor that is longer than the history is rejected by count()", () => {
    const c = new TokenCounter();
    c.restoreAnchor(10, 90_000); // e.g. history compacted after the save
    const short = [msg("one"), msg("two")];
    expect(c.count(short)).toBe(estimateMessagesTokens(short));
    expect(c.anchored).toBe(false);
  });
});
