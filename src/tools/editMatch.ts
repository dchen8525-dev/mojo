/**
 * Matching and diff helpers that make edit_file forgiving.
 *
 * The model routinely gets `old_string` slightly wrong - it copies the wrong
 * indentation, drops trailing spaces, or a line-number prefix leaks in. A hard
 * failure there wastes a whole round trip, so we escalate through strategies
 * of increasing forgiveness (see `findFuzzyEdits`). When even that fails we
 * return the closest region we could find, so the next attempt has the real
 * text in front of it.
 */

export interface Edit {
  /** Character offset of the first replaced character. */
  start: number;
  /** Character offset just past the replaced range. */
  end: number;
  /** Replacement text (already re-indented / newline-normalised). */
  text: string;
}

export interface FuzzyResult {
  edits: Edit[];
  /** Human-readable note about how forgiving the match had to be. */
  note: string;
  /** A similarity-based match landed in more than one place. */
  ambiguous?: boolean;
}

const TAB_WIDTH = 4;
const MAX_DIFF_LINES = 80;
const CONTEXT_LINES = 3;

function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += TAB_WIDTH - (w % TAB_WIDTH);
    else break;
  }
  return w;
}

/** Whitespace-canonical form used to compare a line the model sent with a file line. */
function normalizeLine(line: string): string {
  return line.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();
}

/* Curly quotes / NBSP that models copy out of prose or PDFs. */
const QUOTE_MAP: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"'],
  [/[\u00A0\u2007\u202F]/g, " "],
];

function unquote(line: string): string {
  let out = line;
  for (const [re, to] of QUOTE_MAP) out = out.replace(re, to);
  return out;
}

/** "12\tfoo" / "12: foo" / "12| foo" - the model copied read_file's line numbers. */
function stripLineNumber(line: string): string {
  return line.replace(/^\s*\d+\s*[\t:|]\s?/, "");
}

