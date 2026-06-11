import { describe, it, expect } from "vitest";
import { parseFeed, isAllowedFeedUrl, resolveRedirectTarget, fetchFeedUrlWith } from "../src/feeds";

// A minimal Response-like stub + a recording fetch, so the redirect loop is
// exercised with zero network.
function resp(init: { status: number; location?: string; ok?: boolean; contentLength?: string; body?: string }) {
  const headers = new Headers();
  if (init.location) headers.set("location", init.location);
  if (init.contentLength) headers.set("content-length", init.contentLength);
  return {
    status: init.status,
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    headers,
    text: async () => init.body ?? ""
  } as unknown as Response;
}
function recordingFetch(responders: Array<(url: string) => Response>) {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (url: string) => {
    calls.push(String(url));
    const r = responders[Math.min(i, responders.length - 1)];
    i++;
    return r(String(url));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseFeed", () => {
  it("parses RSS 2.0 items (title, link, guid, pubDate, CDATA)", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <title>Chan</title>
      <item><title><![CDATA[Big news & more]]></title><link>https://ex.com/a</link><guid>g-a</guid><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate></item>
      <item><title>Second</title><link>https://ex.com/b</link><guid isPermaLink="false">g-b</guid></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ guid: "g-a", title: "Big news & more", link: "https://ex.com/a", published: "Mon, 01 Jun 2026 10:00:00 GMT" });
    expect(items[1].guid).toBe("g-b");
    expect(items[1].published).toBeNull();
  });

  it("parses Atom entries (link href, id, updated)", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Atom one</title><link href="https://ex.com/x" rel="alternate"/><id>urn:x</id><updated>2026-06-01T10:00:00Z</updated></entry>
    </feed>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Atom one");
    expect(items[0].link).toBe("https://ex.com/x");
    expect(items[0].guid).toBe("urn:x");
    expect(items[0].published).toBe("2026-06-01T10:00:00Z");
  });

  it("returns [] for non-feed / empty input", () => {
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("<html><body>no feed</body></html>")).toEqual([]);
  });
});

describe("isAllowedFeedUrl (SSRF guard)", () => {
  it("allows public http(s) URLs", () => {
    expect(isAllowedFeedUrl("https://techcrunch.com/feed/")).toBe(true);
    expect(isAllowedFeedUrl("http://example.com/rss.xml")).toBe(true);
  });

  it("blocks non-http schemes", () => {
    expect(isAllowedFeedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedFeedUrl("ftp://ex.com")).toBe(false);
    expect(isAllowedFeedUrl("not a url")).toBe(false);
  });

  it("blocks localhost, private ranges, and cloud metadata", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x"
    ]) {
      expect(isAllowedFeedUrl(u), u).toBe(false);
    }
  });
});

// M3 — redirects must be followed MANUALLY and re-validated each hop, so an
// allowed URL can't bounce the relay onto a private/internal address (SSRF).
describe("resolveRedirectTarget", () => {
  it("passes through an allowed absolute Location", () => {
    expect(resolveRedirectTarget("https://a.example/feed", "https://b.example/real.xml")).toBe("https://b.example/real.xml");
  });
  it("blocks a redirect to loopback / private / metadata", () => {
    expect(resolveRedirectTarget("https://a.example/feed", "http://127.0.0.1/x")).toBeNull();
    expect(resolveRedirectTarget("https://a.example/feed", "http://10.0.0.5/x")).toBeNull();
    expect(resolveRedirectTarget("https://a.example/feed", "http://169.254.169.254/latest/meta-data/")).toBeNull();
  });
  it("resolves a relative Location against the current URL then re-checks it", () => {
    expect(resolveRedirectTarget("https://a.example/dir/feed", "/internal")).toBe("https://a.example/internal");
    // protocol-relative resolving to a loopback host is blocked
    expect(resolveRedirectTarget("https://a.example/feed", "//127.0.0.1/x")).toBeNull();
  });
  it("returns null for a missing Location header", () => {
    expect(resolveRedirectTarget("https://a.example/feed", null)).toBeNull();
  });
});

describe("fetchFeedUrlWith (manual redirect + per-hop SSRF guard)", () => {
  it("follows an allowed→allowed redirect and returns the body", async () => {
    const { fn, calls } = recordingFetch([
      () => resp({ status: 302, location: "https://b.example/real.xml" }),
      () => resp({ status: 200, ok: true, body: "<rss/>" })
    ]);
    const out = await fetchFeedUrlWith(fn, "https://a.example/feed");
    expect(out).toBe("<rss/>");
    expect(calls).toEqual(["https://a.example/feed", "https://b.example/real.xml"]);
  });

  it("blocks a redirect to loopback and never fetches the internal target", async () => {
    const { fn, calls } = recordingFetch([() => resp({ status: 302, location: "http://127.0.0.1:8080/secret" })]);
    const out = await fetchFeedUrlWith(fn, "https://a.example/feed");
    expect(out).toBeNull();
    expect(calls).toEqual(["https://a.example/feed"]); // exactly one call
  });

  it("blocks a redirect to cloud metadata", async () => {
    const { fn, calls } = recordingFetch([() => resp({ status: 301, location: "http://169.254.169.254/latest/meta-data/" })]);
    expect(await fetchFeedUrlWith(fn, "https://a.example/feed")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("resolves + follows a relative redirect", async () => {
    const { fn, calls } = recordingFetch([
      () => resp({ status: 307, location: "/feed.xml" }),
      () => resp({ status: 200, ok: true, body: "<rss/>" })
    ]);
    expect(await fetchFeedUrlWith(fn, "https://a.example/news")).toBe("<rss/>");
    expect(calls[1]).toBe("https://a.example/feed.xml");
  });

  it("aborts a redirect chain that exceeds the hop cap", async () => {
    const { fn, calls } = recordingFetch([() => resp({ status: 302, location: "https://a.example/next" })]);
    const out = await fetchFeedUrlWith(fn, "https://a.example/0", 10_000, 3_000_000, 5);
    expect(out).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(6); // maxRedirects + 1
  });

  it("aborts on a redirect with no Location header", async () => {
    const { fn, calls } = recordingFetch([() => resp({ status: 302 })]);
    expect(await fetchFeedUrlWith(fn, "https://a.example/feed")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("short-circuits when the INITIAL url is blocked (never fetches)", async () => {
    const { fn, calls } = recordingFetch([() => resp({ status: 200, ok: true, body: "x" })]);
    expect(await fetchFeedUrlWith(fn, "http://127.0.0.1/x")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on a non-redirect, non-ok response", async () => {
    const { fn } = recordingFetch([() => resp({ status: 500, ok: false })]);
    expect(await fetchFeedUrlWith(fn, "https://a.example/feed")).toBeNull();
  });

  it("returns null when content-length exceeds the cap", async () => {
    const { fn } = recordingFetch([() => resp({ status: 200, ok: true, contentLength: "4000000", body: "x" })]);
    expect(await fetchFeedUrlWith(fn, "https://a.example/feed", 10_000, 3_000_000)).toBeNull();
  });
});
