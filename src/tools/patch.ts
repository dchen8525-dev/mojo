import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { relPath, resolvePath, str, describeError } from "./utils.js";
import { diagnosticsHint } from "../lsp.js";
import { editGuardMessage } from "../fileState.js";
import { atomicWriteFile } from "../atomicWrite.js";
import { derivePatchedContent, parseStructuredPatch, type ParsedPatch } from "../patch.js";

const PREVIEW_LINE_CAP = 120;

interface PlannedChange {
  kind: "add" | "update" | "move" | "delete";
  abs: string;
  /** Move target; the source file is deleted after the new one is written. */
  moveAbs?: string;
  newContent?: string;
  oldContent?: string;
  preview: string;
  description: string;
  oldLineCount: number;
  added: number;
  removed: number;
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply a structured multi-file patch in one call. The patch starts with `*** Begin Patch` " +
    "and ends with `*** End Patch`; use `*** Add File: <path>` (every line prefixed `+`), " +
    "`*** Update File: <path>` with `@@` hunks (context lines prefixed with a space, removed " +
    "lines `-`, added lines `+`, optional `*** Move to: <path>` and `*** End of File`), and " +
    "`*** Delete File: <path>`. Hunk context matches with escalating leniency, but prefer " +
    "copying exact lines from read_file output. Use this instead of several write/edit calls " +
    "when one change spans multiple files.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The full `*** Begin Patch … *** End Patch` text." },
    },
    required: ["patch"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      let sections: ParsedPatch[];
      try {
        sections = parseStructuredPatch(str(input, "patch"));
      } catch (err) {
        return { content: `Error: ${describeError(err)}`, isError: true };
      }
      if (sections.length === 0) {
        return { content: "Error: the patch contains no file sections.", isError: true };
      }

      const seen = new Set<string>();
      const plans: PlannedChange[] = [];
      for (const section of sections) {
        const abs = resolvePath(ctx.cwd, section.path);
        const key = `${section.type}:${abs.toLowerCase()}`;
        if (seen.has(key)) {
          return { content: `Error: duplicate ${section.type} section for ${section.path}.`, isError: true };
        }
        seen.add(key);
        plans.push(await planSection(section, abs, ctx));
      }

      // Two sections may not write the same path (update+delete, move onto a
      // file another section edits, ...): applying them in parse order would
      // silently make one of them win.
      const touched = new Map<string, string>();
      for (const plan of plans) {
        for (const p of plan.moveAbs ? [plan.abs, plan.moveAbs] : [plan.abs]) {
          const key = pathKey(p);
          const previous = touched.get(key);
          if (previous) {
            return {
              content:
                `Error: conflicting patch sections both touch ${relPath(ctx.cwd, p)} ` +
                `(${previous} and ${plan.kind}). Split them into separate calls.`,
              isError: true,
            };
          }
          touched.set(key, plan.kind);
        }
      }

      // Ask once per affected path; existing allow rules answer silently and a
      // denial aborts the whole patch before anything touches the disk.
      for (const plan of plans) {
        const displayPath = relPath(ctx.cwd, plan.moveAbs ?? plan.abs);
        const ok = await ctx.askPermission(plan.description, "high", clipPreview(plan.preview), {
          tool: "apply_patch",
          values: [displayPath],
        });
        if (!ok) return { content: "The user rejected this patch. Ask before trying again.", isError: true };
      }

      const summaries: string[] = [];
      let hint = "";
      for (const plan of plans) {
        if (plan.kind === "delete") {
          const checkpoint = await ctx.checkpoint?.(plan.abs, "apply_patch");
          await fs.unlink(plan.abs);
          await checkpoint?.finalize?.();
          ctx.fileState?.invalidate(plan.abs);
          summaries.push(`D ${relPath(ctx.cwd, plan.abs)} (-${plan.oldLineCount})`);
          continue;
        }
        const target = plan.moveAbs ?? plan.abs;
        const checkpoint = await ctx.checkpoint?.(
          plan.abs,
          "apply_patch",
          plan.moveAbs ? { movedTo: plan.moveAbs } : undefined,
        );
        if (plan.kind === "add") await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWriteFile(target, plan.newContent ?? "");
        if (plan.moveAbs) {
          await fs.unlink(plan.abs);
          ctx.fileState?.invalidate(plan.abs);
        }
        // Finalize only after the source is gone: for a move the checkpoint must
        // record that post-state, otherwise /undo mistakes the agent's own
        // unlink for a user edit and refuses to roll the move back.
        await checkpoint?.finalize?.();
        ctx.fileState?.recordCurrent(target);
        if (plan.moveAbs) {
          summaries.push(`M ${relPath(ctx.cwd, plan.abs)} -> ${relPath(ctx.cwd, plan.moveAbs)} (+${plan.added}/-${plan.removed})`);
        } else {
          summaries.push(`${plan.kind === "add" ? "A" : "M"} ${relPath(ctx.cwd, plan.abs)} (+${plan.added}/-${plan.removed})`);
        }
        if (plan.newContent !== undefined && plan.newContent.length < 400_000) {
          hint += await diagnosticsHint(ctx.cwd, target, plan.newContent);
        }
      }
      return { content: `Patch applied.\n${summaries.join("\n")}${hint}` };
    } catch (err) {
      return { content: `Error: ${describeError(err)}`, isError: true };
    }
  },
};

