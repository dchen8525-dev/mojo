import { promises as dns } from "node:dns";
import net from "node:net";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num, truncate, describeError } from "./utils.js";

/**
 * Web tools built on the global fetch (Node >= 18). No API key required:
 * - web_search uses DuckDuckGo's HTML endpoint and parses the results,
 * - web_fetch downloads a page and strips it to readable text/markdown-ish.
 * Both cap response size and time, refuse non-http(s) schemes, and reject
 * loopback/private/link-local hosts (including names that resolve to them),
 * so a model cannot reach file://, localhost, or cloud metadata endpoints.
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1_000_000;
const UA = "Mozilla/5.0 (compatible; node-agent/0.1; +https://example.invalid)";

/** True for addresses that must never be fetched: loopback, private, metadata, ... */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(addr)) {
    const [a, b, c] = addr.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments / TEST-NET-1
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      a >= 224 // multicast + reserved
    );
  }
  if (!net.isIPv6(addr)) return true;
  const s = addr.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    /^f[cd]/.test(s) || // unique local fc00::/7
    /^fe[89ab]/.test(s) || // link-local fe80::/10
    /^ff/.test(s) || // multicast
    /^2001:db8:/.test(s) || // documentation
    s.startsWith("64:ff9b:") || // NAT64
    s.startsWith("2001:0:") // Teredo
  );
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa") ||
    h === "metadata.google.internal"
  );
}

/**
 * Validate an http(s) URL and every address its host resolves to. Redirect
 * targets are validated the same way, so a public URL cannot bounce the agent
 * into the local network. DNS is re-resolved per hop; rebinding between the
 * check and the connect is out of scope for fetch-level guarding.
 */
export async function assertPublicUrl(input: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new Error(`invalid URL: ${String(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing non-http(s) URL: ${url.protocol}//`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("refusing URL without a host");
  if (isBlockedHostname(host)) throw new Error(`refusing to fetch local host "${host}"`);
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`refusing to fetch private address ${host}`);
    return url;
  }
  let addresses: string[];
  try {
    addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new Error(`cannot resolve host "${host}"`);
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new Error(`refusing to fetch "${host}": it resolves to a local/private address`);
  }
  return url;
}

