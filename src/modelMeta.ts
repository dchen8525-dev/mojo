import type { Provider } from "./llm/types.js";

/**
 * Context-window discovery for endpoints that publish model metadata.
 *
 * The local table in `llm/models.ts` is a static guess; gateways increasingly
 * report the real number on their model list (DeepSeek returns
 * `context_window`, OpenRouter `context_length`, ...). We cache one lookup per
 * (provider, endpoint, model) for the life of the process and never let the
 * network sit in the hot path — `LLM.contextWindow` reads the cache
 * synchronously.
 */

export interface ModelMeta {
  contextWindow?: number;
}

/** Field names different providers/gateways use for the input window. */
const CONTEXT_FIELDS = ["context_window", "context_length", "max_context_tokens", "max_input_tokens", "input_token_limit"];

const cache = new Map<string, ModelMeta>();

function key(provider: Provider, baseURL: string | undefined, model: string): string {
  const base = (baseURL ?? "").trim().replace(/\/+$/, "");
  return `${provider}|${base}|${model}`;
}

export function getModelMeta(provider: Provider, baseURL: string | undefined, model: string): ModelMeta | undefined {
  return cache.get(key(provider, baseURL, model));
}

export function setModelMeta(provider: Provider, baseURL: string | undefined, model: string, meta: ModelMeta): void {
  cache.set(key(provider, baseURL, model), meta);
}

/** Test hook: drop everything cached. */
export function clearModelMeta(): void {
  cache.clear();
}

function defaultBase(provider: Provider): string {
  return provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com";
}

function authHeaders(provider: Provider, apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return provider === "openai"
    ? { authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

function pickNumber(entry: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const raw = entry[field];
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/** Candidate list URLs: the provider's native one, then the host's OpenAI-style route. */
function listUrls(provider: Provider, baseURL: string | undefined): string[] {
  const base = (baseURL?.trim() || defaultBase(provider)).replace(/\/+$/, "");
  const urls = [provider === "openai" ? `${base}/models` : `${base}/v1/models`];
  try {
    const fallback = `${new URL(base).origin}/models`;
    // Anthropic-format gateways (DeepSeek, …) often expose the list only here.
    if (!urls.includes(fallback)) urls.push(fallback);
  } catch {
    /* bad baseURL: native URL will fail on its own */
  }
  return urls;
}

/**
 * Best-effort: read `contextWindow` for `model` from the endpoint's model list.
 * Returns null when the endpoint has no list, no match, or no usable field.
 */
export async function fetchModelMeta(opts: {
  provider: Provider;
  model: string;
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<ModelMeta | null> {
  const wanted = opts.model.trim().toLowerCase();
  for (const url of listUrls(opts.provider, opts.baseURL)) {
    try {
      const res = await fetch(url, {
        headers: authHeaders(opts.provider, opts.apiKey),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: unknown };
      const list = Array.isArray(body.data) ? body.data : [];
      const entries = list.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
      // Prefer an exact id match; a single-entry list is unambiguous.
      const entry = entries.find((e) => String(e.id ?? "").toLowerCase() === wanted) ?? (entries.length === 1 ? entries[0] : undefined);
      if (!entry) continue;
      const contextWindow = pickNumber(entry, CONTEXT_FIELDS);
      if (contextWindow) return { contextWindow };
    } catch {
      /* offline / unsupported / timeout: try the next URL */
    }
  }
  return null;
}
