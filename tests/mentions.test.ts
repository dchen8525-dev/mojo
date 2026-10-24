import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWorkspacePathCacheForTests,
  completeMention,
  filterMentionPaths,
  listWorkspacePaths,
  parseGitFileList,
  resolveActiveMention,
  visibleMentionWindow,
  type MentionPath,
} from "../src/mentions.js";

describe("resolveActiveMention", () => {
  it("detects a trailing @token after whitespace or at start", () => {
    expect(resolveActiveMention("@src")).toEqual({ start: 0, token: "src" });
    expect(resolveActiveMention("look at @src/ind")).toEqual({ start: 8, token: "src/ind" });
    expect(resolveActiveMention("hi @")).toEqual({ start: 3, token: "" });
  });

  it("rejects mid-word @, whitespace tokens, and text without @", () => {
    expect(resolveActiveMention("mail a@b.com")).toBeNull();
    expect(resolveActiveMention("no mention here")).toBeNull();
    expect(resolveActiveMention("@foo bar")).toBeNull();
    expect(resolveActiveMention("x @foo bar")).toBeNull();
  });

  it("accepts spaces inside an open quoted token and stops once the quote closes", () => {
    expect(resolveActiveMention('look @"my fi')).toEqual({ start: 5, token: "my fi", quoted: true });
    expect(resolveActiveMention('@"my file.txt" and more')).toBeNull();
  });
});

const FIXTURE: MentionPath[] = [
  { kind: "file", path: "src/mentions.ts" },
  { kind: "file", path: "src/ui/app.tsx" },
  { kind: "directory", path: "src/ui" },
  { kind: "file", path: "tests/mentions.test.ts" },
  { kind: "file", path: "package.json" },
];

describe("filterMentionPaths", () => {
  it("ranks basename prefix above path prefix above substring", () => {
    const ranked = filterMentionPaths(FIXTURE, "men");
    expect(ranked[0]).toEqual({ kind: "file", path: "src/mentions.ts" });
    expect(ranked.map((e) => e.path)).toEqual(["src/mentions.ts", "tests/mentions.test.ts"]);
  });

  it("is case-insensitive and honors the limit", () => {
    expect(filterMentionPaths(FIXTURE, "SRC")[0]?.path.startsWith("src/")).toBe(true);
    expect(filterMentionPaths(FIXTURE, "", 2)).toHaveLength(2);
  });

  it("returns nothing for tokens that match no path", () => {
    expect(filterMentionPaths(FIXTURE, "zzz")).toEqual([]);
  });
});

describe("completeMention", () => {
  it("files get a trailing space, directories keep the token open", () => {
    const text = "check @men please";
    const mention = { start: 6, token: "men" };
    expect(completeMention(text, mention, { kind: "file", path: "src/mentions.ts" })).toBe(
      "check @src/mentions.ts  please",
    );
    expect(completeMention(text, mention, { kind: "directory", path: "src" })).toBe(
      "check @src please",
    );
  });

  it("quotes paths the unquoted grammar cannot express", () => {
    const mention = { start: 0, token: "my" };
    expect(completeMention("@my rest", mention, { kind: "file", path: "my file.txt" })).toBe(
      '@"my file.txt"  rest',
    );
    // Directories stay open (no closing quote) so completion can continue.
    expect(completeMention("@my rest", mention, { kind: "directory", path: "my dir" })).toBe(
      '@"my dir rest',
    );
    const open = resolveActiveMention('@"my dir/');
    expect(open).toEqual({ start: 0, token: "my dir/", quoted: true });
    const openFile = resolveActiveMention('@"my dir/f')!;
    expect(completeMention('@"my dir/f', openFile, { kind: "file", path: "my dir/f.ts" })).toBe(
      '@"my dir/f.ts" ',
    );
  });
});

describe("visibleMentionWindow", () => {
  const entries = Array.from({ length: 12 }, (_, i): MentionPath => ({ kind: "file", path: `f${i}.txt` }));

  it("slides so the selection stays visible", () => {
    expect(visibleMentionWindow(entries, 0).selectedIndex).toBe(0);
    const bottom = visibleMentionWindow(entries, 11);
    expect(bottom.startIndex).toBe(4);
    expect(bottom.selectedIndex).toBe(7);
    expect(bottom.entries).toHaveLength(8);
    expect(visibleMentionWindow(entries, 3, 5).startIndex).toBe(0);
  });
});

describe("parseGitFileList", () => {
  it("decodes a multi-byte name split across stdout chunks", () => {
    const bytes = Buffer.from("café.txt\0src/main.ts\0", "utf8");
    const split = bytes.indexOf(Buffer.from("é")) + 1; // middle of the two-byte char
    const entries = parseGitFileList([bytes.subarray(0, split), bytes.subarray(split)]);
    expect(entries.map((e) => e.path)).toEqual(["café.txt", "src/main.ts", "src"]);
    expect(entries.find((e) => e.path === "src")?.kind).toBe("directory");
  });

  it("drops agent state files and rejects empty output", () => {
    expect(() => parseGitFileList(Buffer.from("\0"))).toThrow(/returned nothing/u);
    const entries = parseGitFileList(Buffer.from("a.ts\0.node-agent/data.jsonl\0"));
    expect(entries.map((e) => e.path)).toEqual(["a.ts"]);
  });
});

describe("listWorkspacePaths", () => {
  let dir = "";

  beforeEach(() => {
    clearWorkspacePathCacheForTests();
  });
  afterEach(async () => {
    await fs.rm(dir, { force: true, recursive: true });
  });

  it("walks a plain directory (no git) and skips ignore-listed dirs", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mentions-"));
    await fs.mkdir(path.join(dir, "sub", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.ts"), "x");
    await fs.writeFile(path.join(dir, "sub", "b.ts"), "x");
    await fs.writeFile(path.join(dir, "sub", "node_modules", "c.ts"), "x");

    const entries = await listWorkspacePaths(dir);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("a.ts");
    expect(paths).toContain("sub/b.ts");
    expect(paths).toContain("sub");
    expect(paths).not.toContain("sub/node_modules");
    expect(entries.find((e) => e.path === "sub")?.kind).toBe("directory");
  });

  it("uses git ls-files inside a git repository and caches per cwd", async () => {
    const entries = await listWorkspacePaths(process.cwd());
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("package.json");
    expect(entries.find((e) => e.path === "src/mentions.ts")?.kind).toBe("file");

    const again = await listWorkspacePaths(process.cwd());
    expect(again).toBe(entries); // cache hit within the TTL
  });
});
