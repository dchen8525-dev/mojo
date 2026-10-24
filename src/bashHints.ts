import type { ImageBlockParam } from "./types.js";
import { systemReminder } from "./reminder.js";

/**
 * Post-processing of bash output. Two cheap transforms that steer the model:
 * - Output-pattern hints (e.g. a GitHub API rate limit) inject a bounded
 *   system-reminder telling the model what to do instead of blindly retrying;
 *   a 60s per-pattern cooldown keeps repeated failures from spamming history.
 * - A data-URL image on stdout (screenshot CLIs, playwright scripts) becomes a
 *   real image block instead of megabytes of base64 text.
 */

const HINT_COOLDOWN_MS = 60_000;

interface BashHint {
  pattern: RegExp;
  hint: string;
}

const BASH_HINTS: BashHint[] = [
  {
    pattern: /API rate limit exceeded|rate limit (?:reached|exceeded) for .*(?:api\.github\.com|gh)/i,
    hint:
      "The GitHub API rate limit was hit. Do not retry immediately: run `gh api rate_limit` (or " +
      "`curl -s https://api.github.com/rate_limit`) to read the reset time, wait until then, or " +
      "authenticate with `gh auth status` if the unauthenticated quota is the problem.",
  },
];

const lastFired = new Map<string, number>();

/** Reset cooldowns (tests). */
export function resetBashHints(): void {
  lastFired.clear();
}

/** The hint whose cooldown has expired and whose pattern matches, or null. */
export function matchBashHint(output: string, now = Date.now()): string | null {
  for (const { pattern, hint } of BASH_HINTS) {
    if (!pattern.test(output)) continue;
    const last = lastFired.get(hint) ?? 0;
    if (now - last < HINT_COOLDOWN_MS) return null;
    lastFired.set(hint, now);
    return systemReminder(hint, { event: "BashHint" });
  }
  return null;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Embedded images attached per command output (extra ones stay text). */
export const MAX_OUTPUT_IMAGES = 2;
const IMAGE_KINDS = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
const B64_RUN = /^[A-Za-z0-9+/=]+/;

/**
 * Length of the base64 run starting at `start`. Scanned in 1 MiB chunks with a
 * bounded regex — an unbounded {N,} quantifier over a multi-megabyte run blows
 * V8's backtrack stack.
 */
function scanBase64Run(text: string, start: number): number {
  const CHUNK = 1 << 20;
  let end = start;
  for (;;) {
    const slice = text.slice(end, end + CHUNK);
    const m = B64_RUN.exec(slice);
    if (!m || !m[0].length) break;
    end += m[0].length;
    if (m[0].length < slice.length || end >= text.length) break;
  }
  return end;
}

export interface BashOutputPost {
  /** Text after removing attached data URLs (and with the hint appended). */
  text: string;
  images: ImageBlockParam[];
}

/**
 * Streaming-capture headroom for embedded images, in base64 characters. The
 * bash tool caps plain text output; screenshots legitimately exceed that cap,
 * so its capture loop needs the base64 size of the images this module accepts.
 */
export function imageCaptureChars(): number {
  return MAX_OUTPUT_IMAGES * Math.ceil((MAX_IMAGE_BYTES / 3) * 4);
}

/**
 * Extract data-URL images from command output and compute the hint reminder.
 * `now` is injectable for cooldown tests.
 */
export function postProcessBashOutput(output: string, now = Date.now()): BashOutputPost {
  const images: ImageBlockParam[] = [];
  const cuts: Array<[number, number, string]> = [];
  const MARKER = "data:image/";
  let idx = output.indexOf(MARKER);
  while (idx >= 0 && images.length < MAX_OUTPUT_IMAGES) {
    const semi = output.indexOf(";base64,", idx + MARKER.length);
    if (semi < 0) break;
    const kind = output.slice(idx + MARKER.length, semi);
    if (!IMAGE_KINDS.has(kind)) {
      idx = output.indexOf(MARKER, semi + 1);
      continue;
    }
    const dataStart = semi + ";base64,".length;
    const dataEnd = scanBase64Run(output, dataStart);
    const data = output.slice(dataStart, dataEnd);
    if (data.length >= 100) {
      const approxBytes = Math.floor((data.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) {
        cuts.push([idx, dataEnd, "[image omitted: exceeds the 5 MiB per-image budget]"]);
      } else {
        images.push({
          type: "image",
          source: { type: "base64", media_type: kind === "jpg" ? "image/jpeg" : `image/${kind}`, data },
        } as ImageBlockParam);
        cuts.push([idx, dataEnd, "[image attached from output]"]);
      }
    }
    idx = output.indexOf(MARKER, dataEnd);
  }
  let text = output;
  if (cuts.length) {
    let rebuilt = "";
    let pos = 0;
    for (const [s, e, rep] of cuts) {
      rebuilt += text.slice(pos, s) + rep;
      pos = e;
    }
    text = rebuilt + text.slice(pos);
  }
  const hint = matchBashHint(output, now);
  if (hint) text = `${text}\n\n${hint}`;
  return { text, images };
}
