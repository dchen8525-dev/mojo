import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileStateStore } from "../fileState.js";

/**
 * Keeps the read-before-edit guard in sync with what the model learned from
 * bash. Two directions:
 *
 * - `cat`/`type`/`head`/`tail`/`Get-Content` are views of real file content,
 *   so the files count as read (fully or partially).
 * - Redirects and formatters rewrite files behind the model's back, so their
 *   read records are dropped and the next edit must re-read.
 *
 * Parsing is deliberately conservative: anything compound (pipes, `;`, `&&`,
 * substitutions) is ignored, because its output is not a faithful view.
 */

export interface CommandRead {
  path: string;
  /** The command printed the whole file (subject to output truncation). */
  full: boolean;
}

const VIEWERS = new Set(["cat", "type", "get-content", "gc", "head", "tail"]);

/** Formatters known to rewrite files in place. Over-matching only causes re-reads. */
const FORMATTER_RE =
  /\b(prettier|eslint|gofmt|goimports|rustfmt|cargo\s+fmt|black|isort|clang-format|dprint|stylelint|biome|deno\s+fmt|rubocop|php-cs-fixer|swiftformat|ktlint)\b/i;

export function isFormatterCommand(command: string): boolean {
  return FORMATTER_RE.test(command);
}

/** Tokens of a single simple command; null when shell syntax makes output unreliable. */
function simpleTokens(command: string): string[] | null {
  const cmd = command.trim();
  if (!cmd) return null;
  if (/[|;&<>`\n]|\$\(/.test(cmd)) return null;
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

/** Files whose full/partial contents a simple viewer command printed. */
export function parseFileReads(command: string): CommandRead[] {
  const t = simpleTokens(command);
  if (!t?.length) return [];
  const prog = path.basename(t[0]).toLowerCase();
  if (!VIEWERS.has(prog)) return [];
  const args = t.slice(1);
  const files: string[] = [];
  let full = prog !== "head" && prog !== "tail";

  if (prog === "head" || prog === "tail") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "-c") {
        i++; // skip the count
        continue;
      }
      if (a.startsWith("-")) continue; // -20 / -q / -v
      files.push(unquote(a));
    }
  } else if (prog === "get-content" || prog === "gc" || prog === "type") {
    // PowerShell's `type` is an alias for Get-Content; cmd's type has no flags.
    const limits = new Set(["-totalcount", "-first", "-head", "-tail", "-last", "-readcount"]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-")) {
        const flag = a.toLowerCase();
        if (limits.has(flag)) {
          full = false;
          i++; // skip the count
        }
        continue;
      }
      if (a.startsWith("/")) continue; // cmd switches like /A
      files.push(unquote(a));
    }
  } else {
    // cat: flags such as -n/-b/-s do not hide content.
    for (const a of args) if (!a.startsWith("-")) files.push(unquote(a));
  }

  return files.filter(Boolean).map((p) => ({ path: p, full }));
}

/** Redirection targets written by the command (`> out`, `2>> log`). */
export function parseWrittenFiles(command: string): string[] {
  const out: string[] = [];
  const re = /\d?>>?\s*("[^"]+"|'[^']+'|[^\s|;&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const target = unquote(m[1]);
    if (!target || target.startsWith("&") || target.startsWith("/dev/")) continue;
    if (target.toLowerCase() === "nul") continue;
    out.push(target);
  }
  return out;
}

/**
 * Apply one successful command to the session's read state. `outputComplete`
 * is false when the capture was truncated, which downgrades full cat views to
 * partial reads.
 */
export async function syncBashFileState(
  command: string,
  workdir: string,
  outputComplete: boolean,
  fileState: FileStateStore | undefined,
): Promise<void> {
  if (!fileState) return;
  if (isFormatterCommand(command)) {
    // A formatter may rewrite any file; we cannot know which, so drop all records.
    fileState.clear();
    return;
  }
  for (const target of parseWrittenFiles(command)) {
    fileState.invalidate(path.resolve(workdir, target));
  }
  for (const read of parseFileReads(command)) {
    const abs = path.resolve(workdir, read.path);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      // Record against the post-command stat: for a viewer nothing changed.
      fileState.record(abs, stat, read.full && outputComplete);
    } catch {
      /* not a file / unreadable - nothing to record */
    }
  }
}
