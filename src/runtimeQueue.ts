/**
 * Unified runtime command queue, modeled on ZCode's pendingCommands: inputs
 * submitted while a task is busy are recorded with an explicit lifecycle
 * (accepted → running → done/failed/cancelled) instead of being refused or
 * silently racing the running turn. Two command types share the surface:
 *  - "steer": injected into the running turn at the next round boundary
 *    (Agent.steer()).
 *  - "send_prompt": executed as a full follow-up turn once the current turn
 *    finishes (GUI pump loop).
 */
export type RuntimeCommandType = "steer" | "send_prompt";
export type RuntimeCommandStatus = "accepted" | "running" | "done" | "failed" | "cancelled";

/** Shape of attached images; kept structural to avoid importing agent types. */
export interface RuntimeCommandImage {
  type: "image";
  source: unknown;
}

export interface RuntimeCommand {
  id: string;
  type: RuntimeCommandType;
  prompt: string;
  source: string;
  status: RuntimeCommandStatus;
  error?: string;
  images?: RuntimeCommandImage[];
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export const MAX_RUNTIME_COMMANDS = 20;

export class RuntimeCommandQueue {
  private items: RuntimeCommand[] = [];
  private seq = 0;

  constructor(private onChange?: () => void) {}

  /** Record a command. Returns null when the queue is full (caller decides UX). */
  enqueue(type: RuntimeCommandType, prompt: string, source: string): RuntimeCommand | null {
    const accepted = this.items.filter((c) => c.status === "accepted").length;
    if (accepted >= MAX_RUNTIME_COMMANDS) return null;
    const cmd: RuntimeCommand = {
      id: `cmd-${++this.seq}`,
      type,
      prompt,
      source,
      status: "accepted",
      enqueuedAt: Date.now(),
    };
    this.items.push(cmd);
    this.prune();
    this.onChange?.();
    return cmd;
  }

  list(): RuntimeCommand[] {
    return this.items.map((c) => ({ ...c }));
  }

  /** Pop the oldest accepted command of this type and mark it running. */
  take(type: RuntimeCommandType): RuntimeCommand | undefined {
    const cmd = this.items.find((c) => c.type === type && c.status === "accepted");
    if (!cmd) return undefined;
    cmd.status = "running";
    cmd.startedAt = Date.now();
    this.onChange?.();
    return { ...cmd };
  }

  /** Settle a running command. */
  complete(id: string, error?: string): void {
    const cmd = this.items.find((c) => c.id === id);
    if (!cmd || cmd.status !== "running") return;
    cmd.status = error ? "failed" : "done";
    cmd.error = error;
    cmd.finishedAt = Date.now();
    this.onChange?.();
  }

  /** Cancel one accepted command (never a running one). True when cancelled. */
  cancel(id: string): boolean {
    const cmd = this.items.find((c) => c.id === id);
    if (!cmd || cmd.status !== "accepted") return false;
    cmd.status = "cancelled";
    cmd.finishedAt = Date.now();
    this.onChange?.();
    return true;
  }

  /** Cancel all accepted commands of a type; returns how many were cancelled. */
  cancelAll(type?: RuntimeCommandType): number {
    let n = 0;
    for (const cmd of this.items) {
      if (cmd.status !== "accepted") continue;
      if (type && cmd.type !== type) continue;
      cmd.status = "cancelled";
      cmd.finishedAt = Date.now();
      n++;
    }
    if (n) this.onChange?.();
    return n;
  }

  /**
   * Cancel accepted commands from one source (e.g. "goal" continuations when
   * the user speaks up). Running commands are left alone: their turn owns them.
   */
  cancelBySource(source: string, type?: RuntimeCommandType): number {
    let n = 0;
    for (const cmd of this.items) {
      if (cmd.status !== "accepted" || cmd.source !== source) continue;
      if (type && cmd.type !== type) continue;
      cmd.status = "cancelled";
      cmd.finishedAt = Date.now();
      n++;
    }
    if (n) this.onChange?.();
    return n;
  }

  /** Keep total size bounded: live commands first, then the newest settled ones. */
  private prune(): void {
    if (this.items.length <= MAX_RUNTIME_COMMANDS) return;
    const live = this.items.filter((c) => c.status === "accepted" || c.status === "running");
    const settled = this.items
      .filter((c) => c.status !== "accepted" && c.status !== "running")
      .slice(live.length >= MAX_RUNTIME_COMMANDS ? 0 : -(MAX_RUNTIME_COMMANDS - live.length));
    this.items = [...live, ...settled];
  }
}
