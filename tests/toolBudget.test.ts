import { describe, expect, it } from "vitest";
import { nextToolBudgetWarning, TOOL_CALL_BUDGET } from "../src/toolBudget.js";

describe("nextToolBudgetWarning", () => {
  it("stays quiet below the first threshold", () => {
    expect(nextToolBudgetWarning(0, 0)).toBeNull();
    expect(nextToolBudgetWarning(49, 0)).toBeNull();
  });

  it("fires once per threshold and reports the count and percentage", () => {
    const first = nextToolBudgetWarning(50, 0);
    expect(first).not.toBeNull();
    expect(first!.warned).toBe(1);
    expect(first!.text).toContain(`50/${TOOL_CALL_BUDGET}`);
    expect(first!.text).toContain("50%");
    expect(first!.text).toContain("Start converging");

    const second = nextToolBudgetWarning(75, first!.warned);
    expect(second!.warned).toBe(2);
    expect(second!.text).toContain("75%");

    const third = nextToolBudgetWarning(90, second!.warned);
    expect(third!.warned).toBe(3);
    expect(third!.text).toContain("90%");
  });

  it("does not repeat a threshold already warned", () => {
    expect(nextToolBudgetWarning(60, 1)).toBeNull();
    expect(nextToolBudgetWarning(80, 2)).toBeNull();
  });

  it("caps the number of warnings", () => {
    expect(nextToolBudgetWarning(500, 3)).toBeNull();
  });

  it("emits every threshold skipped by one large jump", () => {
    const seen: number[] = [];
    let warned = 0;
    let warning = nextToolBudgetWarning(95, warned);
    while (warning) {
      seen.push(warning.warned);
      warned = warning.warned;
      warning = nextToolBudgetWarning(95, warned);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});
