const MAX_REF_IDS = 3;

/** #sess_<hex> references in a prompt, deduped and capped. */
export function sessionReferenceIds(text: string): string[] {
  const out: string[] = [];
  const re = /#sess_([0-9a-f]{4,64})\b/gi;
  for (const match of text.matchAll(re)) {
    const id = match[1].toLowerCase();
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_REF_IDS) break;
  }
  return out;
}
