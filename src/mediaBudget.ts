import type { ImageBlockParam, MessageParam } from "./types.js";

/**
 * Media budget: images dominate a context window, so both the inbound flow
 * (per message / per image) and the resident history (session-wide) are
 * capped. Excess resident images are elided oldest-first — replaced with a
 * text placeholder, which keeps the history API-valid — right before each
 * model round, mirroring what ZCode does when its media budget trips.
 */

const DEFAULT_MAX_IMAGES_PER_MESSAGE = 5;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SESSION_IMAGES = 20;

export interface MediaLimits {
  /** Images accepted per chat()/steer() call. */
  perMessage: number;
  /** Decoded size ceiling per image. */
  perImageBytes: number;
  /** Images allowed to stay live in the history. */
  sessionImages: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function mediaLimits(): MediaLimits {
  return {
    perMessage: envInt("AGENT_MAX_IMAGES_PER_MESSAGE", DEFAULT_MAX_IMAGES_PER_MESSAGE),
    perImageBytes: envInt("AGENT_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES),
    sessionImages: envInt("AGENT_MAX_SESSION_IMAGES", DEFAULT_MAX_SESSION_IMAGES),
  };
}

/** Decoded byte size of a base64 data image (no full decode needed). */
export function imageByteSize(img: ImageBlockParam): number {
  const source = img.source as { data?: string } | undefined;
  const data = source?.data ?? "";
  return Math.floor((data.length * 3) / 4);
}

function imageBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === "image") out.push(b);
    else if (b?.type === "tool_result" && Array.isArray(b.content)) {
      for (const part of b.content as Array<Record<string, unknown>>) {
        if (part?.type === "image") out.push(part);
      }
    }
  }
  return out;
}

/**
 * Reject oversized or over-counted inbound images with a message the caller
 * can surface verbatim. Only user input reaches this, so it is a real
 * validation boundary.
 */
export function validateImages(images: ImageBlockParam[] | undefined, limits: MediaLimits): void {
  if (!images?.length) return;
  if (images.length > limits.perMessage) {
    throw new Error(`too many images: ${images.length} sent, limit ${limits.perMessage} per message (AGENT_MAX_IMAGES_PER_MESSAGE)`);
  }
  for (const img of images) {
    const size = imageByteSize(img);
    if (size > limits.perImageBytes) {
      throw new Error(`image too large: ~${Math.round(size / 1024 / 1024)} MB, limit ${Math.round(limits.perImageBytes / 1024 / 1024)} MB (AGENT_MAX_IMAGE_BYTES)`);
    }
  }
}

/**
 * Elide the oldest resident images down to the session cap, in place.
 * Returns how many images were replaced; the caller must invalidate the
 * token anchor when this is non-zero.
 */
export function enforceSessionMediaBudget(messages: MessageParam[], limits: MediaLimits): number {
  let live = 0;
  for (const m of messages) live += imageBlocks(m.content).length;
  if (live <= limits.sessionImages) return 0;
  let toRemove = live - limits.sessionImages;
  let removed = 0;
  for (const m of messages) {
    if (!toRemove) break;
    if (!Array.isArray(m.content)) continue;
    const content = m.content as unknown as Array<Record<string, unknown>>;
    for (let i = 0; i < content.length && toRemove > 0; i++) {
      const b = content[i];
      if (b?.type === "image") {
        content[i] = { type: "text", text: "[image removed: session media budget]" };
        toRemove--;
        removed++;
      } else if (b?.type === "tool_result" && Array.isArray(b.content)) {
        const parts = b.content as unknown as Array<Record<string, unknown>>;
        for (let j = 0; j < parts.length && toRemove > 0; j++) {
          if (parts[j]?.type === "image") {
            parts[j] = { type: "text", text: "[image removed: session media budget]" };
            toRemove--;
            removed++;
          }
        }
      }
    }
  }
  return removed;
}
