import path from "node:path";

export const MAX_TOOL_OUTPUT = 30_000; // characters

/** Truncate long output so a single tool call cannot blow up the context. */
export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return (
    head +
    `\n\n[... output truncated: ${text.length - max} more characters omitted. ` +
    `Narrow your query or read a specific line range instead.]`
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
 * Resolve a model-provided path and keep it inside the working directory.
 * The model is not trusted with paths outside cwd unless it explicitly asks
 * with an absolute path that passes the allowlist below.
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

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
