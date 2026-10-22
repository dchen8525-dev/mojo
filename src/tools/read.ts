import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, num, describeError, isSensitivePath } from "./utils.js";
import { boundedResult } from "../artifacts.js";

const MAX_LINES = 2000;
/** A read larger than this is a mistake or an exfiltration attempt: page it. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Best-effort binary detection for read_file. A NUL byte is a strong signal,
 * but some binaries / encodings (e.g. UTF-16 without NUL alignment artifacts)
 * slip through, so we also flag a high ratio of non-printing control bytes in
 * a sample. Serves to keep byte soup out of the model's context.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const sample = buf.subarray(0, 8192);
  let control = 0;
  for (const b of sample) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control++;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

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
      if (isSensitivePath(abs)) {
        return {
          content: `Error: refusing to read "${abs}" because it is inside a credential store. Ask the user for the specific value instead.`,
          isError: true,
        };
      }
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return { content: `Error: "${abs}" is a directory. Use glob_files instead.`, isError: true };
      }
      if (!stat.isFile()) {
        return { content: `Error: "${abs}" is not a regular file.`, isError: true };
      }
      if (stat.size > MAX_READ_BYTES) {
        return {
          content:
            `Error: "${abs}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the ` +
            `${MAX_READ_BYTES / 1024 / 1024} MB read cap. Use grep to locate the relevant lines, or read with offset/limit.`,
          isError: true,
        };
      }
      // A symlink inside the workspace can point into ~/.ssh; the lexical
      // check above cannot see that, so re-check the resolved target.
      const real = await fs.realpath(abs);
      if (isSensitivePath(real)) {
        return { content: `Error: refusing to read "${abs}" (resolves into a credential store).`, isError: true };
      }
      const buf = await fs.readFile(abs);
      if (looksBinary(buf)) {
        return { content: `Error: "${abs}" appears to be a binary file.`, isError: true };
      }

      const all = buf.toString("utf8").split("\n");
      const offset = Math.max(0, num(input, "offset") ?? 0);
      const limit = Math.min(MAX_LINES, Math.max(1, num(input, "limit") ?? all.length));
      const slice = all.slice(offset, offset + limit);
      ctx.fileState?.record(abs, stat, offset === 0 && offset + slice.length >= all.length);
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
      return { content: await boundedResult(`${relPath(ctx.cwd, abs)}\n${body}${meta}`, 30_000, "read-file") };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