async function planSection(section: ParsedPatch, abs: string, ctx: ToolContext): Promise<PlannedChange> {
  const display = relPath(ctx.cwd, abs);
  if (section.type === "add") {
    const exists = await fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new Error(`File already exists: ${display}`);
    const lines = section.contents.replace(/\n$/, "").split("\n");
    return {
      kind: "add",
      abs,
      newContent: section.contents,
      oldContent: "",
      preview: `@@ -0,0 +1,${lines.length} @@ ${display}\n${lines.map((l) => `+${l}`).join("\n")}`,
      description: `Create file ${display} (${lines.length} lines, ${section.contents.length} chars)`,
      oldLineCount: 0,
      added: lines.length,
      removed: 0,
    };
  }

  if (section.type === "delete") {
    const blocked = await ctx.fileState?.check(abs);
    if (blocked) throw new Error(`${editGuardMessage(ctx.cwd, abs, blocked)} Delete it via apply_patch after reading.`);
    const current = await fs.readFile(abs, "utf8");
    const lineCount = current.replace(/\n$/, "").split("\n").length;
    return {
      kind: "delete",
      abs,
      oldContent: current,
      preview: `@@ -1,${lineCount} +0,0 @@ ${display}\n${current
        .replace(/\n$/, "")
        .split("\n")
        .slice(0, 40)
        .map((l) => `-${l}`)
        .join("\n")}`,
      description: `Delete file ${display} (${lineCount} lines)`,
      oldLineCount: lineCount,
      added: 0,
      removed: lineCount,
    };
  }

  // update (optionally with move)
  if (section.chunks.length === 0) throw new Error(`Update section for ${display} has no hunks.`);
  const blocked = await ctx.fileState?.check(abs);
  if (blocked) throw new Error(editGuardMessage(ctx.cwd, abs, blocked));
  const current = await fs.readFile(abs, "utf8");
  let patched: string;
  try {
    patched = derivePatchedContent(current, section.chunks).content;
  } catch (err) {
    throw new Error(
      `${display}: ${describeError(err)}. Re-read the file and copy the exact lines into the hunk.`,
    );
  }
  const moveAbs = section.movePath ? resolvePath(ctx.cwd, section.movePath) : undefined;
  if (moveAbs) {
    if (pathKey(moveAbs) === pathKey(abs)) {
      throw new Error(`Cannot move ${display} onto itself (the source is deleted after writing).`);
    }
    const exists = await fs
      .access(moveAbs)
      .then(() => true)
      .catch(() => false);
    // Overwriting an existing file during a move is silent data loss: the old
    // content is never read, previewed or checkpointed.
    if (exists) throw new Error(`Move target already exists: ${relPath(ctx.cwd, moveAbs)}.`);
  }
  const { added, removed } = countChunkLines(section.chunks);
  const preview = section.chunks
    .map((chunk) => {
      const header = `@@${chunk.changeContext ? ` ${chunk.changeContext}` : ""}${chunk.endOfFile ? " (to end of file)" : ""}`;
      const lines = [
        ...chunk.oldLines.map((l) => {
          const shared = chunk.newLines.includes(l);
          return shared ? ` ${l}` : `-${l}`;
        }),
        ...chunk.newLines
          .filter((l) => !chunk.oldLines.includes(l))
          .map((l) => `+${l}`),
      ];
      return `${header} ${display}\n${lines.join("\n")}`;
    })
    .join("\n");
  const description = moveAbs
    ? `Move ${display} -> ${relPath(ctx.cwd, moveAbs)} (${added}+/-${removed})`
    : `Edit ${display}: ${section.chunks.length} hunk${section.chunks.length === 1 ? "" : "s"} (${added}+/-${removed})`;
  return {
    kind: moveAbs ? "move" : "update",
    abs,
    moveAbs,
    newContent: patched,
    oldContent: current,
    preview,
    description,
    oldLineCount: current.replace(/\n$/, "").split("\n").length,
    added,
    removed,
  };
}

function countChunkLines(chunks: Array<{ oldLines: string[]; newLines: string[] }>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const chunk of chunks) {
    const shared = new Set(chunk.oldLines.filter((l) => chunk.newLines.includes(l)));
    removed += chunk.oldLines.filter((l) => !shared.has(l)).length;
    added += chunk.newLines.filter((l) => !shared.has(l)).length;
  }
  return { added, removed };
}

function clipPreview(preview: string): string {
  const lines = preview.split("\n");
  if (lines.length <= PREVIEW_LINE_CAP) return preview;
  return `${lines.slice(0, PREVIEW_LINE_CAP).join("\n")}\n[... preview truncated: ${lines.length - PREVIEW_LINE_CAP} more lines]`;
}

/** Case-insensitive only where the filesystem is (Windows). */
function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
