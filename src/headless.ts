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
 *   {"type":"tool_start","id","name","input_preview","input"?}
 *   {"type":"tool_end","id","name","ok","preview"}   preview is truncated
 *   {"type":"usage","input","output"}        per model response
 *   {"type":"compacting"} / {"type":"compacted","before","after"}
 *   {"type":"retry","attempt","max_attempts","delay_ms","reason","status"?}
 *   {"type":"permission","description","risk","decision"}
 *   {"type":"result","subtype":"success"|"error"|"aborted","text",...}  last
 *
 * Field names are snake_case to match the wider headless-agent ecosystem.
 * Every event carries an ISO `ts` timestamp.
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
    ask: (description: string, risk: Risk, preview?: string) => Promise<PermissionDecision>,
  ) => (description: string, risk: Risk, preview?: string) => Promise<PermissionDecision>;
  /** The final result line; call once when the turn settles. */
  result: (subtype: "success" | "error" | "aborted", text: string, info: { durationMs: number; tokens: number; costUsd: number; provider: string; model: string }) => void;
}

export function createNdjsonEvents(
  init: NdjsonInit,
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
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
      onSubTool: (parentId, name, inputPreview, ok, preview, round) =>
        emit({ type: "sub_tool", parent_id: parentId, name, input_preview: inputPreview, ok, preview, ...(round ? { round } : {}) }),
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
      onCostWarning: (message) => emit({ type: "cost_warning", message }),
      onHook: (event, message) => emit({ type: "hook", event, message }),
      onPlanApproved: () => emit({ type: "plan_approved" }),
    },
    wrapPermission:
      (ask) =>
      async (description: string, risk: Risk, preview?: string) => {
        const decision = await ask(description, risk, preview);
        emit({ type: "permission", description, risk, decision });
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
  };
}
