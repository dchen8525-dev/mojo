import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Workspace file mentions for the TUI prompt: typing `@tok` opens a suggestion
 * panel; Tab/Enter completes the path inline. Completion only edits the draft —
 * the submitted text still goes through `expandFileReferences`, which inlines
 * file contents into `<file>` blocks at turn time.
 */

export type MentionKind = "file" | "directory";

export interface MentionPath {
  kind: MentionKind;
  path: string;
}

export interface ActiveMention {
  start: number;
  token: string;
  /** Set for `@"partial path` tokens, where spaces belong to the path. */
  quoted?: boolean;
}

export const MENTION_VISIBLE_COUNT = 8;
const MENTION_QUERY_LIMIT = 50;
const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 8;
const WALK_SKIP_DIRS = new Set([".git", "node_modules", ".svn", ".hg"]);
const PATH_CACHE_TTL_MS = 30_000;
/** A giant monorepo must not turn completion into an unbounded read. */
const GIT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

const pathCache = new Map<string, { entries: MentionPath[]; fetchedAt: number }>();

/** The mention whose completion was Esc-dismissed; suppressed until the token changes. */
export interface MentionDismissal {
  start: number;
  token: string;
}

export function resolveActiveMention(text: string): ActiveMention | null {
  const before = text.lastIndexOf("@");
  if (before < 0) return null;
  if (before > 0 && !/\s/u.test(text[before - 1]!)) return null;
  const rest = text.slice(before + 1);
  if (rest.startsWith('"')) {
    // An unterminated quote is an in-progress mention; a closed one is final
    // (completeMention closes it for files), so suggestions stop there.
    if (rest.indexOf('"', 1) >= 0) return null;
    return { start: before, token: rest.slice(1), quoted: true };
  }
  if (/\s/u.test(rest)) return null;
  return { start: before, token: rest };
}

/** Rank matches: basename prefix > path prefix > substring; then alphabetical. */
export function filterMentionPaths(entries: MentionPath[], token: string, limit = MENTION_QUERY_LIMIT): MentionPath[] {
  const needle = token.toLowerCase();
  const scored: Array<{ entry: MentionPath; score: number }> = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const base = lower.slice(Math.max(lower.lastIndexOf("/"), lower.lastIndexOf(path.sep)) + 1);
    let score: number;
    if (needle && base.startsWith(needle)) score = 0;
    else if (needle && lower.startsWith(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    else if (!needle) score = 3;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Paths the unquoted `@token` grammar cannot express (see commands.ts AT_RE). */
const MENTION_NEEDS_QUOTES = /[\s,;()]/u;

export function completeMention(text: string, mention: ActiveMention, entry: MentionPath): string {
  // Spaces/specials break the unquoted grammar, so quote instead of producing
  // a mention that expandFileReferences would silently leave as literal text.
  const quote = MENTION_NEEDS_QUOTES.test(entry.path) && !entry.path.includes('"');
  const trailing = entry.kind === "file" ? " " : "";
  const replacement = quote
    ? `@"${entry.path}${entry.kind === "file" ? '"' : ""}${trailing}`
    : `@${entry.path}${trailing}`;
  const consumed = mention.start + 1 + mention.token.length + (mention.quoted ? 1 : 0);
  return `${text.slice(0, mention.start)}${replacement}${text.slice(consumed)}`;
}

/** Sliding window of suggestions shown in the panel. */
export function visibleMentionWindow(
  entries: MentionPath[],
  selectedIndex: number,
  maxVisible = MENTION_VISIBLE_COUNT,
): { entries: MentionPath[]; selectedIndex: number; startIndex: number } {
  if (!entries.length || maxVisible <= 0) return { entries: [], selectedIndex: 0, startIndex: 0 };
  const sel = Math.max(0, Math.min(selectedIndex, entries.length - 1));
  const count = Math.min(maxVisible, entries.length);
  const maxStart = entries.length - count;
  const startIndex = Math.min(Math.max(0, sel - count + 1), maxStart);
  return { entries: entries.slice(startIndex, startIndex + count), selectedIndex: sel - startIndex, startIndex };
}

/**
 * Workspace path index: `git ls-files` (tracked + untracked-not-ignored) when
 * available, otherwise a bounded directory walk. Ancestor directories are
 * included so `@src/` can be completed too.
 */
export async function listWorkspacePaths(
  cwd: string,
  opts: { limit?: number; signal?: AbortSignal; now?: number } = {},
): Promise<MentionPath[]> {
  const now = opts.now ?? Date.now();
  const cached = pathCache.get(cwd);
  if (cached && now - cached.fetchedAt < PATH_CACHE_TTL_MS) return cached.entries;

  let entries: MentionPath[];
  try {
    entries = await gitListPaths(cwd, opts.signal);
  } catch {
    entries = await walkPaths(cwd, opts.signal);
  }
  pathCache.set(cwd, { entries, fetchedAt: now });
  if (pathCache.size > 8) {
    const oldest = [...pathCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    if (oldest) pathCache.delete(oldest[0]);
  }
  return entries;
}

export function clearWorkspacePathCacheForTests(): void {
  pathCache.clear();
}

async function gitListPaths(cwd: string, signal?: AbortSignal): Promise<MentionPath[]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("git ls-files timeout"));
    }, 5_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_STDOUT_BYTES) {
        child.kill();
        finish(new Error("git ls-files output too large"));
        return;
      }
      chunks.push(chunk);
    });
    const onAbort = () => {
      child.kill();
      finish(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`git ls-files exited ${code}`));
    });
  });
  // Decode after concatenating: a UTF-8 filename can straddle chunk boundaries.
  return parseGitFileList(chunks);
}

/** Build the mention index from `git ls-files -z` output. */
export function parseGitFileList(output: Buffer | Buffer[]): MentionPath[] {
  // Concatenate before decoding: a UTF-8 filename can straddle chunk boundaries.
  const files = (Array.isArray(output) ? Buffer.concat(output) : output)
    .toString("utf8")
    .split("\0")
    .filter((p) => p && !p.startsWith(".node-agent/"));
  if (!files.length) throw new Error("git ls-files returned nothing");
  const seen = new Set<string>();
  const entries: MentionPath[] = [];
  for (const file of files.slice(0, WALK_MAX_ENTRIES)) {
    const normalized = file.replace(/\\/g, "/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push({ kind: "file", path: normalized });
    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (!seen.has(dir)) {
        seen.add(dir);
        entries.push({ kind: "directory", path: dir });
      }
    }
  }
  return entries;
}

async function walkPaths(cwd: string, signal?: AbortSignal): Promise<MentionPath[]> {
  const entries: MentionPath[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  while (queue.length && entries.length < WALK_MAX_ENTRIES) {
    if (signal?.aborted) throw new Error("aborted");
    const { rel, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await fs.readdir(rel ? path.join(cwd, rel) : cwd, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (entries.length >= WALK_MAX_ENTRIES) break;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(dirent.name)) continue;
        entries.push({ kind: "directory", path: childRel });
        if (depth < WALK_MAX_DEPTH) queue.push({ rel: childRel, depth: depth + 1 });
      } else if (dirent.isFile()) {
        entries.push({ kind: "file", path: childRel });
      }
    }
  }
  return entries;
}
