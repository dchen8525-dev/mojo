import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckpointStore, MAX_CHECKPOINTS } from "../src/checkpoint.js";

let dir: string; // checkpoint store dir
let work: string; // "project" files

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ckpt-store-"));
  work = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ckpt-work-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

let n = 0;
function store() {
  // Each store gets its own directory so index.json never collides.
  return new CheckpointStore("unused", path.join(dir, `s${++n}`));
}

describe("CheckpointStore", () => {
  it("captures existing content and restores it on undo", async () => {
    const s = store();
    const f = path.join(work, "a.ts");
    await fs.writeFile(f, "original\n", "utf8");
    await s.capture(f, "edit_file");
    await fs.writeFile(f, "mangled by the agent\n", "utf8");

    const r = await s.undoLast();
    expect(r).not.toBeNull();
    expect(r!.action).toContain("restored");
    expect(await fs.readFile(f, "utf8")).toBe("original\n");
  });

  it("undo of a created file deletes it", async () => {
    const s = store();
    const f = path.join(work, "created.ts");
    await s.capture(f, "write_file"); // did not exist
    await fs.writeFile(f, "new file\n", "utf8");

    const r = await s.undoLast();
    expect(r!.action).toContain("deleted");
    await expect(fs.access(f)).rejects.toThrow();
  });

  it("undoes LIFO: second undo restores the earlier change", async () => {
    const s = store();
    const f = path.join(work, "lifo.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    await s.capture(f, "edit_file");
    await fs.writeFile(f, "v2\n", "utf8");
    await s.capture(f, "edit_file");
    await fs.writeFile(f, "v3\n", "utf8");

    await s.undoLast();
    expect(await fs.readFile(f, "utf8")).toBe("v2\n");
    await s.undoLast();
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
    // No more unrestored checkpoints.
    expect(await s.undoLast()).toBeNull();
  });

  it("an undone checkpoint is not undone twice", async () => {
    const s = store();
    const f = path.join(work, "once.ts");
    await fs.writeFile(f, "keep\n", "utf8");
    await s.capture(f, "edit_file");
    await fs.writeFile(f, "changed\n", "utf8");
    await s.undoLast();
    await fs.writeFile(f, "user's own edit\n", "utf8");
    // A second /undo must NOT clobber the user's later edit.
    expect(await s.undoLast()).toBeNull();
    expect(await fs.readFile(f, "utf8")).toBe("user's own edit\n");
  });

  it("persists across store instances (same session id)", async () => {
    const id = "persist-" + Math.random().toString(36).slice(2);
    const s1 = new CheckpointStore(id, dir);
    const f = path.join(work, "persist.ts");
    await fs.writeFile(f, "before\n", "utf8");
    await s1.capture(f, "write_file");

    const s2 = new CheckpointStore(id, dir); // fresh instance, same session
    expect((await s2.list()).length).toBe(1);
    const r = await s2.undoLast();
    expect(r).not.toBeNull();
    expect(await fs.readFile(f, "utf8")).toBe("before\n");
  });

  it("prunes to MAX_CHECKPOINTS, dropping oldest snapshots", async () => {
    const s = store();
    const f = path.join(work, "prune.ts");
    for (let i = 0; i < MAX_CHECKPOINTS + 5; i++) {
      await fs.writeFile(f, `v${i}\n`, "utf8");
      await s.capture(f, "edit_file");
    }
    const list = await s.list();
    expect(list.length).toBe(MAX_CHECKPOINTS);
    // Oldest 5 snapshot files are gone; the newest kept ones remain on disk.
    await expect(fs.access(list[0].snapshot)).resolves.toBeUndefined();
    const storeDir = path.dirname(list[0].snapshot);
    await expect(fs.access(path.join(storeDir, "snap-1.bin"))).rejects.toThrow();
  });

  it("capture is best-effort: a failing copy never throws", async () => {
    const s = new CheckpointStore("bad", path.join(dir, "nested", "does", "not", "matter"));
    // A directory cannot be copied as a file -> internal error swallowed.
    const r = await s.capture(work, "edit_file"); // work is a directory
    expect(r).toBeNull();
  });
});
