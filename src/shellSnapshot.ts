import { spawn } from "node:child_process";

/**
 * Windows shell profile snapshot.
 *
 * The bash tool spawns PowerShell with -NoProfile, which silently discards
 * everything the user's profile sets up (PATH additions like vcpkg/gh, tool
 * env vars, etc.) — a GUI- or cron-spawned agent process inherits even less.
 * At the first bash invocation we dot-source the four $PROFILE scripts in a
 * throwaway PowerShell and record only the environment entries the profiles
 * changed or added; every later bash spawn merges that diff into its env.
 *
 * POSIX needs none of this: the bash tool already runs `-lc` (login shell),
 * so profile state is picked up on every command.
 *
 * Purely in-memory (per process, cached per shell exe) — a profile dump can
 * contain secrets, so nothing is written to disk. AGENT_SHELL_SNAPSHOT=0
 * disables the feature entirely.
 */

const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER = 1_000_000;

/**
 * The shell whose profile should be snapshotted, or null when there is no
 * profile to capture (cmd.exe has none; PowerShell variants do). Mirrors the
 * bash tool's pickWin32Shell resolution so the snapshot always matches the
 * shell commands actually run in.
 */
export function resolveSnapshotShell(env: NodeJS.ProcessEnv = process.env): string | null {
  const forced = (env.AGENT_SHELL ?? "").trim().toLowerCase();
  if (forced === "pwsh" || forced.endsWith("pwsh.exe")) return "pwsh.exe";
  if (forced === "powershell" || forced.endsWith("powershell.exe")) return "powershell.exe";
  if (forced === "cmd" || forced.endsWith("cmd.exe")) return null;
  const comspec = (env.COMSPEC ?? "").toLowerCase();
  if (comspec.includes("pwsh")) return "pwsh.exe";
  if (comspec.includes("powershell")) return "powershell.exe";
  return null;
}

const SNAPSHOT_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "$__pre=@{};" +
  "foreach($k in @([Environment]::GetEnvironmentVariables('Process').Keys)){$__pre[$k]=[Environment]::GetEnvironmentVariable($k,'Process')}" +
  "foreach($p in @($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost)){if($p -and (Test-Path $p)){. $p}}" +
  "$__o=@{};" +
  "foreach($k in @([Environment]::GetEnvironmentVariables('Process').Keys)){$v=[Environment]::GetEnvironmentVariable($k,'Process');if((-not $__pre.ContainsKey($k)) -or ($__pre[$k] -ne $v)){$__o[$k]=$v}}" +
  "$__o | ConvertTo-Json -Compress";

/** Parse the PowerShell JSON output; non-string values are dropped. */
export function parseSnapshotOutput(raw: string): Record<string, string> {
  const start = raw.indexOf("{");
  if (start < 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.slice(start));
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && k) out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function captureShellSnapshot(exe: string, env: NodeJS.ProcessEnv): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: Record<string, string> | null) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT_SCRIPT], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, SNAPSHOT_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > SNAPSHOT_MAX_BUFFER) {
          child.kill();
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? parseSnapshotOutput(out) : null);
      });
    } catch {
      finish(null);
    }
  });
}

const cache = new Map<string, Record<string, string> | null>();

/**
 * The profile's env diff for the resolved shell, cached per process, or null
 * when the feature is off / not applicable / the capture failed. Never throws.
 */
export async function shellSnapshotEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string> | null> {
  if (process.platform !== "win32") return null;
  if ((env.AGENT_SHELL_SNAPSHOT ?? "").trim() === "0") return null;
  const exe = resolveSnapshotShell(env);
  if (!exe) return null;
  if (cache.has(exe)) return cache.get(exe)!;
  const snap = await captureShellSnapshot(exe, env);
  cache.set(exe, snap);
  return snap;
}

/** Test hook: forget cached snapshots. */
export function resetShellSnapshotCache(): void {
  cache.clear();
}

/**
 * Merge the snapshot into a spawn env. The agent's own env always wins
 * (fill-missing-only) except `PATH`, where the snapshot value is a superset
 * (base PATH + whatever the profile appended) and is preferred wholesale.
 */
export function mergeShellSnapshotEnv(
  base: NodeJS.ProcessEnv,
  snap: Record<string, string> | null,
): NodeJS.ProcessEnv {
  if (!snap || !Object.keys(snap).length) return base;
  const merged: NodeJS.ProcessEnv = { ...base };
  // Windows env names are case-insensitive; write PATH back under the exact
  // casing the base env already uses so the object never carries two PATHs.
  const basePathKey = Object.keys(merged).find((k) => /^path$/i.test(k)) ?? "PATH";
  for (const [key, value] of Object.entries(snap)) {
    if (/^path$/i.test(key)) {
      if (value) merged[basePathKey] = value;
      continue;
    }
    const existing = merged[key];
    if (existing === undefined || existing === "") merged[key] = value;
  }
  return merged;
}
