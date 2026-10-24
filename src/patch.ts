/**
 * Structured `*** Begin Patch` parsing and application (ported from ZCode's
 * tool/patch-parser.ts + patch-apply.ts). One patch can add, delete, update
 * and move several files in a single tool call; update hunks match by context
 * with escalating leniency (exact → trimEnd → trim → unicode-normalized).
 */

export type ParsedPatch =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

export interface PatchChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  endOfFile?: boolean;
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_HEADER = "*** Add File:";
const DELETE_HEADER = "*** Delete File:";
const UPDATE_HEADER = "*** Update File:";
const MOVE_HEADER = "*** Move to:";
const END_OF_FILE_MARKER = "*** End of File";

export function parseStructuredPatch(patchText: string): ParsedPatch[] {
  const normalized = stripHeredoc(patchText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.trim().split("\n");
  const beginIndex = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
  const endIndex = lines.findIndex((line) => line.trim() === END_MARKER);

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const sections: ParsedPatch[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const line = lines[index] ?? "";
    if (line.startsWith(ADD_HEADER)) {
      const path = readHeaderPath(line, ADD_HEADER);
      const parsed = parseAddFile(lines, index + 1, endIndex);
      sections.push({ type: "add", path, contents: parsed.contents });
      index = parsed.nextIndex;
      continue;
    }
    if (line.startsWith(DELETE_HEADER)) {
      sections.push({ type: "delete", path: readHeaderPath(line, DELETE_HEADER) });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_HEADER)) {
      const path = readHeaderPath(line, UPDATE_HEADER);
      let movePath: string | undefined;
      index += 1;
      if (index < endIndex && (lines[index] ?? "").startsWith(MOVE_HEADER)) {
        movePath = readHeaderPath(lines[index] ?? "", MOVE_HEADER);
        index += 1;
      }
      const parsed = parseUpdateChunks(lines, index, endIndex);
      sections.push({ type: "update", path, movePath, chunks: parsed.chunks });
      index = parsed.nextIndex;
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    throw new Error(`Invalid patch section header: ${line}`);
  }

  return sections;
}

function parseAddFile(lines: string[], startIndex: number, endIndex: number): { contents: string; nextIndex: number } {
  const contents: string[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const line = lines[index] ?? "";
    if (!line.startsWith("+")) {
      throw new Error(`Invalid add file line: ${line}`);
    }
    contents.push(line.slice(1));
    index += 1;
  }
  return { contents: `${contents.join("\n")}\n`, nextIndex: index };
}

function parseUpdateChunks(lines: string[], startIndex: number, endIndex: number): { chunks: PatchChunk[]; nextIndex: number } {
  const chunks: PatchChunk[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const header = lines[index] ?? "";
    if (!header.startsWith("@@")) {
      if (header.trim().length === 0) {
        index += 1;
        continue;
      }
      throw new Error(`Invalid update hunk header: ${header}`);
    }

    const changeContext = header.slice(2).trim() || undefined;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;

    while (index < endIndex && !startsNextHunkOrSection(lines[index] ?? "")) {
      const line = lines[index] ?? "";
      if (line === END_OF_FILE_MARKER) {
        endOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else {
        throw new Error(`Invalid update hunk line: ${line}`);
      }
      index += 1;
    }

    chunks.push({ oldLines, newLines, changeContext, endOfFile });
  }
  return { chunks, nextIndex: index };
}

function startsNextHunkOrSection(line: string): boolean {
  return line.startsWith("@@") || isSectionHeader(line);
}

function isSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD_HEADER) ||
    line.startsWith(DELETE_HEADER) ||
    line.startsWith(UPDATE_HEADER) ||
    line.trim() === END_MARKER
  );
}

function readHeaderPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (value.length === 0) {
    throw new Error(`Missing path for ${prefix}`);
  }
  return value;
}

function stripHeredoc(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:cat\s+)?<<['"]?([A-Za-z0-9_]+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? (match[2] ?? "") : input;
}

// ---------------------------------------------------------------------------
// Applier

type Replacement = [startIndex: number, oldLineCount: number, newLines: string[]];
type Comparator = (actual: string, expected: string) => boolean;

export function derivePatchedContent(content: string, chunks: PatchChunk[]): { content: string } {
  const originalLines = splitLogicalLines(normalizeLineEndings(content));
  const replacements = computeReplacements(originalLines, chunks);
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }
  return { content: nextLines.join("\n") };
}

function computeReplacements(lines: string[], chunks: PatchChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex);
      if (contextIndex === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}'`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      // An insertion hunk with a context anchor belongs directly after that
      // line; only an anchor-less hunk appends at end of file.
      const insertionIndex = chunk.changeContext
        ? lineIndex
        : lines.length > 0 && lines[lines.length - 1] === ""
          ? lines.length - 1
          : lines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    if (found === -1 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      replacement =
        replacement[replacement.length - 1] === "" ? replacement.slice(0, -1) : replacement;
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    }

    if (found === -1) {
      throw new Error(`Failed to find expected lines:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  return replacements.sort((left, right) => left[0] - right[0]);
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [startIndex, oldLineCount, newLines] = replacements[index]!;
    result.splice(startIndex, oldLineCount, ...newLines);
  }
  return result;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;
  for (const compare of [exactCompare, trimEndCompare, trimCompare, normalizedCompare]) {
    const index = tryMatch(lines, pattern, startIndex, compare, eof);
    if (index !== -1) return index;
  }
  return -1;
}

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && linesMatch(lines, pattern, fromEnd, compare)) return fromEnd;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (linesMatch(lines, pattern, index, compare)) return index;
  }
  return -1;
}

function linesMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? "", pattern[offset] ?? "")) return false;
  }
  return true;
}

function exactCompare(actual: string, expected: string): boolean {
  return actual === expected;
}

function trimEndCompare(actual: string, expected: string): boolean {
  return actual.trimEnd() === expected.trimEnd();
}

function trimCompare(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function normalizedCompare(actual: string, expected: string): boolean {
  return normalizeUnicode(actual.trim()) === normalizeUnicode(expected.trim());
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLogicalLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
