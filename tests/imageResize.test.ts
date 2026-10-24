import { describe, expect, it } from "vitest";
import { Jimp, JimpMime } from "jimp";
import type { ImageBlockParam } from "../src/types.js";
import {
  detectMediaType,
  imageDimensions,
  prepareImagesForModel,
} from "../src/imageResize.js";

const FIVE_MB = 5 * 1024 * 1024;

function imageBlock(data: Buffer, mediaType = "image/png"): ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
  } as ImageBlockParam;
}

function decode(block: ImageBlockParam): { data: Buffer; mediaType: string } {
  const source = block.source as { media_type: string; data: string };
  return { data: Buffer.from(source.data, "base64"), mediaType: source.media_type };
}

async function solidImage(width: number, height: number): Promise<Buffer> {
  return new Jimp({ width, height, color: 0x3366ccff }).getBuffer(JimpMime.png);
}

/** Noise makes compression hard, so the payload is genuinely large. */
async function noiseImage(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed & 255;
  };
  image.scan((_x, _y, idx) => {
    image.bitmap.data[idx] = rnd();
    image.bitmap.data[idx + 1] = rnd();
    image.bitmap.data[idx + 2] = rnd();
    image.bitmap.data[idx + 3] = 255;
  });
  return image.getBuffer(JimpMime.png);
}

describe("image header probing", () => {
  it("reads format and dimensions for PNG, JPEG and GIF", async () => {
    const png = await solidImage(320, 200);
    expect(detectMediaType(png)).toBe("image/png");
    expect(imageDimensions(png)).toEqual({ width: 320, height: 200 });

    const base = new Jimp({ width: 123, height: 45, color: 0x112233ff });
    const jpeg = await base.getBuffer(JimpMime.jpeg, { quality: 80 });
    expect(detectMediaType(jpeg)).toBe("image/jpeg");
    expect(imageDimensions(jpeg)).toEqual({ width: 123, height: 45 });

    const gif = await base.getBuffer(JimpMime.gif);
    expect(detectMediaType(gif)).toBe("image/gif");
    expect(imageDimensions(gif)).toEqual({ width: 123, height: 45 });
  });

  it("returns undefined for unknown bytes", () => {
    expect(detectMediaType(Buffer.from("hello world"))).toBeUndefined();
    expect(imageDimensions(Buffer.from("hello world"))).toBeUndefined();
  });

  it("reads BMP dimensions so oversized bitmaps are refused before decoding", async () => {
    const bmp = Buffer.alloc(54);
    bmp.write("BM", 0, "latin1");
    bmp.writeInt32LE(120, 18);
    bmp.writeInt32LE(-80, 22);
    expect(imageDimensions(bmp)).toEqual({ width: 120, height: 80 });

    const bomb = Buffer.alloc(54);
    bomb.write("BM", 0, "latin1");
    bomb.writeInt32LE(30_000, 18);
    bomb.writeInt32LE(30_000, 22);
    await expect(
      prepareImagesForModel([imageBlock(bomb, "image/bmp")], { perImageBytes: FIVE_MB, maxEdge: 1568 }),
    ).rejects.toThrow(/too large to process/);
  });
});

describe("prepareImagesForModel", () => {
  it("returns small images untouched", async () => {
    const block = imageBlock(await solidImage(64, 64));
    const out = await prepareImagesForModel([block], { perImageBytes: FIVE_MB, maxEdge: 1568 });
    expect(out.resized).toBe(0);
    expect(out.images).toHaveLength(1);
    expect(out.images![0]).toBe(block);
  });

  it("does not resize on dimensions when the edge cap is disabled", async () => {
    const block = imageBlock(await solidImage(900, 900));
    const out = await prepareImagesForModel([block], { perImageBytes: FIVE_MB, maxEdge: 0 });
    expect(out.resized).toBe(0);
    expect(out.images![0]).toBe(block);
  });

  it("caps the longest edge while preserving the format", async () => {
    const block = imageBlock(await solidImage(900, 900));
    const out = await prepareImagesForModel([block], { perImageBytes: FIVE_MB, maxEdge: 300 });
    expect(out.resized).toBe(1);
    const { data, mediaType } = decode(out.images![0]);
    expect(mediaType).toBe("image/png");
    expect(imageDimensions(data)).toEqual({ width: 300, height: 300 });
  });

  it("re-encodes until the byte cap is met", async () => {
    const png = await noiseImage(600, 600);
    expect(png.byteLength).toBeGreaterThan(200_000);
    const out = await prepareImagesForModel([imageBlock(png)], { perImageBytes: 200_000, maxEdge: 0 });
    expect(out.resized).toBe(1);
    const { data } = decode(out.images![0]);
    expect(data.byteLength).toBeLessThanOrEqual(200_000);
    expect(imageDimensions(data)!.width).toBeLessThanOrEqual(600);
  });

  it("falls back to JPEG when the source format cannot meet the cap", async () => {
    const png = await noiseImage(400, 400);
    const out = await prepareImagesForModel([imageBlock(png)], { perImageBytes: 40_000, maxEdge: 200 });
    expect(out.resized).toBe(1);
    const { data, mediaType } = decode(out.images![0]);
    expect(mediaType).toBe("image/jpeg");
    expect(detectMediaType(data)).toBe("image/jpeg");
    expect(data.byteLength).toBeLessThanOrEqual(40_000);
    expect(imageDimensions(data)!.width).toBeLessThanOrEqual(200);
  });

  it("passes WebP through untouched", async () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(40)]);
    const block = imageBlock(webp, "image/webp");
    const out = await prepareImagesForModel([block], { perImageBytes: 10, maxEdge: 10 });
    expect(out.resized).toBe(0);
    expect(out.images![0]).toBe(block);
  });

  it("leaves undecodable data for the size validation to reject", async () => {
    const junk = Buffer.from("not-an-image".repeat(200));
    const block = imageBlock(junk, "image/png");
    const out = await prepareImagesForModel([block], { perImageBytes: 100, maxEdge: 100 });
    expect(out.resized).toBe(0);
    expect(out.images![0]).toBe(block);
  });

  it("refuses decompression bombs instead of decoding them", async () => {
    // PNG signature + IHDR length/type + a 20000x20000 declaration.
    const png = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(20_000, 16);
    png.writeUInt32BE(20_000, 20);
    await expect(
      prepareImagesForModel([imageBlock(png)], { perImageBytes: FIVE_MB, maxEdge: 1568 }),
    ).rejects.toThrow(/too large to process/);
  });

  it("rejects an input above the absolute decode ceiling without decoding it", async () => {
    const block = imageBlock(Buffer.alloc(200, 1), "image/png");
    await expect(
      prepareImagesForModel([block], { perImageBytes: 100, maxEdge: 100, maxInputBytes: 50 }),
    ).rejects.toThrow(/too large to process/);
  });

  it("honors an aborted signal before decoding", async () => {
    const block = imageBlock(await noiseImage(200, 200));
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareImagesForModel([block], { perImageBytes: 100, maxEdge: 100 }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it("resizes only the images that need it", async () => {
    const small = imageBlock(await solidImage(32, 32));
    const large = imageBlock(await solidImage(900, 900));
    const out = await prepareImagesForModel([small, large], { perImageBytes: FIVE_MB, maxEdge: 300 });
    expect(out.resized).toBe(1);
    expect(out.images![0]).toBe(small);
    expect(out.images![1]).not.toBe(large);
  });
});
