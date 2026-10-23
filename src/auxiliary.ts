import type { SendOptions } from "./llm/types.js";

/** Output-token ceiling for auxiliary (non-user-facing) LLM calls. */
export const AUX_MAX_OUTPUT = 5000;

/**
 * Auxiliary calls (session title, goal verifier, memory extraction, dream,
 * compaction summarizer) never need long thinking or huge outputs. AGENT_AUX_MAX_OUTPUT
 * overrides the ceiling when a model chokes on 5k.
 */
export function auxiliarySendOptions(): SendOptions {
  const env = Number.parseInt(process.env.AGENT_AUX_MAX_OUTPUT ?? "", 10);
  return {
    maxOutput: Number.isFinite(env) && env > 0 ? env : AUX_MAX_OUTPUT,
    thinking: false,
  };
}
