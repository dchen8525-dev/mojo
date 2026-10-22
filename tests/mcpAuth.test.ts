import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpOAuthFlow, mcpAuthDir, mcpAuthFilePath } from "../src/mcpAuth.js";

/** GET with a caller-chosen Host header (fetch forbids overriding it). */
function rawGet(url: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: { host },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mojo-mcp-auth-"));
}

function startFlow(dir: string, extra: { timeoutMs?: number; serverUrl?: string } = {}): Promise<McpOAuthFlow> {
  return McpOAuthFlow.start({
    serverName: "demo",
    serverUrl: extra.serverUrl ?? "https://mcp.example/mcp",
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

  it("drops credentials when the server URL changes", async () => {
    const dir = await tempDir();
    try {
      const first = await startFlow(dir);
      await first.provider.saveTokens({ access_token: "token-1", token_type: "Bearer" });
      await first.provider.saveClientInformation!({ client_id: "client-1", redirect_uris: [first.redirectUrl] });
      await first.close();

      // Reusing a bearer token (or registration) minted for another endpoint
      // would leak it to whatever host now sits at this server's name.
      const moved = await startFlow(dir, { serverUrl: "https://other.example/mcp" });
      expect(await moved.provider.tokens()).toBeUndefined();
      expect(await moved.provider.clientInformation()).toBeUndefined();
      await moved.close();

      const back = await startFlow(dir);
      expect(await back.provider.tokens()).toBeUndefined();
      await back.provider.saveTokens({ access_token: "token-2", token_type: "Bearer" });
      await back.close();

      const same = await startFlow(dir);
      expect(await same.provider.tokens()).toMatchObject({ access_token: "token-2" });
      await same.close();
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
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.text()).toContain("授权完成");
      await expect(pending).resolves.toBe("code-1");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a callback sent under a foreign Host header (DNS rebinding)", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir);
    try {
      const state = String(await flow.provider.state!());
      const evil = await rawGet(`${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=evil`, "attacker.example");
      expect(evil.status).toBe(400);
      expect(evil.body).toContain("invalid host");
      // The rejected attempt must not consume the state of the real flow.
      const genuine = await rawGet(
        `${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=code-1`,
        new URL(flow.redirectUrl).host,
      );
      expect(genuine.status).toBe(200);
      await expect(flow.waitForCode()).resolves.toBe("code-1");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not accept a replayed callback after the code was delivered", async () => {
    const dir = await tempDir();
    const flow = await startFlow(dir);
    try {
      const state = String(await flow.provider.state!());
      const first = await fetch(`${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=code-1`);
      expect(first.status).toBe(200);
      const replay = await fetch(`${flow.redirectUrl}?state=${encodeURIComponent(state)}&code=attacker`);
      expect(replay.status).toBe(400);
      expect(await replay.text()).toContain("already completed");
      await expect(flow.waitForCode()).resolves.toBe("code-1");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open a non-http(s) authorization URL", async () => {
    const dir = await tempDir();
    const opened: string[] = [];
    const flow = await McpOAuthFlow.start({
      serverName: "demo",
      serverUrl: "https://mcp.example/mcp",
      authDir: dir,
      openUrl: (url) => opened.push(url),
      log: () => {},
      timeoutMs: 2_000,
    });
    try {
      expect(() =>
        flow.provider.redirectToAuthorization!(new URL("file:///C:/Windows/System32/calc.exe")),
      ).toThrow(/non-http\(s\)/);
      expect(opened).toEqual([]);
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

  it("keeps waiting and logs the URL when the browser cannot be opened", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const flow = await McpOAuthFlow.start({
      serverName: "demo",
      serverUrl: "https://mcp.example/mcp",
      authDir: dir,
      openUrl: () => {
        throw new Error("no browser here");
      },
      log: (message) => logs.push(message),
      timeoutMs: 20,
    });
    try {
      expect(() =>
        flow.provider.redirectToAuthorization!(new URL("https://auth.example/authorize?client_id=c")),
      ).not.toThrow();
      expect(logs.join("\n")).toContain("no browser here");
      const err = await flow.waitForCode().catch((e: Error) => e);
      expect((err as Error).message).toContain("https://auth.example/authorize?client_id=c");
    } finally {
      await flow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
