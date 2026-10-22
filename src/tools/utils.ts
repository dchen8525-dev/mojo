import os from "node:os";
import path from "node:path";

export const MAX_TOOL_OUTPUT = 30_000; // characters

/**
 * Credential stores that a prompt-injected model must not be able to read
 * without an explicit user action. Read-only tools never prompt, so a lexical
 * deny here is the only thing standing between a poisoned web page and
 * ~/.ssh/id_rsa.
 */
const SENSITIVE_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".password-store",
  ".node-agent",
  path.join(".config", "gcloud"),
  path.join(".config", "gh"),
  path.join(".docker", "config.json"),
].map((p) => path.join(os.homedir(), p));

const SENSITIVE_FILES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".pypirc",
]);

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True for paths inside well-known credential stores (checked lexically). */
export function isSensitivePath(p: string): boolean {
  const abs = comparable(p);
  for (const dir of SENSITIVE_DIRS) {
    const d = comparable(dir);
    if (abs === d || abs.startsWith(d + path.sep)) return true;
  }
  return SENSITIVE_FILES.has(path.basename(abs));
}

/** Truncate long output so a single tool call cannot blow up the context.
 * Keeps BOTH ends: the head shows how the work started, the tail usually
 * carries the error or summary line that matters most. Plain head-only
 * truncation silently drops exactly that.
 */
export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.75);
  const tailLen = Math.floor(max * 0.2);
  const omitted = text.length - headLen - tailLen;
  return (
    text.slice(0, headLen) +
    `\n\n[... ${omitted.toLocaleString()} characters omitted from the middle of this output ` +
    `(total ${text.length.toLocaleString()} chars; head + tail kept). Narrow your query, page with ` +
    `offset/limit, or read the saved full output if a file path is mentioned below.]` +
    `\n\n` +
    text.slice(text.length - tailLen)
  );
}

export function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string parameter "${key}"`);
  }
  return v;
}

export function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Parameter "${key}" must be a number`);
  }
  return v;
}

export function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Resolve a model-provided path. Relative paths must stay inside the working
 * directory; absolute paths are allowed because the user may explicitly ask
 * the agent to work elsewhere (writes still prompt; reads are governed by
 * `isSensitivePath`).
 */
export function resolvePath(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
  const root = path.resolve(cwd);
  const inside = abs === root || abs.startsWith(root + path.sep);
  if (!inside && !path.isAbsolute(p)) {
    throw new Error(`Path "${p}" escapes the working directory`);
  }
  return abs;
}

export function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  return r === "" ? "." : r;
}

/**
 * Heuristic: does the command mention a path that may leave the working
 * directory (absolute, home-relative, env-expanded or parent-relative)?
 * Read-only bash skips the permission prompt, so `cat ~/.ssh/id_rsa` must not
 * be classified as harmless just because `cat` is an allowlisted program.
 */
export function hasOutsidePathArg(command: string): boolean {
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (!token || token.startsWith("-")) continue;
    // Windows cmd switches such as `DIR /b` are not paths.
    if (/^\/[A-Za-z]$/.test(token)) continue;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(token)) return true;
    if (token.startsWith("~") || token.startsWith("$env:") || /%[^%\s]+%/.test(token)) return true;
    if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("/") || token.startsWith("\\\\")) return true;
  }
  return false;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
