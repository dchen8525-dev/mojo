import type {
  Tool,
  ToolContext,
  ToolResult,
  UserQuestion,
  UserQuestionOutcome,
} from "../types.js";

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTION_CHARS = 500;
const MAX_HEADER_CHARS = 16;
const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Explicit timeout wins; otherwise AGENT_ASK_TIMEOUT_MS, clamped to a sane window. */
export function askTimeoutMs(raw?: unknown): number {
  const explicit = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  const env = Number(process.env.AGENT_ASK_TIMEOUT_MS);
  const value = explicit ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS);
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function fail(message: string): { error: string } {
  return { error: message };
}

/**
 * Validate the model-supplied questions and copy them into a clean shape.
 * Answers are keyed by question text, so duplicates are rejected rather than
 * silently merged.
 */
export function normalizeQuestions(raw: unknown): { questions?: UserQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length < MIN_QUESTIONS || raw.length > MAX_QUESTIONS) {
    return fail(`questions must be an array of ${MIN_QUESTIONS}-${MAX_QUESTIONS} questions`);
  }
  const questions: UserQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i] as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`question ${i + 1} must be an object`);
    const question = typeof value.question === "string" ? value.question.trim() : "";
    if (!question) return fail(`question ${i + 1} needs a non-empty "question"`);
    if (question.length > MAX_QUESTION_CHARS) {
      return fail(`question ${i + 1} is longer than ${MAX_QUESTION_CHARS} characters`);
    }
    const key = question.toLowerCase();
    if (seenQuestions.has(key)) return fail(`question ${i + 1} duplicates an earlier question`);
    seenQuestions.add(key);

    const header = typeof value.header === "string" ? value.header.replace(/\s+/g, " ").trim() : "";
    if (header.length > MAX_HEADER_CHARS) {
      return fail(`question ${i + 1} header must be at most ${MAX_HEADER_CHARS} characters`);
    }

    if (!Array.isArray(value.options) || value.options.length < MIN_OPTIONS || value.options.length > MAX_OPTIONS) {
      return fail(`question ${i + 1} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options`);
    }
    const options: UserQuestion["options"] = [];
    const seenLabels = new Set<string>();
    for (const opt of value.options) {
      if (!opt || typeof opt !== "object" || Array.isArray(opt)) return fail(`question ${i + 1} has an invalid option`);
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) return fail(`question ${i + 1} has an option without a label`);
      if (label.length > MAX_LABEL_CHARS) {
        return fail(`question ${i + 1} option labels must be at most ${MAX_LABEL_CHARS} characters`);
      }
      const labelKey = label.toLowerCase();
      if (seenLabels.has(labelKey)) return fail(`question ${i + 1} repeats the option "${label}"`);
      seenLabels.add(labelKey);
      const description = typeof o.description === "string" ? o.description.trim() : "";
      if (description.length > MAX_DESCRIPTION_CHARS) {
        return fail(`question ${i + 1} option descriptions must be at most ${MAX_DESCRIPTION_CHARS} characters`);
      }
      options.push({ label, ...(description ? { description } : {}) });
    }

    questions.push({
      question,
      ...(header ? { header } : {}),
      options,
      multiSelect: value.multiSelect === true,
    });
  }
  return { questions };
}

/** Keep answers to labels that were actually offered, in option order. */
function cleanSelected(question: UserQuestion, selected: string[]): string[] {
  const wanted = new Set(selected.map((s) => s.toLowerCase()));
  return question.options.filter((o) => wanted.has(o.label.toLowerCase())).map((o) => o.label);
}

/** Render the outcome for the model; never throws on malformed answers. */
export function formatAskOutcome(
  questions: UserQuestion[],
  outcome: UserQuestionOutcome,
  timeoutMs: number,
): string {
  const seconds = Math.round(timeoutMs / 1000);
  if (outcome.unavailable) {
    return (
      "No interactive question UI is available in this run (headless, subagent, or no connected client). " +
      "Do not call ask_user again; make a reasonable choice yourself and state the assumption in your answer."
    );
  }
  if (outcome.aborted) {
    return "The user did not answer because the turn was interrupted. Stop and wait for their next instruction.";
  }
  const answers = new Map(outcome.answers.map((a) => [a.question, a.selected]));
  const lines: string[] = [];
  let anyAnswer = false;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = cleanSelected(q, answers.get(q.question) ?? []);
    if (!selected.length) {
      lines.push(`${i + 1}. ${q.question} → (no answer)`);
      continue;
    }
    anyAnswer = true;
    lines.push(`${i + 1}. ${q.question} → ${selected.join(", ")}`);
  }
  const lead = outcome.timedOut
    ? `The user did not answer within ${seconds}s, so the question timed out. ` +
      "Proceed using your best judgment; clearly state any assumption this creates."
    : anyAnswer
      ? "The user answered:"
      : "The user skipped the question(s) without choosing an option. Proceed using your best judgment.";
  return [lead, ...lines].join("\n");
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user 1-4 structured multiple-choice questions and wait for their answer. Use it only when a " +
    "choice genuinely belongs to the user and cannot be settled from the repository or the request " +
    "(ambiguous requirements, a trade-off with real consequences, an unstated preference). Each question " +
    "offers 2-4 short options; set multiSelect when several choices may be combined. Answers are option " +
    "labels. Permission approvals are handled by the system - never use this tool for them. In headless " +
    "runs and subagents the question is skipped automatically, so proceed with a stated assumption.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1-4 questions to ask, in order.",
        items: { type: "object" },
      },
      timeout_ms: {
        type: "number",
        description: "How long to wait for an answer (1000-300000 ms; default 120000).",
      },
    },
    required: ["questions"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const normalized = normalizeQuestions(input.questions);
    if (!normalized.questions) return { content: `Error: ${normalized.error}`, isError: true };
    const questions = normalized.questions;
    const timeoutMs = askTimeoutMs(input.timeout_ms);
    if (!ctx.askUser) {
      return { content: formatAskOutcome(questions, { answers: [], unavailable: true }, timeoutMs) };
    }
    const outcome = await ctx.askUser({ questions, timeoutMs });
    return { content: formatAskOutcome(questions, outcome, timeoutMs) };
  },
};
