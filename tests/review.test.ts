import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReviewPrompt, collectReview, REVIEW_SYSTEM } from "../src/review.js";

let dir: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-review-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "init");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("collectReview", () => {
  it("collects uncommitted changes including untracked files", async () => {
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2;\n", "utf8");
    await fs.writeFile(path.join(dir, "new.ts"), "export const n = 1;\n", "utf8");
    const b = await collectReview(dir);
    expect(b.header).toContain("UNCOMMITTED");
    expect(b.header).toContain("branch main");
    expect(b.diff).toContain("export const a = 2");
    expect(b.diff).toContain("(new file) new.ts"); // untracked content included
    expect(b.truncated).toBe(false);
    // cleanup so later tests see a clean tree
    git("checkout", "--", "a.ts");
    await fs.rm(path.join(dir, "new.ts"));
  });

  it("throws on a clean tree", async () => {
    await expect(collectReview(dir)).rejects.toThrow("nothing to review");
  });

  it("collects a branch range with commit log", async () => {
    git("checkout", "-b", "feat");
    await fs.writeFile(path.join(dir, "b.ts"), "export const b = 1;\n", "utf8");
    git("add", ".");
    git("commit", "-m", "add b");
    const b = await collectReview(dir, "main");
    expect(b.header).toContain("against main");
    expect(b.header).toContain("add b"); // commit list
    expect(b.diff).toContain("export const b = 1");
    git("checkout", "main");
    git("branch", "-D", "feat");
  });

  it("throws for an unknown base", async () => {
    await expect(collectReview(dir, "no-such-ref")).rejects.toThrow(/nothing to review|failed|unknown revision/);
  });

  it("throws outside a git repo", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "agent-review-plain-"));
    try {
      await expect(collectReview(plain)).rejects.toThrow("not a git repository");
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});

describe("buildReviewPrompt", () => {
  const bundle = { header: "H", diff: "D", truncated: false };

  it("includes structure requirements and the diff", () => {
    const p = buildReviewPrompt(bundle);
    expect(p).toContain("SEVERITY");
    expect(p).toContain("verdict");
    expect(p).toContain("<diff>\nD\n</diff>");
    expect(p).toContain("H");
    expect(p).not.toContain("eyes on");
  });

  it("weaves the focus text in when given", () => {
    expect(buildReviewPrompt(bundle, "concurrency")).toContain("wants eyes on: concurrency");
  });

  it("system prompt demands actionable findings", () => {
    expect(REVIEW_SYSTEM).toContain("code review");
  });
});
