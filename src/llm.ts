import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { MessageParam, Tool, ContentBlock, ToolUseBlock } from "./types.js";
import type { AssistantTurn, LLMBackend, Provider, RetryReason, SendOptions, StreamEvents, SystemPrompt } from "./llm/types.js";
import { StreamInterrupted, CancelledStreamError, StreamRecoveryExhausted } from "./llm/types.js";
import { AnthropicBackend } from "./llm/anthropic.js";
import { OpenAiBackend } from "./llm/openai.js";
import { lookupModel } from "./llm/models.js";
import { fetchModelMeta, getModelMeta, setModelMeta, type ModelMeta } from "./modelMeta.js";
import { recordJournalTurn } from "./journal.js";

export type { AssistantTurn, StreamEvents, Provider, SendOptions } from "./llm/types.js";
export { CancelledStreamError, StreamRecoveryExhausted } from "./llm/types.js";
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
 * True when the provider rejected a request because it exceeded the model's
 * context window. Wording differs by provider ("prompt is too long",
 * "context_length_exceeded", "maximum context length is N tokens", Gemini's
 * "input token count … exceeds"), so match the common phrases. Only
 * 400/413/422 qualify: other statuses belong to the transient retry path.
 */
export function isContextOverflowError(err: unknown): boolean {
  const e = err as
    | { status?: number; message?: string; error?: { message?: string; code?: string; type?: string } }
    | null;
  const status = e?.status;
  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) return false;
  const nested = e?.error;
  const text = `${e?.message ?? ""} ${nested?.message ?? ""} ${nested?.code ?? ""} ${nested?.type ?? ""}`.toLowerCase();
  return (
    /context[ _-]?length[ _-]?exceeded/.test(text) ||
    /prompt is too long/.test(text) ||
    /maximum context length/.test(text) ||
    /context window (?:is )?(?:exceeded|too small)/.test(text) ||
    /(?:exceed|longer than)[^.]*context (?:length|window)/.test(text) ||
    /(?:input|prompt)[^.]*too (?:long|large)/.test(text) ||
    /request too large/.test(text) ||
    /too many tokens/.test(text) ||
    /input token count[^.]*exceed/.test(text) ||
    /reduce the length of (?:the )?(?:messages|prompt|input)/.test(text) ||
    /exceeds? the (?:maximum|model'?s?)[^.]*tokens?/.test(text) ||
    /token (?:limit|budget) exceeded/.test(text) ||
    /conversation (?:is )?too long/.test(text)
  );
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
  /** Set by the owning Agent so journal entries attribute to a session. */
  journalSession = "";

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
    fn: (attempt: number) => Promise<T>,
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<T> {
    const cfg = LLM.retryConfig();
    let attempt = 0;
    for (;;) {
      try {
        return await fn(attempt);
      } catch (err) {
        if (signal?.aborted || attempt >= cfg.maxAttempts) throw err;
        if (err instanceof StreamInterrupted) throw err; // owned by the resume loop above
        if ((err as { name?: string }).name === "APIUserAbortError") throw err;
        const e = err as { status?: number; headers?: { get?: (k: string) => string | null } };
        const status = e.status;
        if (!LLM.isTransientError(err)) throw err;
        // Respect server-provided Retry-After when present, else back off
        // exponentially (1s -> 2s -> 4s ...) with a little jitter so clients
        // that fail together do not retry in lockstep.
        let wait = Math.round(
          Math.min(cfg.baseMs * 2 ** attempt, cfg.maxDelayMs) * (1 + (Math.random() * 2 - 1) * cfg.jitter),
        );
        const ra = e.headers?.get?.("retry-after");
        if (ra) {
          const secs = Number(ra);
          // The header is either delta-seconds or an HTTP date.
          const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
          if (Number.isFinite(ms) && ms >= 0) wait = Math.min(ms, 30_000);
        }
        const reason: RetryReason =
          status === 429
            ? "rate-limit"
            : status === 408 || (err as { name?: string }).name === "StreamIdleError"
              ? "timeout"
              : status !== undefined
                ? "server"
                : "connection";
        events?.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: cfg.maxAttempts,
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

  /**
   * Backoff knobs, re-read per retry so tests and users can tune via env:
   * AGENT_RETRY_BASE_MS (1s), AGENT_RETRY_MAX_ATTEMPTS (3),
   * AGENT_RETRY_MAX_DELAY_MS (60s), AGENT_RETRY_JITTER (0.25, 0 disables).
   */
  private static retryConfig() {
    const num = (raw: string | undefined, fallback: number) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const env = process.env;
    return {
      baseMs: num(env.AGENT_RETRY_BASE_MS, 1000),
      maxAttempts: num(env.AGENT_RETRY_MAX_ATTEMPTS, 3),
      maxDelayMs: num(env.AGENT_RETRY_MAX_DELAY_MS, 60_000),
      jitter: num(env.AGENT_RETRY_JITTER, 0.25),
    };
  }

  /**
   * How many times one logical request may recover from a broken stream
   * (AGENT_STREAM_RECOVERY_ATTEMPTS, default 4; 0 disables recovery).
   */
  private static streamRecoveryAttempts(): number {
    const n = Number(process.env.AGENT_STREAM_RECOVERY_ATTEMPTS);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
  }

  /** Same exponential backoff as retries, indexed by recovery number (0-based). */
  private static recoveryDelayMs(index: number): number {
    const cfg = LLM.retryConfig();
    return Math.round(
      Math.min(cfg.baseMs * 2 ** index, cfg.maxDelayMs) * (1 + (Math.random() * 2 - 1) * cfg.jitter),
    );
  }

  /** Label a stream break for the UI; `stream` when the cause is unknown. */
  private static recoveryReason(cause: unknown): RetryReason | "stream" {
    const e = cause as { status?: number; name?: string } | undefined;
    if (!e) return "stream";
    if (e.status === 429) return "rate-limit";
    if (e.status === 408 || e.name === "StreamIdleError") return "timeout";
    if (typeof e.status === "number") return e.status >= 500 && e.status < 600 ? "server" : "stream";
    return "connection";
  }

  /**
   * A broken stream is worth recovering only for transient causes; a 400 or a
   * malformed request would fail the same way on every retry. A missing cause
   * counts as transient (tests and gateways that drop the socket outright).
   */
  private static isRecoverableStreamBreak(err: StreamInterrupted): boolean {
    return err.cause === undefined || LLM.isTransientError(err.cause);
  }

  /** Transient failures that retry/stream-recovery may re-attempt. */
  private static isTransientError(err: unknown): boolean {
    const e = err as { status?: number } | null;
    const status = e?.status;
    if (status === 408 || status === 429) return true;
    if (typeof status === "number") return status >= 500 && status < 600;
    return LLM.isConnectionError(err);
  }

  /** Abort a stream that stops sending events (AGENT_STREAM_IDLE_MS, 0 = off). */
  private static streamIdleMs(): number {
    const n = Number(process.env.AGENT_STREAM_IDLE_MS);
    return Number.isFinite(n) && n >= 0 ? n : 60_000;
  }

  /** SDKs wrap fetch failures in APIConnectionError; raw fetch throws TypeError. */
  private static isConnectionError(err: unknown): boolean {
    // SDK 0.135 stopped setting `name` on APIConnectionError, so fall back to
    // the constructor name before giving up on classifying it.
    const e = err as { name?: string; constructor?: { name?: string }; code?: string; message?: string } | null;
    const ctorName = e?.constructor?.name;
    if (ctorName === "APIConnectionError" || ctorName === "APIConnectionTimeoutError") return true;
    const name = e?.name;
    if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "StreamIdleError") return true;
    const code = e?.code;
    if (
      code &&
      ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"].includes(
        code,
      )
    ) {
      return true;
    }
    // Undici surfaces a killed SSE body as a plain Error("terminated") or
    // Error("premature close"); neither carries a status or a code.
    return /fetch failed|network|terminated|premature close|socket hang up/i.test(e?.message ?? "");
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
  /**
   * Journaling wrapper around the resume loop: one entry per logical request,
   * success or failure, only when AGENT_JOURNAL is on.
   */
  async send(
    messages: MessageParam[],
    system: string | SystemPrompt,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
    opts?: SendOptions,
  ): Promise<AssistantTurn> {
    const start = Date.now();
    const base = {
      ts: new Date().toISOString(),
      sessionId: this.journalSession,
      provider: this.provider,
      model: this.model,
      request: {
        messageCount: messages.length,
        systemChars: typeof system === "string" ? system.length : system.stable.length + (system.volatile?.length ?? 0),
        toolNames: tools.map((t) => t.name),
        messages,
      },
    };
    try {
      const turn = await this.sendResumable(messages, system, tools, signal, events, opts);
      void recordJournalTurn({
        ...base,
        durationMs: Date.now() - start,
        response: {
          text: turn.text,
          toolUses: turn.toolUses.map((t) => ({ name: t.name, input: t.input })),
          stopReason: turn.stopReason,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheWriteTokens: turn.cacheWriteTokens,
        },
      });
      return turn;
    } catch (err) {
      void recordJournalTurn({
        ...base,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Recovery state machine for one logical request. A stream that dies mid-text
   * is resumed from the cut-off point (provider prefill / continuation). A
   * stream that dies while tool arguments are still arriving cannot be resumed,
   * so the partial response is discarded and the request is re-run — the host
   * is told how many visible characters to drop via `onStreamRecovery`.
   * Recovery is transient-only, backed off, and budgeted; when it runs out the
   * received text is thrown as `StreamRecoveryExhausted` for the agent to
   * salvage into history instead of losing what the user already saw.
   */
  private async sendResumable(
    messages: MessageParam[],
    system: string | SystemPrompt,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
    opts?: SendOptions,
  ): Promise<AssistantTurn> {
    const maxRecoveries = LLM.streamRecoveryAttempts();
    // Text accumulated across resumes; also the provider-safe prefill anchor.
    let partial = "";
    // Characters the host has actually rendered for this response. Aborts and
    // restarts use it to salvage or discard exactly what was on screen.
    let visible = "";
    let recoveries = 0;

    for (;;) {
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

      // Deltas seen on a resumed attempt. The model may re-emit text we
      // already showed (OpenAI has no prefill), so these are held back and
      // only the new suffix is emitted once the overlap can be computed.
      let resumedDelta = "";
      try {
        const attemptEvents =
          partial && events
            ? { ...events, onTextDelta: (d: string) => { resumedDelta += d; } }
            : events && partial === ""
              ? { ...events, onTextDelta: (d: string) => { visible += d; events.onTextDelta?.(d); } }
              : events;
        const turn = await LLM.withRetry(
          (retryAttempt) =>
            // A stalled stream gets an increasingly generous idle budget:
            // a slow provider on a slow day should not be killed twice.
            this.backend.send(
              resumedMessages,
              system,
              tools,
              signal,
              attemptEvents,
              LLM.streamIdleMs() + 30_000 * retryAttempt,
              opts,
            ),
          signal,
          events,
        );
        LLM.ensureUniqueToolIds(turn);
        if (!partial) return turn;
        const text = LLM.mergeText(partial, turn.text);
        const suffix = text.slice(visible.length);
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
        // only special-case the "aborted" message, so keep it and attach the
        // streamed-so-far text for the agent to salvage.
        if (signal?.aborted) {
          throw new CancelledStreamError(
            partial ? partial + (this.provider === "anthropic" ? resumedDelta : "") : visible,
          );
        }
        if (!(err instanceof StreamInterrupted)) throw err;

        const combined = partial ? LLM.mergeText(partial, err.partialText) : err.partialText;
        const mode = err.toolStarted ? "restart" : "resume";
        if (mode === "resume") {
          // Sync the host with the held-back continuation: on resumed attempts
          // deltas are withheld until the overlap is known, and without this
          // the text from an interrupted attempt would never reach the UI.
          const unseen = combined.slice(visible.length);
          visible = combined;
          if (unseen) events?.onTextDelta?.(unseen);
        }

        const recoverable = recoveries < maxRecoveries && LLM.isRecoverableStreamBreak(err);
        if (!recoverable) {
          // Everything visible stays visible; hand the text to the agent for
          // history salvage instead of dropping it with the error.
          throw new StreamRecoveryExhausted(mode === "restart" ? visible : combined, recoveries, err.cause ?? err);
        }

        recoveries++;
        const delayMs = LLM.recoveryDelayMs(recoveries - 1);
        events?.onStreamRecovery?.({
          attempt: recoveries,
          maxAttempts: maxRecoveries,
          mode,
          discardedChars: mode === "restart" ? visible.length : 0,
          delayMs,
          reason: LLM.recoveryReason(err.cause),
        });
        if (mode === "restart") {
          // The incomplete tool call is unusable; re-run from the original
          // messages and make the host drop the abandoned response.
          partial = "";
          visible = "";
        } else {
          partial = combined;
        }
        await LLM.abortableSleep(delayMs, signal);
        if (signal?.aborted) {
          throw new CancelledStreamError(mode === "restart" ? "" : partial);
        }
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

  /**
   * Tool results are matched to calls by id. Some OpenAI-compatible gateways
   * reuse one id for several calls (or omit it); duplicate ids would make the
   * next request ambiguous, so rewrite them in place.
   */
  private static ensureUniqueToolIds(turn: { toolUses: ToolUseBlock[] }): void {
    const seen = new Set<string>();
    for (let i = 0; i < turn.toolUses.length; i++) {
      const tu = turn.toolUses[i];
      const base = tu.id || `tool_${Date.now().toString(36)}_${i}`;
      let id = base;
      for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
      tu.id = id;
      seen.add(id);
    }
  }
}
