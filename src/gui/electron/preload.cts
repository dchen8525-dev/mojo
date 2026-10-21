/**
 * Electron preload. Kept as CommonJS (`.cts` -> `preload.cjs`) because the
 * package is `"type": "module"` while sandboxed preload scripts are CJS.
 * Only the native directory picker and dropped-file path resolution are exposed;
 * the actual project switch goes through the same token-gated HTTP endpoint as
 * browser mode.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("mojo", {
  pickProject: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("mojo:pick-project", typeof defaultPath === "string" ? defaultPath : ""),
  // Electron 44 dropped File.path; webUtils recovers the absolute path of a
  // dropped file so the client can send a relative @reference.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
