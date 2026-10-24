import { systemReminder } from "./reminder.js";

/**
 * Session goal ("autopilot"): a persisted objective the agent keeps working
 * toward across turns. After each successful turn a small verifier call decides
 * whether the objective is met; if not, the next action is queued as an
 * automatic continuation. This module owns the state shape, persistence
 * sanitizing, prompt text and command parsing — the Agent owns the loop.
 */
export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

export interface SessionGoal {
  /** What the agent is trying to achieve, one line. */
  objective: string;
  status: GoalStatus;
  /** Provider tokens (input + output) the goal may consume; null = unlimited. */
  tokenBudget: number | null;
  tokensUsed: number;
  /** Automatic continuation turns queued so far. */
  continuations: number;
  maxContinuations: number;
  createdAt: string;
  updatedAt: string;
  /** Why the goal was paused/completed (shown in status output). */
  note?: string;
  /** What the verifier said to do next; fed into the continuation prompt. */
  nextAction?: string;
}

export const DEFAULT_MAX_CONTINUATIONS = 10;
export const MAX_GOAL_CONTINUATIONS = 50;
export const MAX_GOAL_OBJECTIVE = 4_000;
export const GOAL_VERIFY_TIMEOUT_MS = 60_000;
/** Event name used for both the continuation reminder and status reminders. */
export const GOAL_EVENT = "Goal";

const NEXT_ACTION_MAX = 600;
const NOTE_MAX = 600;
const VERIFIER_EXCERPT_MAX = 8_000;

/**
 * Goal text reaches the prompt outside any escaping wrapper: nextAction/note
 * are verifier-authored and the excerpt is raw assistant output (which may
 * quote a file or web page). A literal closing tag there would end the block
 * early and let the rest read as top-level instructions.
 */
