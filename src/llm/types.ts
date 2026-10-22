import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";

export interface AssistantTurn {
  text: string;
  toolUses: ToolUseBlock[];
  /** Full blocks in Anthropic format (OpenAI backend converts back). */
  content: ContentBlock[];
  /** Fresh (non-cached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (0 when the provider hides it). */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache (Anthropic only). */
  cacheWriteTokens: number;
  stopReason: string | null;
}

/** Why a request is being retried; the UI maps this to a short label. */
export type RetryReason = "rate-limit" | "timeout" | "server" | "connection";

export interface RetryInfo {
  /** 1-based number of the retry that is about to start. */
  attempt: number;
  maxAttempts: number;
  /** How long the request will wait before retrying. */
  delayMs: number;
  /** HTTP status when the failure came from a response. */
  status?: number;
  reason: RetryReason;
}

export interface StreamEvents {
  onTextDelta?: (delta: string) => void;
  /** Reasoning/thinking tokens streamed before (or between) visible output. */
  onThinkingDelta?: (delta: string) => void;
  onToolUseStart?: (name: string, id: string) => void;
  /** A transient failure is about to be retried after `delayMs`. */
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Thrown when a stream dies after partial content was received. Carries the
 * accumulated text so the caller can resume from the interruption point
 * instead of re-running the whole request.
 */
export class StreamInterrupted extends Error {
  partialText: string;
  constructor(partialText: string, cause?: unknown) {
    super(`stream interrupted after ${partialText.length} chars`);
    this.name = "StreamInterrupted";
    this.partialText = partialText;
    this.cause = cause;
  }
}

/** Thrown when the provider stops sending stream events for too long. */
export class StreamIdleError extends Error {
  constructor(idleMs: number) {
    super(`stream idle for ${Math.round(idleMs / 1000)}s`);
    this.name = "StreamIdleError";
  }
}

/**
 * User abort mid-stream. The message stays "aborted" (existing callers match
 * on it); `partialText` carries what was already streamed so the agent can
 * salvage it into the history instead of losing the visible work.
 */
export class CancelledStreamError extends Error {
  readonly partialText: string;
  constructor(partialText: string) {
    super("aborted");
    this.name = "CancelledStreamError";
    this.partialText = partialText;
  }
}

export type Provider = "anthropic" | "openai";

/**
 * System prompt split for prompt caching. `stable` rarely changes within a
 * session (instructions, memory, skills) and is the cacheable prefix;
 * `volatile` is per-turn status (date, git state) that must not invalidate it.
 * A plain string means everything is stable.
 */
export interface SystemPrompt {
  stable: string;
  volatile?: string;
}

export function normalizeSystem(system: string | SystemPrompt): Required<SystemPrompt> {
  return typeof system === "string" ? { stable: system, volatile: "" } : { stable: system.stable, volatile: system.volatile ?? "" };
}

export interface LLMBackend {
  readonly provider: Provider;
  model: string;
  send(
    messages: MessageParam[],
    system: string | SystemPrompt,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
    /** Abort the request when no stream event arrives for this long (0 = off). */
    idleMs?: number,
  ): Promise<AssistantTurn>;
  /** Model ids available on this endpoint (best-effort; may throw). */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
