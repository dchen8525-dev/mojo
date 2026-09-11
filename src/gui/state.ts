import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { Risk } from "../types.js";
import type { SseHub } from "./sse.js";
import type { UiTurn } from "./transcript.js";

export type PermissionDecision = "yes" | "no" | "always" | "always_deny";

/**
 * Mutable state shared by the HTTP routes: the single running turn, pending
 * permission prompts, and the SSE hub used to wake the UI. One agent serves
 * one turn at a time; everything the UI needs to redraw after a reconnect
 * lives here (or in /api/state).
 */
export class GuiRuntime {
  busy = false;
  turnId = 0;
  controller: AbortController | null = null;
  /** In-flight turn, accumulated from events so a reconnecting tab can recover. */
  liveTurn: UiTurn | null = null;
  agent!: Agent;
  permissions!: PermissionManager;
  private pending = new Map<string, { resolve: (d: PermissionDecision) => void; description: string; risk: Risk; preview?: string }>();

  constructor(readonly hub: SseHub) {}

  /** Wire the agent + permission manager once they exist (backend assembly order). */
  attach(agent: Agent, permissions: PermissionManager): void {
    this.agent = agent;
    this.permissions = permissions;
  }

  /**
   * AskUser seam for the PermissionManager: broadcast a request, park its
   * resolver, and await the client's decision. Resolves "no" if flushed.
   */
  askPermission = (description: string, risk: Risk, preview?: string): Promise<PermissionDecision> => {
    const id = randomUUID();
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, { resolve, description, risk, preview });
      this.hub.broadcast("permission_request", { id, description, risk, preview });
    });
  };

  /** Outstanding prompts, so a reconnecting client can re-show the modal. */
  pendingPermissions(): Array<{ id: string; description: string; risk: Risk; preview?: string }> {
    return [...this.pending.entries()].map(([id, p]) => ({
      id,
      description: p.description,
      risk: p.risk,
      preview: p.preview,
    }));
  }

  /** Resolve a pending prompt. Returns false when it was already answered. */
  respond(id: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }

  /**
   * Answer every outstanding prompt with "no". Called on abort and when the
   * last client disconnects — without it a turn blocked on a prompt would
   * hang forever.
   */
  flushPermissions(): void {
    for (const entry of this.pending.values()) entry.resolve("no");
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
