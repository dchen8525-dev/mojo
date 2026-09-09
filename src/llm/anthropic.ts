import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";
import { toAnthropicTool } from "../types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents } from "./types.js";
import { StreamInterrupted } from "./types.js";
import { lookupModel } from "./models.js";

export class AnthropicBackend implements LLMBackend {
  readonly provider: Provider = "anthropic";
  private client: Anthropic;
  model: string;

  constructor(opts: { apiKey?: string; model?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: opts.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      // Retries (incl. stream resume) are owned by the LLM facade; disable
      // the SDK's own layer so a failed request is not silently re-sent.
      maxRetries: 0,
    });
    this.model = opts.model ?? "claude-sonnet-4-5";
  }

  async send(
    messages: MessageParam[],
    system: string,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<AssistantTurn> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: lookupModel(this.model).maxOutput,
        system,
        messages,
        tools: tools.map(toAnthropicTool),
      },
      { signal },
    );

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let toolStarted = false;

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolStarted = true;
          events?.onToolUseStart?.(event.content_block.name, event.content_block.id);
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          events?.onTextDelta?.(event.delta.text);
        }
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens ?? 0;
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
          cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
        }
        if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
      }
    } catch (err) {
      // A dead connection mid-text can be resumed from the partial output;
      // a break during tool-call streaming cannot (incomplete args), so only
      // surface StreamInterrupted for the resumable case.
      if (!toolStarted && text && !signal?.aborted && !(err instanceof Error && err.name === "APIUserAbortError")) {
        throw new StreamInterrupted(text, err);
      }
      throw err;
    }

    const final = await stream.finalMessage();
    const toolUses: ToolUseBlock[] = [];
    for (const block of final.content) {
      if (block.type === "tool_use") toolUses.push(block);
    }

    // The final message carries authoritative usage (including cache fields);
    // fall back to the streamed values if it is somehow absent.
    const u = final.usage;
    return {
      text,
      toolUses,
      content: final.content,
      inputTokens: u?.input_tokens ?? inputTokens,
      outputTokens: u?.output_tokens ?? outputTokens,
      cacheReadTokens: u?.cache_read_input_tokens ?? cacheReadTokens,
      cacheWriteTokens: u?.cache_creation_input_tokens ?? cacheWriteTokens,
      stopReason: final.stop_reason,
    };
  }

  /** Best-effort: query the endpoint's /v1/models (works on most gateways). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.get("/v1/models", { signal });
    const data = (page as { data?: unknown[] }).data ?? [];
    return data
      .map((m) => (typeof m === "string" ? m : (m as { id?: string }).id))
      .filter((id): id is string => !!id);
  }
}
