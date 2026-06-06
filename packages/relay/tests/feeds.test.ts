import { describe, it, expect } from "vitest";
import { parseFeed, isAllowedFeedUrl } from "../src/feeds";

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
