// The HTTP surface: one node:http server, one router. Order of checks on
// every request: security headers → per-client rate limit → route. Public
// routes are /healthz and (oauth mode) the well-known metadata and the
// /oauth/* endpoints; the MCP path requires an authenticated bearer. Bodies
// are read through the 64 KB cap before anything parses them.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { EkhoConnectorAgent } from "./agent.js";
import { BodyTooLargeError, TokenBucket, clientKey, readBodyCapped, type Authenticator } from "./auth.js";
import type { ConnectorConfig } from "./config.js";
import { handleMcpRequest } from "./mcp.js";
import { OAuthError, type OAuthServer } from "./oauth.js";
import type { WakeNotifier } from "./webhook.js";

export interface HttpDeps {
  config: ConnectorConfig;
  agent: EkhoConnectorAgent;
  authenticator: Authenticator;
  oauth?: OAuthServer;
  notifier?: WakeNotifier;
  log?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void };
  now?: () => number;
  version?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(html);
}

function parseForm(body: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function queryOf(url: URL): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

export function createHttpServer(deps: HttpDeps): http.Server {
  const { config, agent } = deps;
  const bucket = new TokenBucket(config.rateLimitPerMinute, deps.now);
  const log = deps.log ?? console;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    const key = clientKey(req, config.trustProxy);
    const limit = bucket.take(key);
    if (!limit.ok) {
      sendJson(res, 429, { error: "rate_limited", error_description: "too many requests" }, { "retry-after": String(limit.retryAfterSeconds) });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if (pathname === "/healthz" && method === "GET") {
      const h = agent.health();
      sendJson(res, h.status === "connected" || h.status === "paused" ? 200 : 503, {
        ok: h.status === "connected" || h.status === "paused",
        version: deps.version ?? "unknown",
        agent: h.status,
        unread: h.unread,
        pinned_operator_keys: h.pinned_operator_keys,
        last_poll_at: h.last_poll_at,
        last_heartbeat_at: h.last_heartbeat_at,
        auth: config.auth,
        wake_webhook: config.wakeWebhookUrl ? (deps.notifier?.breakerOpen() ? "breaker_open" : "configured") : "off",
        ...(deps.notifier ? { wake_stats: deps.notifier.stats } : {})
      });
      return;
    }

    if (deps.oauth) {
      const oauth = deps.oauth;
      if (method === "GET" && (pathname === "/.well-known/oauth-protected-resource" || pathname === `/.well-known/oauth-protected-resource${config.mcpPath}`)) {
        sendJson(res, 200, oauth.protectedResourceMetadata());
        return;
      }
      if (method === "GET" && (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration")) {
        sendJson(res, 200, oauth.authorizationServerMetadata());
        return;
      }
      if (pathname.startsWith("/oauth/")) {
        await handleOAuth(oauth, pathname, method, url, req, res, key);
        return;
      }
    }

    if (pathname === config.mcpPath) {
      const decision = await deps.authenticator.authenticate(req.headers.authorization);
      if (!decision.ok) {
        sendJson(res, decision.status, { error: decision.error, error_description: decision.description }, { "www-authenticate": decision.wwwAuthenticate });
        return;
      }
      if (method === "POST") {
        let raw: Buffer;
        try {
          raw = await readBodyCapped(req, config.bodyCapBytes);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, { error: "payload_too_large", error_description: err.message }, { connection: "close" });
            req.socket.destroy();
            return;
          }
          throw err;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON" }, id: null });
          return;
        }
        await handleMcpRequest(agent, req, res, parsed, config.bodyCapBytes);
        return;
      }
      // GET (server-initiated stream) and DELETE (session end) go to the
      // transport, which answers 405 in stateless mode — spec behaviour, not ours.
      await handleMcpRequest(agent, req, res, undefined, config.bodyCapBytes);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  async function handleOAuth(oauth: OAuthServer, pathname: string, method: string, url: URL, req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    try {
      if (pathname === "/oauth/register" && method === "POST") {
        const raw = await readBodyCapped(req, config.bodyCapBytes);
        let body: unknown;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new OAuthError(400, "invalid_client_metadata", "invalid JSON");
        }
        sendJson(res, 201, oauth.registerClient(body));
        return;
      }
      if (pathname === "/oauth/authorize" && method === "GET") {
        const v = oauth.validateAuthorizeRequest(queryOf(url));
        if (!v.ok) {
          res.writeHead(302, { location: v.redirect });
          res.end();
          return;
        }
        const nonce = oauth.beginConsent(v.params);
        sendHtml(res, 200, oauth.renderConsentPage(v.params, nonce, oauth.getClient(v.params.client_id)?.client_name ?? v.params.client_id));
        return;
      }
      if (pathname === "/oauth/authorize" && method === "POST") {
        const form = parseForm((await readBodyCapped(req, config.bodyCapBytes)).toString("utf8"));
        const redirect = oauth.completeConsent(form.consent, form.password, key);
        res.writeHead(302, { location: redirect });
        res.end();
        return;
      }
      if (pathname === "/oauth/token" && method === "POST") {
        const form = parseForm((await readBodyCapped(req, config.bodyCapBytes)).toString("utf8"));
        sendJson(res, 200, oauth.token(form), { pragma: "no-cache" });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "payload_too_large", error_description: err.message }, { connection: "close" });
        req.socket.destroy();
        return;
      }
      if (err instanceof OAuthError) {
        sendJson(res, err.status, { error: err.error, error_description: err.description }, err.status === 401 ? { "www-authenticate": 'Bearer realm="ekho-mcp"' } : {});
        return;
      }
      throw err;
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn?.(`[ekho-mcp] request failed: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
