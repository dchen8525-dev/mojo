import { spawn } from "node:child_process";
import { glob } from "glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, num, truncate, describeError } from "./utils.js";

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", ".next", "target", "__pycache__", ".venv", "vendor"];
const MAX_FILES_SCANNED = 2000;
const MAX_LINE_CHARS = 300;

/** null = not probed yet; true/false once `rg --version` has answered. */
let rgAvailable: boolean | null = null;

function probeRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return Promise.resolve(rgAvailable);
  return new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      rgAvailable = false;
      resolve(false);
    });
    child.once("close", (code) => {
      rgAvailable = code === 0;
      resolve(rgAvailable);
    });
  });
}

interface RgResult {
  hits: string[];
  /** false means ripgrep could not handle the search (unsupported regex, I/O error); caller falls back. */
  ok: boolean;
  unavailable?: boolean;
}

/** Run ripgrep in --json mode, resolving as soon as `limit` matches were collected. */
function rgSearch(
  pattern: string,
  target: string,
  opts: { glob?: string; ignoreCase: boolean; limit: number; cwd: string; signal?: AbortSignal },
): Promise<RgResult> {
  const args = ["--json", "--max-filesize", "1500000", "--max-columns", String(MAX_LINE_CHARS)];
  if (opts.ignoreCase) args.push("-i");
  if (opts.glob) args.push("--glob", opts.glob);
  for (const dir of IGNORED_DIRS) args.push("--glob", `!**/${dir}/**`);
  args.push("--", pattern, target);

  return new Promise((resolve) => {
    const child = spawn("rg", args, { windowsHide: true });
    const hits: string[] = [];
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RgResult) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      child.kill();
      resolve(result);
    };
    const onAbort = () => finish({ hits, ok: false });

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (ev.type !== "match") continue;
          const file = ev.data?.path?.text;
          const lineNo = ev.data?.line_number;
          if (typeof file !== "string" || typeof lineNo !== "number") continue;
          hits.push(`${relPath(opts.cwd, file)}:${lineNo}:${(ev.data?.lines?.text ?? "").trim().slice(0, MAX_LINE_CHARS)}`);
          if (hits.length >= opts.limit) finish({ hits, ok: true });
        } catch {
          /* skip malformed event */
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.once("error", (err: NodeJS.ErrnoException) => {
      finish({ hits, ok: false, unavailable: err.code === "ENOENT" });
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0 || code === 1) finish({ hits, ok: true });
      else finish({ hits, ok: false });
    });
  });
}

/** Pure-JS ripgrep fallback: regex search across text files. */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns matching lines as " +
    "'path:line:content'. Case-insensitive by default is OFF (pass ignore_case for that). " +
    "Optionally restrict to files matching a glob pattern. This is the fastest way to find " +
    "where a symbol or string is used.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regex." },
      path: { type: "string", description: "File or directory to search (default: working directory)." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts')." },
      ignore_case: { type: "boolean" },
      limit: { type: "number", description: "Max matching lines to return (default 100)." },
    },
    required: ["pattern"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const pattern = str(input, "pattern");
      const re = new RegExp(pattern, input.ignore_case === true ? "i" : "");
      const limit = Math.min(500, Math.max(1, num(input, "limit") ?? 100));
      const target = input.path ? resolvePath(ctx.cwd, String(input.path)) : ctx.cwd;
      const globPattern = typeof input.glob === "string" && input.glob ? input.glob : undefined;

      const stat = await fs.stat(target);

      if (await probeRipgrep()) {
        const r = await rgSearch(pattern, target, {
          glob: globPattern,
          ignoreCase: input.ignore_case === true,
          limit,
          cwd: ctx.cwd,
          signal: ctx.signal,
        });
        if (r.unavailable) rgAvailable = false;
        if (r.ok) return formatHits(r.hits, limit);
        if (ctx.signal?.aborted) return { content: "Search aborted.", isError: true };
        // Unsupported regex / rg failure: fall through to the JS scanner.
      }

      let files: string[];
      if (stat.isFile()) {
        files = [target];
      } else {
        const found = await glob(globPattern ?? "**/*", {
          cwd: target,
          ignore: IGNORED_DIRS.map((d) => `${d}/**`),
          nodir: true,
        });
        files = found.slice(0, MAX_FILES_SCANNED).map((f) => path.join(target, f));
      }

      const hits: string[] = [];
      let skipped = 0;
      for (const file of files) {
        if (hits.length >= limit) break;
        if (ctx.signal?.aborted) return { content: "Search aborted.", isError: true };
        let text: string;
        try {
          const buf = await fs.readFile(file);
          if (buf.includes(0) || buf.length > 1_500_000) {
            skipped++;
            continue;
          }
          text = buf.toString("utf8");
        } catch {
          skipped++;
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${relPath(ctx.cwd, file)}:${i + 1}:${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
            if (hits.length >= limit) break;
          }
        }
      }

      return formatHits(hits, limit, skipped);
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

function formatHits(hits: string[], limit: number, skipped = 0): ToolResult {
  if (hits.length === 0) {
    return {
      content:
        `No matches${skipped ? ` (skipped ${skipped} binary/huge files)` : ""}. ` +
        `Try a looser pattern or check spelling/casing.`,
    };
  }
  return {
    content: truncate(
      hits.join("\n") + (hits.length >= limit ? `\n[... capped at ${limit} matches; narrow the pattern]` : ""),
    ),
  };
}
