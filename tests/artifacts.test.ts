import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { boundedResult } from "../src/artifacts.js";

const SHORT = "hello world";

describe("boundedResult", () => {
  it("passes short text through unchanged", async () => {
    await expect(boundedResult(SHORT)).resolves.toBe(SHORT);
    await expect(boundedResult(SHORT, 10)).resolves.toContain("hello");
  });

  it("spills oversized text and returns head+tail plus a pointer", async () => {
    const big = "A".repeat(40_000) + "MIDDLE-MARKER" + "Z".repeat(40_000);
    const out = await boundedResult(big, 5_000, "test-label");
    expect(out).toContain("characters omitted from the middle");
    expect(out).toMatch(/Full test-label \([\d,.]+ chars\) saved to/);
    expect(out).toContain("read it with read_file");
    const m = /saved to (.+\.txt)/.exec(out)!;
    const spilled = await fs.readFile(m[1], "utf8");
    expect(spilled).toBe(big);
    await fs.rm(m[1], { force: true });
  });

  it("sanitizes the label in the artifact filename", async () => {
    const out = await boundedResult("x".repeat(31_000), 1_000, "../weird label!/.x");
    const m = /saved to (.+\.txt)/.exec(out)!;
    expect(path.basename(m[1])).toMatch(/^weird-label-x-\d+-[a-z0-9]+\.txt$/);
    await fs.rm(m[1], { force: true });
  });

  it("falls back to plain truncation when the spill fails", async () => {
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("denied"));
    const big = "y".repeat(10_000);
    const out = await boundedResult(big, 1_000);
    expect(out).not.toContain("saved to");
    expect(out).toContain("characters omitted from the middle");
    mkdir.mockRestore();
  });

  it("spills into the shared node-agent-output temp dir", async () => {
    const out = await boundedResult("z".repeat(2_000), 100, "dir-check");
    const m = /saved to (.+\.txt)/.exec(out)!;
    expect(path.dirname(m[1])).toBe(path.join(os.tmpdir(), "node-agent-output"));
    await fs.rm(m[1], { force: true });
  });
});
