import type { ImageBlockParam } from "./types.js";
import { imageMaxEdge, mediaLimits } from "./mediaBudget.js";

/**
 * Shrink inbound images before they reach the model: cap the longest edge and
 * re-encode (format-preserving when cheap, JPEG otherwise) until the payload
 * fits the per-image byte budget. This turns the old hard rejection for
 * oversized pastes/screenshots into a transparent downscale.
 *
 * jimp is loaded lazily — the common small-image path only sniffs dimensions.
 * WebP is passed through because the bundled jimp build cannot transcode it.
 */

type SupportedMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type JimpModule = typeof import("jimp");
type JimpImage = Awaited<ReturnType<JimpModule["Jimp"]["read"]>>;

export interface ImagePrepareLimits {
  /** Decoded byte ceiling per image (the model boundary). */
  perImageBytes: number;
  /** Longest edge target; 0 disables dimension-based resizing. */
  maxEdge: number;
  /** Hard ceiling on the decoded input; larger payloads are rejected undecoded. */
  maxInputBytes?: number;
}

export interface PreparedImage {
  image: ImageBlockParam;
  changed: boolean;
}

export interface PrepareImagesOptions {
  signal?: AbortSignal;
}

const JPEG_QUALITIES = [80, 60, 40, 20] as const;
const SCALE_STEPS = [0.75, 0.5, 0.25] as const;
const AGGRESSIVE_EDGES = [1000, 800, 600, 400, 300, 200] as const;
const AGGRESSIVE_QUALITIES = [60, 40, 20] as const;
/** Decoding allocates 4 bytes per pixel; refuse decompression bombs. */
const MAX_DECODE_PIXELS = 24_000_000;
/**
 * Absolute size ceiling for an inbound payload. A configured byte budget can
 * be raised arbitrarily; decoding hundreds of MB is never useful and risks
 * the process before validation sees it.
 */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

let jimpPromise: Promise<JimpModule> | undefined;

function loadJimp(): Promise<JimpModule> {
  jimpPromise ??= import("jimp");
  return jimpPromise;
}

/** Current limits from the environment (same source as validateImages). */
export function imagePrepareLimits(): ImagePrepareLimits {
  return { perImageBytes: mediaLimits().perImageBytes, maxEdge: imageMaxEdge() };
}

/**
 * Prepare every image for one request. Images that already fit are returned
 * untouched (same object), so the hot path costs only a header read.
 */
export async function prepareImagesForModel(
  images: ImageBlockParam[] | undefined,
  limits: ImagePrepareLimits = imagePrepareLimits(),
  options: PrepareImagesOptions = {},
): Promise<{ images: ImageBlockParam[] | undefined; resized: number }> {
  if (!images?.length) return { images, resized: 0 };
  const out: ImageBlockParam[] = [];
  let resized = 0;
  for (const image of images) {
    const prepared = await prepareImageForModel(image, limits, options);
    if (prepared.changed) resized++;
    out.push(prepared.image);
  }
  return { images: out, resized };
}

export async function prepareImageForModel(
  image: ImageBlockParam,
  limits: ImagePrepareLimits,
  options: PrepareImagesOptions = {},
): Promise<PreparedImage> {
  const source = image.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (source?.type !== "base64" || typeof source.data !== "string" || !source.data) {
    return { image, changed: false };
  }
  const input = Buffer.from(source.data, "base64");
  if (!input.length) return { image, changed: false };
  const inputCeiling = limits.maxInputBytes ?? MAX_INPUT_BYTES;
  if (input.byteLength > inputCeiling) {
    throw new Error(
      `image too large to process: ${Math.round(input.byteLength / 1024 / 1024)} MB ` +
        `(max ${Math.round(inputCeiling / 1024 / 1024)} MB)`,
    );
  }

  const detected = detectMediaType(input);
  if (detected === "image/webp") return { image, changed: false };

  const dims = imageDimensions(input);
  const overBytes = input.byteLength > limits.perImageBytes;
  // A container we cannot measure cheaply (TIFF, AVIF, ...) must not be
  // handed to the decoder just because it is over budget: a tiny header can
  // declare a bitmap that exhausts memory. validateImages rejects it instead.
  if (overBytes && dims === undefined && detected === undefined) return { image, changed: false };
  const overEdge =
    limits.maxEdge > 0 && dims !== undefined && Math.max(dims.width, dims.height) > limits.maxEdge;
  if (!overBytes && !overEdge) return { image, changed: false };
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    throw new Error(
      `image too large to process: ${dims.width}x${dims.height} (max ${MAX_DECODE_PIXELS / 1_000_000} megapixels)`,
    );
  }

  throwIfAborted(options.signal);
  const jimp = await loadJimp();
  let decoded: JimpImage;
  try {
    decoded = await jimp.Jimp.read(input);
  } catch {
    // Not decodable: leave the original bytes in place so validateImages
    // reports the size problem (or the provider rejects the format).
    return { image, changed: false };
  }
  throwIfAborted(options.signal);

  const sourceKind = detected ?? declaredMediaType(source.media_type);
  const candidate = await findFittingCandidate(jimp, decoded, sourceKind, limits, options.signal);
  if (!candidate) return { image, changed: false };
  return { image: base64Image(candidate.data, candidate.mediaType), changed: true };
}

interface Candidate {
  data: Buffer;
  mediaType: SupportedMedia;
}

