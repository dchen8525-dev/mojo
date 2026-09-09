import { describe, expect, it, vi } from "vitest";
import { htmlToText, parseDuckDuckGo, webFetchTool, webSearchTool } from "../src/tools/web.js";
import type { ToolContext } from "../src/types.js";

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
      expect(r.content).toContain("Search error");
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
