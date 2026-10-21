import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteProfile,
  findProfile,
  loadProfileStore,
  maskKey,
  profileFile,
  publicProfile,
  saveProfileStore,
  upsertProfile,
  type ProfileStore,
} from "../src/llmProfiles.js";

const dirs: string[] = [];

async function tmpHome(prefix = "prof-"): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe("loadProfileStore", () => {
  it("reads an empty store when the file does not exist", async () => {
    const home = await tmpHome();
    expect(await loadProfileStore(home)).toEqual({ profiles: [] });
  });

  it("round-trips a saved store", async () => {
    const home = await tmpHome();
    const store: ProfileStore = {
      activeId: "p_1",
      profiles: [{ id: "p_1", name: "网关", provider: "openai", baseURL: "https://gw/v1", apiKey: "sk-x", model: "glm-4.6", updatedAt: "2026-10-18T00:00:00.000Z" }],
    };
    await saveProfileStore(store, home);
    expect(await loadProfileStore(home)).toEqual(store);
  });

  it("treats a corrupt file as 'no profiles' instead of throwing", async () => {
    const home = await tmpHome();
    await fs.mkdir(path.dirname(profileFile(home)), { recursive: true });
    await fs.writeFile(profileFile(home), "{ nope", "utf8");
    expect(await loadProfileStore(home)).toEqual({ profiles: [] });
  });

  it("drops entries that are not usable profiles", async () => {
    const home = await tmpHome();
    await fs.mkdir(path.dirname(profileFile(home)), { recursive: true });
    await fs.writeFile(
      profileFile(home),
      JSON.stringify({ profiles: [{ id: "p_1", provider: "gemini", model: "x" }, { id: "p_2", provider: "openai", model: "ok" }, null] }),
      "utf8",
    );
    const store = await loadProfileStore(home);
    expect(store.profiles.map((p) => p.id)).toEqual(["p_2"]);
  });
});

describe("saveProfileStore", () => {
  it("refuses to clobber a corrupt file", async () => {
    const home = await tmpHome();
    await fs.mkdir(path.dirname(profileFile(home)), { recursive: true });
    const corrupt = "{ not json";
    await fs.writeFile(profileFile(home), corrupt, "utf8");
    await expect(saveProfileStore({ profiles: [] }, home)).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(profileFile(home), "utf8")).toBe(corrupt);
  });
});

describe("upsertProfile", () => {
  it("appends a new profile with a generated id", () => {
    const { store, id } = upsertProfile({ profiles: [] }, { name: "网关", provider: "openai", model: "glm-4.6" });
    expect(id).toMatch(/^p_/);
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]).toMatchObject({ id, name: "网关", provider: "openai", model: "glm-4.6" });
  });

  it("keeps the stored key when the edit leaves the key field blank", () => {
    const seed: ProfileStore = { profiles: [{ id: "p_1", name: "a", provider: "openai", model: "m", apiKey: "sk-old", updatedAt: "t" }] };
    const { store } = upsertProfile(seed, { id: "p_1", name: "b", provider: "openai", model: "m2", apiKey: "  " });
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]).toMatchObject({ name: "b", model: "m2", apiKey: "sk-old" });
  });

  it("replaces the key when a new one is supplied and drops a cleared baseURL", () => {
    const seed: ProfileStore = { profiles: [{ id: "p_1", name: "a", provider: "openai", model: "m", apiKey: "sk-old", baseURL: "https://old", updatedAt: "t" }] };
    const { store } = upsertProfile(seed, { id: "p_1", name: "a", provider: "openai", model: "m", apiKey: " sk-new " });
    expect(store.profiles[0].apiKey).toBe("sk-new");
    expect(store.profiles[0].baseURL).toBeUndefined();
  });

  it("falls back to the model name and normalizes an unknown provider", () => {
    const { store } = upsertProfile({ profiles: [] }, { name: "   ", provider: "gemini" as never, model: " glm-4.6 " });
    expect(store.profiles[0].name).toBe("glm-4.6");
    expect(store.profiles[0].provider).toBe("anthropic");
  });

  it("stores and clears the context window override", () => {
    const first = upsertProfile({ profiles: [] }, { name: "a", provider: "openai", model: "m", contextWindow: 1_048_576 });
    expect(first.store.profiles[0].contextWindow).toBe(1_048_576);

    const cleared = upsertProfile(first.store, { id: first.id, name: "a", provider: "openai", model: "m" });
    expect(cleared.store.profiles[0].contextWindow).toBeUndefined();
  });

  it("ignores a non-positive context window", () => {
    const { store } = upsertProfile({ profiles: [] }, { name: "a", provider: "openai", model: "m", contextWindow: 0 });
    expect(store.profiles[0].contextWindow).toBeUndefined();
  });
});

describe("deleteProfile", () => {
  it("removes the entry and clears the active marker that pointed at it", () => {
    const seed: ProfileStore = {
      activeId: "p_1",
      profiles: [
        { id: "p_1", name: "a", provider: "openai", model: "m", updatedAt: "t" },
        { id: "p_2", name: "b", provider: "anthropic", model: "m", updatedAt: "t" },
      ],
    };
    const next = deleteProfile(seed, "p_1");
    expect(next.profiles.map((p) => p.id)).toEqual(["p_2"]);
    expect(next.activeId).toBeUndefined();
  });

  it("returns the same store when the id is unknown", () => {
    const seed: ProfileStore = { profiles: [] };
    expect(deleteProfile(seed, "nope")).toBe(seed);
  });

  it("keeps the active marker when another entry is deleted", () => {
    const seed: ProfileStore = {
      activeId: "p_2",
      profiles: [
        { id: "p_1", name: "a", provider: "openai", model: "m", updatedAt: "t" },
        { id: "p_2", name: "b", provider: "anthropic", model: "m", updatedAt: "t" },
      ],
    };
    expect(deleteProfile(seed, "p_1").activeId).toBe("p_2");
  });
});

describe("masking", () => {
  it("keeps only the head and tail of a real key", () => {
    expect(maskKey("sk-1234567890abcd")).toBe("sk-1…abcd");
  });

  it("collapses a short key to a single character", () => {
    expect(maskKey("sk-abc")).toBe("s…");
  });

  it("returns an empty string when there is no key", () => {
    expect(maskKey(undefined)).toBe("");
    expect(maskKey("   ")).toBe("");
  });

  it("publicProfile never carries the raw key", () => {
    const view = publicProfile({ id: "p_1", name: "a", provider: "openai", model: "m", apiKey: "sk-secret-value", updatedAt: "t" });
    expect(view).toEqual({ id: "p_1", name: "a", provider: "openai", model: "m", updatedAt: "t", hasKey: true, keyMasked: "sk-s…alue" });
    expect("apiKey" in view).toBe(false);
  });
});

describe("findProfile", () => {
  it("locates an entry by id", () => {
    const store: ProfileStore = { profiles: [{ id: "p_1", name: "a", provider: "openai", model: "m", updatedAt: "t" }] };
    expect(findProfile(store, "p_1")).toMatchObject({ name: "a" });
    expect(findProfile(store, "nope")).toBeUndefined();
  });
});
