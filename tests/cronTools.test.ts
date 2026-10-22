import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/cron.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cron.js")>("../src/cron.js");
  return {
    ...actual,
    loadCronTasks: async () => store.tasks.map((t) => ({ ...t })),
    createCronTask: async (input: { name?: string; cron: string; prompt: string; cwd: string; enabled?: boolean }) => {
      const task = {
        id: "cr_new0001",
        name: input.name || input.prompt.slice(0, 20),
        cron: input.cron,
        prompt: input.prompt,
        cwd: input.cwd,
        enabled: input.enabled !== false,
        createdAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
        runCount: 0,
      };
      store.tasks.push(task);
      return { ...task };
    },
    deleteCronTask: async (id: string) => {
      const index = store.tasks.findIndex((t) => t.id === id);
      if (index < 0) return false;
      store.tasks.splice(index, 1);
      return true;
    },
  };
});

import { cronCreateTool, cronDeleteTool, cronListTool } from "../src/tools/cron.js";
import type { ToolContext } from "../src/types.js";

function ctx(approved = true): { ctx: ToolContext; asked: Array<{ desc: string; risk: string }> } {
  const asked: Array<{ desc: string; risk: string }> = [];
  return {
    asked,
    ctx: {
      cwd: "/tmp/repo",
      askPermission: async (desc, risk) => {
        asked.push({ desc, risk });
        return approved;
      },
    },
  };
}

beforeEach(() => {
  store.tasks = [];
});

afterEach(() => {
  delete process.env.AGENT_CRON_RUN;
});

describe("cron tools", () => {
  it("creates a task after high-risk approval and defaults cwd to the session", async () => {
    const { ctx: c, asked } = ctx();
    const r = await cronCreateTool.execute({ cron: "0 9 * * 1-5", prompt: "summarize commits", name: "daily" }, c);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("cr_new0001");
    expect(r.content).toContain("daily");
    expect(asked).toHaveLength(1);
    expect(asked[0].risk).toBe("high");
    expect(asked[0].desc).toContain("0 9 * * 1-5");
    expect(store.tasks[0]).toMatchObject({ cwd: "/tmp/repo", enabled: true });
  });

  it("rejects invalid expressions before asking for approval", async () => {
    const { ctx: c, asked } = ctx();
    const r = await cronCreateTool.execute({ cron: "* * * *", prompt: "x" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("5 fields");
    expect(asked).toHaveLength(0);
  });

  it("honours a denied approval", async () => {
    const { ctx: c } = ctx(false);
    const r = await cronCreateTool.execute({ cron: "* * * * *", prompt: "x" }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Denied");
    expect(store.tasks).toHaveLength(0);
  });

  it("lists tasks, including an empty ledger", async () => {
    expect((await cronListTool.execute({}, ctx().ctx)).content).toContain("No scheduled tasks");
    store.tasks.push({
      id: "cr_list0001",
      name: "daily",
      cron: "0 9 * * *",
      prompt: "p",
      cwd: "/tmp/repo",
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      runCount: 0,
    });
    const r = await cronListTool.execute({}, ctx().ctx);
    expect(r.content).toContain("cr_list0001");
    expect(r.content).toContain("0 9 * * *");
  });

  it("deletes a task after approval and reports missing ids", async () => {
    store.tasks.push({
      id: "cr_del0001",
      name: "old",
      cron: "0 9 * * *",
      prompt: "p",
      cwd: "/tmp/repo",
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
      runCount: 0,
    });
    const { ctx: c, asked } = ctx();
    const r = await cronDeleteTool.execute({ id: "cr_del0001" }, c);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Deleted");
    expect(asked[0].risk).toBe("high");
    expect(store.tasks).toHaveLength(0);

    const missing = await cronDeleteTool.execute({ id: "cr_del0001" }, c);
    expect(missing.isError).toBe(true);
  });

  it("blocks schedule mutations inside a scheduled run but allows listing", async () => {
    process.env.AGENT_CRON_RUN = "cr_parent";
    const create = await cronCreateTool.execute({ cron: "* * * * *", prompt: "loop" }, ctx().ctx);
    expect(create.isError).toBe(true);
    expect(create.content).toMatch(/cannot create/);
    const del = await cronDeleteTool.execute({ id: "cr_x" }, ctx().ctx);
    expect(del.isError).toBe(true);
    expect(del.content).toMatch(/cannot modify/);
    const list = await cronListTool.execute({}, ctx().ctx);
    expect(list.isError).toBeUndefined();
  });
});
