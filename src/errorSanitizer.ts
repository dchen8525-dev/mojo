/**
 * Error-message sanitization for persistence and display sinks (journal error
 * field, GUI turn_error, TUI error row, print-mode stderr). Ported from
 * ZCode's telemetry/error-sanitizer.ts: provider and transport errors can echo
 * request URLs, auth headers, local paths or whole response bodies — those are
 * redacted before the text leaves the process boundary. Tool stdout/stderr and
 * the journal's full request dump are deliberately NOT sanitized (debugging
 * payload, not telemetry).
 */

const PRETRIM_CHARS = 4_096;
const MAX_ERROR_MESSAGE_CHARS = 2_048;

export function sanitizeErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .slice(0, PRETRIM_CHARS)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, sanitizeUrl)
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bsk[_-](?:live|test)_[A-Za-z0-9]{10,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "{secret}")
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}\b/gu, "{secret}")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gu, "{secret}")
    .replace(/\bnpm_[A-Za-z0-9]{30,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "{secret}")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, "{secret}")
    .replace(/\b[A-Za-z0-9]{4,32}@[0-9a-f]{12,}\b/giu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "/{path}",
    )
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "/{path}")
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.slice(0, MAX_ERROR_MESSAGE_CHARS) || undefined;
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const route = parsed.pathname
      .split("/")
      .map((segment) => sanitizeRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "{url}";
  }
}

function sanitizeRouteSegment(segment: string): string {
  if (!segment) return segment;
  if (
    segment.includes("@") ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, 128);
}