async function readLimited(res: Response, limit = MAX_BODY_BYTES): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.subarray(0, limit);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const room = limit - total;
      chunks.push(value.subarray(0, room));
      total += Math.min(value.byteLength, room);
      if (value.byteLength >= room) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function httpGet(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string; contentType: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    let current = await assertPublicUrl(url);
    for (let hop = 0; ; hop++) {
      const res = await fetch(current.toString(), {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`);
        current = await assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const bytes = await readLimited(res);
      const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return { status: res.status, body, contentType, finalUrl: current.toString() };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Turn an HTML document into readable plain text (drops scripts/styles/tags). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Preserve some structure: block ends become newlines.
  s = s
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract the DuckDuckGo <title> for a query into result links. */
export function parseDuckDuckGo(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  // Built via RegExp because a literal `$` before `/` would end the literal.
  const blockRe = new RegExp('<div class="result[^"]*">([\\s\\S]*?)(?=<div class="result|$)', "gi");
  for (const m of html.matchAll(blockRe)) {
    const block = m[1];
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const href = decodeEntities(a[1]);
    const title = htmlToText(a[2]).trim();
    const sn = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippet = sn ? htmlToText(sn[1]).trim() : "";
    // DDG wraps links in /l/?uddg=<encoded>; unwrap to the real target.
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const url = uddg ? decodeURIComponent(uddg[1]) : href;
    if (!title || !url.startsWith("http")) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

/** Extract the Bing SERP's organic results. */
export function parseBing(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  for (const m of html.matchAll(blockRe)) {
    const block = m[0];
    const a = /<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i.exec(block);
    if (!a) continue;
    const url = decodeEntities(a[1]);
    const title = htmlToText(a[2]).trim();
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sn ? htmlToText(sn[1]).trim() : "";
    if (!title || !/^https?:\/\//.test(url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

async function ddgSearch(query: string, max: number, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, body } = await httpGet(url, signal);
  if (status >= 400) throw new Error(`DuckDuckGo returned HTTP ${status}`);
  return parseDuckDuckGo(body).slice(0, max);
}

async function bingSearch(query: string, max: number, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`;
  const { status, body } = await httpGet(url, signal);
  if (status >= 400) throw new Error(`Bing returned HTTP ${status}`);
  return parseBing(body).slice(0, max);
}

/**
 * Ordered search engines, tried in sequence until one yields results.
 * `AGENT_SEARCH_ENGINE=bing` (or `duckduckgo`) pins a single engine.
 */
function engineOrder(): string[] {
  const pin = (process.env.AGENT_SEARCH_ENGINE ?? "").trim().toLowerCase();
  if (pin === "bing") return ["bing"];
  if (pin === "duckduckgo" || pin === "ddg") return ["duckduckgo"];
  return ["duckduckgo", "bing"]; // default: try duckduckgo, fall back to bing
}

const ENGINES: Record<string, (q: string, max: number, signal?: AbortSignal) => Promise<Array<{ title: string; url: string; snippet: string }>>> = {
  duckduckgo: ddgSearch,
  bing: bingSearch,
};

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for the top results as title / URL / snippet. Tries DuckDuckGo first and " +
    "falls back to Bing if that yields nothing; set AGENT_SEARCH_ENGINE=bing to pin the engine. " +
    "Use it to find documentation or when you are stuck on an error you have not seen before. " +
    "Follow up promising links with web_fetch to read the actual page.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "number", description: "How many results to return (default 5, max 10)." },
    },
    required: ["query"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = str(input, "query");
    const max = Math.min(10, Math.max(1, num(input, "max_results") ?? 5));
    const engines = engineOrder();
    const errors: string[] = [];
    for (const name of engines) {
      try {
        const results = await ENGINES[name](query, max, ctx.signal);
        if (!results.length) {
          errors.push(`${name}: no results parsed`);
          continue;
        }
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
        const note = engines.length > 1 ? `\n(engine: ${name})` : "";
        return { content: truncate(`Results for "${query}":\n\n${lines.join("\n\n")}${note}`, 8_000) };
      } catch (err) {
        errors.push(`${name}: ${describeError(err)}`);
      }
    }
    return { content: `Search failed. ${errors.join("; ")}`, isError: true };
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its readable text (HTML is stripped to plain text). Use for " +
    "documentation pages, READMEs, error explanations, and API references. Output is " +
    "truncated if large. Only public http(s) URLs are allowed: localhost, private, " +
    "link-local, and cloud-metadata addresses are refused.",
  isReadOnly: true,
  parallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
      max_chars: { type: "number", description: "Cap the returned text (default 20000)." },
    },
    required: ["url"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = str(input, "url");
    const maxChars = Math.min(100_000, Math.max(1_000, num(input, "max_chars") ?? 20_000));
    try {
      const { status, body, contentType, finalUrl } = await httpGet(url, ctx.signal);
      if (status >= 400) return { content: `Fetch failed: HTTP ${status} for ${finalUrl}`, isError: true };
      let text: string;
      if (/json/i.test(contentType)) text = body;
      else if (/html/i.test(contentType) || /^\s*</.test(body)) text = htmlToText(body);
      else text = body; // plain text or unknown
      if (!text.trim()) return { content: `Fetched ${finalUrl} but it had no readable text.`, isError: true };
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
      const header = title ? `# ${htmlToText(title).trim()}\nSource: ${finalUrl}\n\n` : `Source: ${finalUrl}\n\n`;
      return { content: truncate(header + text, maxChars) };
    } catch (err) {
      return { content: `Fetch error: ${describeError(err)}`, isError: true };
    }
  },
};
