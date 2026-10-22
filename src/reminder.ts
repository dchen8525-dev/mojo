/**
 * Uniform injection format for meta-notifications the agent infrastructure
 * adds to the conversation (hook contexts, session status...). Wrapping them
 * in one recognizable tag keeps model-side parsing stable and leaves plain
 * text for genuine user/model content.
 */
export function systemReminder(body: string, attrs: Record<string, string> = {}): string {
  const open = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`)
    .join("");
  // Bodies can embed tool output / subagent reports; a literal closing tag
  // would end the reminder early and let the rest read as user content.
  const safe = body.replace(/<\/system-reminder\s*>/gi, "&lt;/system-reminder>");
  return `<system-reminder${open}>\n${safe}\n</system-reminder>`;
}
