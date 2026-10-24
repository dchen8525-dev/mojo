import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../src/fileState.js";
import { buildReadStateReminder } from "../src/contextRestore.js";

let cwd: string;
let fileState: FileStateStore;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ctxrestore-"));
  fileState = new FileStateStore();
});

describe("FileStateStore.recent", () => {
  it("returns the newest reads last and re-reads move to the end", () => {
    fileState.record("a.ts", { mtimeMs: 1, size: 1 });
    fileState.record("b.ts", { mtimeMs: 2, size: 1 });
    fileState.record("c.ts", { mtimeMs: 3, size: 1 });
    expect(fileState.recent(2).map((r) => r.path)).toEqual(["b.ts", "c.ts"]);
    fileState.record("a.ts", { mtimeMs: 9, size: 1 });
    expect(fileState.recent(3).map((r) => r.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
  });
});

describe("buildReadStateReminder", () => {
  it("restores unchanged full reads with their current content", async () => {
    const f = path.join(cwd, "a.ts");
    await fs.writeFile(f, "export const x = 1;\n", "utf8");
    const stat = await fs.stat(f);
    fileState.record(f, stat, true);
    const reminder = await buildReadStateReminder(fileState, [], cwd);
    expect(reminder).toContain('event="ReadStateRestored"');
    expect(reminder).toContain("export const x = 1;");
    expect(reminder).toContain("content restored");
  });

  it("skips files whose path is still visible in the kept tail", async () => {
    const f = path.join(cwd, "kept.ts");
    await fs.writeFile(f, "still in history\n", "utf8");
    fileState.record(f, await fs.stat(f), true);
    expect(await buildReadStateReminder(fileState, [{ role: "user", content: `reading ${f} now` }], cwd)).toBeNull();
  });

  it("skips a read result still in the kept tail via its relative-path header", async () => {
    const f = path.join(cwd, "kept-rel.ts");
    await fs.writeFile(f, "still in history\n", "utf8");
    fileState.record(f, await fs.stat(f), true);
    // read_file reports the workspace-relative path, so the absolute path the
    // record stores never appears in history.
    const tail = [
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "tu1", content: "kept-rel.ts\n1\tstill in history" }],
      },
    ];
    expect(await buildReadStateReminder(fileState, tail, cwd)).toBeNull();
  });

  it("restores a file when the tail merely mentions its path in prose", async () => {
    const f = path.join(cwd, "mention.ts");
    await fs.writeFile(f, "content the model lost\n", "utf8");
    fileState.record(f, await fs.stat(f), true);
    const tail = [{ role: "user" as const, content: "please look at mention.ts\nand continue" }];
    const reminder = await buildReadStateReminder(fileState, tail, cwd);
    expect(reminder).toContain("content the model lost");
  });

  it("degrades to a warning line when the file changed on disk since the read", async () => {
    const f = path.join(cwd, "changed.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    fileState.record(f, await fs.stat(f), true);
    await fs.writeFile(f, "v2 much longer\n", "utf8");
    const reminder = await buildReadStateReminder(fileState, [], cwd);
    expect(reminder).toContain("changed on disk since");
    expect(reminder).not.toContain("v2 much longer");
  });

  it("degrades to a reference line for partial reads", async () => {
    const f = path.join(cwd, "partial.ts");
    await fs.writeFile(f, "partial view\n", "utf8");
    fileState.record(f, await fs.stat(f), false);
    const reminder = await buildReadStateReminder(fileState, [], cwd);
    expect(reminder).toContain("partial read, unchanged since");
    expect(reminder).not.toContain("partial view\n");
  });

  it("drops files that vanished and tolerates an empty read map", async () => {
    expect(await buildReadStateReminder(fileState, [], cwd)).toBeNull();
    const f = path.join(cwd, "gone.ts");
    fileState.record(f, { mtimeMs: 1, size: 1 }, true);
    expect(await buildReadStateReminder(fileState, [], cwd)).toBeNull();
  });
});
