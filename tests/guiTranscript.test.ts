import { describe, expect, it } from "vitest";
import { toUiTranscript } from "../src/gui/transcript.js";
import type { MessageParam } from "../src/types.js";

describe("toUiTranscript", () => {
  it("maps plain string turns", () => {
    const items = toUiTranscript([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ] as MessageParam[]);
    expect(items).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi there" },
    ]);
  });

  it("pairs tool_use with its tool_result into one card", () => {
    const items = toUiTranscript([
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading now" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file body", is_error: false }],
      },
    ] as MessageParam[]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    const tool = items[1].tool!;
    expect(tool.name).toBe("read_file");
    expect(tool.result).toBe("file body");
    expect(tool.ok).toBe(true);
  });

  it("marks errored tool results", () => {
    const items = toUiTranscript([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
    ] as MessageParam[]);
    expect(items[0].tool?.ok).toBe(false);
  });

  it("renders image blocks as a count placeholder", () => {
    const items = toUiTranscript([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ] as MessageParam[]);
    expect(items[0]).toEqual({ kind: "user", text: "look at this" });
    expect(items[1]).toEqual({ kind: "user", text: "", images: 1 });
  });

  it("renders thinking blocks as their own item before the text", () => {
    const items = toUiTranscript([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me consider", signature: "sig" },
          { type: "text", text: "the answer" },
        ],
      },
    ] as unknown as MessageParam[]);
    expect(items).toEqual([
      { kind: "thinking", text: "let me consider" },
      { kind: "assistant", text: "the answer" },
    ]);
  });

  it("skips blank text blocks", () => {
    const items = toUiTranscript([
      { role: "user", content: [{ type: "text", text: "   " }] },
      { role: "assistant", content: [] },
    ] as unknown as MessageParam[]);
    expect(items).toHaveLength(0);
  });

  it("pairs multiple tools from one assistant message", () => {
    const items = toUiTranscript([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "grep", input: {} },
          { type: "tool_use", id: "b", name: "glob_files", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "b", content: "found", is_error: false },
          { type: "tool_result", tool_use_id: "a", content: "matches", is_error: false },
        ],
      },
    ] as MessageParam[]);
    const tools = items.filter((i) => i.kind === "tool").map((i) => i.tool!);
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.id === "a")?.result).toBe("matches");
    expect(tools.find((t) => t.id === "b")?.result).toBe("found");
  });

  it("numbers rounds per user turn and keeps structured args", () => {
    const items = toUiTranscript([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts", offset: 10, limit: 20 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "body", is_error: false }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "grep", input: { pattern: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "hit", is_error: false }] },
    ] as MessageParam[]);

    const tools = items.filter((i) => i.kind === "tool").map((i) => i.tool!);
    expect(tools.map((t) => t.round)).toEqual([1, 2]);
    expect(tools[0].input).toEqual({ path: "a.ts", offset: 10, limit: 20 });
  });

  it("restarts round numbering at the next user turn", () => {
    const items = toUiTranscript([
      { role: "user", content: "turn one" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "grep", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "turn two" },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "glob_files", input: {} }] },
    ] as MessageParam[]);

    const tools = items.filter((i) => i.kind === "tool").map((i) => i.tool!);
    expect(tools.map((t) => t.round)).toEqual([1, 1]);
  });

  it("clips long argument strings and long results", () => {
    const items = toUiTranscript([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "w", name: "write_file", input: { path: "big.ts", content: "x".repeat(5000) } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: "y".repeat(20_000), is_error: false }] },
    ] as MessageParam[]);

    const tool = items[0].tool!;
    expect(String(tool.input!.content).length).toBeLessThan(1000);
    expect(String(tool.input!.content)).toContain("共 5000 字符");
    expect(tool.result!.length).toBeLessThan(8300);
    expect(tool.result).toContain("已截断");
  });
});
