import type { Tool, ToolContext, ToolResult } from "../types.js";
import { str, num, truncate, describeError } from "./utils.js";

/**
 * Web tools built on the global fetch (Node >= 18). No API key required:
 * - web_search uses DuckDuckGo's HTML endpoint and parses the results,
 * - web_fetch downloads a page and strips it to readable text/markdown-ish.
 * Both cap response size and time, and refuse non-http(s) schemes so a model
 * cannot poke at file:// or the local network.
 */

const FETCH_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; node-agent/0.1; +https://example.invalid)";

async function httpGet(url: string, signal?: AbortSignal): Promise<{ status: number; body: string; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`refusing non-http(s) URL: ${parsed.protocol}//`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    const buf = await res.arrayBuffer();
    // Bound the in-memory body to ~1 MB before decoding.
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf.byteLength > 1_000_000 ? buf.slice(0, 1_000_000) : buf);
    return { status: res.status, body, contentType };
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

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web (DuckDuckGo) and return the top results as title / URL / snippet. " +
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
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { status, body } = await httpGet(url, ctx.signal);
      if (status >= 400) return { content: `Search failed: HTTP ${status}. Try a different query.`, isError: true };
      const results = parseDuckDuckGo(body).slice(0, max);
      if (!results.length) {
        return { content: `No results parsed for "${query}" (the search page may have changed).`, isError: true };
      }
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
      return { content: truncate(`Results for "${query}":\n\n${lines.join("\n\n")}`, 8_000) };
    } catch (err) {
      return { content: `Search error: ${describeError(err)}`, isError: true };
    }
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its readable text (HTML is stripped to plain text). Use for " +
    "documentation pages, READMEs, error explanations, and API references. Output is " +
    "truncated if large. Only http(s) URLs are allowed.",
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
      const { status, body, contentType } = await httpGet(url, ctx.signal);
      if (status >= 400) return { content: `Fetch failed: HTTP ${status} for ${url}`, isError: true };
      let text: string;
      if (/json/i.test(contentType)) text = body;
      else if (/html/i.test(contentType) || /^\s*</.test(body)) text = htmlToText(body);
      else text = body; // plain text or unknown
      if (!text.trim()) return { content: `Fetched ${url} but it had no readable text.`, isError: true };
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
      const header = title ? `# ${htmlToText(title).trim()}\nSource: ${url}\n\n` : `Source: ${url}\n\n`;
      return { content: truncate(header + text, maxChars) };
    } catch (err) {
      return { content: `Fetch error: ${describeError(err)}`, isError: true };
    }
  },
};
