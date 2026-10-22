import { promises as fs } from "node:fs";
import path from "node:path";
import type { MessageParam } from "./types.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { systemReminder } from "./reminder.js";

/**
 * Approved-plan persistence. When plan mode ends with the user's approval,
 * the plan is written to `.node-agent/plans/plan-<sessionId>.md` and re-injected
 * as a system-reminder whenever it is no longer visible in recent history
 * (e.g. after a compaction, or on /resume), so hours-long executions do not
 * drift from the plan the user actually signed off on.
 */

const MAX_PLAN_CHARS = 12_000;

export function planFilePath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".node-agent", "plans", `plan-${sessionId.replace(/[^\w.-]/g, "_")}.md`);
}

export async function writePlanFile(cwd: string, sessionId: string, plan: string): Promise<string | null> {
  try {
    const p = planFilePath(cwd, sessionId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await atomicWriteFile(p, plan.trimEnd() + "\n");
    return p;
  } catch {
    return null;
  }
}

/** Read the session's approved plan; null when there is none. */
export async function readPlanFile(cwd: string, sessionId: string): Promise<string | null> {
  try {
    const text = await fs.readFile(planFilePath(cwd, sessionId), "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Carry the plan over to a forked session (best-effort). */
export async function copyPlanFile(cwd: string, fromSessionId: string, toSessionId: string): Promise<void> {
  const plan = await readPlanFile(cwd, fromSessionId);
  if (plan) await writePlanFile(cwd, toSessionId, plan);
}

/** The plan bounded for injection, with a truncation marker when cut. */
export function planForInjection(plan: string): string {
  const p = plan.trim();
  return p.length <= MAX_PLAN_CHARS
    ? p
    : p.slice(0, MAX_PLAN_CHARS) + "\n…[truncated — the full plan is at the plan file on disk]";
}

/** The system-reminder form the plan is re-attached with. */
export function approvedPlanReminder(plan: string): string {
  return systemReminder(
    "The user approved this implementation plan earlier and it has left the visible context. " +
      "Follow it; do not silently restart or re-plan:\n\n" +
      planForInjection(plan),
    { event: "ApprovedPlan" },
  );
}

/** The plan's distinctive first non-empty line; matched against flattened history. */
function planMarker(plan: string): string {
  const line = plan.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.slice(0, 200);
}

/**
 * Whether the plan is still visible in the given messages. Text blocks are
 * flattened verbatim; tool_use inputs are scanned as JSON (a single-line
 * marker survives JSON escaping), so an exit_plan call also counts.
 */
export function planVisibleIn(messages: readonly MessageParam[], plan: string): boolean {
  const marker = planMarker(plan);
  if (!marker) return true; // nothing distinctive to find; assume visible
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      if (typeof m.content === "string" && m.content.includes(marker)) return true;
      continue;
    }
    for (const b of m.content) {
      const rec = b as unknown as Record<string, unknown>;
      if (typeof rec.text === "string" && rec.text.includes(marker)) return true;
      if (rec.type === "tool_use" && rec.input && JSON.stringify(rec.input).includes(marker)) return true;
    }
  }
  return false;
}
