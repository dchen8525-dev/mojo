/**
 * Stuck-loop detector. When the same tool is called with byte-identical input
 * several times in a row within one turn, the result cannot have changed and
 * repeating the call will not move the task forward. The agent injects a
 * system-reminder instead of silently burning rounds.
 */

export const REPEAT_WARNING_AT = 3;

/** Key-order-independent JSON so the same logical input always hashes equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export class RepetitionTracker {
  private key = "";
  private count = 0;

  /**
   * Observe one call. Returns the current streak length when it hits a warning
   * point (every REPEAT_WARNING_AT consecutive repeats), otherwise 0.
   */
  observe(toolName: string, input: unknown): number {
    const key = `${toolName}\u0000${canonical(input)}`;
    if (key === this.key) {
      this.count++;
    } else {
      this.key = key;
      this.count = 1;
    }
    return this.count >= REPEAT_WARNING_AT && this.count % REPEAT_WARNING_AT === 0 ? this.count : 0;
  }
}
