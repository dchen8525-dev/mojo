import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared reader/writer for the layered `~/.node-agent/config.json` and
 * `<cwd>/.node-agent/config.json` files.
 *
 * Both layers are hand-editable, so reads tolerate a UTF-8 BOM (Windows editors
 * add one) and a file that exists but will not parse is *reported* rather than
 * silently treated as empty. Writes always merge into what is already there, so
 * keys this module knows nothing about survive.
 */

export type ConfigJson = Record<string, unknown>;

/** Parsed JSON; `null` when the file is absent, `"corrupt"` when it exists but won't parse. */
export function readConfigJson(file: string): ConfigJson | null | "corrupt" {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // no file yet
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as ConfigJson;
  } catch {
    return "corrupt";
  }
}

/**
 * Merge `patch` into the object already at `file` and write it back.
 *
 * Throws — without touching the file — when it exists but is not valid JSON:
 * otherwise a hand-corrupted config would be replaced by `patch` alone and
 * silently lose apiKey/model/theme.
 */
export async function mergeConfigJson(file: string, patch: ConfigJson): Promise<void> {
  const existing = readConfigJson(file);
  if (existing === "corrupt") {
    throw new Error(`${file} exists but is not valid JSON — fix it before saving (refused to overwrite)`);
  }
  const next = { ...(existing ?? {}), ...patch };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
