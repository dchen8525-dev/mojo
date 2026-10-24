import type { AgentEvents } from "./agent.js";
import type { Risk } from "./types.js";

/**
 * Headless NDJSON contract for print mode (--output-format stream-json).
 *
 * stdout carries exactly one JSON object per line and nothing else; human
 * diagnostics stay on stderr. Events, in a typical order:
 *
 *   {"type":"system","subtype":"init",...}   session identity, once
 *   {"type":"round_start","round":1}
 *   {"type":"text_delta","delta":"..."}      streamed assistant text
 *   {"type":"thinking_delta","delta":"..."}  reasoning delta (when the model streams it)
 *   {"type":"tool_start","id","name","input_preview","input"?}
 *   {"type":"sub_tool_start","parent_id","name","input_preview","round"?}
 *   {"type":"sub_tool","parent_id","name","input_preview","ok","preview","round"?}
 *   {"type":"tool_end","id","name","ok","preview"}   preview is truncated
 *   {"type":"session_title","title"}         first turn only, when generated
 *   {"type":"goal_changed","goal","note"?}   session goal started/paused/completed
 *   {"type":"goal_checking"}                 the verifier call is in flight
 *   {"type":"usage","input","output"}        per model response
 *   {"type":"compacting"} / {"type":"compacted","before","after"}
 *   {"type":"retry","attempt","max_attempts","delay_ms","reason","status"?}
 *   {"type":"stream_recovery","attempt","max_attempts","mode","discarded_chars","delay_ms","reason"}
 *   {"type":"cost_warning","message"}
 *   {"type":"hook","event","message"}
 *   {"type":"plan_approved"}
 *   {"type":"permission","description","risk","decision","rule"?}
 *   {"type":"result","subtype":"success"|"error"|"aborted","text",...}  last
 *
 * Field names are snake_case to match the wider headless-agent ecosystem.
 * Every event carries an ISO `ts` timestamp. Human-readable print-mode text
 * (the interactive permission prompt) goes to stderr through `human()`, so a
 * terminal run still has a pure NDJSON stdout.
 */

export type PermissionDecision = "yes" | "no" | "session" | "project" | "always" | "always_deny";

export interface NdjsonInit {
  sessionId: string;
  cwd: string;
  permissionMode: string;
  planMode: boolean;
}

export interface NdjsonEvents {
  /** The system/init line; call once the provider and model are resolved. */
  init: (model: string) => void;
  events: AgentEvents;
  /** Wraps the permission ask callback so every decision is observable. */
  wrapPermission: (
    ask: (
      description: string,
      risk: Risk,
      preview?: string,
      meta?: { tool: string; rule: string },
    ) => Promise<PermissionDecision>,
  ) => (
    description: string,
    risk: Risk,
    preview?: string,
    meta?: { tool: string; rule: string },
  ) => Promise<PermissionDecision>;
  /** The final result line; call once when the turn settles. */
  result: (subtype: "success" | "error" | "aborted", text: string, info: { durationMs: number; tokens: number; costUsd: number; provider: string; model: string }) => void;
  /**
   * Human-readable print-mode text (permission prompts and previews). stdout
   * belongs to the event stream, so this must never write there.
   */
  human: (line: string) => void;
}

export function createNdjsonEvents(
  init: NdjsonInit,
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  human: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): NdjsonEvents {
  const emit = (event: Record<string, unknown>) => write(JSON.stringify({ ts: new Date().toISOString(), ...event }));

  return {
    init: (model) =>
      emit({
        type: "system",
        subtype: "init",
        session_id: init.sessionId,
        cwd: init.cwd,
        model,
        permission_mode: init.permissionMode,
        plan_mode: init.planMode,
      }),
    events: {
      onRoundStart: (round) => emit({ type: "round_start", round }),
      onTextDelta: (delta) => emit({ type: "text_delta", delta }),
      onThinkingDelta: (delta) => emit({ type: "thinking_delta", delta }),
      onToolStart: (id, name, inputPreview, input) =>
        emit({ type: "tool_start", id, name, input_preview: inputPreview, ...(input ? { input } : {}) }),
      onToolEnd: (id, name, ok, preview) => emit({ type: "tool_end", id, name, ok, preview }),
      onSubToolStart: (parentId, name, inputPreview, round) =>
        emit({ type: "sub_tool_start", parent_id: parentId, name, input_preview: inputPreview, ...(round ? { round } : {}) }),
      onSubTool: (parentId, name, inputPreview, ok, preview, round) =>
        emit({ type: "sub_tool", parent_id: parentId, name, input_preview: inputPreview, ok, preview, ...(round ? { round } : {}) }),
      onSessionTitle: (title) => emit({ type: "session_title", title }),
      onGoalChanged: (goal, note) =>
        emit({
          type: "goal_changed",
          goal: goal
            ? {
                objective: goal.objective,
                status: goal.status,
                token_budget: goal.tokenBudget,
                tokens_used: goal.tokensUsed,
                continuations: goal.continuations,
                max_continuations: goal.maxContinuations,
                updated_at: goal.updatedAt,
                ...(goal.nextAction ? { next_action: goal.nextAction } : {}),
                ...(goal.note ? { note: goal.note } : {}),
              }
            : null,
          ...(note ? { note } : {}),
        }),
      onGoalChecking: () => emit({ type: "goal_checking" }),
      onUsage: (input, output) => emit({ type: "usage", input, output }),
      onCompacting: () => emit({ type: "compacting" }),
      onCompacted: (before, after) => emit({ type: "compacted", before, after }),
      onRetry: (info) =>
        emit({
          type: "retry",
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          delay_ms: info.delayMs,
          reason: info.reason,
          ...(info.status !== undefined ? { status: info.status } : {}),
        }),
      onStreamRecovery: (info) =>
        emit({
          type: "stream_recovery",
          attempt: info.attempt,
          max_attempts: info.maxAttempts,
          mode: info.mode,
          discarded_chars: info.discardedChars,
          delay_ms: info.delayMs,
          reason: info.reason,
        }),
      onCostWarning: (message) => emit({ type: "cost_warning", message }),
      onHook: (event, message) => emit({ type: "hook", event, message }),
      onPlanApproved: () => emit({ type: "plan_approved" }),
    },
    wrapPermission:
      (ask) =>
      async (
        description: string,
        risk: Risk,
        preview?: string,
        meta?: { tool: string; rule: string },
      ) => {
        const decision = await ask(description, risk, preview, meta);
        emit({ type: "permission", description, risk, decision, ...(meta ? { rule: meta.rule } : {}) });
        return decision;
      },
    result: (subtype, text, info) => {
      emit({
        type: "result",
        subtype,
        text,
        duration_ms: info.durationMs,
        tokens: info.tokens,
        cost_usd: info.costUsd,
        provider: info.provider,
        model: info.model,
      });
    },
    human,
  };
}
