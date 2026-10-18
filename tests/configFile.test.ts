import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfigJson, readConfigJson } from "../src/configFile.js";

const dirs: string[] = [];

async function tmpdir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe("readConfigJson", () => {
  it("returns null when the file does not exist yet", async () => {
    const d = await tmpdir("cfg-");
    expect(readConfigJson(path.join(d, "config.json"))).toBeNull();
  });

  it("parses a UTF-8 BOM prefixed file", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, "config.json");
    await fs.writeFile(file, `\uFEFF${JSON.stringify({ provider: "openai" })}`, "utf8");
    expect(readConfigJson(file)).toEqual({ provider: "openai" });
  });

  it("reports a file that exists but will not parse", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, "config.json");
    await fs.writeFile(file, '{ "apiKey": "sk-x", }', "utf8");
    expect(readConfigJson(file)).toBe("corrupt");
  });
});

describe("mergeConfigJson", () => {
  it("creates the file and its directory on the first write", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, ".node-agent", "config.json");
    await mergeConfigJson(file, { provider: "openai", model: "glm-4.6" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ provider: "openai", model: "glm-4.6" });
  });

  it("keeps keys it was not asked to change", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, "config.json");
    await fs.writeFile(file, JSON.stringify({ theme: "light", apiKey: "sk-secret", model: "old" }), "utf8");
    await mergeConfigJson(file, { model: "new" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ theme: "light", apiKey: "sk-secret", model: "new" });
  });

  it("drops a key whose patch value is undefined rather than writing null", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, "config.json");
    await fs.writeFile(file, JSON.stringify({ baseURL: "https://stale.example", theme: "dark" }), "utf8");
    await mergeConfigJson(file, { baseURL: undefined, model: "m" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ theme: "dark", model: "m" });
  });

  it("refuses to overwrite a corrupt config, leaving the original bytes intact", async () => {
    const d = await tmpdir("cfg-");
    const file = path.join(d, "config.json");
    const corrupt = '{ "apiKey": "sk-secret", }';
    await fs.writeFile(file, corrupt, "utf8");
    await expect(mergeConfigJson(file, { model: "m" })).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(file, "utf8")).toBe(corrupt);
  });
});
