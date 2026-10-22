import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpOAuthFlow, mcpAuthDir, mcpAuthFilePath } from "../src/mcpAuth.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mojo-mcp-auth-"));
}

function startFlow(dir: string, extra: { timeoutMs?: number } = {}): Promise<McpOAuthFlow> {
  return McpOAuthFlow.start({
    serverName: "demo",
    serverUrl: "https://mcp.example/mcp",
    authDir: dir,
    openUrl: () => {},
    log: () => {},
    timeoutMs: extra.timeoutMs ?? 2_000,
  });
}

describe("MCP OAuth credential store", () => {
  it("maps server names to safe file paths", () => {
    expect(mcpAuthDir("/home/u")).toBe(path.join("/home/u", ".node-agent", "mcp-auth"));
    expect(mcpAuthFilePath("my server/x", "/tmp/auth")).toBe(path.join("/tmp/auth", "my_server_x.json"));
  });

  it("persists tokens, client info and verifier with owner-only permissions", async () => {
    const dir = await tempDir();
    try {
      const flow = await startFlow(dir);
      await flow.provider.saveTokens({ access_token: "token-1", token_type: "Bearer", refresh_token: "refresh-1" });
      await flow.provider.saveClientInformation!({ client_id: "client-1", redirect_uris: [flow.redirectUrl] });
      await flow.provider.saveCodeVerifier!("verifier-1");
      await flow.provider.saveDiscoveryState!({ authorizationServerUrl: "https://auth.example" });
      await flow.close();

      const file = mcpAuthFilePath("demo", dir);
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      expect(record.tokens.access_token).toBe("token-1");
      expect(record.clientInformation.client_id).toBe("client-1");
      expect(record.codeVerifier).toBe("verifier-1");
      expect(record.discoveryState.authorizationServerUrl).toBe("https://auth.example");
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

      const again = await startFlow(dir);
      expect(await again.provider.tokens()).toMatchObject({ access_token: "token-1" });
      await again.provider.invalidateCredentials!("tokens");
      expect(await again.provider.tokens()).toBeUndefined();
      // Only tokens are dropped; the registration survives for the next authorization.
      expect(await again.provider.clientInformation()).toMatchObject({ client_id: "client-1" });
      await again.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP OAuth loopback callback", () => {
  it("rejects a mismatched state and resolves the code", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir);
    try {
      const state = String(await flow.provider.state!());
      const bad = await fetch(`${flow.redirectUrl}?state=wrong&code=evil`);
      expect(bad.status).toBe(400);

      const missing = await fetch(`${flow.redirectUrl}?state=${encodeURIComponent(state)}`);
      expect(missing.status).toBe(400);

      const pending = flow.waitForCode();
      const ok = await fetch(`${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=code-1`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("授权完成");
      await expect(pending).resolves.toBe("code-1");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("buffers a code that arrives before waitForCode", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir);
    try {
      const state = String(await flow.provider.state!());
      // A fast browser redirect must not race the agent into waiting forever.
      const early = await fetch(`${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=early`);
      expect(early.status).toBe(200);
      await expect(flow.waitForCode()).resolves.toBe("early");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when the provider reports an authorization error", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir);
    try {
      const state = String(await flow.provider.state!());
      const assertion = expect(flow.waitForCode()).rejects.toThrow(/access_denied/);
      const failed = await fetch(
        `${flow.redirectUrl}?state=${encodeURIComponent(state)}&error=access_denied&error_description=user%20denied`,
      );
      expect(failed.status).toBe(200);
      await assertion;
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("times out with the authorization URL in the error", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir, { timeoutMs: 20 });
    try {
      flow.provider.redirectToAuthorization!(new URL("https://auth.example/authorize?client_id=c"));
      const err = await flow.waitForCode().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out/);
      expect((err as Error).message).toContain("https://auth.example/authorize?client_id=c");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
