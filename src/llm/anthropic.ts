import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";
import { toAnthropicTool } from "../types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents, SystemPrompt } from "./types.js";
import { StreamInterrupted, normalizeSystem } from "./types.js";
import { lookupModel } from "./models.js";
import { withIdleTimeout } from "./idle.js";
import { ToolBlockAccumulator } from "./toolStream.js";

const CACHE_CONTROL = { type: "ephemeral" as const };

/** Mark the last block so the whole prefix up to it is cached. */
function cacheLastBlock<T extends { cache_control?: unknown }>(blocks: T[]): T[] {
  if (!blocks.length) return blocks;
  return [...blocks.slice(0, -1), { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL }];
}

function cachedTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  return cacheLastBlock(tools.map(toAnthropicTool));
}

function cachedMessages(messages: MessageParam[]): MessageParam[] {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const content = (
    typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content
  ) as Array<{ cache_control?: unknown }>;
  const marked = cacheLastBlock(content);
  return [
    ...messages.slice(0, -1),
    { ...last, content: marked as MessageParam["content"] },
  ] as MessageParam[];
}

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
    system: string | SystemPrompt,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
    idleMs = 0,
  ): Promise<AssistantTurn> {
    // Own the request's lifetime so the idle watchdog can kill it; the outer
    // signal (user abort) must still reach it.
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener("abort", onOuterAbort, { once: true });

    // The stable part carries the cache breakpoint; the volatile tail (date,
    // git status) sits after it so per-turn changes never invalidate the
    // cached prefix.
    const { stable, volatile } = normalizeSystem(system);
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];
    if (stable) systemBlocks.push({ type: "text", text: stable, cache_control: CACHE_CONTROL });
    if (volatile) systemBlocks.push({ type: "text", text: volatile });

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: lookupModel(this.model).maxOutput,
        system: systemBlocks,
        messages: cachedMessages(messages),
        tools: cachedTools(tools),
        // Opt-in extended thinking (AGENT_THINKING=1). Off by default so
        // gateways without thinking support keep working; when on, the UI
        // streams the model's reasoning via onThinkingDelta.
        ...(/^(1|true)$/i.test(process.env.AGENT_THINKING ?? "")
          ? { thinking: { type: "enabled" as const, budget_tokens: 4096 } }
          : {}),
      },
      { signal: ac.signal },
    );

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let toolStarted = false;
    // Announces each tool call at content_block_stop, before the stream ends.
    const readyTools = new ToolBlockAccumulator(events);

    try {
      for await (const event of withIdleTimeout(stream, idleMs, () => ac.abort())) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolStarted = true;
          readyTools.start(event.index, event.content_block);
          events?.onToolUseStart?.(event.content_block.name, event.content_block.id);
        }
        if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
          readyTools.append(event.index, event.delta.partial_json);
        }
        if (event.type === "content_block_stop") {
          readyTools.stop(event.index);
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          events?.onTextDelta?.(event.delta.text);
        }
        if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
          events?.onThinkingDelta?.((event.delta as { thinking?: string }).thinking ?? "");
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
      // Surface mid-stream breaks to the facade, which decides whether to
      // resume from the text or restart because a tool call was left with
      // incomplete arguments. User aborts keep their own path.
      if (text && !signal?.aborted && !(err instanceof Error && err.name === "APIUserAbortError")) {
        throw new StreamInterrupted(text, err, { toolStarted });
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onOuterAbort);
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
