import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, truncate, describeError } from "./utils.js";

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing one. Prefer edit_file for " +
    "existing files so you do not destroy content you have not read. Parent directories " +
    "are created automatically. The whole file content must be provided.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or working-directory-relative path." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const abs = resolvePath(ctx.cwd, str(input, "path"));
      const content = str(input, "content");
      const existed = await fs
        .access(abs)
        .then(() => true)
        .catch(() => false);

      const ok = await ctx.askPermission(
        `${existed ? "Overwrite" : "Create"} file ${relPath(ctx.cwd, abs)} ` +
          `(${content.split("\n").length} lines, ${content.length} chars)`,
        "high",
      );
      if (!ok) return { content: "The user rejected this edit. Ask before trying again.", isError: true };

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return { content: `${existed ? "Wrote" : "Created"} ${relPath(ctx.cwd, abs)} (${content.length} chars)` };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file byte-for-byte " +
    "including indentation; line numbers you see from read_file are NOT part of the content. " +
    "If old_string appears more than once the call fails - add surrounding context to make it " +
    "unique, or pass replace_all. Always read_file the target first.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace. Must be unique unless replace_all." },
      new_string: { type: "string", description: "Replacement text. Empty string deletes." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const abs = resolvePath(ctx.cwd, str(input, "path"));
      const oldString = str(input, "old_string");
      const newString = typeof input.new_string === "string" ? (input.new_string as string) : "";
      const replaceAll = input.replace_all === true;

      const original = await fs.readFile(abs, "utf8");
      const count = original.split(oldString).length - 1;

      if (count === 0) {
        return {
          content:
            `Error: old_string not found in ${relPath(ctx.cwd, abs)}. ` +
            `Re-read the file and copy the exact text (watch indentation and trailing spaces).`,
          isError: true,
        };
      }
      if (count > 1 && !replaceAll) {
        return {
          content:
            `Error: old_string matches ${count} places in ${relPath(ctx.cwd, abs)}. ` +
            `Include more surrounding context, or pass replace_all: true.`,
          isError: true,
        };
      }

      const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);

      const ok = await ctx.askPermission(
        `Edit ${relPath(ctx.cwd, abs)}: replace ${count === 1 ? "1 occurrence" : `${count} occurrences`} ` +
          `(${oldString.length} chars -> ${newString.length} chars)`,
        "high",
      );
      if (!ok) return { content: "The user rejected this edit. Ask before trying again.", isError: true };

      await fs.writeFile(abs, updated, "utf8");
      return {
        content: truncate(
          `Edited ${relPath(ctx.cwd, abs)} (${count} occurrence${count === 1 ? "" : "s"} replaced). ` +
            `File is now ${updated.length} chars.`,
        ),
      };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
