import { describe, expect, it } from "vitest";
import { matchBashHint, postProcessBashOutput, resetBashHints } from "../src/bashHints.js";

const RATE_LIMIT_OUTPUT = "gh: API rate limit exceeded for 1.2.3.4. (But here's the good news: rate limit resets at 12:00)";

describe("matchBashHint", () => {
  it("fires once per cooldown window and stays silent right after", () => {
    resetBashHints();
    const now = 1_000_000;
    const first = matchBashHint(RATE_LIMIT_OUTPUT, now);
    expect(first).toContain('event="BashHint"');
    expect(first).toContain("gh api rate_limit");
    expect(matchBashHint(RATE_LIMIT_OUTPUT, now + 1000)).toBeNull();
    expect(matchBashHint("all good", now + 2000)).toBeNull();
    // After the cooldown a new failure fires again.
    expect(matchBashHint(RATE_LIMIT_OUTPUT, now + 61_000)).toContain("BashHint");
  });

  it("does not fire for unrelated output", () => {
    resetBashHints();
    expect(matchBashHint("npm install finished", 5_000_000)).toBeNull();
  });
});

describe("postProcessBashOutput", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64").padEnd(120, "A");

  it("extracts a data-URL image and replaces it with a placeholder", () => {
    const out = postProcessBashOutput(`screenshot ready\ndata:image/png;base64,${PNG}\ndone`);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(out.images[0].source.data.length).toBeGreaterThan(100);
    expect(out.text).toContain("[image attached from output]");
    expect(out.text).not.toContain(PNG);
  });

  it("normalizes jpg to the jpeg media type", () => {
    const out = postProcessBashOutput(`data:image/jpg;base64,${PNG}`);
    expect(out.images[0].source.media_type).toBe("image/jpeg");
  });

  it("omits images past the per-image budget instead of attaching them", () => {
    const huge = "A".repeat(7 * 1024 * 1024);
    const out = postProcessBashOutput(`data:image/png;base64,${huge}`);
    expect(out.images).toHaveLength(0);
    expect(out.text).toContain("image omitted");
  });

  it("appends the hint reminder when the output matches a pattern", () => {
    resetBashHints();
    const now = 9_000_000;
    const out = postProcessBashOutput(RATE_LIMIT_OUTPUT, now);
    expect(out.text).toContain('event="BashHint"');
    expect(out.images).toHaveLength(0);
  });
});
