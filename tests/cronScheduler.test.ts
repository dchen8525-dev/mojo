import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCronTask, cronFilePath, loadCronTasks, cronRunsDir, startCronRun, type CronTask } from "../src/cron.js";
import {
  CronScheduler,
  createProcessRunner,
  cronLeasePath,
  type CronRunResult,
} from "../src/cronScheduler.js";

let home: string;
let project: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cron-sched-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "cron-proj-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

async function forceDue(): Promise<CronTask> {
  const file = cronFilePath(home);
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { tasks: CronTask[] };
  parsed.tasks[0].nextRunAt = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
  return parsed.tasks[0];
}

function silent(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

describe("CronScheduler", () => {
  it("claims due tasks under the lease and records the outcome", async () => {
    const task = await createCronTask({ cron: "* * * * *", prompt: "tick", cwd: project }, home);
    await forceDue();
    const calls: string[] = [];
    const result: CronRunResult = { ok: true, log: "/tmp/log" };
    const { log } = silent();
    const scheduler = new CronScheduler({
      home,
      intervalMs: 60_000,
      log,
      runner: async (t) => {
        calls.push(t.id);
        return result;
      },
    });
    try {
      expect(await scheduler.start()).toBe(true);
      expect(calls).toEqual([task.id]);
      const [stored] = await loadCronTasks(home);
      expect(stored.lastStatus).toBe("ok");
      expect(stored.runCount).toBe(1);
      expect(stored.lastLog).toBe("/tmp/log");
      expect(stored.nextRunAt).toBeTruthy();
      expect(await fs.stat(cronLeasePath(home))).toBeTruthy();
    } finally {
      await scheduler.stop();
    }
    await expect(fs.stat(cronLeasePath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stays in standby while another live process owns the lease", async () => {
    await createCronTask({ cron: "* * * * *", prompt: "tick", cwd: project }, home);
    await forceDue();
    await fs.mkdir(path.dirname(cronLeasePath(home)), { recursive: true });
    await fs.writeFile(cronLeasePath(home), JSON.stringify({ pid: process.ppid }), "utf8");
    const calls: string[] = [];
    const { log } = silent();
    const scheduler = new CronScheduler({ home, intervalMs: 60_000, log, runner: async (t) => (calls.push(t.id), { ok: true }) });
    try {
      expect(await scheduler.start()).toBe(false);
      expect(scheduler.isOwner).toBe(false);
      expect(calls).toEqual([]);
      expect((await loadCronTasks(home))[0].lastStatus).toBeUndefined();
      // The other owner's lease survives our shutdown.
      expect(await fs.readFile(cronLeasePath(home), "utf8")).toContain(String(process.ppid));
    } finally {
      await scheduler.stop();
    }
  });

  it("grants the lease to exactly one of two simultaneous schedulers", async () => {
    const mk = () => new CronScheduler({ home, intervalMs: 60_000, log: () => {}, runner: async () => ({ ok: true }) });
    const a = mk();
    const b = mk();
    try {
      const [ownerA, ownerB] = await Promise.all([a.start(), b.start()]);
      expect(Number(ownerA) + Number(ownerB)).toBe(1);
      expect(a.isOwner).not.toBe(b.isOwner);
      const lease = JSON.parse(await fs.readFile(cronLeasePath(home), "utf8")) as { token?: string };
      expect(lease.token).toBeTruthy();
      // Stopping the standby must leave the live owner's lease untouched.
      await (ownerA ? b : a).stop();
      const after = JSON.parse(await fs.readFile(cronLeasePath(home), "utf8")) as { token?: string };
      expect(after.token).toBe(lease.token);
    } finally {
      await a.stop();
      await b.stop();
    }
    await expect(fs.stat(cronLeasePath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes over a lease left by a dead process", async () => {
    await createCronTask({ cron: "* * * * *", prompt: "tick", cwd: project }, home);
    const deadPid = 2147483647;
    await fs.mkdir(path.dirname(cronLeasePath(home)), { recursive: true });
    await fs.writeFile(cronLeasePath(home), JSON.stringify({ pid: deadPid }), "utf8");
    const { log } = silent();
    const scheduler = new CronScheduler({ home, intervalMs: 60_000, log, runner: async () => ({ ok: true }) });
    try {
      expect(await scheduler.start()).toBe(true);
      const lease = JSON.parse(await fs.readFile(cronLeasePath(home), "utf8")) as { pid: number };
      expect(lease.pid).toBe(process.pid);
    } finally {
      await scheduler.stop();
    }
  });

  it("takes over a lease whose pid is alive but heartbeats stopped", async () => {
    const file = cronLeasePath(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, token: "someone-else" }), "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    const { log, lines } = silent();
    const scheduler = new CronScheduler({
      home,
      intervalMs: 60_000,
      heartbeatMs: 1000,
      leaseStaleMs: 5000,
      log,
      runner: async () => ({ ok: true }),
    });
    try {
      expect(await scheduler.start()).toBe(true);
      const lease = JSON.parse(await fs.readFile(file, "utf8")) as { token?: string };
      expect(lease.token).not.toBe("someone-else");
      expect(lines.some((l) => l.includes("without a heartbeat"))).toBe(true);
    } finally {
      await scheduler.stop();
    }
  });

  it("refreshes the lease mtime while it owns the scheduler", async () => {
    const file = cronLeasePath(home);
    const { log } = silent();
    const scheduler = new CronScheduler({
      home,
      intervalMs: 60_000,
      heartbeatMs: 25,
      leaseStaleMs: 5000,
      log,
      runner: async () => ({ ok: true }),
    });
    try {
      expect(await scheduler.start()).toBe(true);
      const first = (await fs.stat(file)).mtimeMs;
      let latest = first;
      const deadline = Date.now() + 2000;
      while (latest <= first && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        latest = (await fs.stat(file)).mtimeMs;
      }
      expect(latest).toBeGreaterThan(first);
    } finally {
      await scheduler.stop();
    }
  });

  it("refuses a manual run when another process already started it", async () => {
    const task = await createCronTask({ cron: "0 9 * * *", prompt: "manual", cwd: project }, home);
    await startCronRun(task.id, new Date(), home);
    const scheduler = new CronScheduler({ home, intervalMs: 60_000, log: () => {}, runner: async () => ({ ok: true }) });
    try {
      const r = await scheduler.runNow(task.id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already running/);
    } finally {
      await scheduler.stop();
    }
  });

  it("runs a task on demand without changing its schedule", async () => {
    const task = await createCronTask({ cron: "0 9 * * *", prompt: "manual", cwd: project, enabled: false }, home);
    const before = task.nextRunAt;
    const { log } = silent();
    let runs = 0;
    let changes = 0;
    const scheduler = new CronScheduler({
      home,
      intervalMs: 60_000,
      log,
      onChange: () => changes++,
      runner: async () => {
        runs++;
        return { ok: true };
      },
    });
    try {
      const r = await scheduler.runNow(task.id);
      expect(r.ok).toBe(true);
      expect(runs).toBe(1);
      expect(changes).toBe(1);
      const [stored] = await loadCronTasks(home);
      expect(stored.lastStatus).toBe("ok");
      expect(stored.nextRunAt).toBe(before);
      expect(stored.enabled).toBe(false);
      expect((await scheduler.runNow("missing")).ok).toBe(false);
    } finally {
      await scheduler.stop();
    }
  });

  it("does not start inside a scheduled run", async () => {
    const previous = process.env.AGENT_CRON_RUN;
    process.env.AGENT_CRON_RUN = "cr_inside";
    const scheduler = new CronScheduler({ home, intervalMs: 60_000, log: () => {} });
    try {
      expect(await scheduler.start()).toBe(false);
      expect(scheduler.isOwner).toBe(false);
    } finally {
      await scheduler.stop();
      if (previous === undefined) delete process.env.AGENT_CRON_RUN;
      else process.env.AGENT_CRON_RUN = previous;
    }
  });

  it("survives a runner that throws and records the error", async () => {
    await createCronTask({ cron: "* * * * *", prompt: "boom", cwd: project }, home);
    await forceDue();
    const { log } = silent();
    const scheduler = new CronScheduler({
      home,
      intervalMs: 60_000,
      log,
      runner: async () => {
        throw new Error("runner exploded");
      },
    });
    try {
      await scheduler.start();
      const [stored] = await loadCronTasks(home);
      expect(stored.lastStatus).toBe("error");
      expect(stored.lastError).toBe("runner exploded");
    } finally {
      await scheduler.stop();
    }
  });
});

describe("createProcessRunner", () => {
  it("spawns the configured CLI with cron context and captures output", async () => {
    const script = path.join(project, "fake-cli.mjs");
    await fs.writeFile(
      script,
      'console.log("prompt:" + process.argv.slice(2).join(" "));\nconsole.error("env:" + process.env.AGENT_CRON_RUN);\nprocess.exit(0);\n',
      "utf8",
    );
    const previous = process.env.AGENT_CLI_ENTRY;
    process.env.AGENT_CLI_ENTRY = script;
    const task = await createCronTask({ cron: "* * * * *", prompt: "hello cron", cwd: project }, home);
    try {
      const runner = createProcessRunner({ home, timeoutMs: 20_000 });
      const r = await runner(task);
      expect(r.ok).toBe(true);
      expect(r.log).toBeTruthy();
      const log = await fs.readFile(r.log!, "utf8");
      expect(log).toContain("-p hello cron --auto --no-lsp");
      expect(log).toContain(`env:${task.id}`);
      expect(log).toContain("# exit 0");
      const files = await fs.readdir(cronRunsDir(home));
      expect(files).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.AGENT_CLI_ENTRY;
      else process.env.AGENT_CLI_ENTRY = previous;
    }
  });

  it("reports a nonzero exit with the stderr tail", async () => {
    const script = path.join(project, "fail-cli.mjs");
    await fs.writeFile(script, 'console.error("no api key");\nprocess.exit(2);\n', "utf8");
    const previous = process.env.AGENT_CLI_ENTRY;
    process.env.AGENT_CLI_ENTRY = script;
    const task = await createCronTask({ cron: "* * * * *", prompt: "fail", cwd: project }, home);
    try {
      const r = await createProcessRunner({ home, timeoutMs: 20_000 })(task);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("exit code 2");
      expect(r.error).toContain("no api key");
    } finally {
      if (previous === undefined) delete process.env.AGENT_CLI_ENTRY;
      else process.env.AGENT_CLI_ENTRY = previous;
    }
  });

  it("keeps hand-edited task ids inside the runs directory", async () => {
    const script = path.join(project, "fake-cli.mjs");
    await fs.writeFile(script, "process.exit(0);\n", "utf8");
    const previous = process.env.AGENT_CLI_ENTRY;
    process.env.AGENT_CLI_ENTRY = script;
    const rogue: CronTask = {
      id: "../../escape",
      name: "rogue",
      cron: "* * * * *",
      prompt: "x",
      cwd: project,
      enabled: true,
      createdAt: new Date(0).toISOString(),
      nextRunAt: new Date().toISOString(),
      runCount: 0,
    };
    try {
      const r = await createProcessRunner({ home, timeoutMs: 20_000 })(rogue);
      expect(r.ok).toBe(true);
      expect(path.dirname(r.log!)).toBe(cronRunsDir(home));
      expect(path.basename(r.log!)).toMatch(/^_+escape-\d{4}-/);
    } finally {
      if (previous === undefined) delete process.env.AGENT_CLI_ENTRY;
      else process.env.AGENT_CLI_ENTRY = previous;
    }
  });

  it("kills a run that exceeds the timeout", async () => {
    const script = path.join(project, "slow-cli.mjs");
    await fs.writeFile(script, "setTimeout(() => {}, 60_000);\n", "utf8");
    const previous = process.env.AGENT_CLI_ENTRY;
    process.env.AGENT_CLI_ENTRY = script;
    const task = await createCronTask({ cron: "* * * * *", prompt: "slow", cwd: project }, home);
    try {
      const r = await createProcessRunner({ home, timeoutMs: 2_000 })(task);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/timed out/);
    } finally {
      if (previous === undefined) delete process.env.AGENT_CLI_ENTRY;
      else process.env.AGENT_CLI_ENTRY = previous;
    }
  }, 30_000);
});
