import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import type { MessageParam, Tool, ContentBlock } from "./types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents } from "./llm/types.js";
import { StreamInterrupted } from "./llm/types.js";
import { AnthropicBackend } from "./llm/anthropic.js";
import { OpenAiBackend } from "./llm/openai.js";
import { lookupModel } from "./llm/models.js";

export type { AssistantTurn, StreamEvents, Provider } from "./llm/types.js";
export { knownModelNames, lookupModel } from "./llm/models.js";

export interface ApiProfile {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  baseURL?: string;
  apiKey: string;
}

export interface Config {
  provider?: Provider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** UI theme: "dark" | "light" | "auto" (see src/ui/theme.ts). */
  theme?: string;
  /** Global registry of named API configurations. */
  apiProfiles?: ApiProfile[];
  /** Global default profile id, used when a project has no selection. */
  defaultApiProfile?: string;
  /** Project-scoped profile id. */
  apiProfile?: string;
}

export interface LLMOptions extends Config {
  /** Project root used to locate .node-agent/config.json (default: process.cwd()). */
  cwd?: string;
  /** Home directory override (tests / embedded use). */
  home?: string;
}

function readConfigFile(p: string): Config {
  try {
    const raw = readFileSync(p, "utf8");
    // Strip a leading UTF-8 BOM (Windows editors/tools often add one) before parsing.
    return JSON.parse(raw.replace(/^﻿/, "")) as Config;
  } catch {
    return {};
  }
}

/**
 * Layered config: ~/.node-agent/config.json (global) overridden per-key by
 * <cwd>/.node-agent/config.json (project). Same layering as hooks/lsp.
 */
/**
 * Both config layers unmerged, so callers can tell *which* file a key came
 * from (the theme picker reports that back to the user).
 */
export function loadConfigLayers(cwd: string = process.cwd(), home: string = os.homedir()): { global: Config; project: Config } {
  return {
    global: readConfigFile(path.join(home, ".node-agent", "config.json")),
    project: readConfigFile(path.join(cwd, ".node-agent", "config.json")),
  };
}

export function loadConfigFiles(cwd: string = process.cwd(), home: string = os.homedir()): Config {
  const { global, project } = loadConfigLayers(cwd, home);
  return { ...global, ...project };
}

function defaultModel(provider: Provider): string {
  return provider === "openai" ? "gpt-4o" : "claude-sonnet-4-5";
}

function isValidProfile(value: unknown): value is ApiProfile {
  const p = value as Partial<ApiProfile>;
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    (p.provider === "anthropic" || p.provider === "openai") &&
    typeof p.model === "string" &&
    typeof p.apiKey === "string"
  );
}

function profilesOf(config: Config): ApiProfile[] {
  return Array.isArray(config.apiProfiles) ? config.apiProfiles.filter(isValidProfile) : [];
}

/** Read one config file. Missing -> null; corrupt -> throw (never overwrite silently). */
function readConfigObject(file: string): (Config & Record<string, unknown>) | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Config & Record<string, unknown>;
  } catch {
    throw new Error(`${file} exists but is not valid JSON — fix it before saving API settings (refused to overwrite)`);
  }
}

export interface PublicApiProfile {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  baseURL?: string;
  hasKey: boolean;
}

export interface ApiProfilesView {
  profiles: PublicApiProfile[];
  defaultProfileId: string | null;
  projectProfileId: string | null;
  /** Effective profile (project selection, else global default), or null. */
  activeProfileId: string | null;
  activeProfileName: string | null;
  /** A project selection that no longer exists in the registry. */
  missingProfileId: string | null;
  /** The global default points at a profile that no longer exists. */
  missingDefaultProfileId: string | null;
  /** Legacy top-level credentials exist but no profiles are registered. */
  hasLegacyKey: boolean;
  config: { global: string; project: string };
}

/** Masked profile list for the UI: never returns API keys. */
export function listApiProfiles(cwd: string = process.cwd(), home: string = os.homedir()): ApiProfilesView {
  const { global, project } = loadConfigLayers(cwd, home);
  const profiles = profilesOf(global);
  const projectProfileId = typeof project.apiProfile === "string" && project.apiProfile ? project.apiProfile : null;
  const defaultProfileId =
    typeof global.defaultApiProfile === "string" && global.defaultApiProfile ? global.defaultApiProfile : null;
  const projectProfile = projectProfileId ? profiles.find((p) => p.id === projectProfileId) : undefined;
  const defaultProfile = defaultProfileId ? profiles.find((p) => p.id === defaultProfileId) : undefined;
  const active = projectProfile ?? defaultProfile;

  return {
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      hasKey: !!p.apiKey,
    })),
    defaultProfileId,
    projectProfileId,
    activeProfileId: active?.id ?? null,
    activeProfileName: active?.name ?? null,
    missingProfileId: projectProfileId && !projectProfile ? projectProfileId : null,
    missingDefaultProfileId: defaultProfileId && !defaultProfile ? defaultProfileId : null,
    hasLegacyKey: !!(global.apiKey || project.apiKey),
    config: {
      global: path.join(home, ".node-agent", "config.json"),
      project: path.join(cwd, ".node-agent", "config.json"),
    },
  };
}

