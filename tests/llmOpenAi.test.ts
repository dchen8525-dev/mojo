import { describe, expect, it } from "vitest";
import type { MessageParam } from "../src/types.js";
import { finalizeToolCalls, mergeToolCallDelta, toOpenAiMessages } from "../src/llm/openai.js";

describe("toOpenAiMessages", () => {
  it("keeps images when switching an Anthropic-format history to OpenAI", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://example.com/x.jpg" } },
        ],
      },
    ] as unknown as MessageParam[];
    const out = toOpenAiMessages(messages);
    expect(out).toHaveLength(1);
    const content = (out[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
    ]);
  });

  it("converts tool calls and tool results", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "hello" },
          { type: "text", text: "and now?" },
        ],
      },
    ] as unknown as MessageParam[];
    const out = toOpenAiMessages(messages);
    expect(out[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "t1", content: "hello" });
    expect(out[2]).toEqual({ role: "user", content: "and now?" });
  });

  it("keeps a plain string user message untouched", () => {
    expect(toOpenAiMessages([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("mergeToolCallDelta", () => {
  it("accumulates indexed argument fragments", () => {
    const calls: Parameters<typeof mergeToolCallDelta>[0] = [];
    mergeToolCallDelta(calls, { index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } });
    mergeToolCallDelta(calls, { index: 0, function: { arguments: 'th":"x"}' } });
    expect(calls).toEqual([{ index: 0, id: "c1", name: "read_file", args: '{"path":"x"}' }]);
  });

  it("ignores a resent full function name", () => {
    const calls: Parameters<typeof mergeToolCallDelta>[0] = [];
    mergeToolCallDelta(calls, { index: 0, id: "c1", function: { name: "bash", arguments: "{" } });
    mergeToolCallDelta(calls, { index: 0, function: { name: "bash", arguments: "}" } });
    expect(calls[0].name).toBe("bash");
    expect(calls[0].args).toBe("{}");
  });

  it("attaches id-less, index-less chunks to the previous call", () => {
    const calls: Parameters<typeof mergeToolCallDelta>[0] = [];
    mergeToolCallDelta(calls, { id: "c1", function: { name: "grep", arguments: '{"pat' } });
    mergeToolCallDelta(calls, { function: { arguments: 'tern":"x"}' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBe('{"pattern":"x"}');
  });

  it("separates calls that only carry an index", () => {
    const calls: Parameters<typeof mergeToolCallDelta>[0] = [];
    mergeToolCallDelta(calls, { index: 0, function: { name: "a", arguments: "{}" } });
    mergeToolCallDelta(calls, { index: 1, function: { name: "b", arguments: "{}" } });
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("finalizeToolCalls", () => {
  it("parses arguments and tolerates malformed or non-object JSON", () => {
    const calls = [
      { index: 0, id: "c1", name: "read_file", args: '{"path":"a"}' },
      { index: 1, id: "c2", name: "grep", args: '{"pattern":' },
      { index: 2, id: "c3", name: "glob_files", args: "null" },
    ];
    const { toolUses } = finalizeToolCalls(calls, "tool_calls");
    expect(toolUses.map((t) => t.input)).toEqual([{ path: "a" }, {}, {}]);
  });

  it("drops the whole batch when the response was truncated by max tokens", () => {
    const calls = [{ index: 0, id: "c1", name: "bash", args: '{"command":"rm -rf ' }];
    expect(finalizeToolCalls(calls, "length")).toEqual({ toolUses: [], blocks: [] });
  });
});
