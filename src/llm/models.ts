export interface ModelInfo {
  /** Total input context window in tokens. */
  contextWindow: number;
  /** Default max output tokens sent to the API. */
  maxOutput: number;
  /** Reasoning models (o-series): use max_completion_tokens, no sampling params. */
  reasoning?: boolean;
}

const KNOWN: Array<[RegExp, ModelInfo]> = [
  [/^claude-(opus|sonnet|haiku)/, { contextWindow: 200_000, maxOutput: 8192 }],
  [/^claude-3/, { contextWindow: 200_000, maxOutput: 4096 }],
  [/^gpt-4\.1/, { contextWindow: 1_000_000, maxOutput: 32_768 }],
  [/^gpt-4o/, { contextWindow: 128_000, maxOutput: 16_384 }],
  [/^(o1|o3|o4)(-|$)/, { contextWindow: 200_000, maxOutput: 100_000, reasoning: true }],
  [/^glm-/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/^deepseek/, { contextWindow: 128_000, maxOutput: 8192 }],
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
