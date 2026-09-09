import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compareUrl, gitCommitTool, gitDiffTool, gitPrTool, gitStatusTool, looksSecret } from "../src/tools/git.js";
import type { ToolContext } from "../src/types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, askPermission: async () => true, ...overrides };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-git-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.local");
  git(dir, "config", "user.name", "Test");
  await fs.writeFile(path.join(dir, "readme.md"), "# project\n", "utf8");
  git(dir, "add", "readme.md");
  git(dir, "commit", "-m", "initial");
});

afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

describe("looksSecret", () => {
  it("flags env files, keys, and credentials", () => {
    expect(looksSecret(".env")).toBe(true);
    expect(looksSecret("config/.env.production")).toBe(true);
    expect(looksSecret("secrets/api.pem")).toBe(true);
    expect(looksSecret("id_rsa")).toBe(true);
    expect(looksSecret("src\\main\\credentials.yml")).toBe(true);
  });
  it("does not flag ordinary files", () => {
    expect(looksSecret("src/env.ts")).toBe(false);
    expect(looksSecret("README.md")).toBe(false);
    expect(looksSecret("package.json")).toBe(false);
  });
});

describe("compareUrl", () => {
  it("builds a GitHub compare URL from https and ssh remotes", () => {
    expect(compareUrl("https://github.com/acme/widgets.git", "feat/x")).toBe(
      "https://github.com/acme/widgets/compare/feat%2Fx?expand=1",
    );
    expect(compareUrl("git@github.com:acme/widgets.git", "feat/x")).toBe(
      "https://github.com/acme/widgets/compare/feat%2Fx?expand=1",
    );
  });
  it("returns null for unparseable remotes", () => {
    expect(compareUrl("weird-url", "b")).toBeNull();
  });
});

