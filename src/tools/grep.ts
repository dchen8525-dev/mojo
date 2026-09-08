import { glob } from "glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, num, truncate, describeError } from "./utils.js";

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", ".next", "target", "__pycache__", ".venv", "vendor"];
const MAX_FILES_SCANNED = 2000;

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
      const re = new RegExp(str(input, "pattern"), input.ignore_case === true ? "i" : "");
      const limit = Math.min(500, Math.max(1, num(input, "limit") ?? 100));
      const target = input.path ? resolvePath(ctx.cwd, String(input.path)) : ctx.cwd;

      let files: string[];
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        files = [target];
      } else {
        const pattern = typeof input.glob === "string" && input.glob ? input.glob : "**/*";
        const found = await glob(pattern, {
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
            hits.push(`${relPath(ctx.cwd, file)}:${i + 1}:${lines[i].trim().slice(0, 300)}`);
            if (hits.length >= limit) break;
          }
        }
      }

      if (hits.length === 0) {
        return {
          content:
            `No matches${skipped ? ` (skipped ${skipped} binary/huge files)` : ""}. ` +
            `Try a looser pattern or check spelling/casing.`,
        };
      }
      return {
        content: truncate(
          hits.join("\n") +
            (hits.length >= limit ? `\n[... capped at ${limit} matches; narrow the pattern]` : ""),
        ),
      };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
