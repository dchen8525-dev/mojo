import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/cost.js";
import { lookupModel } from "../src/llm/models.js";

describe("CostTracker", () => {
  it("computes USD from the model price table (anthropic spec)", () => {
    const t = new CostTracker();
    // sonnet-4-5: $3/M in, $15/M out.
    t.record("anthropic:claude-sonnet-4-5", { input: 1_000_000, output: 100_000 });
    expect(t.totalUsd()).toBeCloseTo(3 + 1.5, 6);
  });

  it("prices cache read/write tokens separately", () => {
    const t = new CostTracker();
    // opus-4-1: $15/M in, $75/M out, $1.5/M cache-read, $18.75/M cache-write.
    t.record("anthropic:claude-opus-4-1", {
      input: 10_000,
      output: 1_000,
      cacheRead: 100_000,
      cacheWrite: 50_000,
    });
    const expectUsd = (10_000 * 15 + 1_000 * 75 + 100_000 * 1.5 + 50_000 * 18.75) / 1e6;
    expect(t.totalUsd()).toBeCloseTo(expectUsd, 6);
  });

  it("tracks unknown models by tokens but reports them unpriced", () => {
    const t = new CostTracker();
    t.record("openai:mystery-llm-v9", { input: 500, output: 200 });
    expect(t.totalUsd()).toBe(0);
    const snap = t.snapshot();
    expect(snap.byModel["openai:mystery-llm-v9"].priced).toBe(false);
    expect(snap.byModel["openai:mystery-llm-v9"].input).toBe(500);
    expect(t.format()).toContain("(unpriced)");
  });

  it("aggregates per model across requests", () => {
    const t = new CostTracker();
    t.record("anthropic:claude-haiku-4-5", { input: 1000, output: 500 });
    t.record("anthropic:claude-haiku-4-5", { input: 2000, output: 1000 });
    const s = t.snapshot().byModel["anthropic:claude-haiku-4-5"];
    expect(s.requests).toBe(2);
    expect(s.input).toBe(3000);
    // haiku-4-5: $1/M in, $5/M out -> 3000/1M*1 + 1500/1M*5 = 0.003 + 0.0075
    expect(s.usd).toBeCloseTo(0.0105, 6);
  });

  it("budget warns once at 80% and stops once at 100%", () => {
    const t = new CostTracker(1); // $1 budget
    expect(t.checkBudget()).toBeNull();
    t.record("anthropic:claude-sonnet-4-5", { input: 0, output: 60_000 }); // $0.90
    const warn = t.checkBudget();
    expect(warn).not.toBeNull();
    expect(warn!.stop).toBe(false);
    expect(warn!.message).toContain("80%");
    // Second call must not re-warn.
    expect(t.checkBudget()).toBeNull();
    t.record("anthropic:claude-sonnet-4-5", { input: 0, output: 20_000 }); // +$0.30 -> $1.20
    const stop = t.checkBudget();
    expect(stop).not.toBeNull();
    expect(stop!.stop).toBe(true);
    expect(stop!.message).toContain("exhausted");
    expect(t.checkBudget()).toBeNull(); // fires at most once
  });

  it("no budget configured -> checkBudget always null", () => {
    const t = new CostTracker();
    t.record("anthropic:claude-opus-4-1", { input: 10_000_000, output: 1_000_000 });
    expect(t.checkBudget()).toBeNull();
  });

  it("empty tracker formats friendly", () => {
    expect(new CostTracker().format()).toContain("no API calls yet");
  });

  it("budget can be set at runtime (via /cost 5)", async () => {
    const t = new CostTracker();
    t.budgetUsd = 0.5;
    t.record("anthropic:claude-sonnet-4-5", { input: 0, output: 40_000 }); // $0.60 > budget
    const r = t.checkBudget();
    expect(r!.stop).toBe(true);
  });

  it("onRecord fires with the per-turn USD and priced flag", () => {
    const t = new CostTracker();
    const seen: Array<{ spec: string; usd: number; priced: boolean }> = [];
    t.onRecord = (spec, _usage, usd, priced) => seen.push({ spec, usd, priced });
    t.record("anthropic:claude-haiku-4-5", { input: 1_000_000, output: 0 }); // $1/M in
    t.record("openai:mystery-llm-v9", { input: 10, output: 5 });
    expect(seen).toHaveLength(2);
    expect(seen[0].usd).toBeCloseTo(1, 6);
    expect(seen[0].priced).toBe(true);
    expect(seen[1].usd).toBe(0);
    expect(seen[1].priced).toBe(false);
    // The tracker's own total still matches what it handed the callback.
    expect(t.totalUsd()).toBeCloseTo(1, 6);
  });
});

describe("model price table", () => {
  it("prices known models and leaves unknown ones undefined", () => {
    expect(lookupModel("claude-sonnet-4-5").inputPerMTok).toBe(3);
    expect(lookupModel("gpt-4o-mini").outputPerMTok).toBe(0.6);
    expect(lookupModel("glm-4-plus").inputPerMTok).toBeUndefined();
    expect(lookupModel("some-random-model").contextWindow).toBe(128_000);
  });

  it("specific claude entries win over the generic family entry", () => {
    // The generic claude-(opus|sonnet|haiku) row must not shadow priced rows.
    expect(lookupModel("claude-opus-4-1").outputPerMTok).toBe(75);
    expect(lookupModel("claude-haiku-4-5").cacheWritePerMTok).toBe(1.25);
    // An unpriced claude variant still resolves (window only).
    expect(lookupModel("claude-sonnet-5").contextWindow).toBe(200_000);
    expect(lookupModel("claude-sonnet-5").inputPerMTok).toBeUndefined();
  });
});
