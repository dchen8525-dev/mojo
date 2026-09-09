import { promises as fs } from "node:fs";
import path from "node:path";
import { truncate } from "./tools/utils.js";
import { runGit } from "./tools/git.js";

/**
 * /review: collect the diff (working tree, staged, or a branch range) plus
 * basic repo context, then ask the model for a focused code review. Read-only
 * by design - it never commits or pushes anything.
 */

const MAX_DIFF_CHARS = 60_000;

export interface ReviewBundle {
  /** Human-readable header: branch, files changed, stats. */
  header: string;
  /** The diff text (possibly truncated). */
  diff: string;
  /** True when the diff had to be cut. */
  truncated: boolean;
}

/**
 * Gather the diff to review. `target` selects what to compare:
 * - "" / undefined -> uncommitted changes (staged + unstaged)
 * - a branch/sha   -> `base...HEAD` range
 */
export async function collectReview(cwd: string, target?: string, signal?: AbortSignal): Promise<ReviewBundle> {
  const err = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  if (err.code !== 0) throw new Error("not a git repository");

  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  let diff: string;
  let stat: string;
  let header: string;

  if (!target) {
    const staged = await runGit(cwd, ["diff", "--cached", "--no-color", "-U5"], signal);
    const unstaged = await runGit(cwd, ["diff", "--no-color", "-U5"], signal);
    const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"], signal);
    diff = [staged.out, unstaged.out].filter(Boolean).join("\n");
    if (untracked.out) {
      // Include small untracked files in full so new code is reviewable.
      const parts: string[] = [];
      for (const f of untracked.out.split("\n").filter(Boolean).slice(0, 20)) {
        try {
          const content = await fs.readFile(path.join(cwd, f), "utf8");
          if (content.length < 20_000 && !content.includes("\0")) parts.push(`--- (new file) ${f}\n+++ ${f}\n${content}`);
        } catch {
          /* unreadable; skip */
        }
      }
      if (parts.length) diff += (diff ? "\n" : "") + parts.join("\n");
    }
    stat = (await runGit(cwd, ["diff", "--cached", "--stat", "--no-color"], signal)).out;
    const wstat = (await runGit(cwd, ["diff", "--stat", "--no-color"], signal)).out;
    header = `Reviewing UNCOMMITTED changes on branch ${branch.out || "?"}` +
      (untracked.out ? ` (plus ${untracked.out.split("\n").filter(Boolean).length} untracked file(s))` : "") +
      `\n${[stat, wstat].filter(Boolean).join("\n")}`;
    if (!diff.trim()) throw new Error("nothing to review: the working tree is clean");
  } else {
    const range = await runGit(cwd, ["diff", `${target}...HEAD`, "--no-color", "-U5"], signal);
    if (range.code !== 0) throw new Error(`git diff ${target}...HEAD failed: ${range.out.slice(0, 300) || "unknown revision"}`);
    diff = range.out;
    stat = (await runGit(cwd, ["diff", `${target}...HEAD`, "--stat", "--no-color"], signal)).out;
    const log = await runGit(cwd, ["log", "--oneline", `${target}..HEAD`, "--no-color", "-20"], signal);
    header = `Reviewing branch ${branch.out || "?"} against ${target}\n${stat}\ncommits:\n${log.out}`;
    if (!diff.trim()) throw new Error(`nothing to review: no diff between ${target} and HEAD`);
  }

  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n[... diff truncated - review what is shown]";
  return { header, diff, truncated };
}

export const REVIEW_SYSTEM =
  "You are a meticulous senior engineer performing a code review. Report only real, " +
  "actionable issues in the diff; do not restate what the change does at length.";

export function buildReviewPrompt(bundle: ReviewBundle, focus?: string): string {
  return (
    `Review the following change.\n` +
    (focus ? `The author specifically wants eyes on: ${focus}\n` : "") +
    `Look for: correctness bugs, security issues (injection, secrets, path traversal), ` +
    `race conditions, error handling gaps, off-by-one, breaking API changes, and missing ` +
    `tests for risky paths. Skip style nits and anything a linter would catch.\n\n` +
    `For each finding output: [SEVERITY: critical|major|minor] file:line - issue and concrete fix.\n` +
    `End with a one-line verdict: APPROVE, APPROVE WITH NITS, or REQUEST CHANGES.\n\n` +
    `${bundle.header}\n\n<diff>\n${bundle.diff}\n</diff>`
  );
}
