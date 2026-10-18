/**
 * Rasterize an SVG into the app icon set.
 *
 * No image toolchain is installed, so this leans on the Chromium that ships
 * with Electron: draw the SVG onto a canvas at each size and write the PNGs.
 * Usage: npx electron scripts/make-icon.cjs [path/to/icon.svg]
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const svgFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "ui-demos", "icons", "01-m-dot.svg");
const outDir = path.join(root, "src", "gui", "static");
const SIZES = [256, 128, 64, 48, 32, 16];

/** ICO container with embedded PNG frames (Windows Vista+). */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + 16 * frames.length;
  frames.forEach(({ size, data }, i) => {
    const o = i * 16;
    const dim = size >= 256 ? 0 : size; // 0 means 256 in the ICO directory
    dir.writeUInt8(dim, o);
    dir.writeUInt8(dim, o + 1);
    dir.writeUInt8(0, o + 2); // palette size
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.data)]);
}

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const svg = fs.readFileSync(svgFile, "utf8");
    const win = new BrowserWindow({ width: 320, height: 320, show: false });
    await win.loadURL("data:text/html,<html><body></body></html>");

    const dataUrls = await win.webContents.executeJavaScript(`
      (async () => {
        const svg = ${JSON.stringify(svg)};
        const sizes = ${JSON.stringify(SIZES)};
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("svg failed to decode"));
          img.src = url;
        });
        const out = {};
        for (const size of sizes) {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, size, size);
          out[size] = canvas.toDataURL("image/png");
        }
        return out;
      })()
    `);

    fs.mkdirSync(outDir, { recursive: true });
    const frames = SIZES.map((size) => {
      const b64 = String(dataUrls[size]).split(",")[1];
      const data = Buffer.from(b64, "base64");
      fs.writeFileSync(path.join(outDir, `icon-${size}.png`), data);
      return { size, data };
    });

    fs.writeFileSync(path.join(outDir, "icon.png"), frames[0].data);
    fs.writeFileSync(path.join(outDir, "icon.ico"), buildIco(frames));
    console.log(`icon written from ${path.relative(root, svgFile)} -> ${path.relative(root, outDir)} (${SIZES.join(", ")})`);
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
