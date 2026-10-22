import { describe, expect, it } from "vitest";
import {
  mergeShellSnapshotEnv,
  parseSnapshotOutput,
  resetShellSnapshotCache,
  resolveSnapshotShell,
  shellSnapshotEnv,
} from "../src/shellSnapshot.js";

describe("resolveSnapshotShell", () => {
  it("follows AGENT_SHELL when it points at a PowerShell", () => {
    expect(resolveSnapshotShell({ AGENT_SHELL: "pwsh" })).toBe("pwsh.exe");
    expect(resolveSnapshotShell({ AGENT_SHELL: "C:\\Tools\\powershell.exe" })).toBe("powershell.exe");
  });

  it("falls back to COMSPEC for PowerShell, null for cmd", () => {
    expect(resolveSnapshotShell({ COMSPEC: "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\powershell.exe" })).toBe(
      "powershell.exe",
    );
    expect(resolveSnapshotShell({ COMSPEC: "C:\\Windows\\system32\\cmd.exe" })).toBeNull();
    expect(resolveSnapshotShell({})).toBeNull();
  });

  it("an explicit AGENT_SHELL=cmd disables the snapshot even with a PowerShell COMSPEC", () => {
    expect(resolveSnapshotShell({ AGENT_SHELL: "cmd", COMSPEC: "pwsh.exe" })).toBeNull();
  });
});

describe("parseSnapshotOutput", () => {
  it("parses the JSON diff and drops non-string values", () => {
    expect(parseSnapshotOutput('{"A":"1","B":2,"C":"x"}')).toEqual({ A: "1", C: "x" });
  });

  it("returns empty on garbage or empty output", () => {
    expect(parseSnapshotOutput("")).toEqual({});
    expect(parseSnapshotOutput("not json")).toEqual({});
  });
});

describe("mergeShellSnapshotEnv", () => {
  it("returns the base untouched for a null/empty snapshot", () => {
    const base = { PATH: "/bin", A: "1" };
    expect(mergeShellSnapshotEnv(base, null)).toBe(base);
    expect(mergeShellSnapshotEnv(base, {})).toBe(base);
  });

  it("PATH takes the snapshot value (profile superset), other keys fill-in only", () => {
    const merged = mergeShellSnapshotEnv(
      { PATH: "/bin", A: "keep", B: "", C: undefined } as NodeJS.ProcessEnv,
      { PATH: "/bin;/profile", A: "snap", B: "fill", C: "fill", D: "new" },
    );
    expect(merged.PATH).toBe("/bin;/profile");
    expect(merged.A).toBe("keep");
    expect(merged.B).toBe("fill");
    expect(merged.C).toBe("fill");
    expect(merged.D).toBe("new");
  });

  it("writes PATH back under the base's casing so there is only one PATH key", () => {
    const merged = mergeShellSnapshotEnv({ Path: "c:\\bin" } as NodeJS.ProcessEnv, { PATH: "c:\\bin;c:\\profile" });
    expect(Object.keys(merged).filter((k) => /^path$/i.test(k))).toEqual(["Path"]);
    expect(merged.Path).toBe("c:\\bin;c:\\profile");
  });
});

describe("shellSnapshotEnv gating", () => {
  it("is disabled by AGENT_SHELL_SNAPSHOT=0, cmd.exe shells, and off Windows", async () => {
    expect(await shellSnapshotEnv({ AGENT_SHELL_SNAPSHOT: "0", COMSPEC: "pwsh.exe" } as never)).toBeNull();
    expect(await shellSnapshotEnv({ AGENT_SHELL: "cmd" } as never)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "captures the real PowerShell profile env once and caches it per process",
    async () => {
      resetShellSnapshotCache();
      const snap = await shellSnapshotEnv({ AGENT_SHELL: "powershell.exe" } as never);
      expect(snap).not.toBeNull(); // {} is valid when the profile changes nothing
      const again = await shellSnapshotEnv({ AGENT_SHELL: "powershell.exe" } as never);
      expect(again).toBe(snap); // served from the per-process cache
    },
  );
});
