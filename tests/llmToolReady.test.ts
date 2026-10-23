import { describe, expect, it, vi } from "vitest";
import type { MessageParam } from "../src/types.js";

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t1", name: "read_file" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
          };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } };
          yield { type: "message_delta", usage: { output_tokens: 3 } };
        },
        async finalMessage() {
          return {
            content: [
              { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
              { type: "text", text: "done" },
            ],
            usage: { input_tokens: 10, output_tokens: 3 },
            stop_reason: "tool_use",
          };
        },
      }),
    };
    constructor(_opts: Record<string, unknown>) {}
  }
  return { default: FakeAnthropic };
});

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async () =>
          (async function* () {
            yield {
              choices: [
                { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } },
              ],
            };
            yield {
              choices: [
                { delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "grep", arguments: '{"pattern":"x"}' } }] } },
              ],
            };
            yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
          })(),
      },
    };
    models = { list: async () => ({ data: [] }) };
    constructor(_opts: Record<string, unknown>) {}
  }
  return { default: FakeOpenAI };
});

const { AnthropicBackend } = await import("../src/llm/anthropic.js");
const { OpenAiBackend } = await import("../src/llm/openai.js");

const user = [{ role: "user", content: "go" }] as MessageParam[];

describe("Anthropic early tool readiness", () => {
  it("announces a tool at content_block_stop, before the text that follows", async () => {
    const order: string[] = [];
    const backend = new AnthropicBackend({ apiKey: "sk-test", model: "claude-sonnet-4-5" });
    const turn = await backend.send(user, "SYS", [], undefined, {
      onToolReady: (t) => order.push(`ready:${t.name}:${t.id}:${JSON.stringify(t.input)}`),
      onTextDelta: (d) => order.push(`text:${d}`),
    });
    expect(order).toEqual(['ready:read_file:t1:{"path":"a.ts"}', "text:done"]);
    expect(turn.toolUses.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("OpenAI early tool readiness", () => {
  it("announces earlier calls when the next call index starts", async () => {
    const ready: string[] = [];
    const backend = new OpenAiBackend({ apiKey: "sk-test", model: "gpt-4o" });
    const turn = await backend.send(user, "SYS", [], undefined, {
      onToolReady: (t) => ready.push(t.id),
    });
    // c2 is only known to be complete at stream end, so it is not announced.
    expect(ready).toEqual(["c1"]);
    expect(turn.toolUses.map((t) => t.id)).toEqual(["c1", "c2"]);
  });
});
