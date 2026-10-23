/**
 * Soft per-turn tool-call budget. The hard stop is on model rounds
 * (`MAX_TOOL_ITERATIONS`), but one round can contain many parallel calls; a
 * call-count budget gives the model an early chance to converge instead of
 * losing the last rounds to the hard stop. Warnings are advisory only.
 */
export const TOOL_CALL_BUDGET = 100;

const WARN_AT = [0.5, 0.75, 0.9];

export interface ToolBudgetWarning {
  /** Number of thresholds consumed after this warning. */
  warned: number;
  text: string;
}

/**
 * The next reminder once `calls` crosses threshold number `warned`, or null.
 * Call in a loop with the returned `warned` to emit every threshold a single
 * large round jumped over.
 */
export function nextToolBudgetWarning(calls: number, warned: number): ToolBudgetWarning | null {
  if (warned >= WARN_AT.length) return null;
  const threshold = Math.ceil(TOOL_CALL_BUDGET * WARN_AT[warned]);
  if (calls < threshold) return null;
  const pct = Math.round(WARN_AT[warned] * 100);
  return {
    warned: warned + 1,
    text:
      `Tool budget: ${calls}/${TOOL_CALL_BUDGET} tool calls used this turn; the ${pct}% warning threshold is crossed. ` +
      "Start converging: stop exploring, avoid repeated calls, and leave room to summarize what you found.",
  };
}
