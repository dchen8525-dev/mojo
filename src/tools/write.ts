import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, truncate, describeError } from "./utils.js";
import { diagnosticsHint } from "../lsp.js";
import { editGuardMessage } from "../fileState.js";
import { atomicWriteFile } from "../atomicWrite.js";
import { applyEdits, diffStats, findAll, findFuzzyEdits, nearestMiss, renderDiff, type Edit } from "./editMatch.js";

/** A whole-file "added" diff for new/empty files, in the same shape as renderDiff. */
function createDiffPreview(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
}

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

      if (existed) {
        // Overwriting is only allowed for files whose full contents the model
        // has seen, and only while the on-disk copy still matches that read.
        const blocked = await ctx.fileState?.check(abs, true);
        if (blocked) return { content: editGuardMessage(ctx.cwd, abs, blocked), isError: true };
      }

      // Show the planned change as a diff, not just counts: the GUI and the
      // Ink UI render `@@`-headed previews with line numbers.
      let preview: string | undefined;
      if (existed) {
        const current = await fs.readFile(abs, "utf8").catch(() => null);
        preview = current
          ? renderDiff(current, [{ start: 0, end: current.length, text: content }])
          : createDiffPreview(content);
      } else {
        preview = createDiffPreview(content);
      }
      const previewLines = preview.split("\n");
      if (previewLines.length > 120) {
        preview =
          previewLines.slice(0, 120).join("\n") + `\n[... preview truncated: ${previewLines.length - 120} more lines]`;
      }

      const displayPath = relPath(ctx.cwd, abs);
      const ok = await ctx.askPermission(
        `${existed ? "Overwrite" : "Create"} file ${displayPath} ` +
          `(${content.split("\n").length} lines, ${content.length} chars)`,
        "high",
        preview,
        {
          tool: "write_file",
          values: [displayPath],
          remember: `write_file(${displayPath.replace(/\\/g, "/")})`,
        },
      );
      if (!ok) return { content: "The user rejected this edit. Ask before trying again.", isError: true };

      const checkpoint = await ctx.checkpoint?.(abs, "write_file");
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWriteFile(abs, content);
      await checkpoint?.finalize?.();
      await ctx.fileState?.recordCurrent(abs);
      const hint = await diagnosticsHint(ctx.cwd, abs, content);
      return { content: `${existed ? "Wrote" : "Created"} ${relPath(ctx.cwd, abs)} (${content.length} chars)${hint}` };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace string(s) in a file. old_string should match the file exactly - copy it from " +
    "read_file output (the \"N\\t\" prefixes are line numbers, not content). As a fallback the " +
    "match ignores per-line leading/trailing whitespace and re-indents new_string to the file, " +
    "with looser fallbacks (quote / line-number-prefix / escape normalization, then block-anchor " +
    "similarity), but do not rely on that: prefer exact text. If old_string appears more than once the call " +
    "fails unless replace_all is set; add surrounding context to disambiguate. The result shows " +
    "a diff of what changed plus fresh diagnostics.",
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

      const blocked = await ctx.fileState?.check(abs);
      if (blocked) return { content: editGuardMessage(ctx.cwd, abs, blocked), isError: true };

      const original = await fs.readFile(abs, "utf8");

      // Strategy 1: exact byte match.
      let edits: Edit[] = findAll(original, oldString).map((start) => ({
        start,
        end: start + oldString.length,
        text: newString,
      }));
      let note = "";

      // Strategies 2+: escalating normalizations (whitespace, quotes,
      // line-number prefixes, escapes, block-anchor similarity). Only when the
      // exact match found nothing.
      let ambiguous = false;
      if (edits.length === 0) {
        const fuzzy = findFuzzyEdits(original, oldString, newString);
        edits = fuzzy.edits;
        note = fuzzy.note;
        ambiguous = fuzzy.ambiguous === true;
      }

      if (edits.length === 0) {
        const near = nearestMiss(original, oldString);
        const ambiguity = ambiguous
          ? " A loose similarity match lands in several places, so it was not applied."
          : "";
        const hint = near
          ? `${ambiguity} The closest region starts at line ${near.line} and says:\n${near.snippet}\n` +
            `Copy that text (or a wider unique range) as old_string.`
          : `${ambiguity} Re-read the file and copy the exact text (watch indentation and trailing spaces).`;
        return {
          content: `Error: old_string not found in ${relPath(ctx.cwd, abs)}.${hint}`,
          isError: true,
        };
      }
      if (edits.length > 1 && !replaceAll) {
        const lines = edits.map((e) => lineOf(original, e.start)).join(", ");
        return {
          content:
            `Error: old_string matches ${edits.length} places in ${relPath(ctx.cwd, abs)} ` +
            `(lines ${lines}). Include more surrounding context, or pass replace_all: true.`,
          isError: true,
        };
      }

      const updated = applyEdits(original, edits);
      const diff = renderDiff(original, edits);

      const displayPath = relPath(ctx.cwd, abs);
      const ok = await ctx.askPermission(
        `Edit ${displayPath}: ${edits.length} replacement${edits.length === 1 ? "" : "s"}, ` +
          `${diffStats(edits, original)}${note ? ` (${note})` : ""}`,
        "high",
        diff,
        {
          tool: "edit_file",
          values: [displayPath],
          remember: `edit_file(${displayPath.replace(/\\/g, "/")})`,
        },
      );
      if (!ok) return { content: "The user rejected this edit. Ask before trying again.", isError: true };

      const checkpoint = await ctx.checkpoint?.(abs, "edit_file");
      await atomicWriteFile(abs, updated);
      await checkpoint?.finalize?.();
      await ctx.fileState?.recordCurrent(abs);
      const hint = await diagnosticsHint(ctx.cwd, abs, updated);
      return {
        content: truncate(
          `Edited ${relPath(ctx.cwd, abs)} (${edits.length} replacement${edits.length === 1 ? "" : "s"}${
            note ? `, ${note}` : ""
          }).\n<diff>\n${diff}\n</diff>${hint}`,
        ),
      };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}
