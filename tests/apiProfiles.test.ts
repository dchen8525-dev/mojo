import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteApiProfile,
  resolveSettings,
  saveApiProfile,
  selectApiProfile,
  setModelOverride,
} from "../src/llm.js";

const temps: string[] = [];
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
];
let savedEnv: Record<string, string | undefined> = {};

async function tempDir(prefix = "mojo-api-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), "utf8");
}

beforeEach(() => {
  setModelOverride(null);
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  setModelOverride(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("saveApiProfile", () => {
  it("creates a profile, stores the key globally, and masks it in the view", async () => {
    const home = await tempDir();
    const { profile, created, view } = await saveApiProfile(
      { name: "Corp gateway", provider: "openai", model: "gpt-4o", baseURL: "https://llm.corp/v1", apiKey: "sk-corp" },
      { home },
    );

    expect(created).toBe(true);
    expect(view.profiles).toEqual([
      {
        id: profile.id,
        name: "Corp gateway",
        provider: "openai",
        model: "gpt-4o",
        baseURL: "https://llm.corp/v1",
        hasKey: true,
      },
    ]);
    expect(view.defaultProfileId).toBe(profile.id);
    expect(view.activeProfileId).toBe(profile.id);

    const raw = await readJson(path.join(home, ".node-agent", "config.json"));
    expect(raw.apiProfiles[0].apiKey).toBe("sk-corp");
  });

  it("updates a profile and keeps the stored key when apiKey is blank", async () => {
    const home = await tempDir();
    const first = await saveApiProfile(
      { name: "Old", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-keep" },
      { home },
    );

    const updated = await saveApiProfile(
      { id: first.profile.id, name: "New", provider: "anthropic", model: "claude-opus-4-1", apiKey: "" },
      { home },
    );

    expect(updated.created).toBe(false);
    expect(updated.profile.name).toBe("New");
    expect(updated.profile.model).toBe("claude-opus-4-1");
    expect(updated.profile.apiKey).toBe("sk-keep");
  });

  it("requires a key when creating and preserves unrelated config keys", async () => {
    const home = await tempDir();
    const file = path.join(home, ".node-agent", "config.json");
    await writeJson(file, { theme: "light", custom: 1 });

    await expect(
      saveApiProfile({ name: "No key", provider: "anthropic", model: "m" }, { home }),
    ).rejects.toThrow("API key is required");

    await saveApiProfile({ name: "P", provider: "anthropic", model: "m", apiKey: "sk" }, { home });
    const raw = await readJson(file);
    expect(raw.theme).toBe("light");
    expect(raw.custom).toBe(1);
  });
});

describe("selection and resolution", () => {
  it("uses the project-selected profile as a coherent bundle", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await saveApiProfile(
      { name: "Anthropic", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-a" },
      { home },
    );
    const b = await saveApiProfile(
      {
        name: "Gateway",
        provider: "openai",
        model: "gpt-4o",
        baseURL: "https://gw.example/v1",
        apiKey: "sk-b",
      },
      { home },
    );
    await selectApiProfile(cwd, "project", b.profile.id, { home });

    const settings = resolveSettings({ cwd, home });
    expect(settings.provider).toBe("openai");
    expect(settings.model).toBe("gpt-4o");
    expect(settings.baseURL).toBe("https://gw.example/v1");
    expect(settings.apiKey).toBe("sk-b");
    expect(settings.profile?.id).toBe(b.profile.id);

    // The project config stores only the id, never the credential.
    const project = await readJson(path.join(cwd, ".node-agent", "config.json"));
    expect(project).toEqual({ apiProfile: b.profile.id });
  });

  it("falls back to the global default when the project has no selection", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const a = await saveApiProfile(
      { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5", baseURL: "https://a.example", apiKey: "sk-a" },
      { home },
    );
    await saveApiProfile({ name: "Other", provider: "openai", model: "gpt-4o", apiKey: "sk-b" }, { home });

    const settings = resolveSettings({ cwd, home });
    expect(settings.provider).toBe("anthropic");
    expect(settings.apiKey).toBe("sk-a");
    expect(settings.baseURL).toBe("https://a.example");
    expect(settings.profile?.id).toBe(a.profile.id);
  });

  it("lets an explicit model override the profile model but keeps its credentials", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const saved = await saveApiProfile(
      { name: "P", provider: "anthropic", model: "claude-sonnet-4-5", baseURL: "https://gw.example", apiKey: "sk-p" },
      { home },
    );
    await selectApiProfile(cwd, "project", saved.profile.id, { home });

    const settings = resolveSettings({ cwd, home, model: "claude-opus-4-1" });
    expect(settings.model).toBe("claude-opus-4-1");
    expect(settings.apiKey).toBe("sk-p");
    expect(settings.baseURL).toBe("https://gw.example");
  });

  it("profile credentials beat ambient environment variables", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const saved = await saveApiProfile(
      { name: "P", provider: "anthropic", model: "claude-sonnet-4-5", baseURL: "https://gw.example", apiKey: "sk-profile" },
      { home },
    );
    await selectApiProfile(cwd, "project", saved.profile.id, { home });
    process.env.ANTHROPIC_API_KEY = "sk-env";
    process.env.AGENT_BASE_URL = "https://env.example";

    const settings = resolveSettings({ cwd, home });
    expect(settings.apiKey).toBe("sk-profile");
    expect(settings.baseURL).toBe("https://gw.example");
  });

  it("ignores the profile when the provider is overridden", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const saved = await saveApiProfile(
      { name: "Anthropic", provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-a" },
      { home },
    );
    await selectApiProfile(cwd, "project", saved.profile.id, { home });

    const settings = resolveSettings({ cwd, home, provider: "openai" });
    expect(settings.provider).toBe("openai");
    expect(settings.profile).toBeUndefined();
    expect(settings.apiKey).toBeUndefined();
  });

  it("falls back to the legacy top-level config when no profile is selected", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await writeJson(path.join(home, ".node-agent", "config.json"), {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      baseURL: "https://legacy.example",
      apiKey: "sk-legacy",
    });

    const settings = resolveSettings({ cwd, home });
    expect(settings.provider).toBe("anthropic");
    expect(settings.model).toBe("claude-3-5-sonnet");
    expect(settings.baseURL).toBe("https://legacy.example");
    expect(settings.apiKey).toBe("sk-legacy");
    expect(settings.profile).toBeUndefined();
  });

  it("clears a project selection", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const saved = await saveApiProfile({ name: "P", provider: "anthropic", model: "m", apiKey: "sk" }, { home });
    await selectApiProfile(cwd, "project", saved.profile.id, { home });
    const view = await selectApiProfile(cwd, "project", null, { home });
    expect(view.projectProfileId).toBeNull();
    expect(view.activeProfileId).toBe(saved.profile.id); // falls back to the default
  });

  it("rejects selecting an unknown profile", async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await expect(selectApiProfile(cwd, "project", "nope", { home })).rejects.toThrow("unknown API profile");
  });
});

