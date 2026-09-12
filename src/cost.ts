import { lookupModel } from "./llm/models.js";

/**
 * Session cost accounting. The agent feeds every API turn's usage here; the
 * per-model price table in llm/models.ts turns it into a best-effort USD
 * estimate. Unknown models still get accurate token counts, just no dollars.
 */

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSpend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  priced: boolean; // false when the model has no price entry
  requests: number;
}

export interface CostSnapshot {
  byModel: Record<string, ModelSpend>;
  totalUsd: number;
  totalInput: number;
  totalOutput: number;
  budgetUsd: number | null;
}

function priceFor(spec: string): { model: string; priced: boolean; in_: number; out: number; cr: number; cw: number } {
  const model = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
  const info = lookupModel(model);
  const priced = typeof info.inputPerMTok === "number" && typeof info.outputPerMTok === "number";
  return {
    model,
    priced,
    in_: info.inputPerMTok ?? 0,
    out: info.outputPerMTok ?? 0,
    cr: info.cacheReadPerMTok ?? 0,
    cw: info.cacheWritePerMTok ?? 0,
  };
}

/** Best-effort USD for one usage delta; `priced: false` when the model has no price entry. */
export function computeUsd(modelSpec: string, usage: UsageDelta): { usd: number; priced: boolean } {
  const p = priceFor(modelSpec);
  if (!p.priced) return { usd: 0, priced: false };
  return {
    usd:
      (usage.input * p.in_ +
        usage.output * p.out +
        (usage.cacheRead ?? 0) * p.cr +
        (usage.cacheWrite ?? 0) * p.cw) /
      1_000_000,
    priced: true,
  };
}

export class CostTracker {
  private spend = new Map<string, ModelSpend>();
  private _budgetUsd: number | null;
  private warned80 = false;
  private warned100 = false;
  /**
   * Fired after every recorded turn with the per-turn USD, so a host can stream
   * usage to a persistent log (see usage.ts). Best-effort: the callback must
   * not throw, and it is intentionally synchronous to keep ordering.
   */
  onRecord?: (modelSpec: string, usage: UsageDelta, usd: number, priced: boolean) => void;

  constructor(budgetUsd?: number | null) {
    this._budgetUsd = budgetUsd && budgetUsd > 0 ? budgetUsd : null;
  }

  get budgetUsd(): number | null {
    return this._budgetUsd;
  }

  /** Changing the budget (e.g. `/cost 10`) re-arms the warning thresholds. */
  set budgetUsd(v: number | null) {
    this._budgetUsd = v && v > 0 ? v : null;
    this.warned80 = false;
    this.warned100 = false;
  }

  record(modelSpec: string, usage: UsageDelta): void {
    const s = this.spend.get(modelSpec) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      usd: 0,
      priced: priceFor(modelSpec).priced,
      requests: 0,
    };
    const { usd, priced } = computeUsd(modelSpec, usage);
    s.input += usage.input;
    s.output += usage.output;
    s.cacheRead += usage.cacheRead ?? 0;
    s.cacheWrite += usage.cacheWrite ?? 0;
    s.requests += 1;
    s.usd += usd;
    s.priced = s.priced || priced;
    this.spend.set(modelSpec, s);
    this.onRecord?.(modelSpec, usage, usd, priced);
  }

  totalUsd(): number {
    let t = 0;
    for (const s of this.spend.values()) t += s.usd;
    return t;
  }

  snapshot(): CostSnapshot {
    const byModel: Record<string, ModelSpend> = {};
    let totalInput = 0;
    let totalOutput = 0;
    for (const [spec, s] of this.spend) {
      byModel[spec] = { ...s };
      totalInput += s.input + s.cacheRead + s.cacheWrite;
      totalOutput += s.output;
    }
    return { byModel, totalUsd: this.totalUsd(), totalInput, totalOutput, budgetUsd: this.budgetUsd };
  }

  /**
   * Budget guardrail. Returns a warning line when a threshold is newly
   * crossed, "stop" when the budget is exhausted, or null otherwise. Each
   * threshold fires at most once per session.
   */
  checkBudget(): { message: string; stop: boolean } | null {
    if (!this.budgetUsd) return null;
    const spent = this.totalUsd();
    const pct = spent / this.budgetUsd;
    if (pct >= 1 && !this.warned100) {
      this.warned100 = true;
      this.warned80 = true;
      return {
        message:
          `budget exhausted: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} spent. ` +
          `Stopping this turn - raise or clear AGENT_BUDGET_USD to continue.`,
        stop: true,
      };
    }
    if (pct >= 0.8 && !this.warned80) {
      this.warned80 = true;
      return {
        message: `budget warning: $${spent.toFixed(2)} of $${this.budgetUsd.toFixed(2)} (80%) spent.`,
        stop: false,
      };
    }
    return null;
  }

  format(): string {
    const snap = this.snapshot();
    if (!Object.keys(snap.byModel).length) return "no API calls yet this session";
    const lines = Object.entries(snap.byModel)
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([spec, s]) => {
        const cost = s.priced ? `$${s.usd.toFixed(4)}` : "(unpriced)";
        const cache = s.cacheRead || s.cacheWrite ? `, cache ${fmtK(s.cacheRead)}/${fmtK(s.cacheWrite)}` : "";
        return `${spec}: ${cost} · ${s.requests} req · in ${fmtK(s.input)} / out ${fmtK(s.output)}${cache}`;
      });
    const priced = Object.values(snap.byModel).some((s) => s.priced);
    const total = priced ? `$${snap.totalUsd.toFixed(4)}` : "n/a (no priced models)";
    const budget = snap.budgetUsd ? ` · budget $${snap.budgetUsd.toFixed(2)} (${((snap.totalUsd / snap.budgetUsd) * 100).toFixed(0)}%)` : "";
    return [`total: ${total}${budget}`, `tokens: ${fmtK(snap.totalInput)} in / ${fmtK(snap.totalOutput)} out`, ...lines].join("\n");
  }
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
