import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRecentProjects, rememberRecentProject } from "../src/gui/recentProjects.js";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeEach(() => {});
afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("recent projects", () => {
  it("returns an empty list when nothing was stored", async () => {
    const home = await tempDir("mojo-recent-home-");
    expect(await listRecentProjects(home)).toEqual([]);
  });

  it("puts the newest project first and dedupes by path", async () => {
    const home = await tempDir("mojo-recent-home-");
    const a = await tempDir("mojo-proj-a-");
    const b = await tempDir("mojo-proj-b-");

    await rememberRecentProject(a, home);
    await rememberRecentProject(b, home);
    let list = await listRecentProjects(home);
    expect(list.map((p) => p.path)).toEqual([await fs.realpath(b), await fs.realpath(a)]);
    expect(list[0].name).toBe(path.basename(b));

    // Re-opening the older project moves it up instead of duplicating it.
    await rememberRecentProject(a, home);
    list = await listRecentProjects(home);
    expect(list.map((p) => p.path)).toEqual([await fs.realpath(a), await fs.realpath(b)]);
    expect(list).toHaveLength(2);
  });

  it("caps the list at eight entries", async () => {
    const home = await tempDir("mojo-recent-home-");
    const dirs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const dir = await tempDir(`mojo-proj-${i}-`);
      dirs.push(await fs.realpath(dir));
      await rememberRecentProject(dir, home);
    }
    const list = await listRecentProjects(home);
    expect(list).toHaveLength(8);
    expect(list.map((p) => p.path)).toEqual(dirs.slice(-8).reverse());
  });

  it("ignores missing directories and corrupt files", async () => {
    const home = await tempDir("mojo-recent-home-");
    expect(await rememberRecentProject(path.join(home, "nope"), home)).toEqual([]);

    await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
    await fs.writeFile(path.join(home, ".node-agent", "recent-projects.json"), "{broken", "utf8");
    expect(await listRecentProjects(home)).toEqual([]);
  });

  it("keeps the list file private on POSIX", async () => {
    if (process.platform === "win32") return;
    const home = await tempDir("mojo-recent-home-");
    const project = await tempDir("mojo-proj-");
    await rememberRecentProject(project, home);
    const file = path.join(home, ".node-agent", "recent-projects.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