export interface ApiProfileInput {
  /** Existing profile id; omit to create a new one. */
  id?: string;
  name: string;
  provider: Provider;
  model: string;
  baseURL?: string;
  /** Required when creating; blank on update keeps the stored key. */
  apiKey?: string;
}

function newProfileId(): string {
  return `p${randomBytes(4).toString("hex")}`;
}

function globalConfigFile(home: string): string {
  return path.join(home, ".node-agent", "config.json");
}

async function writeConfigFile(file: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Existing files keep their old mode; config may hold API keys, so force private.
  await fs.chmod(file, 0o600).catch(() => {});
}

/** Create or update a profile in the global registry. */
export async function saveApiProfile(
  input: ApiProfileInput,
  opts: { home?: string; cwd?: string } = {},
): Promise<{ profile: ApiProfile; created: boolean; view: ApiProfilesView }> {
  const home = opts.home ?? os.homedir();
  const file = globalConfigFile(home);
  const existing = readConfigObject(file) ?? {};
  const profiles = profilesOf(existing);
  const index = input.id ? profiles.findIndex((p) => p.id === input.id) : -1;
  const created = index === -1;
  const apiKey = input.apiKey?.trim();
  if (created && !apiKey) throw new Error("API key is required for a new profile");

  const profile: ApiProfile = {
    id: created ? newProfileId() : profiles[index].id,
    name: input.name.trim().slice(0, 60) || `${input.provider}:${input.model.trim()}`,
    provider: input.provider,
    model: input.model.trim(),
    ...(input.baseURL?.trim() ? { baseURL: input.baseURL.trim() } : {}),
    apiKey: apiKey || (created ? "" : profiles[index].apiKey),
  };

  if (created) profiles.push(profile);
  else profiles[index] = profile;

  const next: Config & Record<string, unknown> = { ...existing, apiProfiles: profiles };
  if (
    typeof next.defaultApiProfile !== "string" ||
    !profiles.some((p) => p.id === next.defaultApiProfile)
  ) {
    next.defaultApiProfile = profile.id;
  }
  await writeConfigFile(file, next);

  return { profile, created, view: listApiProfiles(opts.cwd ?? process.cwd(), home) };
}

/** Remove a profile. Project selections pointing at it fall back at resolve time. */
export async function deleteApiProfile(
  id: string,
  opts: { home?: string; cwd?: string } = {},
): Promise<{ deleted: boolean; view: ApiProfilesView }> {
  const home = opts.home ?? os.homedir();
  const file = globalConfigFile(home);
  const existing = readConfigObject(file);
  const view = () => listApiProfiles(opts.cwd ?? process.cwd(), home);
  if (!existing) return { deleted: false, view: view() };

  const profiles = profilesOf(existing);
  const nextProfiles = profiles.filter((p) => p.id !== id);
  if (nextProfiles.length === profiles.length) return { deleted: false, view: view() };

  const next: Config & Record<string, unknown> = { ...existing, apiProfiles: nextProfiles };
  if (next.defaultApiProfile === id) {
    if (nextProfiles.length) next.defaultApiProfile = nextProfiles[0].id;
    else delete next.defaultApiProfile;
  }
  await writeConfigFile(file, next);
  return { deleted: true, view: view() };
}

/** Point a project (or the global default) at a profile; null clears the choice. */
export async function selectApiProfile(
  cwd: string,
  scope: "project" | "default",
  id: string | null,
  opts: { home?: string } = {},
): Promise<ApiProfilesView> {
  const home = opts.home ?? os.homedir();
  const file = scope === "project" ? path.join(cwd, ".node-agent", "config.json") : globalConfigFile(home);
  if (id) {
    const profiles = profilesOf(loadConfigLayers(cwd, home).global);
    if (!profiles.some((p) => p.id === id)) throw new Error("unknown API profile");
  }

  const existing = readConfigObject(file) ?? {};
  const next: Config & Record<string, unknown> = { ...existing };
  const key = scope === "project" ? "apiProfile" : "defaultApiProfile";
  if (id) next[key] = id;
  else delete next[key];
  await writeConfigFile(file, next);
  return listApiProfiles(cwd, home);
}

/**
 * Resolve provider/model/credentials from (in priority order):
 * explicit opts > runtime override (set via /model) > selected API profile >
 * environment > <cwd>/.node-agent/config.json > ~/.node-agent/config.json.
 *
 * A selected profile is a coherent bundle: when its provider matches the
 * effective provider, its model/baseURL/key are used and ambient env/config
 * credentials do not override them. A /model switch still overrides the
 * provider/model, and then falls back to the legacy resolution path.
 */
