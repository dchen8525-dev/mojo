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

  it("refuses to undo when the file changed after the agent's write", async () => {
    const s = store();
    const f = path.join(work, "conflict.ts");
    await fs.writeFile(f, "original\n", "utf8");
    const entry = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "agent edit\n", "utf8");
    await s.finalize(entry);
    await fs.writeFile(f, "user's later edit\n", "utf8");

    const r = await s.undoLast();
    expect(r?.conflict).toBe(true);
    expect(r?.action).toBe("refused");
    expect(r?.reason).toContain("modified after");
    expect(await fs.readFile(f, "utf8")).toBe("user's later edit\n");

    const forced = await s.undoLast({ force: true });
    expect(forced?.action).toContain("restored");
    expect(await fs.readFile(f, "utf8")).toBe("original\n");
  });

  it("refuses when a file the agent deleted was re-created afterward", async () => {
    const s = store();
    const f = path.join(work, "recreated.ts");
    const entry = (await s.capture(f, "write_file"))!;
    await fs.writeFile(f, "agent file\n", "utf8");
    await fs.rm(f);
    await s.finalize(entry); // file vanished: postExisted=false
    await fs.writeFile(f, "someone else's file\n", "utf8");

    const r = await s.undoLast();
    expect(r?.conflict).toBe(true);
    expect(r?.reason).toContain("re-created");
    expect(await fs.readFile(f, "utf8")).toBe("someone else's file\n");
  });

  it("capture is best-effort: a failing copy never throws", async () => {
    const s = new CheckpointStore("bad", path.join(dir, "nested", "does", "not", "matter"));
    // A directory cannot be copied as a file -> internal error swallowed.
    const r = await s.capture(work, "edit_file"); // work is a directory
    expect(r).toBeNull();
  });
});

describe("CheckpointStore rewind", () => {
  it("rewinds a file across several edits to the earliest pre-image", async () => {
    const s = store();
    const f = path.join(work, "rew1.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");
    await s.finalize(e1);
    const e2 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v3\n", "utf8");
    await s.finalize(e2);

    const out = await s.rewindTo(e1.id);
    expect(out!.conflicts).toHaveLength(0);
    expect(out!.applied).toHaveLength(1);
    expect(out!.applied[0].action).toContain(`before #${e1.id}`);
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
    // Both folded entries are consumed; /undo has nothing left after them.
    expect((await s.list()).every((e) => e.restored)).toBe(true);
    expect(await s.undoLast()).toBeNull();
  });

  it("rewinds multiple files and deletes agent-created ones", async () => {
    const s = store();
    const a = path.join(work, "rew-a.ts");
    const b = path.join(work, "rew-b.ts");
    await fs.writeFile(a, "a1\n", "utf8");
    const e1 = (await s.capture(a, "edit_file"))!;
    await fs.writeFile(a, "a2\n", "utf8");
    await s.capture(b, "write_file"); // b did not exist
    await fs.writeFile(b, "b1\n", "utf8");

    const out = await s.rewindTo(e1.id); // earliest checkpoint: folds both edits in
    expect(out!.applied.map((r) => path.basename(r.file)).sort()).toEqual(["rew-a.ts", "rew-b.ts"]);
    expect(await fs.readFile(a, "utf8")).toBe("a1\n");
    await expect(fs.access(b)).rejects.toThrow();
  });

  it("conflicts when the user edited a file after the agent's last write", async () => {
    const s = store();
    const f = path.join(work, "rew-conflict.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");
    await s.finalize(e1);
    await fs.writeFile(f, "user's later edit\n", "utf8");

    const refused = await s.rewindTo(e1.id);
    expect(refused!.conflicts).toHaveLength(1);
    expect(refused!.conflicts[0].reason).toContain("modified after");
    expect(refused!.applied).toHaveLength(0);
    expect(await fs.readFile(f, "utf8")).toBe("user's later edit\n");

    const forced = await s.rewindTo(e1.id, { force: true });
    expect(forced!.conflicts).toHaveLength(0);
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
  });

  it("skips entries already undone by /undo", async () => {
    const s = store();
    const f = path.join(work, "rew-skip.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");
    const e2 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v3\n", "utf8");
    await s.undoLast(); // restores v2, marks e2 restored
    expect(await fs.readFile(f, "utf8")).toBe("v2\n");

    const out = await s.rewindTo(e1.id);
    expect(out!.entryIds).toEqual([e1.id]); // e2 excluded
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
  });

  it("dryRun previews without touching files or entries", async () => {
    const s = store();
    const f = path.join(work, "rew-dry.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");

    const preview = await s.rewindTo(e1.id, { dryRun: true });
    expect(preview!.dryRun).toBe(true);
    expect(preview!.applied).toHaveLength(0);
    expect(await fs.readFile(f, "utf8")).toBe("v2\n");
    expect((await s.list())[0].restored).toBe(false);

    const real = await s.rewindTo(e1.id);
    expect(real!.applied).toHaveLength(1);
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
  });

  it("returns null for an unknown id, and rewinding the newest checkpoint equals undo", async () => {
    const s = store();
    const f = path.join(work, "rew-null.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");

    expect(await s.rewindTo(999)).toBeNull();
    const head = await s.rewindTo(e1.id);
    expect(head!.applied).toHaveLength(1); // the target's own edit is reverted
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
    expect(await s.rewindTo(e1.id)!.then((o) => o!.applied)).toHaveLength(0); // nothing left
  });

  it("legacy entries without postHash rewind without a conflict check", async () => {
    const s = store();
    const f = path.join(work, "rew-legacy.ts");
    await fs.writeFile(f, "v1\n", "utf8");
    const e1 = (await s.capture(f, "edit_file"))!;
    await fs.writeFile(f, "v2\n", "utf8");
    await fs.writeFile(f, "user's edit\n", "utf8"); // never finalized

    const out = await s.rewindTo(e1.id);
    expect(out!.conflicts).toHaveLength(0);
    expect(await fs.readFile(f, "utf8")).toBe("v1\n");
  });
});