describe("deleteApiProfile", () => {
  it("removes a profile and promotes the next one as the default", async () => {
    const home = await tempDir();
    const first = await saveApiProfile({ name: "First", provider: "anthropic", model: "m1", apiKey: "sk1" }, { home });
    const second = await saveApiProfile({ name: "Second", provider: "openai", model: "m2", apiKey: "sk2" }, { home });

    const result = await deleteApiProfile(first.profile.id, { home });
    expect(result.deleted).toBe(true);
    expect(result.view.profiles.map((p) => p.id)).toEqual([second.profile.id]);
    expect(result.view.defaultProfileId).toBe(second.profile.id);
  });

  it("returns deleted=false for an unknown id", async () => {
    const home = await tempDir();
    const result = await deleteApiProfile("nope", { home });
    expect(result.deleted).toBe(false);
  });
});

describe("config file permissions", () => {
  it("keeps the credential-bearing global config owner-only on POSIX", async () => {
    if (process.platform === "win32") return; // chmod only toggles the readonly bit there
    const home = await tempDir();
    await saveApiProfile({ name: "P", provider: "anthropic", model: "m", apiKey: "sk" }, { home });
    const file = path.join(home, ".node-agent", "config.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    // Every later rewrite (default selection, deletion) must keep it private.
    const cwd = await tempDir();
    await selectApiProfile(cwd, "default", null, { home });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
