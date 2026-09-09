import { glob } from "glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, str, bool, truncate, describeError } from "./utils.js";
import { applyEdits, findAll, renderDiff, type Edit } from "./editMatch.js";

/**
 * Cross-file search & replace (codemod style): one glob + one pattern replaces
 * every occurrence across the whole project, shows a combined diff, and asks
 * for a SINGLE confirmation before touching anything. Each file is checkpointed
 * first, so /undo can roll back the batch one file at a time.
 */

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", ".next", "target", "__pycache__", ".venv", "vendor"];
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_000_000;

interface FileHit {
  abs: string;
  original: string;
  edits: Edit[];
  updated: string;
}

/** All occurrences of `search` (literal or regex) as edits replacing with `replacement`. */
export function computeEdits(text: string, search: string, replacement: string, useRegex: boolean): Edit[] {
  if (useRegex) {
    // "gm": global across the file, multiline so ^/$ anchor per line.
    const re = new RegExp(search, "gm");
    // Non-global twin for expanding $1/$& inside one match: calling
    // m[0].replace(re, ...) with the /g regex would reset re.lastIndex and
    // restart the exec loop below.
    const perMatch = new RegExp(search, "m");
    const edits: Edit[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") {
        re.lastIndex++; // guard against zero-length matches looping forever
        continue;
      }
      edits.push({ start: m.index, end: m.index + m[0].length, text: m[0].replace(perMatch, replacement) });
    }
    return edits;
  }
  return findAll(text, search).map((start) => ({ start, end: start + search.length, text: replacement }));
}

export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Search & replace across many files in one operation (renames, import path changes, " +
    "API migrations). Takes a glob to pick files and a literal or regex pattern to replace. " +
    "Shows a combined diff and asks the user ONCE before writing. Pass dry_run: true first " +
    "when you want to preview matches without any prompt. Every touched file is checkpointed " +
    "for /undo. Prefer edit_file for single-file changes.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob selecting candidate files, e.g. 'src/**/*.ts'." },
      search: { type: "string", description: "Text (or regex when use_regex) to find." },
      replacement: { type: "string", description: "Replacement. With regex, $1/$& groups are expanded." },
      use_regex: { type: "boolean", description: "Treat search as a JavaScript regex (global)." },
      dry_run: { type: "boolean", description: "Only report what WOULD change; write nothing." },
    },
    required: ["pattern", "search", "replacement"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const pattern = str(input, "pattern");
      const search = str(input, "search");
      const replacement = typeof input.replacement === "string" ? (input.replacement as string) : "";
      const useRegex = bool(input, "use_regex");
      const dryRun = bool(input, "dry_run");
      if (!search) return { content: "Error: search must not be empty.", isError: true };
      if (useRegex) {
        try {
          new RegExp(search);
        } catch (err) {
          return { content: `Error: invalid regex: ${describeError(err)}`, isError: true };
        }
      }

      const matched = await glob(pattern, {
        cwd: ctx.cwd,
        ignore: IGNORED_DIRS.map((d) => `${d}/**`),
        nodir: true,
        dot: false,
      });
      if (!matched.length) return { content: `No files match "${pattern}".`, isError: true };
      if (matched.length > MAX_FILES) {
        return {
          content: `Error: "${pattern}" matches ${matched.length} files (limit ${MAX_FILES}). Narrow the glob.`,
          isError: true,
        };
      }

      const hits: FileHit[] = [];
      let scanned = 0;
      let skippedBinary = 0;
      for (const rel of matched) {
        const abs = path.resolve(ctx.cwd, rel);
        let raw: Buffer;
        try {
          raw = await fs.readFile(abs);
        } catch {
          continue; // unreadable (permissions, race) - skip
        }
        if (raw.length > MAX_FILE_BYTES || raw.includes(0)) {
          skippedBinary++;
          continue; // binary or oversized: never regex-scan
        }
        scanned++;
        const text = raw.toString("utf8");
        const edits = computeEdits(text, search, replacement, useRegex);
        if (edits.length) hits.push({ abs, original: text, edits, updated: applyEdits(text, edits) });
      }

      if (!hits.length) {
        return {
          content: `No matches for ${useRegex ? `regex /${search}/` : `"${search}"`} in ${scanned} file(s) matching "${pattern}".`,
        };
      }

      const total = hits.reduce((n, h) => n + h.edits.length, 0);
      const diff = truncate(
        hits.map((h) => `--- ${relPath(ctx.cwd, h.abs)}\n${renderDiff(h.original, h.edits)}`).join("\n"),
        12_000,
      );
      const summary =
        `${total} replacement${total === 1 ? "" : "s"} in ${hits.length} file${hits.length === 1 ? "" : "s"} ` +
        `(of ${scanned} scanned${skippedBinary ? `, ${skippedBinary} binary/oversized skipped` : ""})`;

      if (dryRun) {
        return { content: `dry run - nothing written.\n${summary}\n<diff>\n${diff}\n</diff>` };
      }

      const ok = await ctx.askPermission(
        `multi_edit: ${summary}. Pattern: ${useRegex ? `/${search}/` : `"${search}"`} → "${replacement}"`,
        "high",
        diff,
      );
      if (!ok) return { content: "The user rejected this batch edit. Nothing was written.", isError: true };

      const written: string[] = [];
      const failed: string[] = [];
      for (const h of hits) {
        try {
          await ctx.checkpoint?.(h.abs, "multi_edit");
          await fs.writeFile(h.abs, h.updated, "utf8");
          written.push(relPath(ctx.cwd, h.abs));
        } catch (err) {
          failed.push(`${relPath(ctx.cwd, h.abs)} (${describeError(err)})`);
        }
      }
      const head = `Applied ${summary}: ${written.join(", ")}`;
      const tail = failed.length ? `\nFailed: ${failed.join(", ")}` : "";
      return {
        content: truncate(
          `${head}${tail}\n<diff>\n${diff}\n</diff>`,
        ),
        isError: written.length === 0,
      };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};