export function resolveSettings(opts: LLMOptions = {}) {
  const { global, project } = loadConfigLayers(opts.cwd, opts.home);
  const file = { ...global, ...project };
  const env = process.env;
  const ov = activeOverride ?? {};

  const profiles = profilesOf(global);
  const projectId =
    typeof project.apiProfile === "string" && project.apiProfile ? project.apiProfile : undefined;
  const defaultId =
    typeof global.defaultApiProfile === "string" && global.defaultApiProfile
      ? global.defaultApiProfile
      : undefined;
  const selected =
    (projectId ? profiles.find((p) => p.id === projectId) : undefined) ??
    (defaultId ? profiles.find((p) => p.id === defaultId) : undefined);

  let provider: Provider =
    opts.provider ??
    ov.provider ??
    selected?.provider ??
    (env.AGENT_PROVIDER as Provider | undefined) ??
    file.provider ??
    // infer: OPENAI_* present and no ANTHROPIC_* -> openai, else anthropic
    (env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY ? "openai" : "anthropic");

  if (provider !== "anthropic" && provider !== "openai") provider = "anthropic";

  const useProfile = !!selected && selected.provider === provider;
  let model: string;
  let baseURL: string | undefined;
  let apiKey: string | undefined;

  if (useProfile) {
    model = opts.model ?? ov.model ?? (selected.model || env.AGENT_MODEL || file.model || defaultModel(provider));
    baseURL = opts.baseURL ?? ov.baseURL ?? selected.baseURL;
    apiKey = opts.apiKey ?? ov.apiKey ?? selected.apiKey;
  } else {
    model = opts.model ?? ov.model ?? env.AGENT_MODEL ?? file.model ?? defaultModel(provider);
    baseURL =
      opts.baseURL ??
      ov.baseURL ??
      env.AGENT_BASE_URL ??
      (provider === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL) ??
      file.baseURL;
    apiKey =
      opts.apiKey ??
      ov.apiKey ??
      (provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) ??
      file.apiKey;
  }

  return { provider, model, baseURL, apiKey, profile: useProfile ? selected : undefined };
}

/**
 * Module-level override set by /model hot-switching. New LLM instances
 * (e.g. subagents) pick it up automatically, so the whole session follows
 * the switch.
 */
let activeOverride: Config | null = null;

export function setModelOverride(spec: Config | null) {
  activeOverride = spec;
}
export function getModelOverride(): Config | null {
  return activeOverride;
}

/** Parse a /model argument: "provider:model", "model", or an alias. */
export function parseModelSpec(spec: string, currentProvider: Provider): Config {
  const aliases: Record<string, Config> = {
    opus: { provider: "anthropic", model: "claude-opus-4-1" },
    sonnet: { provider: "anthropic", model: "claude-sonnet-4-5" },
    haiku: { provider: "anthropic", model: "claude-haiku-4-5" },
    gpt: { provider: "openai", model: "gpt-4o" },
  };
  const s = spec.trim().toLowerCase();
  if (aliases[s]) return aliases[s];
  const m = /^(anthropic|openai):(.+)$/.exec(spec.trim());
  if (m) return { provider: m[1] as Provider, model: m[2] };
  // Bare model name: keep the current provider unless it clearly belongs to the other one.
  const inferred: Provider = /^(gpt-|o[134])/.test(s) ? "openai" : currentProvider;
  return { provider: inferred, model: spec.trim() };
}

/**
 * Provider-agnostic facade. Internally dispatches to an Anthropic or OpenAI
 * (Chat Completions) backend. The conversation is always kept in Anthropic
 * block format; the OpenAI backend converts on the wire.
 */
export class LLM {
  private backend: LLMBackend;
  private cwd: string;
  private home?: string;
  provider: Provider;
  model: string;

  constructor(opts: LLMOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.home = opts.home;
    const s = resolveSettings(opts);
    this.provider = s.provider;
    this.model = s.model;
    this.backend = this.build(s);
  }

  private build(s: { provider: Provider; model: string; baseURL?: string; apiKey?: string }): LLMBackend {
    return s.provider === "openai"
      ? new OpenAiBackend({ apiKey: s.apiKey, model: s.model, baseURL: s.baseURL })
      : new AnthropicBackend({ apiKey: s.apiKey, model: s.model, baseURL: s.baseURL });
  }

