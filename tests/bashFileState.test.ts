import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../src/fileState.js";
import { isFormatterCommand, parseFileReads, parseWrittenFiles, syncBashFileState } from "../src/tools/bashFileState.js";
import { readFileTool } from "../src/tools/read.js";
import { writeFileTool } from "../src/tools/write.js";
import { bashTool } from "../src/tools/bash.js";
import type { ToolContext } from "../src/types.js";

let dir: string;
let fileState: FileStateStore;

const ctx = (): ToolContext =>
  ({
    cwd: dir,
    askPermission: async () => true,
    fileState,
  }) as ToolContext;

const file = (name: string) => path.join(dir, name);
const view = (name: string) => (process.platform === "win32" ? `type "${name}"` : `cat "${name}"`);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bashfs-"));
  fileState = new FileStateStore();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("parseFileReads", () => {
  it("recognizes full file views", () => {
    expect(parseFileReads("cat a.ts")).toEqual([{ path: "a.ts", full: true }]);
    expect(parseFileReads("cat -n a.ts b.ts")).toEqual([
      { path: "a.ts", full: true },
      { path: "b.ts", full: true },
    ]);
    expect(parseFileReads("type a.txt")).toEqual([{ path: "a.txt", full: true }]);
    expect(parseFileReads('Get-Content "a b.txt"')).toEqual([{ path: "a b.txt", full: true }]);
  });

  it("marks line-limited views as partial", () => {
    expect(parseFileReads("head a.txt")).toEqual([{ path: "a.txt", full: false }]);
    expect(parseFileReads("head -n 20 a.txt")).toEqual([{ path: "a.txt", full: false }]);
    expect(parseFileReads("tail -c 100 a.txt")).toEqual([{ path: "a.txt", full: false }]);
    expect(parseFileReads("Get-Content -Tail 5 a.txt")).toEqual([{ path: "a.txt", full: false }]);
    expect(parseFileReads("gc a.txt")).toEqual([{ path: "a.txt", full: true }]);
  });

  it("ignores compound commands and non-viewers", () => {
    expect(parseFileReads("cat a.ts | head")).toEqual([]);
    expect(parseFileReads("cat a.ts && echo done")).toEqual([]);
    expect(parseFileReads("cat a.ts > copy.ts")).toEqual([]);
    expect(parseFileReads("npm test")).toEqual([]);
    expect(parseFileReads("grep x a.ts")).toEqual([]);
  });
});

describe("parseWrittenFiles", () => {
  it("extracts redirection targets", () => {
    expect(parseWrittenFiles("echo hi > out.txt")).toEqual(["out.txt"]);
    expect(parseWrittenFiles("node build.js 2>> logs/err.log")).toEqual(["logs/err.log"]);
    expect(parseWrittenFiles("echo hi > 'two words.txt'")).toEqual(["two words.txt"]);
  });

  it("ignores null sinks", () => {
    expect(parseWrittenFiles("echo hi >/dev/null")).toEqual([]);
    expect(parseWrittenFiles("echo hi >&2")).toEqual([]);
    expect(parseWrittenFiles("echo hi > NUL")).toEqual([]);
  });

  it("is empty for commands without redirects", () => {
    expect(parseWrittenFiles("npm test")).toEqual([]);
  });
});

describe("isFormatterCommand", () => {
  it("detects common formatters", () => {
    expect(isFormatterCommand("npx prettier --write src/a.ts")).toBe(true);
    expect(isFormatterCommand("eslint . --fix")).toBe(true);
    expect(isFormatterCommand("gofmt -w .")).toBe(true);
    expect(isFormatterCommand("cargo fmt")).toBe(true);
  });

  it("does not flag ordinary commands", () => {
    expect(isFormatterCommand("npm test")).toBe(false);
    expect(isFormatterCommand("cat a.ts")).toBe(false);
  });
});

describe("syncBashFileState", () => {
  it("records a cat view so a whole-file overwrite needs no separate read", async () => {
    await fs.writeFile(file("a.txt"), "hello world", "utf8");
    const r = await bashTool.execute({ command: view("a.txt") }, ctx());
    expect(r.isError).toBeFalsy();
    const edit = await writeFileTool.execute({ path: "a.txt", content: "replaced" }, ctx());
    expect(edit.isError).toBeFalsy();
    expect(await fs.readFile(file("a.txt"), "utf8")).toBe("replaced");
  });

  it("downgrades a truncated capture to a partial read", async () => {
    await fs.writeFile(file("big.txt"), "x".repeat(40_000), "utf8");
    const r = await bashTool.execute({ command: view("big.txt") }, ctx());
    expect(r.isError).toBeFalsy();
    const overwrite = await writeFileTool.execute({ path: "big.txt", content: "tiny" }, ctx());
    expect(overwrite.isError).toBe(true);
    expect(overwrite.content).toContain("partially read");
  });

  it("a line-limited view counts as a partial read", async () => {
    await fs.writeFile(file("p.txt"), "one\ntwo\nthree\n", "utf8");
    await syncBashFileState("head -n 1 p.txt", dir, true, fileState);
    const overwrite = await writeFileTool.execute({ path: "p.txt", content: "tiny" }, ctx());
    expect(overwrite.isError).toBe(true);
    expect(overwrite.content).toContain("partially read");
  });

  it("drops read records when a formatter runs", async () => {
    await fs.writeFile(file("f.ts"), "const x=1\n", "utf8");
    await readFileTool.execute({ path: "f.ts" }, ctx());
    expect(fileState.has(file("f.ts"))).toBe(true);
    await syncBashFileState("npx prettier --write f.ts", dir, true, fileState);
    expect(fileState.has(file("f.ts"))).toBe(false);
  });

  it("invalidates a redirection target", async () => {
    await fs.writeFile(file("g.txt"), "old", "utf8");
    await readFileTool.execute({ path: "g.txt" }, ctx());
    await syncBashFileState("echo new > g.txt", dir, true, fileState);
    expect(fileState.has(file("g.txt"))).toBe(false);
  });

  it("does nothing without a file state store", async () => {
    await expect(syncBashFileState("cat a.txt", dir, true, undefined)).resolves.toBeUndefined();
  });
});
