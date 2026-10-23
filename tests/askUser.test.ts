import { describe, expect, it } from "vitest";
import { askTimeoutMs, askUserTool, formatAskOutcome, normalizeQuestions } from "../src/tools/askUser.js";
import type { ToolContext, UserQuestion } from "../src/types.js";

const questions: UserQuestion[] = [
  {
    question: "Which database?",
    header: "Storage",
    options: [{ label: "SQLite" }, { label: "Postgres", description: "server-backed" }],
    multiSelect: false,
  },
  {
    question: "Which targets?",
    options: [{ label: "CLI" }, { label: "GUI" }, { label: "API" }],
    multiSelect: true,
  },
];

function ctx(askUser?: ToolContext["askUser"]): ToolContext {
  return { cwd: process.cwd(), sessionId: "abcd1234", askPermission: async () => true, askUser };
}

describe("normalizeQuestions", () => {
  it("accepts and trims a valid shape", () => {
    const out = normalizeQuestions([
      {
        question: "  Pick one  ",
        header: "  Head   er ",
        options: [{ label: " A ", description: " first " }, { label: "B" }],
        multiSelect: true,
      },
    ]);
    expect(out.error).toBeUndefined();
    expect(out.questions).toEqual([
      {
        question: "Pick one",
        header: "Head er",
        options: [{ label: "A", description: "first" }, { label: "B" }],
        multiSelect: true,
      },
    ]);
  });

  it("defaults multiSelect to false and omits empty headers/descriptions", () => {
    const out = normalizeQuestions([{ question: "Q", options: [{ label: "x" }, { label: "y" }] }]);
    expect(out.questions?.[0]).toEqual({
      question: "Q",
      options: [{ label: "x" }, { label: "y" }],
      multiSelect: false,
    });
  });

  it("rejects too few or too many questions", () => {
    expect(normalizeQuestions([]).error).toMatch(/1-4 questions/);
    const five = Array.from({ length: 5 }, (_, i) => ({
      question: `q${i}`,
      options: [{ label: "a" }, { label: "b" }],
    }));
    expect(normalizeQuestions(five).error).toMatch(/1-4 questions/);
  });

  it("rejects questions that are not objects or lack text", () => {
    expect(normalizeQuestions(["nope"]).error).toMatch(/must be an object/);
    expect(normalizeQuestions([{ options: [{ label: "a" }, { label: "b" }] }]).error).toMatch(/non-empty "question"/);
  });

  it("rejects duplicate question texts and duplicate option labels", () => {
    expect(
      normalizeQuestions([
        { question: "Same", options: [{ label: "a" }, { label: "b" }] },
        { question: "same", options: [{ label: "a" }, { label: "b" }] },
      ]).error,
    ).toMatch(/duplicates/);
    expect(
      normalizeQuestions([{ question: "Q", options: [{ label: "Yes" }, { label: "yes" }] }]).error,
    ).toMatch(/repeats the option/);
  });

  it("rejects out-of-range option counts and empty labels", () => {
    expect(normalizeQuestions([{ question: "Q", options: [{ label: "only" }] }]).error).toMatch(/2-4 options/);
    expect(
      normalizeQuestions([
        { question: "Q", options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] },
      ]).error,
    ).toMatch(/2-4 options/);
    expect(normalizeQuestions([{ question: "Q", options: [{ label: " " }, { label: "b" }] }]).error).toMatch(
      /without a label/,
    );
  });

  it("enforces length limits", () => {
    expect(
      normalizeQuestions([{ question: "Q".repeat(501), options: [{ label: "a" }, { label: "b" }] }]).error,
    ).toMatch(/500/);
    expect(
      normalizeQuestions([{ question: "Q", header: "h".repeat(17), options: [{ label: "a" }, { label: "b" }] }]).error,
    ).toMatch(/16/);
    expect(
      normalizeQuestions([{ question: "Q", options: [{ label: "l".repeat(81) }, { label: "b" }] }]).error,
    ).toMatch(/80/);
    expect(
      normalizeQuestions([
        { question: "Q", options: [{ label: "a", description: "d".repeat(201) }, { label: "b" }] },
      ]).error,
    ).toMatch(/200/);
  });
});

