import { describe, expect, it } from "vitest";
import {
  buildGoalVerificationPrompt,
  createGoal,
  DEFAULT_MAX_CONTINUATIONS,
  formatGoal,
  goalBudgetExhausted,
  goalBudgetLeft,
  goalContinuationPrompt,
  goalStateBlock,
  MAX_GOAL_CONTINUATIONS,
  parseGoalCommand,
  parseGoalVerification,
  sanitizeGoal,
} from "../src/goal.js";

const now = new Date("2026-10-23T08:00:00.000Z");

describe("goal state", () => {
  it("creates an active goal with defaults", () => {
    const goal = createGoal("  make   the tests pass  ", { now });
    expect(goal).toEqual({
      objective: "make the tests pass",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      continuations: 0,
      maxContinuations: DEFAULT_MAX_CONTINUATIONS,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });

  it("rejects an empty objective and clamps options", () => {
    expect(createGoal("   ")).toBeNull();
    const goal = createGoal("ship it", { tokenBudget: 12_500.9, maxContinuations: 999, now });
    expect(goal?.tokenBudget).toBe(12_500);
    expect(goal?.maxContinuations).toBe(MAX_GOAL_CONTINUATIONS);
    expect(createGoal("ship it", { tokenBudget: -5, maxContinuations: 0 })?.tokenBudget).toBeNull();
    expect(createGoal("ship it", { maxContinuations: 0 })?.maxContinuations).toBe(1);
  });

  it("sanitizes persisted goals tolerantly", () => {
    const goal = sanitizeGoal(
      {
        objective: "fix the flaky test",
        status: "banana",
        tokenBudget: 500,
        tokensUsed: 120.7,
        continuations: 2,
        maxContinuations: 8,
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "not-a-date",
        note: "  needs context  ",
        nextAction: " rerun the failing suite ",
      },
      now,
    );
    expect(goal).toEqual({
      objective: "fix the flaky test",
      status: "paused",
      tokenBudget: 500,
      tokensUsed: 120,
      continuations: 2,
      maxContinuations: 8,
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: now.toISOString(),
      note: "needs context",
      nextAction: "rerun the failing suite",
    });
    expect(sanitizeGoal(null)).toBeNull();
    expect(sanitizeGoal({ status: "active" })).toBeNull();
  });

  it("reports budget progress", () => {
    const goal = createGoal("ship", { tokenBudget: 1_000, now })!;
    expect(goalBudgetLeft(goal)).toBe(1_000);
    expect(goalBudgetExhausted(goal)).toBe(false);
    goal.tokensUsed = 1_000;
    expect(goalBudgetLeft(goal)).toBe(0);
    expect(goalBudgetExhausted(goal)).toBe(true);
    expect(goalBudgetLeft({ ...goal, tokenBudget: null })).toBeNull();
  });
});

describe("goal prompts", () => {
  it("injects only live goals into the system prompt", () => {
    const goal = createGoal("finish the migration", { tokenBudget: 2_000, now })!;
    goal.tokensUsed = 500;
    goal.nextAction = "run the migration tests";
    const block = goalStateBlock(goal);
    expect(block).toContain('<goal_state status="active">');
    expect(block).toContain("Objective: finish the migration");
    expect(block).toContain("500 / 2,000");
    expect(block).toContain("Next action: run the migration tests");
    expect(goalStateBlock({ ...goal, status: "completed" })).toBe("");
    expect(goalStateBlock(null)).toBe("");
  });

  it("wraps a continuation as a recognizable reminder", () => {
    const goal = createGoal("finish the migration", { tokenBudget: 2_000, now })!;
    goal.tokensUsed = 500;
    goal.continuations = 3;
    goal.nextAction = "run the migration tests";
    const prompt = goalContinuationPrompt(goal);
    expect(prompt).toContain('<system-reminder event="GoalContinuation">');
    expect(prompt).toContain("Goal: finish the migration");
    expect(prompt).toContain("continuation 3 / 10");
    expect(prompt).toContain("1,500 tokens left of 2,000");
    expect(prompt).toContain("Last verifier next action: run the migration tests");
    expect(prompt).not.toContain("</system-reminder>\n</system-reminder>");
  });

  it("builds a bounded verification prompt", () => {
    const goal = createGoal("finish the migration", { now })!;
    goal.nextAction = "check CI";
    const prompt = buildGoalVerificationPrompt(goal, "x".repeat(10_000));
    expect(prompt).toContain("Goal: finish the migration");
    expect(prompt).toContain("Previous next action: check CI");
    expect(prompt).toContain("[... excerpt truncated]");
    expect(prompt).toContain('"done":boolean');
  });
});

describe("goal verification parsing", () => {
  it("parses strict JSON and code-fenced JSON", () => {
    expect(parseGoalVerification('{"done":false,"nextAction":"run tests","reason":"not run yet"}')).toEqual({
      done: false,
      nextAction: "run tests",
      reason: "not run yet",
    });
    expect(parseGoalVerification('```json\n{"done":true,"reason":"all green"}\n```')).toEqual({
      done: true,
      reason: "all green",
    });
    expect(parseGoalVerification('sure: {"done": "false", "nextAction": "retry"}')).toEqual({
      done: false,
      nextAction: "retry",
    });
  });

  it("rejects malformed verdicts", () => {
    expect(parseGoalVerification("")).toBeNull();
    expect(parseGoalVerification("not json")).toBeNull();
    expect(parseGoalVerification('{"nextAction":"x"}')).toBeNull();
  });
});

describe("/goal parsing", () => {
  it("handles lifecycle and status commands", () => {
    expect(parseGoalCommand([])).toEqual({ action: "status" });
    expect(parseGoalCommand(["pause"])).toEqual({ action: "pause" });
    expect(parseGoalCommand(["resume"])).toEqual({ action: "resume" });
    expect(parseGoalCommand(["done"])).toEqual({ action: "complete" });
    expect(parseGoalCommand(["clear"])).toEqual({ action: "clear" });
    expect(parseGoalCommand(["budget", "50000"])).toEqual({ action: "budget", tokenBudget: 50_000 });
    expect(parseGoalCommand(["budget", "off"])).toEqual({ action: "budget", tokenBudget: null });
    expect(parseGoalCommand(["max", "5"])).toEqual({ action: "max", maxContinuations: 5 });
    expect(parseGoalCommand(["max", "0"]).action).toBe("error");
  });

  it("parses an objective with budget and max flags in any position", () => {
    expect(parseGoalCommand(["fix", "the", "build", "--budget", "12000", "--max", "4"])).toEqual({
      action: "set",
      objective: "fix the build",
      tokenBudget: 12_000,
      maxContinuations: 4,
    });
    expect(parseGoalCommand(["set", "--budget=8000", "ship", "it"])).toEqual({
      action: "set",
      objective: "ship it",
      tokenBudget: 8_000,
      maxContinuations: undefined,
    });
    expect(parseGoalCommand(["--tokens", "1000", "keep", "going"])).toEqual({
      action: "set",
      objective: "keep going",
      tokenBudget: 1_000,
      maxContinuations: undefined,
    });
  });

  it("rejects missing objectives and bad flag values", () => {
    expect(parseGoalCommand(["--budget", "1000"]).action).toBe("error");
    expect(parseGoalCommand(["fix", "--budget"]).action).toBe("error");
    expect(parseGoalCommand(["fix", "--budget", "many"]).action).toBe("error");
    expect(parseGoalCommand(["fix", "--max", "999"]).action).toBe("error");
    expect(parseGoalCommand(["budget"]).action).toBe("error");
  });
});

describe("formatGoal", () => {
  it("describes an empty slot and a live goal", () => {
    expect(formatGoal(null)).toContain("no goal set");
    const goal = createGoal("ship it", { tokenBudget: 2_000, maxContinuations: 5, now })!;
    goal.tokensUsed = 500;
    goal.continuations = 2;
    goal.nextAction = "run tests";
    const text = formatGoal(goal);
    expect(text).toContain("[active] ship it");
    expect(text).toContain("500 / 2,000 used (25%)");
    expect(text).toContain("continuations: 2 / 5");
    expect(text).toContain("next action: run tests");
  });
});
