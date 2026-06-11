// Feeds: dependency-free RSS/Atom parsing + an SSRF guard for operator-supplied
// feed URLs. Kept pure (no I/O) so it's trivially unit-tested; db.pollFeed does
// the fetch + delivery around these.

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  published: string | null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // ampersand LAST so the others aren't double-decoded
}

function firstTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return v.trim();
}

/**
 * Extract items from an RSS 2.0 or Atom feed. Best-effort + tolerant: handles
 * <item>/<entry>, CDATA, Atom <link href>, and the common date fields. Returns
 * newest-as-listed order (feeds are conventionally newest-first).
 */
export function parseFeed(xml: string): FeedItem[] {
  if (typeof xml !== "string" || !xml) return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = decodeXml(firstTag(block, "title")) || "(untitled)";
    let link = decodeXml(firstTag(block, "link"));
    if (!link) {
      const href = block.match(/<link\b[^>]*?href=["']([^"']+)["']/i);
      if (href) link = decodeXml(href[1]);
    }
    const rawGuid = firstTag(block, "guid") || firstTag(block, "id") || link || title;
    const published =
      firstTag(block, "pubDate") || firstTag(block, "published") || firstTag(block, "updated") || null;
    const item: FeedItem = {
      guid: decodeXml(rawGuid).trim(),
      title: title.trim(),
      link: link.trim(),
      published: published ? published.trim() : null
    };
    if (item.guid) items.push(item);
  }
  return items;
}

/**
 * Allow only public http(s) URLs for feeds — a best-effort SSRF guard against
 * pointing the relay at localhost / private ranges / cloud metadata. The
 * operator is trusted; this is defence-in-depth (it does NOT defend against DNS
 * rebinding — a resolve-time check would be needed for that).
 */
export function isAllowedFeedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "0.0.0.0" || host === "::1" || host === "::") return false;
  if (/^127\./.test(host)) return false; // loopback
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return false; // private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // private
  if (/^169\.254\./.test(host)) return false; // link-local + 169.254.169.254 metadata
  if (/^(f[cd])/i.test(host)) return false; // IPv6 unique-local fc00::/7
  if (/^fe80:/i.test(host)) return false; // IPv6 link-local
  return true;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve a redirect Location against the current URL and RE-APPLY the SSRF
 * guard. Returns the absolute next URL if allowed, else null. Handles relative
 * and protocol-relative Locations (resolved against `currentUrl`), and rejects
 * any target isAllowedFeedUrl would reject — closing the redirect-to-private-
 * address SSRF that `redirect: "follow"` left open.
 */
export function resolveRedirectTarget(currentUrl: string, location: string | null): string | null {
  if (!location) return null;
  let next: URL;
  try {
    next = new URL(location, currentUrl); // resolves both relative + absolute
  } catch {
    return null;
  }
  const abs = next.toString();
  return isAllowedFeedUrl(abs) ? abs : null;
}

/**
 * Fetch a feed URL's body with the SSRF guard applied on EVERY hop. Redirects
 * are followed manually (redirect: "manual") and each Location is re-validated
 * before it is fetched, so an allowed URL can't bounce onto a private/internal
 * address. One timeout + size cap span the whole chain. `fetchImpl` is injected
 * for testing. DNS rebinding (host resolving to a private IP at connect time)
 * remains out of scope — a resolve-time IP check would be needed for that.
 */
export async function fetchFeedUrlWith(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 10_000,
  maxBytes = 3_000_000,
  maxRedirects = 5
): Promise<string | null> {
  if (!isAllowedFeedUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); // one budget for the whole chain
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await fetchImpl(current, {
        signal: controller.signal,
        redirect: "manual", // we follow by hand and re-validate each Location
        headers: {
          "user-agent": "Ekho-Feeds/1.0 (+https://github.com/Drakon-Systems-Ltd/ekho)",
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
        }
      });
      if (REDIRECT_CODES.has(res.status)) {
        if (hop === maxRedirects) return null; // too many hops (or a loop) — abort
        const next = resolveRedirectTarget(current, res.headers.get("location"));
        if (!next) return null; // missing / unresolvable / blocked target
        current = next;
        continue;
      }
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared && declared > maxBytes) return null;
      const text = await res.text();
      return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Production entry point: fetch a feed body using the global fetch, with the
 * per-hop SSRF guard, timeout and size cap. Returns null on any failure (caller
 * treats null as "nothing new"). Signature unchanged so callers (sweep, manual
 * poll) need no edits.
 */
export async function fetchFeedUrl(
  url: string,
  timeoutMs = 10_000,
  maxBytes = 3_000_000
): Promise<string | null> {
  return fetchFeedUrlWith(fetch, url, timeoutMs, maxBytes);
}
