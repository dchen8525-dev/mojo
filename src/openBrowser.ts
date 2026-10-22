import { spawn } from "node:child_process";

/** Open `url` in the OS default browser without adding a dependency. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (e.g. xdg-open in a container) arrives as an async
    // 'error' event; without a listener it would crash the process.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless environment - the URL is printed to stderr anyway */
  }
}
