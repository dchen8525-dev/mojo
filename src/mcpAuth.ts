import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { openBrowser } from "./openBrowser.js";

/**
 * OAuth 2.1 support for remote MCP servers: a per-server credential store, a
 * loopback callback receiver, and an OAuthClientProvider the SDK transports
 * can drive (discovery, dynamic registration, PKCE, refresh). Tokens live
 * under ~/.node-agent/mcp-auth/<server>.json with 0600 permissions.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export function mcpAuthDir(home: string = os.homedir()): string {
  return path.join(home, ".node-agent", "mcp-auth");
}

export function mcpAuthFilePath(serverName: string, dir: string = mcpAuthDir()): string {
  return path.join(dir, `${serverName.replace(/[^\w.-]/g, "_")}.json`);
}

interface AuthRecord {
  /** Endpoint these credentials were issued for; a changed URL invalidates them. */
  serverUrl?: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

class OAuthStore {
  private cache: AuthRecord | null = null;

  constructor(readonly file: string) {}

  async load(): Promise<AuthRecord> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      this.cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AuthRecord) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async update(patch: Partial<AuthRecord>): Promise<void> {
    const record = await this.load();
    Object.assign(record, patch);
    await this.save();
  }

  /** Drop everything and start from a clean record (used when the endpoint changes). */
  async replace(record: AuthRecord): Promise<void> {
    this.cache = record;
    await this.save();
  }

  async invalidate(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const record = await this.load();
    if (scope === "all") this.cache = {};
    else if (scope === "tokens") delete record.tokens;
    else if (scope === "client") delete record.clientInformation;
    else if (scope === "verifier") delete record.codeVerifier;
    else delete record.discoveryState;
    await this.save();
  }

  private async save(): Promise<void> {
    const record = this.cache ?? {};
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }
}

export interface McpOAuthFlowOptions {
  serverName: string;
  serverUrl: string;
  /** Directory for the token store (tests use a temp dir). */
  authDir?: string;
  /** How long to wait for the browser callback. */
  timeoutMs?: number;
  /** Override browser launching (tests drive the authorization URL themselves). */
  openUrl?: (url: string) => void;
  log?: (message: string) => void;
}

export class McpOAuthFlow {
  readonly provider: OAuthClientProvider;
  readonly redirectUrl: string;
  private readonly state = randomUUID();
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly openUrl: (url: string) => void;
  private readonly store: OAuthStore;
  /** Exact Host header the loopback receiver answers to (DNS-rebinding guard). */
  private readonly callbackHost: string;
  private callbackConsumed = false;
  private server: Server | null = null;
  private pending: { resolve: (code: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
  private settled: { code: string } | { error: Error } | null = null;
  private lastAuthUrl = "";
  private closed = false;

  private constructor(opts: McpOAuthFlowOptions, server: Server, redirectUrl: string) {
    this.server = server;
    this.redirectUrl = redirectUrl;
    this.callbackHost = new URL(redirectUrl).host;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.openUrl = opts.openUrl ?? openBrowser;
    this.store = new OAuthStore(mcpAuthFilePath(opts.serverName, opts.authDir));

    const flow = this;
    this.provider = {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "mojo",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => flow.state,
      clientInformation: async () => (await flow.store.load()).clientInformation,
      saveClientInformation: async (info) => {
        await flow.store.update({ clientInformation: info });
      },
      tokens: async () => (await flow.store.load()).tokens,
      saveTokens: async (tokens) => {
        await flow.store.update({ tokens });
      },
      saveCodeVerifier: async (verifier) => {
        await flow.store.update({ codeVerifier: verifier });
      },
      codeVerifier: async () => {
        const verifier = (await flow.store.load()).codeVerifier;
        if (!verifier) throw new Error("OAuth code verifier is missing");
        return verifier;
      },
      discoveryState: async () => (await flow.store.load()).discoveryState,
      saveDiscoveryState: async (state) => {
        await flow.store.update({ discoveryState: state });
      },
      invalidateCredentials: async (scope) => {
        await flow.store.invalidate(scope);
      },
      redirectToAuthorization: (authorizationUrl) => {
        // The endpoint comes from the server's discovery document, not from
        // the user. Handing file:/javascript: to the OS opener would let a
        // malicious server launch a local handler; only web URLs are valid.
        if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
          throw new Error(`refusing non-http(s) authorization URL: ${authorizationUrl.protocol}//`);
        }
        flow.lastAuthUrl = authorizationUrl.href;
        flow.log(`mcp: ${opts.serverName} (${opts.serverUrl}) needs OAuth authorization — opening ${authorizationUrl.href}`);
        try {
          flow.openUrl(authorizationUrl.href);
        } catch (err) {
          // Keep waiting: the user can still open the URL from the log or the
          // timeout error, which includes it.
          flow.log(`mcp: could not open a browser (${err instanceof Error ? err.message : String(err)}) — open the URL above manually`);
        }
      },
    };
    server.on("request", (req, res) => flow.handle(req, res));
  }

  static async start(opts: McpOAuthFlowOptions): Promise<McpOAuthFlow> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    const flow = new McpOAuthFlow(opts, server, `http://127.0.0.1:${addr.port}/callback`);
    await flow.bindEndpoint(opts.serverUrl);
    return flow;
  }

