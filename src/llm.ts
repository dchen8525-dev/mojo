import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { MessageParam, Tool, ContentBlock } from "./types.js";
import type { AssistantTurn, LLMBackend, Provider, RetryReason, StreamEvents } from "./llm/types.js";
import { StreamInterrupted } from "./llm/types.js";
import { AnthropicBackend } from "./llm/anthropic.js";
import { OpenAiBackend } from "./llm/openai.js";
import { lookupModel } from "./llm/models.js";
import { fetchModelMeta, getModelMeta, setModelMeta, type ModelMeta } from "./modelMeta.js";

export type { AssistantTurn, StreamEvents, Provider } from "./llm/types.js";
export { knownModelNames, lookupModel } from "./llm/models.js";

export interface Config {
  provider?: Provider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** Override the model's context window (tokens) instead of guessing it. */
  contextWindow?: number;
  /** UI theme: "dark" | "light" | "auto" (see src/ui/theme.ts). */
  theme?: string;
}

export interface LLMOptions extends Config {
  /** Project root used to locate .node-agent/config.json (default: process.cwd()). */
  cwd?: string;
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

/**
 * Resolve provider/model/credentials from (in priority order):
 * explicit opts > runtime override (set via /model) > environment >
 * <cwd>/.node-agent/config.json > ~/.node-agent/config.json > defaults.
 */
export function resolveSettings(opts: LLMOptions = {}) {
  const file = loadConfigFiles(opts.cwd);
  const env = process.env;
  const ov = activeOverride ?? {};

  let provider =
    opts.provider ??
    ov.provider ??
    (env.AGENT_PROVIDER as Provider | undefined) ??
    file.provider ??
    // infer: OPENAI_* present and no ANTHROPIC_* -> openai, else anthropic
    (env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY ? "openai" : "anthropic");

  if (provider !== "anthropic" && provider !== "openai") provider = "anthropic";

  const model = opts.model ?? ov.model ?? env.AGENT_MODEL ?? file.model ?? (provider === "openai" ? "gpt-4o" : "claude-sonnet-4-5");
  const baseURL =
    opts.baseURL ?? ov.baseURL ?? env.AGENT_BASE_URL ?? (provider === "openai" ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL) ?? file.baseURL;
  const apiKey =
    opts.apiKey ?? ov.apiKey ?? (provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) ?? file.apiKey;
  const contextWindow = opts.contextWindow ?? ov.contextWindow ?? file.contextWindow;

  return { provider, model, baseURL, apiKey, contextWindow };
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
  /** Credentials/baseURL for the *current* model, kept for metadata lookups. */
  private baseURL?: string;
  private apiKey?: string;
  /** Explicit window from config — wins over endpoint metadata and the table. */
  private ctxWindow?: number;
  provider!: Provider;
  model!: string;

  constructor(opts: LLMOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    const s = resolveSettings(opts);
    this.adopt(s);
    this.backend = this.build(s);
  }

  /** Point this instance at a resolved settings object. */
  private adopt(s: { provider: Provider; model: string; baseURL?: string; apiKey?: string; contextWindow?: number }): void {
    this.provider = s.provider;
    this.model = s.model;
    this.baseURL = s.baseURL;
    this.apiKey = s.apiKey;
    this.ctxWindow = s.contextWindow;
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
    const s = resolveSettings({ ...parsed, cwd: this.cwd });
    if (!s.apiKey) {
      throw new Error(
        `No API key for provider "${s.provider}" - set ${s.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} before switching.`,
      );
    }
    this.backend = this.build(s);
    this.adopt(s);
    // Only provider+model are pinned session-wide; credentials/baseURL always
    // resolve per-provider from env/config so switching back picks up the
    // right key for each provider.
    setModelOverride({ provider: s.provider, model: s.model });
    return { provider: this.provider, model: this.model };
  }

  /**
   * Rebind this instance to an explicit config (the GUI's LLM profile picker).
   * Unlike `switchModel` this pins the *whole* config — baseURL and apiKey
   * included — into the module-level override, so the rest of this process
   * (subagents included) uses exactly that profile rather than whatever env or
   * a project-level config.json would otherwise supply.
   * Throws before changing anything if the config resolves to no API key.
   */
  applyConfig(cfg: Config): { provider: Provider; model: string } {
    const s = resolveSettings({ ...cfg, cwd: this.cwd });
    if (!s.apiKey) {
      throw new Error(`No API key for provider "${s.provider}" - fill in an API key for this configuration.`);
    }
    this.backend = this.build(s);
    this.adopt(s);
    setModelOverride(cfg);
    return { provider: this.provider, model: this.model };
  }

  /**
   * Context window for the current model, in tokens:
   *   explicit config (`contextWindow`) > endpoint /models metadata > local table.
   */
  get contextWindow(): number {
    if (this.ctxWindow) return this.ctxWindow;
    const meta = getModelMeta(this.provider, this.baseURL, this.model);
    return meta?.contextWindow ?? lookupModel(this.model).contextWindow;
  }

  /**
   * Ask the endpoint's model list for a context window. Cheap to call: a
   * per-(provider, endpoint, model) cache short-circuits repeat lookups.
   * Never throws — the static table stays the fallback.
   */
  async refreshModelMeta(force = false): Promise<ModelMeta | null> {
    if (!force) {
      const hit = getModelMeta(this.provider, this.baseURL, this.model);
      if (hit) return hit;
    }
    const meta = await fetchModelMeta({
      provider: this.provider,
      model: this.model,
      baseURL: this.baseURL,
      apiKey: this.apiKey,
    });
    if (meta) setModelMeta(this.provider, this.baseURL, this.model, meta);
    return meta;
  }

  /** Model ids served by the current endpoint (may throw if unsupported). */
  listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.backend.listModels) return Promise.reject(new Error(`${this.provider} backend cannot list models`));
    return this.backend.listModels(signal);
  }

  /** Retry transient API failures (408 / 429 / 5xx / connection) with backoff. */
  private static async withRetry<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<T> {
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
        const reason: RetryReason =
          status === 429 ? "rate-limit" : status === 408 ? "timeout" : status !== undefined ? "server" : "connection";
        events?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: delays.length,
          delayMs: wait,
          ...(status !== undefined ? { status } : {}),
          reason,
        });
        await LLM.abortableSleep(wait, signal);
        if (signal?.aborted) throw err;
        attempt++;
      }
    }
  }

  /** SDKs wrap fetch failures in APIConnectionError; raw fetch throws TypeError. */
  private static isConnectionError(err: unknown): boolean {
    // SDK 0.135 stopped setting `name` on APIConnectionError, so fall back to
    // the constructor name before giving up on classifying it.
    const e = err as { name?: string; constructor?: { name?: string } } | null;
    const ctorName = e?.constructor?.name;
    if (ctorName === "APIConnectionError" || ctorName === "APIConnectionTimeoutError") return true;
    const name = e?.name;
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
        // On a resumed attempt the model may re-emit text we already showed
        // (OpenAI has no prefill). Hold its deltas back and emit only the new
        // suffix once the overlap can be computed, so nothing is duplicated.
        const attemptEvents = partial && events ? { ...events, onTextDelta: () => {} } : events;
        const turn = await LLM.withRetry(
          () => this.backend.send(resumedMessages, system, tools, signal, attemptEvents),
          signal,
          events,
        );
        if (!partial) return turn;
        const text = LLM.mergeText(partial, turn.text);
        const suffix = text.slice(partial.length);
        if (suffix) events?.onTextDelta?.(suffix);
        return {
          ...turn,
          text,
          content: [
            { type: "text", text } as ContentBlock,
            ...turn.content.filter((b) => (b as { type?: string }).type !== "text"),
          ] as ContentBlock[],
        };
      } catch (err) {
        // Backends surface aborts differently (APIUserAbortError, or the last
        // transient error when cancellation lands during a backoff). Callers
        // only special-case the "aborted" message, so normalize it here.
        if (signal?.aborted) throw new Error("aborted");
        if (err instanceof StreamInterrupted && attempt < MAX_RESUMES) {
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
