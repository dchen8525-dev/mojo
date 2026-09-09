import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, num, truncate, describeError } from "./utils.js";

const MAX_LINES = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the local filesystem and return it with 1-based line numbers " +
    "prefixed by TAB. Always pass offset/limit for files you expect to be large; reading a " +
    "whole big file wastes context. Returns an error if the path is a directory or the file " +
    "looks binary.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or path relative to the working directory." },
      offset: { type: "number", description: "0-based line to start from." },
      limit: { type: "number", description: `Number of lines to read (max ${MAX_LINES}).` },
    },
    required: ["path"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const abs = resolvePath(ctx.cwd, str(input, "path"));
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return { content: `Error: "${abs}" is a directory. Use glob_files instead.`, isError: true };
      }
      const buf = await fs.readFile(abs);
      if (buf.includes(0)) {
        return { content: `Error: "${abs}" appears to be a binary file.`, isError: true };
      }

      const all = buf.toString("utf8").split("\n");
      const offset = Math.max(0, num(input, "offset") ?? 0);
      const limit = Math.min(MAX_LINES, Math.max(1, num(input, "limit") ?? all.length));
      const slice = all.slice(offset, offset + limit);
      const width = String(offset + slice.length).length;
      const body = slice
        .map((line, i) => `${String(offset + i + 1).padStart(width)}\t${line}`)
        .join("\n");

      const meta =
        slice.length < all.length - offset
          ? `\n[Showing lines ${offset + 1}-${offset + slice.length} of ${all.length} total. ` +
            `Continue with offset=${offset + slice.length}${limit < MAX_LINES ? ` (or raise limit, max ${MAX_LINES})` : ""}.]`
          : offset > 0 || limit < all.length
            ? `\n[End of file: ${all.length} lines total.]`
            : "";
      return { content: truncate(`${relPath(ctx.cwd, abs)}\n${body}${meta}`) };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
