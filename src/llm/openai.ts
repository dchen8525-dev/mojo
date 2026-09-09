import OpenAI from "openai";
import type { MessageParam, ContentBlock, ToolUseBlock, Tool } from "../types.js";
import type { AssistantTurn, LLMBackend, Provider, StreamEvents } from "./types.js";
import { StreamInterrupted } from "./types.js";
import { lookupModel } from "./models.js";

type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
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
    const blocks = msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }>;
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
      // user message: tool_result blocks become role:"tool" messages, text stays user
      let userText = "";
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
        } else if (b.type === "text") userText += b.text ?? "";
      }
      if (userText) out.push({ role: "user", content: userText });
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
  id: string;
  name: string;
  args: string;
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
    system: string,
    tools: Tool[],
    signal?: AbortSignal,
    events?: StreamEvents,
  ): Promise<AssistantTurn> {
    const chatMessages: ChatMsg[] = [{ role: "system", content: system }, ...toOpenAiMessages(messages)];
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
      { signal },
    );

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let finishReason: string | null = null;
    const toolCalls = new Map<number, PartialToolCall>();

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          events?.onTextDelta?.(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index;
          const cur = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCalls.set(idx, cur);
        }
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
      if (text && !toolCalls.size && !signal?.aborted && !(err instanceof Error && err.name === "APIUserAbortError")) {
        throw new StreamInterrupted(text, err);
      }
      throw err;
    }

    // Synthesize ids for providers that omit them in deltas.
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text } as ContentBlock);
    const toolUses: ToolUseBlock[] = [];
    for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!tc.name) continue;
      let input: Record<string, unknown> = {};
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        /* malformed args: keep {} so the model gets a validation error back */
      }
      const id = tc.id || `tc_${Date.now()}_${toolUses.length}`;
      events?.onToolUseStart?.(tc.name, id);
      const block: ToolUseBlock = { type: "tool_use", id, name: tc.name, input };
      toolUses.push(block);
      content.push(block);
    }

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