  /**
   * Credentials are keyed by server *name* on disk. If that name is repointed
   * at another endpoint (e.g. a project config shadowing a global server), the
   * stored bearer token and client registration must not be offered to it.
   */
  private async bindEndpoint(serverUrl: string): Promise<void> {
    const record = await this.store.load();
    if (record.serverUrl === serverUrl) return;
    await this.store.replace({ serverUrl });
  }

  /**
   * Resolve with the authorization code delivered to the loopback callback.
   * A fast browser redirect can beat this call, so a code (or error) that
   * arrived while nobody was waiting is buffered instead of being dropped.
   */
  waitForCode(): Promise<string> {
    if (this.settled) {
      return "code" in this.settled ? Promise.resolve(this.settled.code) : Promise.reject(this.settled.error);
    }
    if (this.closed) return Promise.reject(new Error("OAuth flow is already closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new Error(
            `OAuth authorization timed out after ${Math.round(this.timeoutMs / 1000)}s` +
              (this.lastAuthUrl ? ` — open this URL to authorize: ${this.lastAuthUrl}` : ""),
          ),
        );
        void this.close();
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("OAuth flow closed before authorization completed"));
      this.pending = null;
    }
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private settle(kind: "resolve" | "reject", value: string | Error): void {
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      clearTimeout(pending.timer);
      if (kind === "resolve") pending.resolve(value as string);
      else pending.reject(value as Error);
      return;
    }
    if (!this.settled) {
      this.settled = kind === "resolve" ? { code: value as string } : { error: value as Error };
    }
  }

  private handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const page = (body: string) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
      });
      res.end(`<!doctype html><meta charset="utf-8"><title>mojo</title><p>${body}</p>`);
    };
    // A DNS-rebinding page can reach the loopback socket under its own name;
    // requiring the exact loopback Host keeps the callback bound to 127.0.0.1.
    if ((req.headers.host ?? "").toLowerCase() !== this.callbackHost) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid host");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (url.searchParams.get("state") !== this.state) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid state");
      return;
    }
    // The state is single-use: a captured/replayed callback must not resolve
    // a later flow with an attacker-chosen code.
    if (this.callbackConsumed) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("authorization already completed");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      this.callbackConsumed = true;
      page("授权失败，请回到 mojo 查看错误。");
      const description = url.searchParams.get("error_description");
      this.settle("reject", new Error(`OAuth authorization failed: ${error}${description ? ` (${description.slice(0, 200)})` : ""}`));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing authorization code");
      return;
    }
    this.callbackConsumed = true;
    page("授权完成，可以关闭此页面。");
    this.settle("resolve", code);
  }
}
