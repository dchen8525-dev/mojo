import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { MessageParam, Tool, ContentBlock } from "./types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents } from "./llm/types.js";
import { StreamInterrupted } from "./llm/types.js";
import { AnthropicBackend } from "./llm/anthropic.js";
import { OpenAiBackend } from "./llm/openai.js";
import { lookupModel } from "./llm/models.js";

export type { AssistantTurn, StreamEvents, Provider } from "./llm/types.js";
export { knownModelNames, lookupModel } from "./llm/models.js";

interface Config {
  provider?: Provider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

function readConfigFile(): Config {
  try {
    const raw = readFileSync(path.join(os.homedir(), ".node-agent", "config.json"), "utf8");
    // Strip a leading UTF-8 BOM (Windows editors/tools often add one) before parsing.
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as Config;
  } catch {
    return {};
  }
}

/**
 * Resolve provider/model/credentials from (in priority order):
 * explicit opts > runtime override (set via /model) > environment >
 * ~/.node-agent/config.json > defaults.
 */
export function resolveSettings(opts: Config = {}) {
  const file = readConfigFile();
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

  return { provider, model, baseURL, apiKey };
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
  provider: Provider;
  model: string;

  constructor(opts: Config = {}) {
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
    const s = resolveSettings(parsed);
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

  /** Retry transient API failures (429 / 5xx / network) with backoff. */
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
          status === undefined || status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
        if (!retriable) throw err;
        // Respect server-provided Retry-After when present (seconds), else backoff.
        let wait = delays[attempt];
        const ra = e.headers?.get?.("retry-after");
        if (ra) {
          const secs = Number(ra);
          if (Number.isFinite(secs) && secs >= 0) wait = Math.min(secs * 1000, 30_000);
        }
        await new Promise((res) => setTimeout(res, wait));
        attempt++;
      }
    }
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
