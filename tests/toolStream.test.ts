import { describe, expect, it } from "vitest";
import type { ToolUseBlock } from "../src/types.js";
import { ToolBlockAccumulator, parseToolInput, readyToolCall } from "../src/llm/toolStream.js";

describe("parseToolInput", () => {
  it("treats empty arguments as an empty object", () => {
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput("   ")).toEqual({});
  });

  it("parses a complete JSON object", () => {
    expect(parseToolInput('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  it("returns undefined while the JSON is incomplete or broken", () => {
    expect(parseToolInput('{"path":')).toBeUndefined();
    expect(parseToolInput("{oops}")).toBeUndefined();
  });

  it("maps non-object JSON to {} so the tool reports a validation error", () => {
    expect(parseToolInput("null")).toEqual({});
    expect(parseToolInput("[1,2]")).toEqual({});
    expect(parseToolInput("42")).toEqual({});
  });
});

describe("ToolBlockAccumulator", () => {
  it("announces a block only once it closes with valid input", () => {
    const ready: ToolUseBlock[] = [];
    const acc = new ToolBlockAccumulator({ onToolReady: (t) => ready.push(t) });
    acc.start(0, { id: "t1", name: "read_file" });
    acc.append(0, '{"pa');
    expect(ready).toHaveLength(0);
    acc.append(0, 'th":"a.ts"}');
    expect(ready).toHaveLength(0); // still streaming
    expect(acc.stop(0)).toMatchObject({ id: "t1", name: "read_file", input: { path: "a.ts" } });
    expect(ready).toHaveLength(1);
    expect(acc.stop(0)).toBeUndefined(); // closed only once
    expect(ready).toHaveLength(1);
  });

  it("skips a block whose arguments never became valid JSON", () => {
    const ready: ToolUseBlock[] = [];
    const acc = new ToolBlockAccumulator({ onToolReady: (t) => ready.push(t) });
    acc.start(0, { id: "t1", name: "read_file" });
    acc.append(0, '{"path":');
    expect(acc.stop(0)).toBeUndefined();
    expect(ready).toHaveLength(0);
  });

  it("ignores stops for blocks that never started (text blocks)", () => {
    const ready: ToolUseBlock[] = [];
    const acc = new ToolBlockAccumulator({ onToolReady: (t) => ready.push(t) });
    expect(acc.stop(1)).toBeUndefined();
    expect(ready).toHaveLength(0);
  });
});

describe("readyToolCall", () => {
  it("builds a direct tool_use block from a complete call", () => {
    expect(readyToolCall({ id: "c1", name: "grep", args: '{"pattern":"x"}' })).toEqual({
      type: "tool_use",
      id: "c1",
      name: "grep",
      input: { pattern: "x" },
      caller: { type: "direct" },
    });
  });

  it("refuses calls without an id or name", () => {
    expect(readyToolCall({ id: "", name: "grep", args: "{}" })).toBeUndefined();
    expect(readyToolCall({ id: "c1", name: "", args: "{}" })).toBeUndefined();
  });

  it("refuses calls with incomplete arguments", () => {
    expect(readyToolCall({ id: "c1", name: "grep", args: '{"pattern":' })).toBeUndefined();
  });
});
