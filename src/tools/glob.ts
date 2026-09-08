import { glob } from "glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, str, num, truncate, describeError } from "./utils.js";

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", ".next", "target", "__pycache__", ".venv", "vendor"];

export const globTool: Tool = {
  name: "glob_files",
  description:
    "Find files by glob pattern (e.g. 'src/**/*.ts', '*.json'). Returns matching paths " +
    "relative to the working directory, sorted by modification time (newest first). " +
    "Common build/dependency directories are skipped. Use this before read_file when you " +
    "need to locate files.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory to search in (defaults to working directory)." },
      limit: { type: "number", description: "Max results (default 200)." },
    },
    required: ["pattern"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const searchDir = input.path ? path.resolve(ctx.cwd, String(input.path)) : ctx.cwd;
      const limit = Math.min(1000, Math.max(1, num(input, "limit") ?? 200));
      const matches = await glob(str(input, "pattern"), {
        cwd: searchDir,
        ignore: IGNORED_DIRS.map((d) => `${d}/**`),
        dot: false,
        nodir: false,
      });
      const stats = await Promise.all(
        matches.slice(0, 2000).map(async (m) => {
          try {
            const st = await fs.stat(path.join(searchDir, m));
            return { m, mtime: st.mtimeMs, dir: st.isDirectory() };
          } catch {
            return { m, mtime: 0, dir: false };
          }
        }),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      const shown = stats.slice(0, limit).map((s) => relPath(ctx.cwd, path.join(searchDir, s.m)) + (s.dir ? "/" : ""));
      if (shown.length === 0) return { content: "No files matched." };
      const more = stats.length > limit ? `\n[... ${stats.length - limit} more matches]` : "";
      return { content: truncate(shown.join("\n") + more) };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
