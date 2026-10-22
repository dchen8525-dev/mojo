import { describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl,
  htmlToText,
  isBlockedAddress,
  parseBing,
  parseDuckDuckGo,
  webFetchTool,
  webSearchTool,
} from "../src/tools/web.js";
import type { ToolContext } from "../src/types.js";

// Keep SSRF validation hermetic: every name resolves to a public address,
// except *.internal.example which stands in for a private network target.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: async (hostname: string) =>
        String(hostname).includes("internal.example")
          ? [{ address: "192.168.1.10", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    },
  };
});

const ctx: ToolContext = { cwd: process.cwd(), askPermission: async () => true };

describe("htmlToText", () => {
  it("strips scripts, styles, and tags while keeping structure", () => {
    const html = `<html><head><style>.a{color:red}</style><script>evil()</script></head>
      <body><h1>Title</h1><p>First para.</p><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Title");
    expect(text).toContain("First para.");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).not.toContain("<");
  });

  it("decodes entities and collapses blank runs", () => {
    const text = htmlToText("<p>Tom &amp; Jerry &#39;here&#39;&nbsp;&nbsp;now</p>\n\n\n\n\n<p>next</p>");
    expect(text).toContain("Tom & Jerry 'here' now");
    expect(text).not.toContain("\n\n\n");
  });
});

describe("parseDuckDuckGo", () => {
  const sample = `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="noopener" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=abc">Example Doc &amp; Guide</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">A helpful <b>snippet</b> here.</a>
    </div>
    <div class="result">
      <h2 class="result__title"><a class="result__a" href="https://second.example/x">Second</a></h2>
      <a class="result__snippet">plain snippet</a>
    </div>`;

  it("extracts title, unwrapped URL, and cleaned snippet", () => {
    const rs = parseDuckDuckGo(sample);
    expect(rs).toHaveLength(2);
    expect(rs[0].title).toBe("Example Doc & Guide");
    expect(rs[0].url).toBe("https://example.com/doc"); // uddg unwrapped + decoded
    expect(rs[0].snippet).toBe("A helpful snippet here.");
    expect(rs[1].url).toBe("https://second.example/x");
  });

  it("returns empty for a page with no results", () => {
    expect(parseDuckDuckGo("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("parseBing", () => {
  const sample = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://docs.example.com/guide">Bing Guide</a></h2>
        <div><a>…</a></div>
        <p>Some snippet <strong>text</strong>.</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://www.example.com/foo">Foo</a></h2>
        <p>Another snippet.</p>
      </li>
      <li class="b_pag">…</li>
    </ol>`;

  it("extracts b_algo results only", () => {
    const rs = parseBing(sample);
    expect(rs).toHaveLength(2);
    expect(rs[0].title).toBe("Bing Guide");
    expect(rs[0].url).toBe("https://docs.example.com/guide");
    expect(rs[0].snippet).toBe("Some snippet text.");
    expect(rs[1].url).toBe("https://www.example.com/foo");
  });

  it("skips non-http links and returns empty when none match", () => {
    expect(parseBing(`<li class="b_algo"><h2><a href="javascript:void(0)">x</a></h2></li>`)).toEqual([]);
  });
});

describe("web tool guards", () => {
  it("web_fetch refuses non-http(s) schemes", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://host/x"]) {
      const r = await webFetchTool.execute({ url }, ctx);
      expect(r.isError).toBe(true);
    }
  });

  it("web_search surfaces network failure as a tool error, not a throw", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ENOTFOUND html.duckduckgo.com");
    }) as never;
    try {
      const r = await webSearchTool.execute({ query: "anything" }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Search failed");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("falls back to Bing when DuckDuckGo returns no results", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL) => {
      const url = String(_input);
      if (url.includes("duckduckgo"))
        return new Response("<html><body>no results</body></html>", { status: 200 });
      return new Response(
        `<ol id="b_results"><li class="b_algo"><h2><a href="https://docs.example.com/x">Fallback Result</a></h2><p>snippet</p></li></ol>`,
        { status: 200 },
      );
    }) as never;
    try {
      const r = await webSearchTool.execute({ query: "fallback", max_results: 5 }, ctx);
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain("Fallback Result");
      expect(r.content).toContain("engine: bing");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("web_fetch renders a mocked HTML page to text", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response("<html><head><title>Hi page</title></head><body><p>hello <b>world</b></p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ) as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/page" }, ctx);
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain("# Hi page");
      expect(r.content).toContain("hello world");
      expect(r.content).toContain("Source: https://example.com/page");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("web_fetch reports HTTP errors", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/missing" }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("404");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("SSRF guard", () => {
  it("classifies private and special-use addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "2001:db8::1",
      // Deprecated forms that still decode to loopback on some stacks.
      "::7f00:1",
      "::ffff:0:7f00:1",
      "0:0:0:0:0:0:7f00:1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "::ffff:808:808",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("accepts public URLs and rejects local names and schemes", async () => {
    await expect(assertPublicUrl("https://example.com/a")).resolves.toBeInstanceOf(URL);
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "http://localhost/",
      "http://foo.localhost/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://127.0.0.1/",
      "http://[::1]/",
      // Numeric and compressed IPv4 spellings the URL parser normalizes.
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
      // IPv4-compatible / translated IPv6 forms must not slip past the guard.
      "http://[::7f00:1]/",
      "http://[::ffff:0:7f00:1]/",
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow();
    }
  });

  it("honours an already-aborted turn without opening a request", async () => {
    const spy = vi.fn();
    const orig = globalThis.fetch;
    globalThis.fetch = spy as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/" }, { ...ctx, signal: AbortSignal.abort() });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/aborted/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("rejects names that resolve to a private address", async () => {
    await expect(assertPublicUrl("https://db.internal.example/x")).rejects.toThrow(
      /resolves to a local\/private address/,
    );
  });

  it("web_fetch refuses local targets without calling fetch", async () => {
    const orig = globalThis.fetch;
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    try {
      for (const url of [
        "http://localhost:3000/",
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.0.1/",
        "http://[::1]/",
        "http://printer.local/",
      ]) {
        const r = await webFetchTool.execute({ url }, ctx);
        expect(r.isError, url).toBe(true);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("web_fetch follows public redirects and reports the final URL", async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input) === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return new Response("<html><head><title>Moved</title></head><body>arrived</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/start" }, ctx);
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain("arrived");
      expect(r.content).toContain("Source: https://example.com/final");
      expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("web_fetch refuses a redirect into the private network", async () => {
    const orig = globalThis.fetch;
    const spy = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    globalThis.fetch = spy as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/start" }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/private/i);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("web_fetch stops after too many redirects", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
    ) as never;
    try {
      const r = await webFetchTool.execute({ url: "https://example.com/loop" }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("too many redirects");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
