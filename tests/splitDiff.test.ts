import { describe, expect, it } from "vitest";
import { clipCell, looksLikeDiff, splitColumnWidth, splitDiffRows } from "../src/ui/splitDiff.js";

const DIFF = [
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,4 +10,5 @@",
  " ctx one",
  "-old a",
  "-old b",
  "+new a",
  "+new b",
  "+new c",
  " ctx two",
].join("\n");

describe("looksLikeDiff", () => {
  it("recognizes hunk headers and git file headers", () => {
    expect(looksLikeDiff("@@ -1,2 +1,3 @@\n-a\n+b")).toBe(true);
    expect(looksLikeDiff("diff --git a/x b/x\nindex 123..456")).toBe(true);
  });

  it("rejects plans and command lines", () => {
    expect(looksLikeDiff("1. edit src/a.ts\n2. run tests")).toBe(false);
    expect(looksLikeDiff("rm -rf build/")).toBe(false);
    // A lone "---" in prose is not enough (needs the b/ target or a hunk).
    expect(looksLikeDiff("--- just a horizontal rule ---")).toBe(false);
  });
});

describe("splitDiffRows", () => {
  const rows = splitDiffRows(DIFF);

  it("renders file headers and hunk headers as meta rows", () => {
    expect(rows[0]).toEqual({ kind: "meta", text: "--- a/src/x.ts" });
    expect(rows[1]).toEqual({ kind: "meta", text: "+++ b/src/x.ts" });
    expect(rows[2]).toEqual({ kind: "meta", text: "@@ -10,4 +10,5 @@" });
  });

  it("pairs context lines with both line numbers advancing", () => {
    const ctx = rows[3];
    expect(ctx.kind).toBe("pair");
    expect(ctx).toMatchObject({ left: { num: 10, text: "ctx one" }, right: { num: 10, text: "ctx one" }, changed: false });
  });

  it("interleaves -/+ runs side-by-side with filler for the longer side", () => {
    const pairs = rows.filter((r) => r.kind === "pair" && r.changed);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ left: { num: 11, text: "old a" }, right: { num: 11, text: "new a" } });
    expect(pairs[1]).toMatchObject({ left: { num: 12, text: "old b" }, right: { num: 12, text: "new b" } });
    // Third added line has no counterpart on the left.
    expect(pairs[2]).toMatchObject({ left: { num: null, text: "" }, right: { num: 13, text: "new c" } });
  });

  it("continues numbering on the trailing context line", () => {
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ left: { num: 13, text: "ctx two" }, right: { num: 14, text: "ctx two" } });
  });

  it("drops the trailing empty line from a final newline", () => {
    const rows2 = splitDiffRows(DIFF + "\n");
    expect(rows2[rows2.length - 1]).toMatchObject({ right: { text: "ctx two" } });
  });

  it("treats stray non-diff text as meta rows", () => {
    const rows3 = splitDiffRows("hello\nworld");
    expect(rows3).toEqual([
      { kind: "meta", text: "hello" },
      { kind: "meta", text: "world" },
    ]);
  });
});

describe("splitColumnWidth", () => {
  it("splits a normal terminal into two equal content columns", () => {
    // 80 cols - 6 chrome = 74 inner; half = 37; minus 3 gutter = 34.
    expect(splitColumnWidth(80)).toBe(34);
  });

  it("never collapses below the minimum on tiny terminals", () => {
    expect(splitColumnWidth(10)).toBe(8);
  });
});

describe("clipCell", () => {
  it("passes short text through untouched", () => {
    expect(clipCell("hello", 10)).toBe("hello");
  });

  it("truncates with an ellipsis marker at the width limit", () => {
    expect(clipCell("abcdefghij", 5)).toBe("abcd…");
  });
});
