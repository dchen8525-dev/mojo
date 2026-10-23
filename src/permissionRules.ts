/**
 * Structured permission rules and conservative shell splitting.
 *
 * A rule is stored as `tool(pattern)` (e.g. `bash(npm test:*)`,
 * `write_file(src/app.ts)`). Legacy rules without the wrapper still match the
 * human description, but they can never auto-allow a compound shell command:
 * `npm test; curl … | sh` must be covered per sub-command.
 */

export interface ParsedRule {
  tool: string;
  pattern: string;
}

/** `bash(npm test:*)` -> { tool: "bash", pattern: "npm test:*" }. */
export function parseStructuredRule(match: string): ParsedRule | null {
  const text = match.trim();
  const open = text.indexOf("(");
  if (open <= 0 || !text.endsWith(")")) return null;
  const tool = text.slice(0, open).trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tool)) return null;
  return { tool, pattern: text.slice(open + 1, -1) };
}

export type PatternKind = "exact" | "prefix" | "glob";

/** `cmd:*` is a command prefix only for bash; other tools use exact/glob. */
export function patternKind(pattern: string, tool: string): PatternKind {
  const p = pattern.trim();
  if (tool.toLowerCase() === "bash" && p.endsWith(":*")) {
    const base = p.slice(0, -2).trim();
    if (base && !base.includes("*")) return "prefix";
  }
  return p.includes("*") ? "glob" : "exact";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Full-value glob: `*` matches anything, everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "s").test(value);
  } catch {
    return false;
  }
}

export function patternMatches(pattern: string, value: string, kind: PatternKind): boolean {
  const p = pattern.trim();
  const v = value.trim();
  if (kind === "prefix") {
    const base = p.slice(0, -2).trim();
    return v === base || v.startsWith(`${base} `) || v.startsWith(`${base}\t`);
  }
  if (kind === "glob") return globMatches(p, v);
  return v === p;
}

const PATH_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "read_file"]);

/** Rules and values for file tools compare with `/` separators on every OS. */
export function normalizeRuleValue(tool: string, value: string): string {
  return PATH_TOOLS.has(tool.toLowerCase()) ? value.replace(/\\/g, "/") : value;
}

export interface ShellSplit {
  /** Simple commands in execution order (empty/comment segments dropped). */
  segments: string[];
  /**
   * The command uses constructs this parser cannot split safely (command
   * substitution, subshells, heredocs, unterminated quotes…). Callers must not
   * auto-allow it from per-command rules; only an exact whole-command rule may.
   */
  opaque: boolean;
}

/**
 * Split a shell command on `;`, `&&`, `||`, `|`, `&` and newlines, respecting
 * single/double quotes and backslash escapes. Deliberately conservative: if a
 * construct might hide a command, mark the whole request opaque instead of
 * guessing. Over-splitting is safe (it only causes an extra prompt).
 */
export function splitShellCommand(command: string): ShellSplit {
  const segments: string[] = [];
  let buf = "";
  let opaque = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    const text = buf.trim();
    if (text) segments.push(text);
    buf = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) opaque = true;
      buf += ch;
      if (ch === "\\") {
        // Keep the escaped char verbatim; it cannot close the quote.
        if (i + 1 < command.length) buf += command[++i];
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    // Unquoted.
    if (ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(") || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      opaque = true;
      buf += ch;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      opaque = true;
      buf += ch;
      continue;
    }
    if (ch === "#" && (buf === "" || /\s$/.test(buf))) {
      // Comment: skip to the end of the line (the line break still splits).
      while (i + 1 < command.length && command[i + 1] !== "\n" && command[i + 1] !== "\r") i++;
      push();
      continue;
    }
    if (ch === ";") {
      push();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      push();
      continue;
    }
    if (ch === "&" && !buf.endsWith(">")) {
      // `2>&1` / `&>` are redirections, not separators; only `&` alone or `&&`.
      push();
      if (command[i + 1] === "&") i++;
      continue;
    }
    if (ch === "|") {
      push();
      if (command[i + 1] === "|" || command[i + 1] === "&") i++;
      continue;
    }
    buf += ch;
  }
  if (quote) opaque = true; // unterminated quote: don't guess
  push();
  if (!segments.length && command.trim()) {
    // e.g. a comment-only command: nothing to execute, but stay conservative.
    return { segments: [command.trim()], opaque: true };
  }
  return { segments, opaque };
}