describe("askTimeoutMs", () => {
  it("uses an explicit value, clamps it, and falls back to the default", () => {
    delete process.env.AGENT_ASK_TIMEOUT_MS;
    expect(askTimeoutMs(5000)).toBe(5000);
    expect(askTimeoutMs(10)).toBe(1000);
    expect(askTimeoutMs(999_999)).toBe(300_000);
    expect(askTimeoutMs()).toBe(120_000);
    expect(askTimeoutMs("nope")).toBe(120_000);
  });

  it("honours AGENT_ASK_TIMEOUT_MS unless an explicit value is given", () => {
    process.env.AGENT_ASK_TIMEOUT_MS = "7000";
    try {
      expect(askTimeoutMs()).toBe(7000);
      expect(askTimeoutMs(30_000)).toBe(30_000);
      process.env.AGENT_ASK_TIMEOUT_MS = "1";
      expect(askTimeoutMs()).toBe(1000);
    } finally {
      delete process.env.AGENT_ASK_TIMEOUT_MS;
    }
  });
});

describe("formatAskOutcome", () => {
  it("keeps only offered labels and orders them by option order", () => {
    const text = formatAskOutcome(
      questions,
      {
        answers: [
          { question: "Which targets?", selected: ["API", "CLI", "bogus"] },
          { question: "Which database?", selected: ["postgres"] },
        ],
      },
      120_000,
    );
    expect(text).toContain("The user answered:");
    expect(text).toContain("1. Which database? → Postgres");
    expect(text).toContain("2. Which targets? → CLI, API");
  });

  it("reports unanswered questions when only some were answered", () => {
    const text = formatAskOutcome(questions, { answers: [{ question: "Which database?", selected: ["SQLite"] }] }, 120_000);
    expect(text).toContain("1. Which database? → SQLite");
    expect(text).toContain("2. Which targets? → (no answer)");
  });

  it("explains a timeout and tells the model to proceed", () => {
    const text = formatAskOutcome(questions, { answers: [], timedOut: true }, 30_000);
    expect(text).toContain("within 30s");
    expect(text).toContain("best judgment");
    expect(text).toContain("(no answer)");
  });

  it("explains a skip and an abort", () => {
    expect(formatAskOutcome(questions, { answers: [] }, 120_000)).toContain("skipped the question(s)");
    expect(formatAskOutcome(questions, { answers: [], aborted: true }, 120_000)).toContain("turn was interrupted");
  });

  it("tells headless and subagent runs not to retry", () => {
    const text = formatAskOutcome(questions, { answers: [], unavailable: true }, 120_000);
    expect(text).toContain("No interactive question UI");
    expect(text).toContain("Do not call ask_user again");
  });
});

describe("ask_user tool", () => {
  it("passes normalized questions and the timeout to the runtime and formats the answer", async () => {
    const seen: unknown[] = [];
    const result = await askUserTool.execute(
      { questions: [{ question: "Pick", options: [{ label: "a" }, { label: "b" }] }], timeout_ms: 5000 },
      ctx(async (request) => {
        seen.push(request);
        return { answers: [{ question: "Pick", selected: ["b"] }] };
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1. Pick → b");
    expect(seen).toHaveLength(1);
    const request = seen[0] as { questions: UserQuestion[]; timeoutMs: number };
    expect(request.timeoutMs).toBe(5000);
    expect(request.questions[0].question).toBe("Pick");
  });

  it("degrades to an unavailable answer when no interactive UI is wired", async () => {
    const result = await askUserTool.execute(
      { questions: [{ question: "Pick", options: [{ label: "a" }, { label: "b" }] }] },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No interactive question UI");
  });

  it("returns a validation error without calling the runtime", async () => {
    let called = 0;
    const result = await askUserTool.execute(
      { questions: [{ question: "Pick", options: [{ label: "only" }] }] },
      ctx(async () => {
        called++;
        return { answers: [] };
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^Error: .*2-4 options/);
    expect(called).toBe(0);
  });

  it("is read-only (safe in plan mode) and asks alone", () => {
    expect(askUserTool.isReadOnly).toBe(true);
    expect(askUserTool.parallelSafe).toBeUndefined();
  });
});
