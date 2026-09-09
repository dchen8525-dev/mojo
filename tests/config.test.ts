import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfigFiles } from "../src/llm.js";

let home: string;
let project: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-proj-"));
  await fs.mkdir(path.join(home, ".node-agent"), { recursive: true });
  await fs.mkdir(path.join(project, ".node-agent"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

async function writeConfig(dir: string, obj: unknown, bom = false) {
  const raw = (bom ? "﻿" : "") + JSON.stringify(obj);
  await fs.writeFile(path.join(dir, ".node-agent", "config.json"), raw, "utf8");
}

describe("loadConfigFiles (layered config)", () => {
  it("returns {} when neither file exists", () => {
    expect(loadConfigFiles(project, home)).toEqual({});
  });

  it("reads the global file alone", async () => {
    await writeConfig(home, { provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(loadConfigFiles(project, home)).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("project file overrides per-key, not wholesale", async () => {
    await writeConfig(home, { provider: "anthropic", model: "global-model", apiKey: "sk-global" });
    await writeConfig(project, { model: "project-model" });
    const cfg = loadConfigFiles(project, home);
    expect(cfg.model).toBe("project-model");
    expect(cfg.provider).toBe("anthropic"); // kept from global
    expect(cfg.apiKey).toBe("sk-global"); // kept from global
  });

  it("tolerates a UTF-8 BOM (Windows editors)", async () => {
    await writeConfig(home, {}, true);
    await writeConfig(project, { model: "bom-ok" }, true);
    expect(loadConfigFiles(project, home).model).toBe("bom-ok");
  });

  it("ignores malformed JSON instead of crashing", async () => {
    await fs.writeFile(path.join(project, ".node-agent", "config.json"), "{not json", "utf8");
    await writeConfig(home, { model: "still-works" });
    expect(loadConfigFiles(project, home).model).toBe("still-works");
  });
});
