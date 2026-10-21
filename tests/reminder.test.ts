import { describe, expect, it } from "vitest";
import { systemReminder } from "../src/reminder.js";

describe("systemReminder", () => {
  it("wraps the body with no attributes", () => {
    expect(systemReminder("hello")).toBe("<system-reminder>\nhello\n</system-reminder>");
  });

  it("renders attributes on the opening tag and escapes quotes", () => {
    const out = systemReminder("ctx", { event: "PostToolUse", note: 'say "hi"' });
    expect(out).toContain('<system-reminder event="PostToolUse" note="say &quot;hi&quot;">');
    expect(out).toContain("\nctx\n");
  });
});
