import { describe, expect, it } from "vitest";
import { truncate } from "../src/tools/utils.js";

describe("truncate (head + tail)", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("keeps the beginning and the end when cutting", () => {
    const text = "HEAD".padEnd(1000, "a") + "MIDDLE".padEnd(5000, "b") + "TAIL";
    const out = truncate(text, 1000);
    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("HEADaaa")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("characters omitted from the middle");
  });

  it("mentions how to recover: paging hint in the marker", () => {
    const text = "x".repeat(10_000);
    const out = truncate(text, 1000);
    expect(out).toContain("offset/limit");
    expect(out).toContain(text.length.toLocaleString());
  });

  it("reports exact omitted and total counts", () => {
    const text = "y".repeat(1_000_000);
    const out = truncate(text, 2000);
    // head = 75% of max, tail = 20% of max.
    expect(out).toContain((1_000_000 - 1500 - 400).toLocaleString());
    expect(out).toContain(`total ${text.length.toLocaleString()} chars`);
  });
});
