import { describe, expect, it } from "vitest";
import { REPEAT_WARNING_AT, RepetitionTracker } from "../src/repetition.js";

describe("RepetitionTracker", () => {
  it("warns on the third identical call in a row", () => {
    const t = new RepetitionTracker();
    expect(t.observe("bash", { command: "npm test" })).toBe(0);
    expect(t.observe("bash", { command: "npm test" })).toBe(0);
    expect(t.observe("bash", { command: "npm test" })).toBe(REPEAT_WARNING_AT);
  });

  it("resets when the input changes", () => {
    const t = new RepetitionTracker();
    t.observe("bash", { command: "npm test" });
    t.observe("bash", { command: "npm test" });
    expect(t.observe("bash", { command: "npm run lint" })).toBe(0);
    expect(t.observe("bash", { command: "npm run lint" })).toBe(0);
    expect(t.observe("bash", { command: "npm run lint" })).toBe(3);
  });

  it("resets when only the tool name changes", () => {
    const t = new RepetitionTracker();
    t.observe("read_file", { path: "a.ts" });
    t.observe("read_file", { path: "a.ts" });
    expect(t.observe("grep", { path: "a.ts" })).toBe(0);
  });

  it("compares inputs independent of key order", () => {
    const t = new RepetitionTracker();
    t.observe("edit_file", { path: "a.ts", old_string: "x" });
    t.observe("edit_file", { old_string: "x", path: "a.ts" });
    expect(t.observe("edit_file", { path: "a.ts", old_string: "x" })).toBe(3);
  });

  it("keeps warning every third repeat of a long streak", () => {
    const t = new RepetitionTracker();
    const scores = Array.from({ length: 7 }, () => t.observe("bash", { command: "ls" }));
    expect(scores).toEqual([0, 0, 3, 0, 0, 6, 0]);
  });
});
