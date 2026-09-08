import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { ImageBlockParam } from "./types.js";

const run = promisify(execFile);

/**
 * Capture an image from the system clipboard (Claude Code's Ctrl+V paste).
 * Returns a base64 image block, or null when the clipboard holds no image.
 */
export async function captureClipboardImage(): Promise<ImageBlockParam | null> {
  const tmp = path.join(os.tmpdir(), `node-agent-clip-${randomBytes(4).toString("hex")}.png`);
  try {
    if (process.platform === "win32") {
      // WinForms clipboard -> PNG file. Exit 0 with no file => no image.
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
        "$i=[System.Windows.Forms.Clipboard]::GetImage();" +
        `if($i -ne $null){$i.Save('${tmp}',[System.Drawing.Imaging.ImageFormat]::Png);exit 0}else{exit 1}`;
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 10_000 });
    } else if (process.platform === "darwin") {
      await run("pngpaste", [tmp], { timeout: 10_000 }); // brew install pngpaste
    } else {
      // Wayland then X11. Read stdout as a Buffer so PNG bytes survive intact.
      const grab = (cmd: string, args: string[]) =>
        new Promise<Buffer>((resolve, reject) => {
          execFile(cmd, args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" }, (err, stdout) =>
            err ? reject(err) : resolve(stdout as unknown as Buffer),
          );
        });
      let buf: Buffer;
      try {
        buf = await grab("wl-paste", ["-t", "image/png", "--no-newline"]);
      } catch {
        buf = await grab("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
      }
      if (!buf.length) return null;
      return {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
      };
    }
    const buf = await fs.readFile(tmp);
    if (!buf.length) return null;
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
    };
  } catch {
    return null; // no image on clipboard, or tool missing
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
