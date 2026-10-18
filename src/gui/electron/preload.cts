/**
 * Electron preload. Kept as CommonJS (`.cts` -> `preload.cjs`) because the
 * package is `"type": "module"` while sandboxed preload scripts are CJS.
 * Only the native directory picker is exposed; the actual project switch goes
 * through the same token-gated HTTP endpoint as browser mode.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mojo", {
  pickProject: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("mojo:pick-project", typeof defaultPath === "string" ? defaultPath : ""),
});