  /**
   * Hot-switch the model (and optionally provider) for this instance and,
   * via the module-level override, for any LLM created afterwards.
   * Throws if no API key resolves for the target provider.
   */
  switchModel(spec: string): { provider: Provider; model: string } {
    const parsed = parseModelSpec(spec, this.provider);
    const s = resolveSettings({ ...parsed, cwd: this.cwd, home: this.home });
    if (!s.apiKey) {
      throw new Error(
        `No API key for provider "${s.provider}" - set ${s.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} before switching.`,
      );
    }
    this.backend = this.build(s);
    this.provider = s.provider;
    this.model = s.model;
    // Only provider+model are pinned session-wide; credentials/baseURL always
    // resolve per-provider from env/config so switching back picks up the
    // right key for each provider.
    setModelOverride({ provider: s.provider, model: s.model });
    return { provider: this.provider, model: this.model };
  }

  /** Total input context window for the current model, in tokens. */
  get contextWindow(): number {
    return lookupModel(this.model).contextWindow;
  }

  /** Model ids served by the current endpoint (may throw if unsupported). */
  listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.backend.listModels) return Promise.reject(new Error(`${this.provider} backend cannot list models`));
    return this.backend.listModels(signal);
  }

  /** Retry transient API failures (408 / 429 / 5xx / connection) with backoff. */
  private static async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const delays = [1000, 3000, 7000];
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (signal?.aborted || attempt >= delays.length) throw err;
        if (err instanceof StreamInterrupted) throw err; // owned by the resume loop above
        if ((err as { name?: string }).name === "APIUserAbortError") throw err;
        const e = err as { status?: number; headers?: { get?: (k: string) => string | null } };
        const status = e.status;
        const retriable =
          status === 408 ||
          status === 429 ||
          (typeof status === "number" && status >= 500 && status < 600) ||
          (status === undefined && LLM.isConnectionError(err));
        if (!retriable) throw err;
        // Respect server-provided Retry-After when present, else back off.
        let wait = delays[attempt];
        const ra = e.headers?.get?.("retry-after");
        if (ra) {
          const secs = Number(ra);
          // The header is either delta-seconds or an HTTP date.
          const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
          if (Number.isFinite(ms) && ms >= 0) wait = Math.min(ms, 30_000);
        }
        await LLM.abortableSleep(wait, signal);
        if (signal?.aborted) throw err;
        attempt++;
      }
    }
  }

  /** SDKs wrap fetch failures in APIConnectionError; raw fetch throws TypeError. */
  private static isConnectionError(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return (
      name === "APIConnectionError" ||
      name === "APIConnectionTimeoutError" ||
      (err instanceof TypeError && /fetch failed|network|terminat/i.test(err.message))
    );
  }

  /** Wake immediately on abort instead of finishing a multi-second backoff. */
  private static abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Resume a stream that died mid-text. Anthropic supports native assistant
   * prefill (the model literally continues the partial message); OpenAI has
   * no prefill, so we ask it to continue from the exact cut-off point.
   * Overlapping text between partial and continuation is deduplicated.
   */
  async send(
    messages: MessageParam[],
    system: string,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<AssistantTurn> {
    const MAX_RESUMES = 2;
    let partial = "";

    for (let attempt = 0; ; attempt++) {
      let resumedMessages = messages;
      if (partial) {
        if (this.provider === "anthropic") {
          // Prefill must not end with trailing whitespace (API validation).
          const prefill = partial.replace(/\s+$/, "");
          if (!prefill) throw new Error("cannot resume: partial output is whitespace only");
          resumedMessages = [...messages, { role: "assistant", content: [{ type: "text", text: prefill }] } as MessageParam];
        } else {
          resumedMessages = [
            ...messages,
            {
              role: "user",
              content: `Your previous response was cut off mid-stream. Repeat NOTHING and continue your answer from exactly this point:\n${partial}`,
            } as MessageParam,
          ];
        }
      }

      try {
        const turn = await LLM.withRetry(() => this.backend.send(resumedMessages, system, tools, signal, events), signal);
        if (!partial) return turn;
        const text = LLM.mergeText(partial, turn.text);
        return {
          ...turn,
          text,
          content: [
            { type: "text", text } as ContentBlock,
            ...turn.content.filter((b) => (b as { type?: string }).type !== "text"),
          ] as ContentBlock[],
        };
      } catch (err) {
        if (err instanceof StreamInterrupted && attempt < MAX_RESUMES && !signal?.aborted) {
          partial += err.partialText;
          continue;
        }
        if (err instanceof StreamInterrupted && partial) {
          // Out of resume attempts: salvage what we have rather than losing it.
          throw new Error(`stream interrupted; ${partial.length} chars were received before the break: ${partial}`);
        }
        throw err;
      }
    }
  }

  /** Drop the longest overlap where `rest` re-emits the tail of `partial`. */
  private static mergeText(partial: string, rest: string): string {
    const max = Math.min(partial.length, rest.length, 200);
    for (let n = max; n > 0; n--) {
      if (partial.endsWith(rest.slice(0, n))) return partial + rest.slice(n);
    }
    return partial + rest;
  }
}
