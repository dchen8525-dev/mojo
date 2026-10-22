import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpManager } from "../src/mcp.js";
import { mcpAuthFilePath } from "../src/mcpAuth.js";
import { getTool } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

const ACCESS_TOKEN = "oauth-token-1";
const AUTH_CODE = "code-1";

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * One local server playing both roles: an OAuth authorization server
 * (RFC 9728 + RFC 8414 metadata, dynamic registration, PKCE authorize/token)
 * and a streamable-HTTP MCP resource server that accepts `ACCESS_TOKEN`.
 */
function startOAuthServer(): {
  server: Server;
  url: () => string;
  stats: () => { registrations: number; tokenRequests: number; authRequests: number };
} {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let registrations = 0;
  let tokenRequests = 0;
  let authRequests = 0;
  let lastChallenge = "";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const url = new URL(req.url ?? "/", origin);
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      sendJson(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      registrations++;
      const body = (await readJson(req)) as { redirect_uris?: string[] } | undefined;
      sendJson(201, {
        client_id: "test-client",
        redirect_uris: body?.redirect_uris ?? [],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (url.pathname === "/authorize") {
      authRequests++;
      lastChallenge = url.searchParams.get("code_challenge") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri");
      if (
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("client_id") !== "test-client" ||
        !redirectUri
      ) {
        sendJson(400, { error: "invalid_request" });
        return;
      }
      const out = new URL(redirectUri);
      out.searchParams.set("code", AUTH_CODE);
      const state = url.searchParams.get("state");
      if (state) out.searchParams.set("state", state);
      res.writeHead(302, { location: out.href }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      tokenRequests++;
      const form = new URLSearchParams(await readRaw(req));
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const valid =
        form.get("grant_type") === "authorization_code" &&
        form.get("code") === AUTH_CODE &&
        form.get("client_id") === "test-client" &&
        !!form.get("redirect_uri") &&
        challenge === lastChallenge;
      if (!valid) {
        sendJson(400, { error: "invalid_grant" });
        return;
      }
      sendJson(200, {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-1",
      });
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        res
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          })
          .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
        return;
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (req.method === "POST" && isInitializeRequest(body)) {
        let transport!: StreamableHTTPServerTransport;
        const mcp = new McpServer({ name: "oauth-test", version: "1.0.0" });
        mcp.registerTool("echo", { description: "Return pong" }, async () => ({
          content: [{ type: "text" as const, text: "pong" }],
        }));
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "bad request" }, id: null }));
      return;
    }
    res.writeHead(404).end();
  });

  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    stats: () => ({ registrations, tokenRequests, authRequests }),
  };
}

const toolCtx: ToolContext = { cwd: process.cwd(), askPermission: async () => true };

describe("remote MCP over OAuth", () => {
  let fixture: ReturnType<typeof startOAuthServer>;
  let authDir: string;

  beforeAll(async () => {
    authDir = await fs.mkdtemp(path.join(os.tmpdir(), "mojo-mcp-oauth-"));
    fixture = startOAuthServer();
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await fs.rm(authDir, { recursive: true, force: true });
  });

  it("authorizes through the loopback callback and reuses the stored token", async () => {
    const opened: string[] = [];
    const launch = (url: string) => {
      opened.push(url);
      void fetch(url).catch(() => {});
    };

    const manager = new McpManager({ authDir, openUrl: launch, oauthTimeoutMs: 10_000, log: () => {} });
    const statuses = await manager.connectAll({ "oauth-srv": { url: fixture.url(), oauth: true, type: "http" } });
    expect(statuses).toEqual([{ name: "oauth-srv", connected: true, toolCount: 1, kind: "http" }]);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/authorize");
    expect(fixture.stats()).toEqual({ registrations: 1, tokenRequests: 1, authRequests: 1 });

    const tool = getTool("mcp__oauth-srv__echo");
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, toolCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("pong");
    await manager.shutdown();

    const record = JSON.parse(await fs.readFile(mcpAuthFilePath("oauth-srv", authDir), "utf8"));
    expect(record.tokens).toMatchObject({ access_token: ACCESS_TOKEN, refresh_token: "refresh-1" });
    expect(record.clientInformation.client_id).toBe("test-client");

    // A fresh manager with the same store sends the cached token: no browser,
    // no re-registration, no second token exchange.
    const second = new McpManager({ authDir, openUrl: launch, oauthTimeoutMs: 10_000, log: () => {} });
    const status = await second.connect("oauth-srv", { url: fixture.url(), oauth: true, type: "http" });
    expect(status).toMatchObject({ connected: true, toolCount: 1, kind: "http" });
    expect(opened).toHaveLength(1);
    expect(fixture.stats()).toEqual({ registrations: 1, tokenRequests: 1, authRequests: 1 });
    await second.shutdown();
  });
});
