import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectDir, samePath } from "./project.js";

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

const MAX_RECENT = 8;

function fileFor(home: string): string {
  return path.join(home, ".node-agent", "recent-projects.json");
}

/** Most recently opened projects, newest first. Missing/corrupt files read as []. */
export async function listRecentProjects(home: string = os.homedir()): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(fileFor(home), "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RecentProject =>
          !!p && typeof p.path === "string" && p.path && typeof p.openedAt === "string",
      )
      .map((p) => ({
        path: p.path,
        name: typeof p.name === "string" && p.name ? p.name : path.basename(p.path) || p.path,
        openedAt: p.openedAt,
      }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Move `dir` to the front of the recent list. Best effort; never throws. */
export async function rememberRecentProject(dir: string, home: string = os.homedir()): Promise<RecentProject[]> {
  let abs: string;
  try {
    abs = await resolveProjectDir(dir);
  } catch {
    return listRecentProjects(home);
  }
  const current = await listRecentProjects(home);
  const entry: RecentProject = {
    path: abs,
    name: path.basename(abs) || abs,
    openedAt: new Date().toISOString(),
  };
  const next = [entry, ...current.filter((p) => !samePath(p.path, abs))].slice(0, MAX_RECENT);
  try {
    const file = fileFor(home);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
  } catch {
    /* listing is best effort; a failed write must not block the switch */
  }
  return next;
}
