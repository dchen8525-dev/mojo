import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "./llm/types.js";

/**
 * Named LLM configurations ("profiles") the GUI's 模型配置 panel manages.
 *
 * They live in `~/.node-agent/llm-profiles.json` — global, because a profile
 * carries an API key and that should not travel with a project checkout.
 * Activating one merges its provider/model/baseURL/apiKey into the global
 * `config.json`, which is the file `resolveSettings` already reads, so nothing
 * in the resolution chain needs to know profiles exist.
 */

export interface LlmProfile {
  id: string;
  name: string;
  /** Wire format: `openai` covers every OpenAI-compatible gateway. */
  provider: Provider;
  baseURL?: string;
  apiKey?: string;
  model: string;
  /** Explicit context window (tokens); empty means "ask the endpoint, else use the table". */
  contextWindow?: number;
  updatedAt: string;
}

export interface ProfileStore {
  /** Id of the profile currently merged into the global config, if any. */
  activeId?: string;
  profiles: LlmProfile[];
}

/** What the UI is allowed to see: never the raw key. */
export interface PublicProfile extends Omit<LlmProfile, "apiKey"> {
  hasKey: boolean;
  keyMasked: string;
}

export interface ProfileInput {
  id?: string;
  name: string;
  provider: Provider;
  baseURL?: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
}

export function profileFile(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "llm-profiles.json");
}

/** Read the store; a missing or unparseable file reads as "no profiles yet". */
export async function loadProfileStore(home: string = os.homedir()): Promise<ProfileStore> {
  let raw: string;
  try {
    raw = await fs.readFile(profileFile(home), "utf8");
  } catch {
    return { profiles: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return { profiles: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { profiles: [] };
  const store = parsed as Partial<ProfileStore>;
  const profiles = Array.isArray(store.profiles) ? store.profiles.filter(isProfile) : [];
  return { activeId: typeof store.activeId === "string" ? store.activeId : undefined, profiles };
}

function isProfile(v: unknown): v is LlmProfile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<LlmProfile>;
  return typeof p.id === "string" && typeof p.model === "string" && (p.provider === "openai" || p.provider === "anthropic");
}

/**
 * Persist the store. Refuses to overwrite a file that exists but is not valid
 * JSON, so a hand-edited typo never costs the user every saved key.
 */
export async function saveProfileStore(store: ProfileStore, home: string = os.homedir()): Promise<void> {
  const file = profileFile(home);
  const corrupt = isCorrupt(file);
  if (corrupt) throw new Error(`${file} exists but is not valid JSON — fix it before saving (refused to overwrite)`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isCorrupt(file: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false; // absent -> safe to create
  }
  try {
    JSON.parse(raw.replace(/^\uFEFF/, ""));
    return false;
  } catch {
    return true;
  }
}

let seq = 0;

export function newProfileId(): string {
  seq = (seq + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `p_${rand}${seq.toString(16).padStart(4, "0")}`;
}

/**
 * Insert or update one profile. An empty `apiKey` on an existing id keeps the
 * stored key (the form shows a masked value and offers "leave blank to keep").
 */
export function upsertProfile(store: ProfileStore, input: ProfileInput, now: string = new Date().toISOString()): { store: ProfileStore; id: string } {
  const existing = input.id ? store.profiles.find((p) => p.id === input.id) : undefined;
  const id = existing?.id ?? newProfileId();
  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : existing?.apiKey;
  const model = input.model.trim();

  const profile: LlmProfile = {
    id,
    name: input.name.trim() || model,
    provider: input.provider === "openai" ? "openai" : "anthropic",
    model,
    updatedAt: now,
  };
  const baseURL = input.baseURL?.trim();
  if (baseURL) profile.baseURL = baseURL;
  if (apiKey) profile.apiKey = apiKey;
  const ctx = input.contextWindow;
  if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) profile.contextWindow = Math.floor(ctx);

  const profiles = existing ? store.profiles.map((p) => (p.id === id ? profile : p)) : [...store.profiles, profile];
  return { store: { ...store, profiles }, id };
}

export function deleteProfile(store: ProfileStore, id: string): ProfileStore {
  const profiles = store.profiles.filter((p) => p.id !== id);
  if (profiles.length === store.profiles.length) return store;
  return { profiles, activeId: store.activeId === id ? undefined : store.activeId };
}

export function findProfile(store: ProfileStore, id: string): LlmProfile | undefined {
  return store.profiles.find((p) => p.id === id);
}

/** `sk-1234abcd` → `sk-1…abcd`; short keys collapse to the last character only. */
export function maskKey(key?: string): string {
  const k = key?.trim();
  if (!k) return "";
  if (k.length <= 8) return `${k.slice(0, 1)}…`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export function publicProfile(p: LlmProfile): PublicProfile {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: Boolean(apiKey), keyMasked: maskKey(apiKey) };
}
