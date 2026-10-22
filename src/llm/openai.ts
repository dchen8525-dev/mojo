import OpenAI from "openai";
import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents, SystemPrompt } from "./types.js";
import { StreamInterrupted, normalizeSystem } from "./types.js";
import { lookupModel } from "./models.js";
import { withIdleTimeout } from "./idle.js";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Convert Anthropic-format history into OpenAI chat messages. */
export function toOpenAiMessages(messages: MessageParam[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }
    const blocks = msg.content as Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      source?: { type?: string; media_type?: string; data?: string; url?: string };
    }>;
    if (msg.role === "assistant") {
      let text = "";
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
      for (const b of blocks) {
        if (b.type === "text") text += b.text ?? "";
        else if (b.type === "tool_use")
          toolCalls.push({
            id: b.id ?? "",
            type: "function",
            function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
          });
        // thinking blocks: not representable in OpenAI chat format, drop
      }
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // user message: tool_result blocks become role:"tool" messages, while
      // text and images stay user content (images must survive a provider
      // switch, or the model silently answers about a picture it never saw).
      const parts: ChatContentPart[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const content =
            typeof b.content === "string"
              ? b.content
              : ((b.content as Array<{ type: string; text?: string }>) ?? [])
                  .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
                  .join("\n");
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id ?? "",
            content: b.is_error ? `Error: ${content}` : content,
          });
        } else if (b.type === "text" && b.text) {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          const src = b.source;
          if (src?.type === "base64" && src.data) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` },
            });
          } else if (src?.type === "url" && src.url) {
            parts.push({ type: "image_url", image_url: { url: src.url } });
          }
        }
      }
      if (parts.length === 1 && parts[0].type === "text") out.push({ role: "user", content: parts[0].text });
      else if (parts.length) out.push({ role: "user", content: parts });
    }
  }
  return out;
}

function toOpenAiTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(
    (t) =>
      ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }) as OpenAI.Chat.Completions.ChatCompletionTool,
  );
}

interface PartialToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Fold one streamed tool-call delta into the accumulator. Gateways differ:
 * some send no index, some resend the full function name in every chunk, and
 * some omit the id after the first chunk. Matching by index (then id, then
 * "continuation of the last call") keeps all three shapes working.
 */
export function mergeToolCallDelta(calls: PartialToolCall[], tc: ToolCallDelta): void {
  let cur: PartialToolCall | undefined;
  if (typeof tc.index === "number") cur = calls.find((c) => c.index === tc.index);
  else if (tc.id) cur = calls.find((c) => c.id === tc.id);
  else cur = calls[calls.length - 1];
  if (!cur) {
    cur = { index: typeof tc.index === "number" ? tc.index : calls.length, id: "", name: "", args: "" };
    calls.push(cur);
  }
  if (tc.id && !cur.id) cur.id = tc.id;
  const piece = tc.function?.name;
  // A repeated full name is a resend, not a longer name.
  if (piece && piece !== cur.name) cur.name += piece;
  if (tc.function?.arguments) cur.args += tc.function.arguments;
}

/**
 * Turn accumulated deltas into tool_use blocks. A response cut off by the
 * token limit can end mid-arguments; executing such a call would run a
 * half-written command, so the whole batch is dropped and the agent asks the
 * model to continue (clean history, no stray calls).
 */
export function finalizeToolCalls(
  calls: PartialToolCall[],
  finishReason: string | null,
  events?: StreamEvents,
): { toolUses: ToolUseBlock[]; blocks: ContentBlock[] } {
  if (finishReason === "length") return { toolUses: [], blocks: [] };
  const toolUses: ToolUseBlock[] = [];
  const blocks: ContentBlock[] = [];
  for (const [i, tc] of [...calls].sort((a, b) => a.index - b.index).entries()) {
    if (!tc.name) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = tc.args ? JSON.parse(tc.args) : {};
      // null / arrays / scalars cannot be tool input; keep {} so the tool
      // reports a missing-parameter validation error back to the model.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      /* malformed args: keep {} so the model gets a validation error back */
    }
    const id = tc.id || `tc_${Date.now()}_${i}`;
    events?.onToolUseStart?.(tc.name, id);
    const block: ToolUseBlock = { type: "tool_use", id, name: tc.name, input, caller: { type: "direct" } };
    toolUses.push(block);
    blocks.push(block);
  }
  return { toolUses, blocks };
}

export class OpenAiBackend implements LLMBackend {
  readonly provider: Provider = "openai";
  private client: OpenAI;
  model: string;

  constructor(opts: { apiKey?: string; model?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL,
      // Retries (incl. stream resume) are owned by the LLM facade.
      maxRetries: 0,
    });
    this.model = opts.model ?? "gpt-4o";
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

    const { stable, volatile } = normalizeSystem(system);
    const systemText = volatile ? `${stable}\n\n${volatile}` : stable;
    const chatMessages: ChatMsg[] = [{ role: "system", content: systemText }, ...toOpenAiMessages(messages)];
    const info = lookupModel(this.model);

    const params: Record<string, unknown> = {
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: chatMessages,
      tools: tools.length ? toOpenAiTools(tools) : undefined,
    };
    // Reasoning models (o-series) reject max_tokens/temperature; they want
    // max_completion_tokens and no sampling params.
    if (info.reasoning) params.max_completion_tokens = info.maxOutput;
    else params.max_tokens = info.maxOutput;

    const stream = await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: ac.signal },
    );

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let finishReason: string | null = null;
    const toolCalls: PartialToolCall[] = [];

    try {
      for await (const chunk of withIdleTimeout(stream, idleMs, () => ac.abort())) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          events?.onTextDelta?.(delta.content);
        }
        // Reasoning models (deepseek-r1, glm-thinking, o-series) stream their
        // chain of thought on a separate field; forward it so the UI can show it.
        const reasoning = (delta as { reasoning_content?: string } | undefined)?.reasoning_content;
        if (reasoning) events?.onThinkingDelta?.(reasoning);
        for (const tc of delta?.tool_calls ?? []) mergeToolCallDelta(toolCalls, tc);
        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          // OpenAI reports cached prompt tokens as a subset of prompt_tokens;
          // split them out so cost math matches the Anthropic semantics.
          const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
            .prompt_tokens_details?.cached_tokens;
          if (typeof cached === "number" && cached > 0) {
            cacheReadTokens = cached;
            inputTokens = Math.max(0, inputTokens - cached);
          }
        }
      }
    } catch (err) {
      // Same resumability rule as the Anthropic backend: only a mid-text
      // break (no tool-call streaming started) can be picked up from the
      // partial output; aborts are the user's intent and propagate as-is.
      if (text && !toolCalls.length && !signal?.aborted && !(err instanceof Error && err.name === "APIUserAbortError")) {
        throw new StreamInterrupted(text, err);
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onOuterAbort);
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text } as ContentBlock);
    const { toolUses, blocks } = finalizeToolCalls(toolCalls, finishReason, events);
    content.push(...blocks);

    return {
      text,
      toolUses,
      content,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "length" : "end_turn",
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.models.list({ signal });
    return page.data.map((m) => m.id).filter(Boolean);
  }
}
