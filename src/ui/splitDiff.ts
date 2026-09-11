/**
 * Turn a unified diff into left/right rows for a split-pane view.
 *
 * The agent's previews come from several producers (renderDiff for edit_file,
 * `git diff` for git tools, a markdown plan for exit_plan, a command line for
 * bash), so `looksLikeDiff` gates whether split mode is even offered. When the
 * text is a real unified diff we pair removed and added runs side-by-side,
 * carry old/new line numbers from the hunk header, and render file/hunk headers
 * as full-width meta rows.
 */

export interface DiffCell {
  /** Old (left) or new (right) line number; null for a blank filler cell. */
  num: number | null;
  text: string;
}

export type DiffRow =
  | { kind: "meta"; text: string }
  | { kind: "pair"; left: DiffCell; right: DiffCell; changed: boolean };

/** True when the text has at least one hunk header or a git file header. */
export function looksLikeDiff(text: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) || /^diff --git /m.test(text);
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function splitDiffRows(diff: string): DiffRow[] {
  const lines = diff.split("\n");
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      rows.push({ kind: "meta", text: line });
      i++;
      continue;
    }

    if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename ).*/.test(line)) {
      rows.push({ kind: "meta", text: line });
      i++;
      continue;
    }

    if (line.startsWith(" ")) {
      rows.push({
        kind: "pair",
        left: { num: oldNo++, text: line.slice(1) },
        right: { num: newNo++, text: line.slice(1) },
        changed: false,
      });
      i++;
      continue;
    }

    // A removed/added region: gather the contiguous -/+ block, then split into
    // one run of removals and one run of additions and interleave them.
    if (line.startsWith("-") || line.startsWith("+")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && (lines[i].startsWith("-") || lines[i].startsWith("+"))) {
        if (lines[i].startsWith("-")) removed.push(lines[i].slice(1));
        else added.push(lines[i].slice(1));
        i++;
      }
      const n = Math.max(removed.length, added.length);
      for (let k = 0; k < n; k++) {
        const hasLeft = k < removed.length;
        const hasRight = k < added.length;
        rows.push({
          kind: "pair",
          left: hasLeft ? { num: oldNo++, text: removed[k] } : { num: null, text: "" },
          right: hasRight ? { num: newNo++, text: added[k] } : { num: null, text: "" },
          changed: hasLeft || hasRight,
        });
      }
      continue;
    }

    // Anything else (stray text) is a neutral full-width row; a trailing empty
    // line from the final newline is dropped.
    if (line !== "" || i < lines.length - 1) rows.push({ kind: "meta", text: line });
    i++;
  }

  return rows;
}

/** Fixed layout widths: two gutter digits + one sign/space column per side. */
export const GUTTER = 3;

/**
 * Content width (chars, excluding gutters) for each side given the terminal
 * width. Split cells are truncated (never wrapped) so each row is exactly one
 * display line; a very narrow terminal falls back to a cramped minimum.
 */
export function splitColumnWidth(terminalCols: number): number {
  const inner = Math.max(20, terminalCols - 6); // box border + padding
  return Math.max(8, Math.floor(inner / 2) - GUTTER);
}

/** Truncate to `width` display cells, marking overflow with a trailing arrow. */
export function clipCell(text: string, width: number): string {
  if (text.length <= width) return text;
  return width > 1 ? text.slice(0, width - 1) + "…" : text.slice(0, width);
}
