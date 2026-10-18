/**
 * Electron main process: boots the shared GUI backend (same code path as
 * `agent --gui`) and points a BrowserWindow at it. Run with: npm run gui
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunningBackend } from "../backend.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let backend: RunningBackend | null = null;

ipcMain.handle("mojo:pick-project", async (event, defaultPath: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
  const options: OpenDialogOptions = {
    title: "打开项目",
    defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

async function startBackend() {
  const { startGuiBackend } = await import("../backend.js");
  backend = await startGuiBackend({
    cwd: process.cwd(),
    port: 0, // ephemeral; the token in the URL fragment is the real gate
    onQuit: () => app.quit(),
  });
  return backend;
}

async function createWindow() {
  const b = await startBackend();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 520,
    title: "mojo",
    backgroundColor: "#14161a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "preload.cjs"),
    },
  });

  // External links open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(b.gui.url);
  win.on("closed", () => {
    void b.shutdown();
    backend = null;
  });
}

app.whenReady().then(createWindow).catch((err) => {
  console.error("mojo GUI failed to start:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  void backend?.shutdown();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

// Single-instance: focus the existing window instead of stacking backends.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
