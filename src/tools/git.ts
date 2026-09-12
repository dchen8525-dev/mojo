import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num, truncate, describeError } from "./utils.js";

/**
 * Dedicated git tools. Compared to shelling out through `bash`:
 * - git runs as a direct child process (no cmd.exe/bash quoting traps),
 * - destructive operations are impossible by construction (no force push,
 *   no --no-verify, no reset),
 * - commits stage only the files the model names, and secret-looking files
 *   are blocked unless explicitly overridden,
 * - commits to main/master are refused,
 * - rejections restore the index to its previous state.
 */

const GIT_TIMEOUT_MS = 30_000;

interface GitResult {
  code: number;
  out: string; // stdout + stderr combined
}

export async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const onAbort = () => {
      child.kill();
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort);
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`git is not available: ${describeError(err)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, out: out.trim() });
    });
  });
}

async function ensureRepo(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
    return r.code === 0 && r.out === "true" ? null : "Not a git repository (or a worktree inside one).";
  } catch (err) {
    return describeError(err);
  }
}

/* ---------------- git_status ---------------- */

export const gitStatusTool: Tool = {
  name: "git_status",
  description:
    "Show branch, upstream sync state, and all staged/modified/untracked/conflicted files " +
    "(with line-change stats), plus the last few commits. Read-only and cheaper than " +
    "`git status` through bash because the output is structured for you. Prefer this before " +
    "commits or when orienting yourself in a repo.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: { type: "object", properties: {} },
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const err = await ensureRepo(ctx.cwd, ctx.signal);
      if (err) return { content: err, isError: true };

      const [status, stat, log] = await Promise.all([
        runGit(ctx.cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"], ctx.signal),
        runGit(ctx.cwd, ["diff", "--stat", "--no-color"], ctx.signal),
        runGit(ctx.cwd, ["log", "--oneline", "-5", "--no-color"], ctx.signal),
      ]);

      const lines = status.out.split("\n").filter(Boolean);
      const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "(unknown branch)";
      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];
      const conflicted: string[] = [];
      for (const l of lines.slice(1)) {
        const x = l[0];
        const y = l[1];
        const file = l.slice(3);
        if (x === "U" || y === "U" || x === "D" && y === "D" || (x === "A" && y === "A")) conflicted.push(file);
        else if (x === "?" && y === "?") untracked.push(file);
        else if (x !== " " && y !== " " && x !== "?") {
          staged.push(`${x} ${file}`);
          modified.push(`${y} ${file}`);
        } else if (x !== " ") staged.push(`${x} ${file}`);
        else if (y !== " ") modified.push(`${y} ${file}`);
      }

      const parts = [`branch: ${branchLine}`];
      if (conflicted.length) parts.push(`conflicted (${conflicted.length}):\n  ${conflicted.join("\n  ")}`);
      if (staged.length) parts.push(`staged (${staged.length}):\n  ${staged.join("\n  ")}`);
      if (modified.length) parts.push(`unstaged changes (${modified.length}):\n  ${modified.join("\n  ")}`);
      if (untracked.length) {
        const shown = untracked.slice(0, 50);
        parts.push(`untracked (${untracked.length}):\n  ${shown.join("\n  ")}${untracked.length > shown.length ? `\n  [... ${untracked.length - shown.length} more]` : ""}`);
      }
      if (!staged.length && !modified.length && !untracked.length && !conflicted.length) parts.push("working tree clean");
      if (stat.out) parts.push(`unstaged diff stat:\n${stat.out}`);
      if (log.code === 0 && log.out) parts.push(`recent commits:\n${log.out}`);

      return { content: truncate(parts.join("\n\n")) };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

/* ---------------- git_diff ---------------- */

/**
 * Read-only diff view. Shows the working-tree (unstaged), staged, or a commit
 * range (<base>..HEAD) diff, optionally restricted to one path. Cap the output
 * so a large diff doesn't blow the context; tell the model to pass `path` or a
 * `base` for narrower ranges.
 */
export const gitDiffTool: Tool = {
  name: "git_diff",
  description:
    "Show the unified diff of unstaged changes (default), staged changes (staged: true), " +
    "or a committed range (base: e.g. 'main' or a SHA, shown as base...HEAD). Optionally " +
    "restrict to one file with path. Read-only. Use this to understand what changed before " +
    "editing, reviewing, or committing.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      base: { type: "string", description: "Base ref to compare HEAD against (e.g. 'main', 'origin/main', or a SHA). When set, shows the committed range diff." },
      staged: { type: "boolean", description: "Show the staged (index) diff instead of the working-tree diff." },
      path: { type: "string", description: "Restrict the diff to a single file (relative to the working directory)." },
      max_chars: { type: "number", description: "Cap the returned diff (default 30000)." },
    },
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const maxChars = Math.min(100_000, Math.max(1_000, num(input, "max_chars") ?? 30_000));
    const base = optStr(input, "base");
    const pathFilter = optStr(input, "path");
    // Scope selectors shared by both the stat summary and the diff body, so the
    // header never describes a different range than what's shown below it.
    const scope: string[] = [];
    if (base) scope.push(`${trimRef(base)}...HEAD`);
    else if (input.staged === true) scope.push("--cached");
    if (pathFilter) scope.push("--", pathFilter);
    const args = ["diff", "--no-color", "--unified=3", ...scope];
    try {
      const err = await ensureRepo(ctx.cwd, ctx.signal);
      if (err) return { content: err, isError: true };
      const res = await runGit(ctx.cwd, ["diff", "--no-color", "--stat", ...scope], ctx.signal);
      const res2 = await runGit(ctx.cwd, args, ctx.signal);
      if (res2.code !== 0) return { content: `git diff failed: ${res2.out || `exit ${res2.code}`}`, isError: true };
      if (!res2.out) {
        const label = base ? `${base}...HEAD` : input.staged === true ? "staged" : "working tree";
        return { content: `No changes in the ${label} diff${pathFilter ? ` for ${pathFilter}` : ""}.` };
      }
      const scopeLabel = base ? `${trimRef(base)}...HEAD` : input.staged === true ? "staged changes" : "unstaged changes";
      const header = `scope: ${scopeLabel}${pathFilter ? ` · path: ${pathFilter}` : ""}\n${res.out}`;
      return { content: truncate(`${header}\n\n${res2.out}`, maxChars) };
    } catch (e) {
      return { content: `Error: ${describeError(e)}`, isError: true };
    }
  },
};

/** Strip refs/ prefixes and guard against empty refs (belt-and-braces). */
function trimRef(s: string): string {
  const t = s.replace(/^refs\/(heads|tags)\//, "").trim();
  return t || "HEAD";
}

/** Optional string read (missing/empty => ""), unlike strict `str`. */
function optStr(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/* ---------------- git_commit ---------------- */

/** Files that should never end up in a commit without an explicit override. */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[\w-]+)?$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa|\.netrc)$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(credentials|secrets?)(\.[\w]+)?$/i,
  /(^|\/)\.npmrc$/i,
];

export function looksSecret(p: string): boolean {
  const norm = p.replaceAll("\\", "/");
  return SECRET_PATTERNS.some((re) => re.test(norm));
}

export const gitCommitTool: Tool = {
  name: "git_commit",
  description:
    "Stage the listed files and create a commit. Only the files you name are staged - never " +
    "stage everything by reflex. Refuses: empty messages, commits while a merge/rebase is in " +
    "progress, commits on main/master, and secret-looking files (.env, keys, credentials) " +
    "unless allow_secret_files is true. Runs normally, so pre-commit hooks still execute. " +
    "The user sees a diff stat before approving; if they reject, the index is restored.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message (subject line; blank line + body allowed)." },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Paths to stage, relative to the working directory.",
      },
      amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one." },
      allow_secret_files: { type: "boolean", description: "Set true only if the user explicitly confirmed committing a secret-looking file." },
    },
    required: ["message", "files"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const err = await ensureRepo(ctx.cwd, ctx.signal);
      if (err) return { content: err, isError: true };

      const message = str(input, "message").trim();
      if (!message) return { content: "Error: commit message is empty.", isError: true };
      const files = Array.isArray(input.files) ? (input.files as unknown[]).map(String) : [];
      const amend = input.amend === true;
      if (!files.length && !amend) {
        return { content: "Error: files must list at least one path to stage.", isError: true };
      }

      // Guardrails that don't need user interaction.
      const inProgress = await runGit(ctx.cwd, ["rev-parse", "--git-path", "MERGE_HEAD"], ctx.signal);
      if (inProgress.code === 0 && inProgress.out) {
        try {
          await fs.stat(path.resolve(ctx.cwd, inProgress.out));
          return { content: "Error: a merge is in progress. Resolve it (with the user's guidance) before committing.", isError: true };
        } catch {
          /* MERGE_HEAD absent: not merging */
        }
      }

      const branch = await runGit(ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"], ctx.signal);
      const branchName = branch.out || "HEAD";
      if (!amend && (branchName === "main" || branchName === "master")) {
        return {
          content:
            `Error: refusing to commit directly to ${branchName}. ` +
            `Create a feature branch first (bash: git checkout -b <name>) and ask the user if unsure.`,
          isError: true,
        };
      }

      if (!amend && input.allow_secret_files !== true) {
        const secrets = files.filter(looksSecret);
        if (secrets.length) {
          return {
            content:
              `Error: refusing to stage secret-looking file(s): ${secrets.join(", ")}. ` +
              `Ask the user; if they confirm it is safe, re-run with allow_secret_files: true.`,
            isError: true,
          };
        }
      }

      // Stage exactly the named files.
      if (files.length) {
        const add = await runGit(ctx.cwd, ["add", "--", ...files], ctx.signal);
        if (add.code !== 0) {
          return { content: `Error staging files: ${add.out || `git add failed (exit ${add.code})`}`, isError: true };
        }
      }

      const stagedCheck = await runGit(ctx.cwd, ["diff", "--cached", "--stat", "--no-color"], ctx.signal);
      if (!stagedCheck.out && !amend) {
        await runGit(ctx.cwd, ["restore", "--staged", "--", ...files], ctx.signal).catch(() => {});
        return { content: "Nothing staged to commit (files unchanged?).", isError: true };
      }

      const preview = stagedCheck.out || "(amend: no new staged changes)";
      const ok = await ctx.askPermission(
        `git commit${amend ? " --amend" : ""} on ${branchName}: "${message.split("\n")[0].slice(0, 80)}"`,
        "high",
        preview,
      );
      if (!ok) {
        if (files.length) await runGit(ctx.cwd, ["restore", "--staged", "--", ...files], ctx.signal).catch(() => {});
        return { content: "The user rejected this commit. The index was restored. Ask what they want changed.", isError: true };
      }

      const commitArgs = amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
      const res = await runGit(ctx.cwd, commitArgs, ctx.signal);
      if (res.code !== 0) {
        return {
          content: `git commit failed (exit ${res.code}):\n${res.out}\n` +
            `(If a pre-commit hook blocked it, fix the issue or ask the user - do NOT use --no-verify.)`,
          isError: true,
        };
      }
      const head = await runGit(ctx.cwd, ["log", "--oneline", "-1", "--no-color"], ctx.signal);
      const count = await runGit(ctx.cwd, ["rev-list", "--count", "HEAD"], ctx.signal);
      return {
        content:
          `Committed on ${branchName}: ${head.out || "(hash unavailable)"}` +
          `${amend ? " (amended)" : ""} · repo now has ${count.out || "?"} commits\n${preview}`,
      };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

/* ---------------- git_pr ---------------- */

export const gitPrTool: Tool = {
  name: "git_pr",
  description:
    "Push the current branch to origin (plain push, never force) and open a pull request via " +
    "the gh CLI. Refuses to run from main/master and when the working tree has uncommitted " +
    "changes (commit them first). If gh is missing or unauthenticated, the branch is still " +
    "pushed and the result tells you how to open the PR manually. Only use when the user asks " +
    "for a PR/push.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "PR title (keep under ~70 chars)." },
      body: { type: "string", description: "PR description (markdown: summary + test plan)." },
      base: { type: "string", description: "Base branch (default: the repository's default branch)." },
      draft: { type: "boolean", description: "Open as a draft PR." },
    },
    required: ["title", "body"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const err = await ensureRepo(ctx.cwd, ctx.signal);
      if (err) return { content: err, isError: true };

      const title = str(input, "title").trim();
      const body = str(input, "body");
      if (!title) return { content: "Error: PR title is empty.", isError: true };

      const branch = await runGit(ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"], ctx.signal);
      const branchName = branch.out || "HEAD";
      if (branchName === "HEAD") {
        return { content: "Error: detached HEAD. Check out a named branch first.", isError: true };
      }
      if (branchName === "main" || branchName === "master") {
        return {
          content: `Error: refusing to open a PR from ${branchName}. Create a feature branch with your commits and retry.`,
          isError: true,
        };
      }

      const dirty = await runGit(ctx.cwd, ["status", "--porcelain"], ctx.signal);
      if (dirty.out) {
        return {
          content:
            `Error: working tree has uncommitted changes:\n${dirty.out.slice(0, 1500)}\n` +
            `Commit what belongs in this PR first (git_commit).`,
          isError: true,
        };
      }

      const ahead = await runGit(ctx.cwd, ["log", "--oneline", "@{u}..HEAD", "--no-color"], ctx.signal);
      const commits = ahead.code === 0 ? ahead.out : "";

      const preview =
        `branch ${branchName} → origin, PR title:\n  ${title}\n` +
        (commits ? `commits to publish:\n${commits.split("\n").slice(0, 20).map((l) => `  ${l}`).join("\n")}` : "(upstream unknown - pushing new branch)");

      const ok = await ctx.askPermission(`Push ${branchName} and open a PR: "${title.slice(0, 80)}"`, "high", preview);
      if (!ok) return { content: "The user rejected the push/PR.", isError: true };

      const push = await runGit(ctx.cwd, ["push", "-u", "origin", branchName], ctx.signal);
      if (push.code !== 0) {
        return { content: `Push failed:\n${push.out}`, isError: true };
      }

      const ghArgs = ["pr", "create", "--title", title, "--body", body];
      if (typeof input.base === "string" && input.base) ghArgs.push("--base", input.base);
      if (input.draft === true) ghArgs.push("--draft");
      const pr = await runGit(ctx.cwd, ["config", "--get", "remote.origin.url"], ctx.signal);
      try {
        const gh = await new Promise<GitResult>((resolve, reject) => {
          const child = spawn("gh", ghArgs, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
          let out = "";
          child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
          child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
          child.on("error", (e) => reject(e));
          child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim() }));
        });
        if (gh.code === 0) {
          return { content: `Pushed ${branchName} to origin.\nPR created: ${gh.out}` };
        }
        return {
          content:
            `Pushed ${branchName} to origin, but gh PR creation failed (exit ${gh.code}):\n${gh.out}\n` +
            `Report this to the user; they may need to run \`gh auth login\` or open the PR manually.`,
          isError: true,
        };
      } catch {
        const url = pr.code === 0 && pr.out ? compareUrl(pr.out, branchName) : null;
        return {
          content:
            `Pushed ${branchName} to origin, but the gh CLI is not available to open the PR.` +
            (url ? `\nOpen it manually: ${url}` : "\nAsk the user to open the pull request."),
        };
      }
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

/** Build a browser "compare" URL from an origin remote URL. */
export function compareUrl(remoteUrl: string, branch: string): string | null {
  const m = /^(?:https?:\/\/|git@)([\w.-]+)[:/]([\w./-]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (!m) return null;
  const [, host, repo] = m;
  const hostPath = host === "github.com" ? "https://github.com" : `https://${host}`;
  const encoded = encodeURIComponent(branch);
  return `${hostPath}/${repo}/compare/${encoded}?expand=1`;
}
