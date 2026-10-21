import { describe, expect, it, vi } from "vitest";
import type { MessageParam, Tool } from "../src/types.js";

const h = vi.hoisted(() => ({ params: undefined as Record<string, any> | undefined }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, any>) => {
        h.params = params;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", message: { usage: { input_tokens: 7 } } };
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } };
            yield { type: "message_delta", usage: { output_tokens: 2 } };
          },
          async finalMessage() {
            return {
              content: [{ type: "text", text: "ok" }],
              usage: { input_tokens: 7, output_tokens: 2 },
              stop_reason: "end_turn",
            };
          },
        };
      },
    };
    constructor(_opts: Record<string, unknown>) {}
  }
  return { default: FakeAnthropic };
});

const { AnthropicBackend } = await import("../src/llm/anthropic.js");

function fakeTool(name: string): Tool {
  return {
    name,
    description: "d",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: "" }),
  };
}

describe("Anthropic prompt caching", () => {
  it("marks system, the last tool, and the last message block as cache breakpoints", async () => {
    const backend = new AnthropicBackend({ apiKey: "sk-test", model: "claude-sonnet-4-5" });
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "again" },
    ];

    const turn = await backend.send(messages, "SYSTEM", [fakeTool("a"), fakeTool("b")]);
    expect(turn.text).toBe("ok");

    const p = h.params!;
    expect(p.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(p.tools[0].cache_control).toBeUndefined();
    expect(p.tools[1].cache_control).toEqual({ type: "ephemeral" });
    // String content is normalized to a block array so the breakpoint can attach.
    expect(p.messages[2].content).toEqual([
      { type: "text", text: "again", cache_control: { type: "ephemeral" } },
    ]);
    expect(p.messages[1].content[0].cache_control).toBeUndefined();
    // The caller's history is copied, not mutated in place.
    expect(messages[2].content).toBe("again");
  });

  it("handles empty message and tool lists", async () => {
    const backend = new AnthropicBackend({ apiKey: "sk-test" });
    await backend.send([], "S", []);
    expect(h.params!.tools).toEqual([]);
    expect(h.params!.messages).toEqual([]);
  });

  it("splits the system prompt: breakpoint on the stable part, none on the volatile tail", async () => {
    const backend = new AnthropicBackend({ apiKey: "sk-test", model: "claude-sonnet-4-5" });
    await backend.send([], { stable: "STABLE RULES", volatile: "<session_status>git</session_status>" }, []);
    expect(h.params!.system).toEqual([
      { type: "text", text: "STABLE RULES", cache_control: { type: "ephemeral" } },
      { type: "text", text: "<session_status>git</session_status>" },
    ]);
  });

  it("omits empty system blocks", async () => {
    const backend = new AnthropicBackend({ apiKey: "sk-test" });
    await backend.send([], { stable: "", volatile: "V" }, []);
    expect(h.params!.system).toEqual([{ type: "text", text: "V" }]);
  });
});
