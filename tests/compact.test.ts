import { describe, expect, it } from "vitest";
import type { ContentBlock, MessageParam } from "../src/types.js";
import {
  buildAckMessage,
  buildSummarizerInput,
  buildSummaryMessage,
  extractPriorSummary,
  pickCompactBoundary,
  pruneOldToolResults,
  renderTranscript,
  SUMMARIZER_PROMPT,
  truncateTo,
} from "../src/compact.js";

const user = (text: string): MessageParam => ({ role: "user", content: text });
const assistant = (text: string): MessageParam => ({ role: "assistant", content: text });
const userToolResult = (id: string, text: string): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});
const assistantToolUse = (id: string, name: string, input: unknown): MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input } as unknown as ContentBlock[]],
});

describe("pickCompactBoundary", () => {
  it("keeps the requested tail when it starts at a plain user message", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e"), assistant("f"), user("g"), assistant("h")];
    // length 8, keepMin 6 -> cut = 8-6 = 2 = user("c"): plain user, stays.
    expect(pickCompactBoundary(msgs)).toBe(2);
  });

  it("walks back over tool_result messages so the tail never starts mid tool-loop", () => {
    const msgs = [
      user("start"),
      assistantToolUse("t1", "read_file", {}),
      userToolResult("t1", "data"),
      assistant("done"),
      user("next"),
      assistantToolUse("t2", "bash", {}),
      userToolResult("t2", "out"),
      assistant("finished"),
    ];
    // keepMin 6 -> cut 2 (a tool_result). Must walk back to index 0... but 0 is
    // the plain user("start") boundary.
    const cut = pickCompactBoundary(msgs, 6);
    expect(cut).toBe(0);
  });

  it("lands on a plain user message between tool loops", () => {
    const msgs = [
      user("q1"),
      assistantToolUse("t1", "x", {}),
      userToolResult("t1", "r"),
      assistant("a1"),
      user("q2"),
      assistantToolUse("t2", "y", {}),
      userToolResult("t2", "r2"),
      assistant("a2"),
      user("q3"),
      assistant("a3"),
    ];
    // keepMin 6 -> cut 4 = user("q2"): plain user, valid boundary.
    expect(pickCompactBoundary(msgs)).toBe(4);
  });

  it("returns 0 for tiny histories", () => {
    expect(pickCompactBoundary([user("a"), assistant("b")])).toBe(0);
  });
});

describe("renderTranscript", () => {
  it("renders roles, tool calls and condensed tool results", () => {
    const msgs = [
      user("fix the bug"),
      assistantToolUse("t1", "edit_file", { path: "a.ts" }),
      userToolResult("t1", "Edited a.ts\nline2\nline3\nline4\nline5\nline6\nline7\nline8"),
      assistant("fixed it"),
    ];
    const out = renderTranscript(msgs);
    expect(out).toContain("USER: fix the bug");
    expect(out).toContain("ASSISTANT: [calls edit_file");
    expect(out).toContain("tool result");
    expect(out).toContain("line6"); // up to 6 lines kept
    expect(out).not.toContain("line7");
    expect(out).toContain("ASSISTANT: fixed it");
  });

  it("marks errored tool results", () => {
    const m: MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }],
    };
    expect(renderTranscript([m])).toContain("tool ERROR");
  });
});

describe("summary message builders", () => {
  it("wraps the summary in a context_compaction tag", () => {
    const m = buildSummaryMessage("## Task\n- do it");
    expect(m.role).toBe("user");
    const c = m.content as string;
    expect(c).toContain("<context_compaction>");
    expect(c).toContain("## Task");
  });

  it("handles an empty summary without breaking the tag", () => {
    const c = buildSummaryMessage("   ").content as string;
    expect(c).toContain("(summary unavailable)");
  });

  it("ack is an assistant message", () => {
    expect(buildAckMessage().role).toBe("assistant");
  });
});

