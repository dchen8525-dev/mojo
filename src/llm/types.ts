import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";

export interface AssistantTurn {
  text: string;
  toolUses: ToolUseBlock[];
  /** Full blocks in Anthropic format (OpenAI backend converts back). */
  content: ContentBlock[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface StreamEvents {
  onTextDelta?: (delta: string) => void;
  onToolUseStart?: (name: string, id: string) => void;
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

export type Provider = "anthropic" | "openai";

export interface LLMBackend {
  readonly provider: Provider;
  model: string;
  send(
    messages: MessageParam[],
    system: string,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<AssistantTurn>;
  /** Model ids available on this endpoint (best-effort; may throw). */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
