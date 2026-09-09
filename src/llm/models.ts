export interface ModelInfo {
  /** Total input context window in tokens. */
  contextWindow: number;
  /** Default max output tokens sent to the API. */
  maxOutput: number;
  /** Reasoning models (o-series): use max_completion_tokens, no sampling params. */
  reasoning?: boolean;
  /** USD per million input (fresh) tokens; undefined = price unknown. */
  inputPerMTok?: number;
  /** USD per million output tokens. */
  outputPerMTok?: number;
  /** USD per million cached-read input tokens (Anthropic/OpenAI prompt cache). */
  cacheReadPerMTok?: number;
  /** USD per million cache-write input tokens (Anthropic only). */
  cacheWritePerMTok?: number;
}

// Prices are approximate list prices (USD per million tokens) as of 2025 and
// only used for a best-effort cost estimate in /cost. Unknown models report
// token totals without a dollar figure rather than guessing.
const KNOWN: Array<[RegExp, ModelInfo]> = [
  [/^claude-sonnet-4-5/, { contextWindow: 200_000, maxOutput: 8192, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }],
  [/^claude-opus-4-1/, { contextWindow: 200_000, maxOutput: 8192, inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 }],
  [/^claude-haiku-4-5/, { contextWindow: 200_000, maxOutput: 8192, inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 }],
  [/^claude-(opus|sonnet|haiku)/, { contextWindow: 200_000, maxOutput: 8192 }],
  [/^claude-3/, { contextWindow: 200_000, maxOutput: 4096 }],
  [/^gpt-4\.1/, { contextWindow: 1_000_000, maxOutput: 32_768, inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 }],
  [/^gpt-4o-mini/, { contextWindow: 128_000, maxOutput: 16_384, inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 }],
  [/^gpt-4o/, { contextWindow: 128_000, maxOutput: 16_384, inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 }],
  [/^(o1|o3|o4)(-|$)/, { contextWindow: 200_000, maxOutput: 100_000, reasoning: true }],
  [/^glm-/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/^deepseek/, { contextWindow: 128_000, maxOutput: 8192, inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 }],
  [/^qwen-/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/^kimi-/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/^moonshot/, { contextWindow: 128_000, maxOutput: 8192 }],
];

const DEFAULT: ModelInfo = { contextWindow: 128_000, maxOutput: 8192 };

export function lookupModel(model: string): ModelInfo {
  const m = model.toLowerCase();
  for (const [re, info] of KNOWN) if (re.test(m)) return info;
  return DEFAULT;
}

/** Model ids with known capabilities, for /model listing. */
export function knownModelNames(): string[] {
  return [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "gpt-4o",
    "gpt-4o-mini",
    "o3",
    "glm-4-plus",
    "deepseek-chat",
    "qwen-max",
  ];
}