describe("truncateTo", () => {
  it("drops whole exchanges from the front until under budget", () => {
    const big = "x".repeat(4000); // ~1000 tokens per message
    const msgs = [user(big), assistant(big), user(big), assistant(big), user("keep me"), assistant("kept")];
    const out = truncateTo(msgs, 2500);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[out.length - 1].content).toBe("kept");
    // Never starts with an assistant message or a tool_result-only user turn.
    expect(out[0].role).toBe("user");
    expect(typeof out[0].content).toBe("string");
  });

  it("keeps everything when already under budget", () => {
    const msgs = [user("a"), assistant("b")];
    expect(truncateTo(msgs, 10_000)).toEqual(msgs);
  });

  it("never drops below two messages", () => {
    const big = "x".repeat(40_000);
    const msgs = [user(big), assistant(big)];
    expect(truncateTo(msgs, 10)).toHaveLength(2);
  });

  it("preserves tool_use/tool_result pairs inside kept exchanges", () => {
    const big = "x".repeat(4000); // ~1000 tokens
    const msgs = [
      user(big),
      assistant(big),
      user("real question"),
      assistantToolUse("t1", "bash", { cmd: "ls" }),
      userToolResult("t1", "files"),
      assistant("answer"),
    ];
    // ~1004 tokens per big message; budget 1500 drops exactly the first exchange.
    const out = truncateTo(msgs, 1500);
    expect(out[0].content).toBe("real question");
    expect(out).toHaveLength(4);
    expect(out[1].role).toBe("assistant");
    expect(out[2].role).toBe("user");
  });
});

describe("pruneOldToolResults", () => {
  // Build a history where the OLD tool results are huge but the recent ones
  // (last `protectLast`) must survive untouched.
  const history = (n: number, size: number): MessageParam[] => {
    const msgs: MessageParam[] = [];
    for (let i = 0; i < n; i++) {
      msgs.push(user(`q${i}`));
      msgs.push(assistantToolUse(`t${i}`, "read_file", {}));
      msgs.push(userToolResult(`t${i}`, "L".repeat(size)));
      msgs.push(assistant(`a${i}`));
    }
    return msgs;
  };

  it("collapses the tail of stale tool results but keeps a head", () => {
    const msgs = history(6, 5000); // 24 messages, protectLast=12 leaves 12 old
    const { messages, changed, savedChars } = pruneOldToolResults(msgs, 12, 2000);
    expect(changed).toBeGreaterThan(0);
    expect(savedChars).toBeGreaterThan(0);
    // An early (pruned) tool result is now short and carries the marker.
    const early = messages[2].content as Array<{ content: string }>;
    expect(early[0].content.length).toBeLessThan(5000);
    expect(early[0].content).toContain("stale tool output pruned");
    // The most recent tool result is untouched.
    const lastTr = messages[messages.length - 2].content as Array<{ content: string }>;
    expect(lastTr[0].content).toBe("L".repeat(5000));
  });

  it("leaves small tool results and non-tool blocks alone", () => {
    const msgs = [user("hi"), userToolResult("t1", "short"), assistant("ok")];
    const { messages, changed } = pruneOldToolResults(msgs, 0, 2000);
    expect(changed).toBe(0);
    expect(messages).toEqual(msgs);
  });

  it("returns the identical array reference when nothing changed", () => {
    const msgs = history(2, 100); // all under the 2000 threshold
    const r = pruneOldToolResults(msgs, 12, 2000);
    expect(r.changed).toBe(0);
    expect(r.messages).toBe(msgs);
  });
});

describe("extractPriorSummary", () => {
  it("pulls the leading handoff summary and its ack out of the history", () => {
    const msgs = [
      buildSummaryMessage("## Task\n- build the thing"),
      buildAckMessage(),
      user("continue"),
      assistant("ok"),
    ];
    const { summary, rest } = extractPriorSummary(msgs);
    expect(summary).toContain("build the thing");
    expect(rest).toHaveLength(2);
    expect(rest[0].content).toBe("continue");
  });

  it("returns null summary for a fresh (never-compacted) history", () => {
    const msgs = [user("a"), assistant("b")];
    const { summary, rest } = extractPriorSummary(msgs);
    expect(summary).toBeNull();
    expect(rest).toBe(msgs);
  });

  it("extracts the summary even when no ack follows", () => {
    const msgs = [buildSummaryMessage("## Gotchas\n- use pnpm"), user("next")];
    const { summary, rest } = extractPriorSummary(msgs);
    expect(summary).toContain("use pnpm");
    expect(rest[0].content).toBe("next");
  });
});

describe("buildSummarizerInput", () => {
  it("uses the plain prompt when there is no prior summary", () => {
    const out = buildSummarizerInput("TRANSCRIPT", null);
    expect(out).toBe(SUMMARIZER_PROMPT + "TRANSCRIPT");
    expect(out).not.toContain("Existing summary");
  });

  it("folds the prior summary in as an update base", () => {
    const out = buildSummarizerInput("NEW TRANSCRIPT", "OLD SUMMARY BODY");
    expect(out).toContain("UPDATING a handoff summary");
    expect(out).toContain("## Existing summary\nOLD SUMMARY BODY");
    expect(out).toContain("New transcript:\nNEW TRANSCRIPT");
    // Still carries the six-section instructions.
    expect(out).toContain("## Task & intent");
  });
});
