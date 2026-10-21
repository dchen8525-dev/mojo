/**
 * Registry for subagents started detached (task tool with run_in_background).
 * A detached subagent keeps running across tool rounds and turn boundaries;
 * finished tasks are drained by the agent at round boundaries and injected
 * into the conversation as a system-reminder, or polled via task_output.
 */
export interface AgentTask {
  id: string;
  description: string;
  kind: "research" | "worker";
  startedAt: number;
  status: "running" | "done" | "failed";
  report: string;
  delivered: boolean;
}

class SubagentTaskRegistry {
  private tasks = new Map<string, AgentTask>();
  private waiters = new Map<string, Array<() => void>>();
  private next = 1;

  /** Spawn `run` detached; returns the task id immediately. */
  start(description: string, kind: AgentTask["kind"], run: () => Promise<string>): string {
    const id = `sub-${this.next++}`;
    const task: AgentTask = { id, description, kind, startedAt: Date.now(), status: "running", report: "", delivered: false };
    this.tasks.set(id, task);
    void run().then(
      (report) => {
        task.status = "done";
        task.report = report;
        this.settle(id);
      },
      (err) => {
        task.status = "failed";
        task.report = err instanceof Error ? err.message : String(err);
        this.settle(id);
      },
    );
    return id;
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): AgentTask[] {
    return [...this.tasks.values()];
  }

  /** Finished-but-undelivered tasks (oldest first); marks them delivered. */
  drainCompleted(): AgentTask[] {
    const out = this.list().filter((t) => t.status !== "running" && !t.delivered);
    for (const t of out) t.delivered = true;
    return out;
  }

  /** Resolves once the task reaches a terminal state (test/flush helper). */
  whenDone(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return Promise.resolve();
    return new Promise((resolve) => {
      const ws = this.waiters.get(id) ?? [];
      ws.push(resolve);
      this.waiters.set(id, ws);
    });
  }

  reset(): void {
    this.tasks.clear();
    this.waiters.clear();
    this.next = 1;
  }

  private settle(id: string): void {
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }
}

export const subagentTasks = new SubagentTaskRegistry();