describe("git_status", () => {
  it("reports branch, staged, unstaged and untracked files", async () => {
    await fs.writeFile(path.join(dir, "new.txt"), "untracked\n", "utf8");
    await fs.writeFile(path.join(dir, "readme.md"), "# project changed\n", "utf8");
    const r = await gitStatusTool.execute({}, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("branch: main");
    expect(r.content).toContain("unstaged changes (1)");
    expect(r.content).toContain("readme.md");
    expect(r.content).toContain("untracked (1)");
    expect(r.content).toContain("new.txt");
    expect(r.content).toContain("recent commits:");
    expect(r.content).toContain("initial");
    git(dir, "checkout", "--", "readme.md");
  });

  it("detects staged files", async () => {
    git(dir, "add", "new.txt");
    const r = await gitStatusTool.execute({}, ctx());
    expect(r.content).toContain("staged (1)");
    expect(r.content).toContain("new.txt");
    git(dir, "restore", "--staged", "new.txt");
    await fs.rm(path.join(dir, "new.txt"));
  });

  it("errors outside a repo", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "agent-nogit-"));
    try {
      const r = await gitStatusTool.execute({}, ctx({ cwd: bare }));
      expect(r.isError).toBe(true);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});

describe("git_commit", () => {
  function workBranch(name: string) {
    git(dir, "checkout", "-b", name);
  }
  function backToMain() {
    git(dir, "checkout", "main");
  }

  it("stages named files and commits on a feature branch", async () => {
    workBranch("c1");
    await fs.writeFile(path.join(dir, "feat.ts"), "export const x = 1;\n", "utf8");
    const r = await gitCommitTool.execute({ message: "add feat", files: ["feat.ts"] }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Committed on c1");
    expect(git(dir, "log", "--oneline", "-1")).toContain("add feat");
    expect(git(dir, "status", "--porcelain", "feat.ts")).toBe(""); // committed, not dirty
    backToMain();
    git(dir, "branch", "-D", "c1");
  });

  it("refuses commits on main", async () => {
    await fs.writeFile(path.join(dir, "other.ts"), "y\n", "utf8");
    const r = await gitCommitTool.execute({ message: "nope", files: ["other.ts"] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("refusing to commit directly to main");
    await fs.rm(path.join(dir, "other.ts"));
  });

  it("refuses secret-looking files, then accepts with the override", async () => {
    workBranch("sec");
    await fs.writeFile(path.join(dir, ".env"), "API_KEY=secret\n", "utf8");
    const blocked = await gitCommitTool.execute({ message: "env", files: [".env"] }, ctx());
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("secret-looking");

    const allowed = await gitCommitTool.execute(
      { message: "env with consent", files: [".env"], allow_secret_files: true },
      ctx(),
    );
    expect(allowed.isError).toBeUndefined();
    expect(allowed.content).toContain("Committed on sec");
    backToMain();
    git(dir, "branch", "-D", "sec");
  });

  it("rejects an empty message", async () => {
    const r = await gitCommitTool.execute({ message: "   ", files: ["readme.md"] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("empty");
  });

  it("restores the index when the user rejects the commit", async () => {
    workBranch("rej");
    await fs.writeFile(path.join(dir, "rejected.ts"), "no\n", "utf8");
    const ask = vi.fn(async () => false);
    const r = await gitCommitTool.execute({ message: "will be refused", files: ["rejected.ts"] }, ctx({ askPermission: ask }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("index was restored");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    await fs.rm(path.join(dir, "rejected.ts"));
    backToMain();
    git(dir, "branch", "-D", "rej");
  });

  it("reports nothing-to-commit for unchanged files", async () => {
    workBranch("empty-commit");
    const r = await gitCommitTool.execute({ message: "nothing", files: ["readme.md"] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Nothing staged");
    backToMain();
    git(dir, "branch", "-D", "empty-commit");
  });
});

describe("git_diff", () => {
  function workBranch(name: string) {
    git(dir, "checkout", "-b", name);
  }
  function backToMain() {
    git(dir, "checkout", "main");
  }

  it("shows unstaged changes", async () => {
    await fs.writeFile(path.join(dir, "readme.md"), "# project v2\n", "utf8");
    const r = await gitDiffTool.execute({}, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("readme.md");
    expect(r.content).toContain("-# project");
    expect(r.content).toContain("+# project v2");
    git(dir, "checkout", "--", "readme.md");
  });

  it("shows staged changes", async () => {
    await fs.writeFile(path.join(dir, "staged.txt"), "hello\n", "utf8");
    git(dir, "add", "staged.txt");
    const r = await gitDiffTool.execute({ staged: true }, ctx());
    expect(r.content).toContain("staged.txt");
    expect(r.content).toContain("+hello");
    git(dir, "restore", "--staged", "staged.txt");
    await fs.rm(path.join(dir, "staged.txt"));
  });

  it("shows a committed range diff (base...HEAD)", async () => {
    workBranch("diff-range");
    await fs.writeFile(path.join(dir, "range.ts"), "export default 1;\n", "utf8");
    git(dir, "add", "range.ts");
    git(dir, "commit", "-m", "add range");
    const base = git(dir, "rev-parse", "main");
    const r = await gitDiffTool.execute({ base }, ctx());
    expect(r.content).toContain("range.ts");
    expect(r.content).toContain("+export default 1;");
    backToMain();
    git(dir, "branch", "-D", "diff-range");
  });

  it("limits the diff to a single path", async () => {
    await fs.writeFile(path.join(dir, "aaa.txt"), "a\n", "utf8");
    await fs.writeFile(path.join(dir, "bbb.txt"), "b\n", "utf8");
    const r = await gitDiffTool.execute({ path: "aaa.txt" }, ctx());
    expect(r.content).toContain("aaa.txt");
    expect(r.content).not.toContain("bbb.txt");
    await fs.rm(path.join(dir, "aaa.txt"));
    await fs.rm(path.join(dir, "bbb.txt"));
  });

  it("reports no changes when the tree is clean", async () => {
    const r = await gitDiffTool.execute({}, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("No changes");
  });

  it("errors outside a repo", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "agent-nogit-diff-"));
    try {
      const r = await gitDiffTool.execute({}, ctx({ cwd: bare }));
      expect(r.isError).toBe(true);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});

describe("git_pr guardrails (no network)", () => {
  it("refuses to PR from main", async () => {
    const r = await gitPrTool.execute({ title: "t", body: "b" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("refusing to open a PR from main");
  });

  it("refuses with a dirty working tree", async () => {
    git(dir, "checkout", "-b", "dirty-branch");
    await fs.writeFile(path.join(dir, "dirty.txt"), "x\n", "utf8");
    const r = await gitPrTool.execute({ title: "t", body: "b" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("uncommitted changes");
    await fs.rm(path.join(dir, "dirty.txt"));
    git(dir, "checkout", "main");
    git(dir, "branch", "-D", "dirty-branch");
  });
});