function escapeGoalTags(text: string): string {
  return text.replace(/<(\/?)(goal_state|latest_turn)\b/gi, "&lt;$1$2");
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function cleanCount(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function isoOrNow(value: unknown, now: string): string {
  if (typeof value !== "string" || !value.trim()) return now;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : now;
}

/**
 * Tolerant parse of a goal read from disk (or a hand-edited session file).
 * Never throws; an unusable record is dropped. An unknown status becomes
 * "paused" so a corrupt file can never silently start an autonomous loop.
 */
export function sanitizeGoal(raw: unknown, now = new Date()): SessionGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const objective = cleanText(r.objective, MAX_GOAL_OBJECTIVE);
  if (!objective) return null;
  const status: GoalStatus =
    r.status === "active" || r.status === "paused" || r.status === "completed" || r.status === "cancelled"
      ? r.status
      : "paused";
  const budgetRaw = typeof r.tokenBudget === "number" ? r.tokenBudget : Number.NaN;
  const tokenBudget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.floor(budgetRaw) : null;
  const maxRaw = cleanCount(r.maxContinuations, DEFAULT_MAX_CONTINUATIONS);
  const maxContinuations = Math.min(MAX_GOAL_CONTINUATIONS, Math.max(1, maxRaw));
  const stamp = now.toISOString();
  return {
    objective,
    status,
    tokenBudget,
    tokensUsed: cleanCount(r.tokensUsed),
    continuations: cleanCount(r.continuations),
    maxContinuations,
    createdAt: isoOrNow(r.createdAt, stamp),
    updatedAt: isoOrNow(r.updatedAt, stamp),
    ...(cleanText(r.note, NOTE_MAX) ? { note: cleanText(r.note, NOTE_MAX) } : {}),
    ...(cleanText(r.nextAction, NEXT_ACTION_MAX) ? { nextAction: cleanText(r.nextAction, NEXT_ACTION_MAX) } : {}),
  };
}

export interface CreateGoalOptions {
  tokenBudget?: number | null;
  maxContinuations?: number;
  now?: Date;
}

/** Build a fresh active goal; returns null for an empty objective. */
export function createGoal(objective: string, opts: CreateGoalOptions = {}): SessionGoal | null {
  const text = cleanText(objective, MAX_GOAL_OBJECTIVE);
  if (!text) return null;
  const stamp = (opts.now ?? new Date()).toISOString();
  const budget = opts.tokenBudget;
  const tokenBudget = typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : null;
  const max = cleanCount(opts.maxContinuations, DEFAULT_MAX_CONTINUATIONS);
  return {
    objective: text,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    continuations: 0,
    maxContinuations: Math.min(MAX_GOAL_CONTINUATIONS, Math.max(1, max)),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** Remaining budget in tokens, or null when the goal has no budget. */
export function goalBudgetLeft(goal: SessionGoal): number | null {
  if (goal.tokenBudget === null) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function goalBudgetExhausted(goal: SessionGoal): boolean {
  return goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
}

/** One-line status for UIs (sidebar chip / notice). */
export function goalSummaryLine(goal: SessionGoal | null): string {
  if (!goal) return "no goal";
  const progress =
    goal.tokenBudget === null
      ? `${goal.tokensUsed.toLocaleString()} tok`
      : `${goal.tokensUsed.toLocaleString()}/${goal.tokenBudget.toLocaleString()} tok`;
  return `${goal.status} · ${goal.objective} · ${progress} · turn ${goal.continuations}/${goal.maxContinuations}`;
}

/** Human status block for `/goal` (and resume notices). */
export function formatGoal(goal: SessionGoal | null): string {
  if (!goal) {
    return [
      "no goal set for this session",
      "usage: /goal <objective> [--budget <tokens>] [--max <continuations>]",
      "       /goal pause|resume|done|clear · /goal budget <tokens|off> · /goal max <n>",
    ].join("\n");
  }
  const lines = [`goal [${goal.status}] ${goal.objective}`];
  lines.push(
    goal.tokenBudget === null
      ? `tokens: ${goal.tokensUsed.toLocaleString()} used (no budget)`
      : `tokens: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} used (${Math.min(
          100,
          Math.round((goal.tokensUsed / goal.tokenBudget) * 100),
        )}%)`,
  );
  lines.push(`continuations: ${goal.continuations} / ${goal.maxContinuations}`);
  if (goal.nextAction) lines.push(`next action: ${goal.nextAction}`);
  if (goal.note) lines.push(`note: ${goal.note}`);
  if (goal.status === "active") lines.push("autopilot is on: after each turn the agent verifies the goal and continues if needed");
  else if (goal.status === "paused") lines.push("paused: /goal resume continues, /goal done marks it complete, /goal clear forgets it");
  else lines.push("/goal <objective> starts a new goal, /goal clear forgets this one");
  return lines.join("\n");
}

/**
 * The volatile system-prompt block. Only live goals are injected; a finished
 * or cleared goal has no business steering the model.
 */
export function goalStateBlock(goal: SessionGoal | null): string {
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return "";
  const lines = [
    `<goal_state status="${goal.status}">`,
    `Objective: ${escapeGoalTags(goal.objective)}`,
    goal.tokenBudget === null
      ? `Tokens used: ${goal.tokensUsed.toLocaleString()} (no budget)`
      : `Tokens used: ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()}`,
    `Automatic continuations: ${goal.continuations} / ${goal.maxContinuations}`,
  ];
  if (goal.nextAction) lines.push(`Next action: ${escapeGoalTags(goal.nextAction)}`);
  if (goal.note) lines.push(`Note: ${escapeGoalTags(goal.note)}`);
  lines.push(
    goal.status === "active"
      ? "Work toward this objective across turns. If the user's message conflicts with it, follow the user."
      : "The user paused this goal. Do not resume it on your own.",
    "</goal_state>",
  );
  return lines.join("\n");
}

/**
 * The synthetic user message that starts an automatic continuation. It is
 * wrapped as a system-reminder so transcript tooling can recognize it as
 * injected context rather than something the user typed.
 */
export function goalContinuationPrompt(goal: SessionGoal): string {
  const left = goalBudgetLeft(goal);
  const budget =
    left === null ? "no token budget" : `${left.toLocaleString()} tokens left of ${(goal.tokenBudget ?? 0).toLocaleString()}`;
  const next = goal.nextAction ? `\nLast verifier next action: ${goal.nextAction}` : "";
  return systemReminder(
    [
      "Automatic goal continuation — this is not a new user request.",
      `Goal: ${goal.objective}${next}`,
      `Progress: continuation ${goal.continuations} / ${goal.maxContinuations} · ${budget}.`,
      "Keep working toward the goal with tools. Do not repeat work already completed and do not ask the user to confirm the plan again.",
      "If the goal is already satisfied, say so briefly; the verifier will stop the loop.",
    ].join("\n"),
    { event: `GoalContinuation` },
  );
}

export const GOAL_VERIFIER_SYSTEM = `You are a strict completion verifier for an autonomous coding agent.
Decide whether the agent's latest turn fully satisfied the stated goal.
Use only the goal, the verifier's previous next action, and the latest assistant output.
Do not assume work that is not evidenced in the excerpt.
Reply with exactly one JSON object and nothing else:
{"done": boolean, "nextAction": "one concrete next step, empty when done", "reason": "short justification"}`;

/**
 * Prompt for the per-turn verifier call. The excerpt is deliberately bounded:
 * the verifier only needs to judge the latest outcome, not the whole session.
 */
export function buildGoalVerificationPrompt(goal: SessionGoal, lastAssistantText: string): string {
  const excerpt =
    lastAssistantText.length > VERIFIER_EXCERPT_MAX
      ? `${lastAssistantText.slice(0, VERIFIER_EXCERPT_MAX)}\n[... excerpt truncated]`
      : lastAssistantText;
  return [
    `Goal: ${goal.objective}`,
    goal.nextAction ? `Previous next action: ${goal.nextAction}` : "Previous next action: (none)",
    `Tokens used so far: ${goal.tokensUsed.toLocaleString()}${
      goal.tokenBudget === null ? "" : ` of ${goal.tokenBudget.toLocaleString()}`
    }`,
    "",
    "Latest assistant output:",
    "<latest_turn>",
    escapeGoalTags(excerpt) || "(empty)",
    "</latest_turn>",
    "",
    'Return JSON: {"done":boolean,"nextAction":"...","reason":"..."}',
  ].join("\n");
}

export interface GoalVerification {
  done: boolean;
  nextAction?: string;
  reason?: string;
}

/** Parse the verifier's strict JSON, tolerating code fences and surrounding prose. */
export function parseGoalVerification(text: string): GoalVerification | null {
  const raw = text.trim();
  if (!raw) return null;
  const candidates: string[] = [];
  const unfenced = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  candidates.push(unfenced);
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const done =
        typeof parsed.done === "boolean"
          ? parsed.done
          : typeof parsed.done === "string" && (parsed.done === "true" || parsed.done === "false")
            ? parsed.done === "true"
            : undefined;
      if (done === undefined) continue;
      return {
        done,
        ...(cleanText(parsed.nextAction, NEXT_ACTION_MAX) ? { nextAction: cleanText(parsed.nextAction, NEXT_ACTION_MAX) } : {}),
        ...(cleanText(parsed.reason, NOTE_MAX) ? { reason: cleanText(parsed.reason, NOTE_MAX) } : {}),
      };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export type GoalCommand =
  | { action: "status" }
  | { action: "set"; objective: string; tokenBudget: number | null; maxContinuations: number | undefined }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "complete" }
  | { action: "clear" }
  | { action: "budget"; tokenBudget: number | null }
  | { action: "max"; maxContinuations: number }
  | { action: "error"; message: string };

function parseBudgetFlag(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "off" || v === "none" || v === "0") return null;
  const n = Number(value.replace(/^[$]/, "").replace(/_/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Parse the arguments following `/goal` (the command name is already stripped). */
export function parseGoalCommand(args: string[]): GoalCommand {
  const words = [...args];
  if (!words.length) return { action: "status" };
  const head = words[0].toLowerCase();
  if (head === "pause" || head === "hold") return { action: "pause" };
  if (head === "resume" || head === "continue") return { action: "resume" };
  if (head === "done" || head === "complete") return { action: "complete" };
  if (head === "clear" || head === "cancel" || head === "stop") return { action: "clear" };
  if (head === "budget" || head === "tokens") {
    const parsed = parseBudgetFlag(words[1]);
    if (parsed === undefined) return { action: "error", message: "usage: /goal budget <tokens|off>" };
    return { action: "budget", tokenBudget: parsed };
  }
  if (head === "max") {
    const n = Number(words[1]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL_CONTINUATIONS) {
      return { action: "error", message: `usage: /goal max <1-${MAX_GOAL_CONTINUATIONS}>` };
    }
    return { action: "max", maxContinuations: n };
  }
  if (head === "set") words.shift();

  let tokenBudget: number | null | undefined;
  let maxContinuations: number | undefined;
  const objective: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--budget" || w === "-b" || w === "--tokens") {
      tokenBudget = parseBudgetFlag(words[++i]);
      if (tokenBudget === undefined) return { action: "error", message: "usage: --budget <tokens|off>" };
    } else if (w.startsWith("--budget=") || w.startsWith("--tokens=")) {
      tokenBudget = parseBudgetFlag(w.slice(w.indexOf("=") + 1));
      if (tokenBudget === undefined) return { action: "error", message: "usage: --budget <tokens|off>" };
    } else if (w === "--max") {
      const n = Number(words[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL_CONTINUATIONS) {
        return { action: "error", message: `usage: --max <1-${MAX_GOAL_CONTINUATIONS}>` };
      }
      maxContinuations = n;
    } else if (w.startsWith("--max=")) {
      const n = Number(w.slice(6));
      if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL_CONTINUATIONS) {
        return { action: "error", message: `usage: --max <1-${MAX_GOAL_CONTINUATIONS}>` };
      }
      maxContinuations = n;
    } else {
      objective.push(w);
    }
  }
  const text = cleanText(objective.join(" "), MAX_GOAL_OBJECTIVE);
  if (!text) return { action: "error", message: "usage: /goal <objective> [--budget <tokens>] [--max <continuations>]" };
  return { action: "set", objective: text, tokenBudget: tokenBudget ?? null, maxContinuations };
}

let autopilotDisabled = false;

/** Print mode and tests disable autopilot: no host loop, no surprising cost. */
export function disableGoalAutopilot(): void {
  autopilotDisabled = true;
}

/** Test seam: re-enable autopilot after `disableGoalAutopilot`. */
export function setGoalAutopilotForTests(enabled: boolean): void {
  autopilotDisabled = !enabled;
}

export function goalAutopilotEnabled(): boolean {
  if (autopilotDisabled) return false;
  return process.env.AGENT_GOAL_AUTOPILOT !== "0";
}