/** Literal "\t" / "\u00e9" / "\"" sequences instead of the real characters. */
function unescapeSeq(line: string): string {
  return line.replace(
    /\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[tnr"'`\\])/g,
    (m, g1: string) => {
      if (g1[0] === "u" || g1[0] === "x") {
        const code = parseInt(g1.replace(/^[ux]\{?|\}/g, ""), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const simple: Record<string, string> = { t: "\t", n: "\n", r: "\r", '"': '"', "'": "'", "`": "`", "\\": "\\" };
      return simple[g1] ?? m;
    },
  );
}

/**
 * Escalating per-line normalizations. Each is tried only when every earlier
 * strategy found nothing, so the loosest transform that still matches wins.
 */
const MATCH_STRATEGIES: Array<{ note: string; norm: (line: string) => string }> = [
  { note: "matched ignoring whitespace", norm: normalizeLine },
  { note: "matched after normalizing quotes", norm: (l) => normalizeLine(unquote(l)) },
  { note: "matched after stripping line-number prefixes", norm: (l) => normalizeLine(stripLineNumber(l)) },
  { note: "matched after unescaping escape sequences", norm: (l) => normalizeLine(unescapeSeq(unquote(l))) },
];

/** Line starts (character offsets) for a text, index 0 = offset of first line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function findAll(text: string, needle: string): number[] {
  if (!needle) return [];
  const hits: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
    hits.push(i);
    if (hits.length > 200) break;
  }
  return hits;
}

function reindent(text: string, delta: number): string {
  if (delta === 0) return text;
  return text
    .split("\n")
    .map((line, i) => {
      if (line.trim() === "") return line;
      if (delta > 0) return " ".repeat(delta) + line;
      // Shrink: drop up to |delta| columns of leading whitespace.
      let left = -delta;
      let out = 0;
      while (out < line.length && left > 0 && (line[out] === " " || line[out] === "\t")) {
        left -= line[out] === "\t" ? TAB_WIDTH : 1;
        out++;
      }
      return line.slice(out);
    })
    .join("\n");
}

/**
 * Find whole-line windows whose normalized content equals `oldString`'s, and
 * build edits that splice the file's real indentation back in. Tries the
 * escalation chain in MATCH_STRATEGIES order; the loosest transform that still
 * matches wins.
 */
export function findFuzzyEdits(text: string, oldString: string, newString: string): FuzzyResult {
  const oldRaw = oldString.replace(/\r\n/g, "\n").split("\n");
  const fileLines = text.split("\n");
  const starts = lineStarts(text);
  const n = oldRaw.length;

  for (const { note, norm } of MATCH_STRATEGIES) {
    const oldNorm = oldRaw.map(norm);
    const edits: Edit[] = [];
    let reindented = false;

    for (let i = 0; i + n <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (norm(fileLines[i + j]) !== oldNorm[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const start = starts[i];
      const lastLine = i + n - 1;
      // Replace up to (but not including) the line terminator, so a trailing \r
      // in CRLF files survives.
      const nl = text.indexOf("\n", starts[lastLine]);
      let lineEnd = nl < 0 ? text.length : nl;
      if (text[lineEnd - 1] === "\r") lineEnd--;
      const delta = indentWidth(fileLines[i]) - indentWidth(oldRaw[0]);
      if (delta !== 0) reindented = true;
      let replacement = reindent(newString.replace(/\r\n/g, "\n"), delta);
      if (text.includes("\r\n")) replacement = replacement.replace(/\n/g, "\r\n");
      edits.push({ start, end: lineEnd, text: replacement });
      if (edits.length > 200) break;
    }

    if (edits.length) {
      return { edits, note: reindented ? `${note}; replacement re-indented to the file` : note };
    }
  }

  // Last resort: block-anchor similarity (>=80% of lines match, first and last
  // must match exactly after normalization). Never re-indented guesses here:
  // multiple candidates mean we cannot know which one the model meant.
  const anchor = findAnchorEdits(text, oldString, newString);
  if (anchor.edits.length === 1) return anchor;
  if (anchor.edits.length > 1) {
    return { edits: [], note: "", ambiguous: true };
  }
  return { edits: [], note: "" };
}

/** Middle-line similarity for the anchor matcher: equality or containment. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a && b && (a.includes(b) || b.includes(a))) return 0.8;
  return 0;
}

const ANCHOR_SIMILARITY = 0.8;

function findAnchorEdits(text: string, oldString: string, newString: string): FuzzyResult {
  const oldRaw = oldString.replace(/\r\n/g, "\n").split("\n");
  const fileLines = text.split("\n");
  const starts = lineStarts(text);
  const n = oldRaw.length;
  if (n < 3) return { edits: [], note: "" };
  const oldNorm = oldRaw.map(normalizeLine);
  const fileNorm = fileLines.map(normalizeLine);
  const edits: Edit[] = [];

  for (let i = 0; i + n <= fileLines.length; i++) {
    if (fileNorm[i] !== oldNorm[0] || fileNorm[i + n - 1] !== oldNorm[n - 1]) continue;
    let score = 0;
    for (let j = 1; j < n - 1; j++) score += lineSimilarity(fileNorm[i + j], oldNorm[j]);
    if (score / (n - 2) < ANCHOR_SIMILARITY) continue;
    const start = starts[i];
    const nl = text.indexOf("\n", starts[i + n - 1]);
    let lineEnd = nl < 0 ? text.length : nl;
    if (text[lineEnd - 1] === "\r") lineEnd--;
    let replacement = reindent(newString.replace(/\r\n/g, "\n"), indentWidth(fileLines[i]) - indentWidth(oldRaw[0]));
    if (text.includes("\r\n")) replacement = replacement.replace(/\n/g, "\r\n");
    edits.push({ start, end: lineEnd, text: replacement });
    if (edits.length > 1) break; // ambiguous: no point collecting more
  }
  if (!edits.length) return { edits: [], note: "" };
  return {
    edits,
    note: `matched by block anchor (${Math.round(ANCHOR_SIMILARITY * 100)}% line similarity); check the diff carefully`,
  };
}

/** Best partial line-window match, used to tell the model what the file really says. */
export function nearestMiss(text: string, oldString: string): { line: number; snippet: string } | null {
  const oldLines = oldString.replace(/\r\n/g, "\n").split("\n");
  const fileLines = text.split("\n");
  const n = oldLines.length;
  const oldNorm = oldLines.map(normalizeLine);
  let best = { score: 0, line: -1 };

  for (let i = 0; i + n <= fileLines.length; i++) {
    let score = 0;
    for (let j = 0; j < n; j++) {
      const s = lineSimilarity(normalizeLine(fileLines[i + j]), oldNorm[j]);
      if (s === 0) break;
      score += s;
    }
    if (score > best.score) best = { score, line: i };
  }
  if (best.line < 0) return null;
  const shown = fileLines.slice(best.line, best.line + Math.min(n, 12));
  return {
    line: best.line + 1,
    snippet: shown.map((l, k) => `${best.line + k + 1}\t${l}`).join("\n"),
  };
}

/**
 * Render a unified diff for the planned edits without running a full LCS: the
 * changed ranges are already known, so each becomes one hunk with context.
 */
export function renderDiff(original: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const starts = lineStarts(original);
  const fileLines = original.split("\n");

  // Map each edit to a line region, then merge regions whose context windows
  // would touch, so a hunk never re-emits lines a previous hunk covered.
  const regions = sorted.map((e) => ({
    from: lineIndexAt(starts, e.start),
    to: lineIndexAt(starts, Math.max(e.start, e.end - 1)),
    edit: e,
  }));
  const merged: Array<{ from: number; to: number; parts: typeof regions }> = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.from - last.to <= CONTEXT_LINES * 2) {
      last.to = Math.max(last.to, r.to);
      last.parts.push(r);
    } else {
      merged.push({ from: r.from, to: r.to, parts: [r] });
    }
  }

  const hunks: string[] = [];
  let delta = 0; // net line shift from previous hunks (new file - old file)

  for (const m of merged) {
    const ctxBefore = Math.max(0, m.from - CONTEXT_LINES);
    const ctxAfter = Math.min(fileLines.length, m.to + 1 + CONTEXT_LINES);
    const before = fileLines.slice(ctxBefore, m.from);
    const after = fileLines.slice(m.to + 1, ctxAfter);
    // Rebuild the region's new content by applying its parts, so +/- lines
    // always show complete file lines.
    const regionStart = starts[m.from];
    const regionEnd = m.to + 1 < starts.length ? starts[m.to + 1] - 1 : original.length;
    const regionText = original.slice(regionStart, regionEnd);
    const regionEdits = m.parts.map((p) => ({
      start: p.edit.start - regionStart,
      end: p.edit.end - regionStart,
      text: p.edit.text,
    }));
    const newRegion = applyEdits(regionText, regionEdits).replace(/\r\n/g, "\n").split("\n");
    const removed = fileLines.slice(m.from, m.to + 1);
    const oldCount = before.length + removed.length + after.length;
    const newCount = before.length + newRegion.length + after.length;
    const body = [
      ...before.map((l) => ` ${l}`),
      ...removed.map((l) => `-${l}`),
      ...newRegion.map((l) => `+${l}`),
      ...after.map((l) => ` ${l}`),
    ];
    hunks.push(`@@ -${ctxBefore + 1},${oldCount} +${ctxBefore + 1 + delta},${newCount} @@\n${body.join("\n")}`);
    delta += newCount - oldCount;
  }

  const out = hunks.join("\n");
  const lines = out.split("\n");
  if (lines.length > MAX_DIFF_LINES) {
    return lines.slice(0, MAX_DIFF_LINES).join("\n") + `\n[... diff truncated: ${lines.length - MAX_DIFF_LINES} more lines]`;
  }
  return out;
}

/** Apply non-overlapping edits (any order) to the original text. */
export function applyEdits(original: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = original;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** +N/-M line stats for a planned edit set, for the permission prompt. */
export function diffStats(edits: Edit[], original: string): string {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    added += e.text.replace(/\r\n/g, "\n").split("\n").length;
    removed += original.slice(e.start, e.end).replace(/\r\n/g, "\n").split("\n").length;
  }
  return `+${added}/-${removed} lines`;
}