async function findFittingCandidate(
  jimp: JimpModule,
  decoded: JimpImage,
  sourceKind: SupportedMedia | undefined,
  limits: ImagePrepareLimits,
  signal?: AbortSignal,
): Promise<Candidate | undefined> {
  const fits = (c: Candidate | undefined): c is Candidate =>
    c !== undefined && c.data.byteLength <= limits.perImageBytes;
  const bounded = limits.maxEdge > 0
    ? resizeToEdge(jimp, decoded, limits.maxEdge)
    : decoded.clone();
  // PNG only gets one format-preserving attempt (at the bounded size); every
  // later step goes straight to JPEG, whose size tracks quality predictably.
  if (sourceKind && sourceKind !== "image/webp" && sourceKind !== "image/png") {
    const preserved = await encodePreserving(jimp, bounded, sourceKind, limits.perImageBytes, signal);
    if (fits(preserved)) return preserved;
  } else if (sourceKind === "image/png") {
    const png = await encodePng(jimp, bounded, signal);
    if (fits(png)) return png;
  }

  const boundedJpeg = await jpegWithin(jimp, bounded, limits.perImageBytes, JPEG_QUALITIES, signal);
  if (boundedJpeg) return boundedJpeg;

  const baseEdge = longestEdge(bounded);
  for (const scale of SCALE_STEPS) {
    const edge = Math.max(1, Math.round(baseEdge * scale));
    if (edge >= baseEdge) continue;
    const scaled = resizeToEdge(jimp, bounded, edge);
    if (sourceKind === "image/jpeg" || sourceKind === "image/gif") {
      const preserved = await encodePreserving(jimp, scaled, sourceKind, limits.perImageBytes, signal);
      if (fits(preserved)) return preserved;
    }
    const jpeg = await jpegWithin(jimp, scaled, limits.perImageBytes, JPEG_QUALITIES, signal);
    if (jpeg) return jpeg;
  }

  for (const maxEdge of AGGRESSIVE_EDGES) {
    const target = limits.maxEdge > 0 ? Math.min(maxEdge, limits.maxEdge) : maxEdge;
    const scaled = resizeToEdge(jimp, decoded, target);
    const jpeg = await jpegWithin(jimp, scaled, limits.perImageBytes, AGGRESSIVE_QUALITIES, signal);
    if (jpeg) return jpeg;
  }
  return undefined;
}

async function encodePreserving(
  jimp: JimpModule,
  image: JimpImage,
  kind: SupportedMedia,
  perImageBytes: number,
  signal?: AbortSignal,
): Promise<Candidate | undefined> {
  if (kind === "image/jpeg") {
    return jpegWithin(jimp, image, perImageBytes, JPEG_QUALITIES, signal);
  }
  if (kind === "image/png") return encodePng(jimp, image, signal);
  if (kind === "image/gif") {
    throwIfAborted(signal);
    const data = await image.getBuffer(jimp.JimpMime.gif);
    throwIfAborted(signal);
    return { data, mediaType: "image/gif" };
  }
  return undefined;
}

async function encodePng(
  jimp: JimpModule,
  image: JimpImage,
  signal?: AbortSignal,
): Promise<Candidate> {
  throwIfAborted(signal);
  const data = await image.getBuffer(jimp.JimpMime.png, { deflateLevel: 9, deflateStrategy: 3 });
  throwIfAborted(signal);
  return { data, mediaType: "image/png" };
}

async function jpegWithin(
  jimp: JimpModule,
  image: JimpImage,
  perImageBytes: number,
  qualities: readonly number[],
  signal?: AbortSignal,
): Promise<Candidate | undefined> {
  for (const quality of qualities) {
    throwIfAborted(signal);
    const data = await image.getBuffer(jimp.JimpMime.jpeg, { quality });
    if (data.byteLength <= perImageBytes) return { data, mediaType: "image/jpeg" };
  }
  throwIfAborted(signal);
  return undefined;
}

function resizeToEdge(jimp: JimpModule, image: JimpImage, edge: number): JimpImage {
  const clone = image.clone();
  if (edge <= 0 || longestEdge(clone) <= edge) return clone;
  clone.scaleToFit({ w: edge, h: edge, mode: jimp.ResizeStrategy.BICUBIC });
  return clone;
}

function longestEdge(image: JimpImage): number {
  return Math.max(image.bitmap.width, image.bitmap.height);
}

function base64Image(data: Buffer, mediaType: SupportedMedia): ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
  } as ImageBlockParam;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("aborted");
}

function declaredMediaType(value: string | undefined): SupportedMedia | undefined {
  const lower = value?.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "image/jpeg";
  if (lower === "image/png" || lower === "image/gif" || lower === "image/webp") return lower;
  return undefined;
}

/** Image format from the leading bytes (only the formats jimp can encode). */
export function detectMediaType(data: Buffer): SupportedMedia | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const sig = data.toString("latin1", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.toString("latin1", 0, 4) === "RIFF" &&
    data.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Pixel dimensions from PNG/GIF/JPEG/BMP headers, without decoding pixels. */
export function imageDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length >= 24 && detectMediaType(data) === "image/png") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && detectMediaType(data) === "image/gif") {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) return jpegDimensions(data);
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    const width = data.readInt32LE(18);
    const height = Math.abs(data.readInt32LE(22)); // negative = top-down bitmap
    if (width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = data.readUInt16BE(i + 2);
    if (length < 2) return undefined;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return undefined;
}
