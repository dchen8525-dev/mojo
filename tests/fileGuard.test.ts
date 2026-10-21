import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../src/fileState.js";
import { readFileTool } from "../src/tools/read.js";
import { writeFileTool, editFileTool } from "../src/tools/write.js";
import { multiEditTool } from "../src/tools/multiEdit.js";
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

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-filestate-"));
  fileState = new FileStateStore();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("read-before-edit guard", () => {
  it("write_file refuses to overwrite a file the model never read", async () => {
    await fs.writeFile(file("a.txt"), "precious content", "utf8");
    const r = await writeFileTool.execute({ path: "a.txt", content: "clobbered" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has not been read");
    expect(await fs.readFile(file("a.txt"), "utf8")).toBe("precious content");
  });

  it("a full read allows a whole-file overwrite", async () => {
    await fs.writeFile(file("b.txt"), "old", "utf8");
    expect((await readFileTool.execute({ path: "b.txt" }, ctx())).isError).toBeFalsy();
    const r = await writeFileTool.execute({ path: "b.txt", content: "new" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(await fs.readFile(file("b.txt"), "utf8")).toBe("new");
  });

  it("a partial read does not allow a whole-file overwrite", async () => {
    await fs.writeFile(file("big.txt"), Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    expect((await readFileTool.execute({ path: "big.txt", limit: 10 }, ctx())).isError).toBeFalsy();
    const r = await writeFileTool.execute({ path: "big.txt", content: "tiny" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("partially read");
    expect((await fs.readFile(file("big.txt"), "utf8")).split("\n")).toHaveLength(500);
  });

  it("edit_file refuses a file changed on disk since the read", async () => {
    await fs.writeFile(file("c.txt"), "alpha beta", "utf8");
    await readFileTool.execute({ path: "c.txt" }, ctx());
    await fs.appendFile(file("c.txt"), " gamma");
    const r = await editFileTool.execute({ path: "c.txt", old_string: "beta", new_string: "BETA" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("changed on disk");
    expect(await fs.readFile(file("c.txt"), "utf8")).toBe("alpha beta gamma");
  });

  it("consecutive edits only need one read", async () => {
    await fs.writeFile(file("d.txt"), "one two three", "utf8");
    await readFileTool.execute({ path: "d.txt" }, ctx());
    expect((await editFileTool.execute({ path: "d.txt", old_string: "one", new_string: "1" }, ctx())).isError).toBeFalsy();
    expect((await editFileTool.execute({ path: "d.txt", old_string: "two", new_string: "2" }, ctx())).isError).toBeFalsy();
    expect(await fs.readFile(file("d.txt"), "utf8")).toBe("1 2 three");
  });

  it("creating a new file needs no read", async () => {
    const r = await writeFileTool.execute({ path: "new-file.txt", content: "fresh" }, ctx());
    expect(r.isError).toBeFalsy();
  });

  it("edit_file refuses a file that was never read", async () => {
    await fs.writeFile(file("e.txt"), "hello", "utf8");
    const r = await editFileTool.execute({ path: "e.txt", old_string: "hello", new_string: "bye" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has not been read");
  });

  it("multi_edit records the files it wrote so later edits need no re-read", async () => {
    await fs.writeFile(file("m1.txt"), "old-name here", "utf8");
    await fs.writeFile(file("m2.txt"), "old-name there", "utf8");
    const r = await multiEditTool.execute({ pattern: "m*.txt", search: "old-name", replacement: "new-name" }, ctx());
    expect(r.isError).toBeFalsy();
    const edit = await editFileTool.execute({ path: "m1.txt", old_string: "here", new_string: "HERE" }, ctx());
    expect(edit.isError).toBeFalsy();
  });

  it("clear() drops the records (a new session starts blind)", async () => {
    await fs.writeFile(file("f.txt"), "hello", "utf8");
    await readFileTool.execute({ path: "f.txt" }, ctx());
    fileState.clear();
    const r = await editFileTool.execute({ path: "f.txt", old_string: "hello", new_string: "bye" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has not been read");
  });
});
