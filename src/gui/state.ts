import { randomUUID } from "node:crypto";
import type { Agent } from "../agent.js";
import type { PermissionManager } from "../permissions.js";
import type { Risk, UserQuestion, UserQuestionAnswer, UserQuestionOutcome, UserQuestionRequest } from "../types.js";
import type { SseHub } from "./sse.js";
import type { UiSubCall, UiTurn } from "./transcript.js";

export type PermissionDecision = "yes" | "no" | "session" | "project" | "always" | "always_deny";

/**
 * Mutable state shared by the HTTP routes: the single running turn, pending
 * permission prompts, and the SSE hub used to wake the UI. One agent serves
 * one turn at a time; everything the UI needs to redraw after a reconnect
 * lives here (or in /api/state).
 */
export class GuiRuntime {
  busy = false;
  /** True while a built-in slash command occupies the runtime. */
  commandBusy = false;
  /** True while the backend is rebinding to another working directory. */
  switching = false;
  turnId = 0;
  controller: AbortController | null = null;
  commandController: AbortController | null = null;
  /** In-flight turn, accumulated from events so a reconnecting tab can recover. */
  liveTurn: UiTurn | null = null;
  /**
   * Subagent call chains keyed by the parent `task` tool id. Kept here so a
   * refresh — which rebuilds the transcript from session history — still shows
   * what the child did (the child's own messages are discarded).
   */
  readonly subCalls = new Map<string, UiSubCall[]>();
  agent!: Agent;
  permissions!: PermissionManager;
  private pending = new Map<string, { resolve: (d: PermissionDecision) => void; description: string; risk: Risk; preview?: string }>();
  private questions = new Map<
    string,
    {
      resolve: (outcome: UserQuestionOutcome) => void;
      questions: UserQuestion[];
      timeoutMs: number;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  constructor(readonly hub: SseHub) {}

  /** Append one subagent call; bounded so a long session cannot grow without limit. */
  recordSubCall(toolId: string, call: UiSubCall): void {
    const list = this.subCalls.get(toolId);
    if (list) {
      if (list.length < 200) list.push(call);
      return;
    }
    // Tool ids are unique per call, so an evicted entry is never matched again.
    if (this.subCalls.size >= 500) {
      const oldest = this.subCalls.keys().next().value;
      if (oldest !== undefined) this.subCalls.delete(oldest);
    }
    this.subCalls.set(toolId, [call]);
  }

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

  /**
   * ask_user transport: broadcast the question, park its resolver, and settle
   * with no answer when the turn aborts (timeout or Stop). Client answers
   * arrive through respondQuestion.
   */
  askUser = (request: UserQuestionRequest, signal?: AbortSignal): Promise<UserQuestionOutcome> => {
    const id = randomUUID();
    return new Promise<UserQuestionOutcome>((resolve) => {
      const entry: {
        resolve: (outcome: UserQuestionOutcome) => void;
        questions: UserQuestion[];
        timeoutMs: number;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, questions: request.questions, timeoutMs: request.timeoutMs, signal };
      const onAbort = () => {
        if (this.questions.get(id) !== entry) return;
        this.questions.delete(id);
        this.hub.broadcast("question_closed", { id, reason: "aborted" });
        resolve({ answers: [], aborted: true });
      };
      entry.onAbort = onAbort;
      this.questions.set(id, entry);
      this.hub.broadcast("question_request", { id, questions: request.questions, timeoutMs: request.timeoutMs });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  /** Outstanding questions, so a reconnecting client can re-show the dialog. */
  pendingQuestions(): Array<{ id: string; questions: UserQuestion[]; timeoutMs: number }> {
    return [...this.questions.entries()].map(([id, q]) => ({
      id,
      questions: q.questions,
      timeoutMs: q.timeoutMs,
    }));
  }

  /** Resolve a pending question. Returns false when it was already resolved. */
  respondQuestion(id: string, answers: UserQuestionAnswer[]): boolean {
    const entry = this.questions.get(id);
    if (!entry) return false;
    this.questions.delete(id);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve({ answers });
    this.hub.broadcast("question_closed", { id, reason: "answered" });
    return true;
  }

  /** Abort every outstanding question (turn stop / last tab closed). */
  flushQuestions(): void {
    for (const [id, entry] of this.questions) {
      if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
      this.hub.broadcast("question_closed", { id, reason: "aborted" });
      entry.resolve({ answers: [], aborted: true });
    }
    this.questions.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
