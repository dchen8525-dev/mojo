import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../src/atomicWrite.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-atomic-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("creates and overwrites a file", async () => {
    const f = path.join(dir, "a.txt");
    await atomicWriteFile(f, "one");
    expect(await fs.readFile(f, "utf8")).toBe("one");
    await atomicWriteFile(f, "two");
    expect(await fs.readFile(f, "utf8")).toBe("two");
  });

  it("leaves no temp files behind", async () => {
    const f = path.join(dir, "b.txt");
    await atomicWriteFile(f, "x");
    expect(await fs.readdir(dir)).toEqual(["b.txt"]);
  });

  it.skipIf(process.platform === "win32")("preserves existing permission bits", async () => {
    const f = path.join(dir, "c.sh");
    await fs.writeFile(f, "#!/bin/sh\n");
    await fs.chmod(f, 0o750);
    await atomicWriteFile(f, "#!/bin/sh\necho hi\n");
    expect((await fs.stat(f)).mode & 0o777).toBe(0o750);
  });

  it.skipIf(process.platform === "win32")("writes through a symlink instead of replacing it", async () => {
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "link.txt");
    await fs.writeFile(target, "old");
    await fs.symlink(target, link);
    await atomicWriteFile(link, "new");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });
});
