import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvedPlanReminder,
  copyPlanFile,
  planFilePath,
  planForInjection,
  planVisibleIn,
  readPlanFile,
  writePlanFile,
} from "../src/planFile.js";
import type { MessageParam } from "../src/types.js";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-planfile-"));
});

const PLAN = "# Plan: rebuild the widget\n\n1. Refactor src/widget.ts\n2. Add tests\n";

describe("planFile store", () => {
  it("writes, reads, and copies per session id", async () => {
    await writePlanFile(cwd, "sess1", PLAN);
    expect(await readPlanFile(cwd, "sess1")).toBe(PLAN.trimEnd() + "\n");
    expect(await readPlanFile(cwd, "sess2")).toBeNull();
    await copyPlanFile(cwd, "sess1", "sess2");
    expect(await readPlanFile(cwd, "sess2")).toBe(PLAN.trimEnd() + "\n");
    expect(planFilePath(cwd, "weird/id")).toContain("plan-weird_id.md");
  });

  it("returns null for a session without a plan", async () => {
    expect(await readPlanFile(cwd, "none")).toBeNull();
  });
});

describe("planVisibleIn", () => {
  const msgs: MessageParam[] = [
    { role: "user", content: "please do it" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "here is my plan" } as never,
        { type: "tool_use", id: "tu1", name: "exit_plan", input: { plan: PLAN } } as never,
      ],
    },
  ];

  it("finds the plan inside an exit_plan tool_use input", () => {
    expect(planVisibleIn(msgs, PLAN)).toBe(true);
  });

  it("finds the plan in a plain text block", () => {
    const withText: MessageParam[] = [{ role: "user", content: "# Plan: rebuild the widget\n...rest" }];
    expect(planVisibleIn(withText, PLAN)).toBe(true);
  });

  it("returns false when only unrelated content is present", () => {
    expect(planVisibleIn(msgs.slice(0, 1), PLAN)).toBe(false);
  });

  it("treats a markerless plan as visible (never re-injects)", () => {
    expect(planVisibleIn([], "   ")).toBe(true);
  });
});

describe("plan injection helpers", () => {
  it("bounds the injected plan with a truncation marker", () => {
    expect(planForInjection(PLAN)).toBe(PLAN.trim());
    const big = "# Plan: huge\n" + "x".repeat(20_000);
    const cut = planForInjection(big);
    expect(cut.length).toBeLessThan(20_500);
    expect(cut).toContain("[truncated");
  });

  it("wraps the reminder with the ApprovedPlan event", () => {
    const r = approvedPlanReminder(PLAN);
    expect(r).toContain('event="ApprovedPlan"');
    expect(r).toContain("rebuild the widget");
  });
});
