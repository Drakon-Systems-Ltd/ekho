// A single-user OAuth 2.1 authorization server + resource server, built in so
// an MCP client that implements the MCP Authorization spec (grok.com's custom
// connectors, per Grok's own account) can connect without a third-party IdP:
//
//   - RFC 9728 Protected Resource Metadata at /.well-known/oauth-protected-resource
//   - RFC 8414 Authorization Server Metadata at /.well-known/oauth-authorization-server
//   - RFC 7591 dynamic client registration (public clients, PKCE S256 required)
//   - authorization_code + PKCE (S256 only), refresh_token with rotation
//   - RFC 8707 resource indicators: tokens are bound to this MCP endpoint
//
// The "user" is the operator: the consent page asks for EKHO_MCP_OAUTH_PASSWORD
// and nothing else, so an authorization is a deliberate act by the person who
// runs the box. Tokens are opaque random strings; only their SHA-256 is stored.

import crypto from "node:crypto";
import path from "node:path";
import { constantTimeEqual, bearerFromHeader, type AuthDecision, type Authenticator } from "./auth.js";
import { readJsonIfPresent, writeJsonAtomic } from "./files.js";

export const OAUTH_FILE = "oauth.json";
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_MS = 10 * 60_000;
export const CONSENT_TTL_MS = 10 * 60_000;
export const MAX_CLIENTS = 32;
export const MAX_TOKENS = 200;
export const SCOPE = "ekho";
/** Failed consent passwords per client address before a cooling period. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  client_id_issued_at: number;
}

interface StoredToken {
  hash: string;
  kind: "access" | "refresh";
  client_id: string;
  resource: string;
  scope: string;
  expires_at: number;
}

interface OAuthFile {
  v: 1;
  clients: RegisteredClient[];
  tokens: StoredToken[];
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: number;
}

interface PendingConsent {
  params: AuthorizeParams;
  expires_at: number;
}

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string
  ) {
    super(`${error}: ${description}`);
    this.name = "OAuthError";
  }
}

export interface OAuthServerOptions {
  stateDir: string;
  /** Public origin, no path: issuer and the base of every endpoint. */
  publicUrl: string;
  mcpPath: string;
  password: string;
  allowedRedirectHosts: string[];
  now?: () => number;
  log?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void };
}

const sha256Hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const randomToken = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString("base64url")}`;

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export class OAuthServer {
  private clients: RegisteredClient[] = [];
  private tokens: StoredToken[] = [];
  private readonly codes = new Map<string, PendingCode>();
  private readonly consents = new Map<string, PendingConsent>();
  private readonly loginFailures = new Map<string, { count: number; windowStart: number }>();
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(private readonly opts: OAuthServerOptions) {
    this.filePath = path.join(opts.stateDir, OAUTH_FILE);
    this.now = opts.now ?? (() => Date.now());
    const data = readJsonIfPresent<OAuthFile>(this.filePath);
    if (data && data.v === 1) {
      this.clients = Array.isArray(data.clients) ? data.clients : [];
      this.tokens = Array.isArray(data.tokens) ? data.tokens : [];
    }
  }

  get issuer(): string {
    return this.opts.publicUrl;
  }

  /** The protected resource identifier tokens are bound to. */
  get resource(): string {
    return `${this.opts.publicUrl}${this.opts.mcpPath}`;
  }

  get resourceMetadataUrl(): string {
    return `${this.opts.publicUrl}/.well-known/oauth-protected-resource${this.opts.mcpPath}`;
  }

  private persist(): void {
    const t = this.now();
    this.tokens = this.tokens.filter((x) => x.expires_at > t);
    while (this.tokens.length > MAX_TOKENS) this.tokens.shift();
    writeJsonAtomic(this.filePath, { v: 1, clients: this.clients, tokens: this.tokens } satisfies OAuthFile);
  }

  // ---- metadata --------------------------------------------------------

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "Ekho MCP connector"
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true
    };
  }

  // ---- registration ----------------------------------------------------

  registerClient(body: unknown): RegisteredClient {
    if (!body || typeof body !== "object") throw new OAuthError(400, "invalid_client_metadata", "JSON object expected");
    const b = body as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (uris.length === 0 || uris.length > 10) throw new OAuthError(400, "invalid_redirect_uri", "1-10 redirect_uris required");
    for (const u of uris) this.validateRedirectUri(u);
    const authMethod = b.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") throw new OAuthError(400, "invalid_client_metadata", "only public clients (token_endpoint_auth_method=none) with PKCE are supported");
    const grants = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ["authorization_code"];
    for (const g of grants) if (g !== "authorization_code" && g !== "refresh_token") throw new OAuthError(400, "invalid_client_metadata", `unsupported grant_type ${g}`);
    const responses = Array.isArray(b.response_types) ? b.response_types.map(String) : ["code"];
    for (const r of responses) if (r !== "code") throw new OAuthError(400, "invalid_client_metadata", `unsupported response_type ${r}`);
    const client: RegisteredClient = {
      client_id: `cl_${crypto.randomBytes(16).toString("base64url")}`,
      ...(typeof b.client_name === "string" ? { client_name: b.client_name.slice(0, 120) } : {}),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: grants.includes("refresh_token") ? grants : [...grants, "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(this.now() / 1000)
    };
    this.clients.push(client);
    while (this.clients.length > MAX_CLIENTS) this.clients.shift();
    this.persist();
    this.opts.log?.info?.(`[ekho-mcp] registered OAuth client ${client.client_id} (${client.client_name ?? "unnamed"}) for ${uris.join(", ")}`);
    return client;
  }

  private validateRedirectUri(u: string): void {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new OAuthError(400, "invalid_redirect_uri", `not an absolute URL: ${u}`);
    }
    if (parsed.hash) throw new OAuthError(400, "invalid_redirect_uri", "fragment not allowed");
    const loop = isLoopback(parsed.hostname) || isLoopback(parsed.host);
    if (parsed.protocol === "http:" && !loop) throw new OAuthError(400, "invalid_redirect_uri", "http redirect only to loopback");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new OAuthError(400, "invalid_redirect_uri", "https required");
    if (this.opts.allowedRedirectHosts.length && !loop && !this.opts.allowedRedirectHosts.includes(parsed.hostname.toLowerCase())) {
      throw new OAuthError(400, "invalid_redirect_uri", `host ${parsed.hostname} is not in EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`);
    }
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.find((c) => c.client_id === clientId);
  }

  // ---- authorization ---------------------------------------------------

  /** Validate an authorize request. Throws OAuthError for errors that must
   *  NOT be redirected (bad client / redirect_uri); returns a redirect error
   *  for the rest, per OAuth 2.1 §4.1.2.1. */
  validateAuthorizeRequest(q: Record<string, string | undefined>): { ok: true; params: AuthorizeParams } | { ok: false; redirect: string } {
    const client = q.client_id ? this.getClient(q.client_id) : undefined;
    if (!client) throw new OAuthError(400, "invalid_client", "unknown client_id");
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw new OAuthError(400, "invalid_request", "redirect_uri required");
      redirectUri = client.redirect_uris[0];
    }
    if (!client.redirect_uris.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "redirect_uri not registered for this client");
    const fail = (error: string, description: string) => {
      const u = new URL(redirectUri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", this.issuer);
      return { ok: false as const, redirect: u.toString() };
    };
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return fail("invalid_request", "code_challenge (S256) required");
    if (q.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    if (q.resource !== undefined && q.resource !== this.resource) return fail("invalid_target", `resource must be ${this.resource}`);
    if (q.scope !== undefined && q.scope.split(/\s+/).filter(Boolean).some((s) => s !== SCOPE)) return fail("invalid_scope", `only scope ${SCOPE} is available`);
    return {
      ok: true,
      params: { client_id: client.client_id, redirect_uri: redirectUri, code_challenge: q.code_challenge, state: q.state, scope: SCOPE, resource: q.resource ?? this.resource }
    };
  }

  /** Mint a one-time consent nonce binding the validated params to the form. */
  beginConsent(params: AuthorizeParams): string {
    const nonce = crypto.randomBytes(24).toString("base64url");
    this.consents.set(nonce, { params, expires_at: this.now() + CONSENT_TTL_MS });
    for (const [k, v] of this.consents) if (v.expires_at <= this.now()) this.consents.delete(k);
    while (this.consents.size > 200) this.consents.delete(this.consents.keys().next().value!);
    return nonce;
  }

  loginThrottled(clientKey: string): boolean {
    const e = this.loginFailures.get(clientKey);
    if (!e) return false;
    if (this.now() - e.windowStart > LOGIN_WINDOW_MS) {
      this.loginFailures.delete(clientKey);
      return false;
    }
    return e.count >= LOGIN_MAX_FAILURES;
  }

  /** Check the consent form: nonce + password. Returns the redirect with the
   *  code, or throws OAuthError (401 for a wrong password, 429 when throttled). */
  completeConsent(nonce: string | undefined, password: string | undefined, clientKey: string): string {
    if (this.loginThrottled(clientKey)) throw new OAuthError(429, "slow_down", "too many failed attempts; try again later");
    const pending = nonce ? this.consents.get(nonce) : undefined;
    if (!pending || pending.expires_at <= this.now()) throw new OAuthError(400, "invalid_request", "consent expired; start again from the client");
    if (!password || !constantTimeEqual(password, this.opts.password)) {
      const e = this.loginFailures.get(clientKey);
      if (!e || this.now() - e.windowStart > LOGIN_WINDOW_MS) this.loginFailures.set(clientKey, { count: 1, windowStart: this.now() });
      else e.count += 1;
      this.opts.log?.warn?.("[ekho-mcp] OAuth consent: wrong operator password");
      throw new OAuthError(401, "access_denied", "wrong password");
    }
    this.consents.delete(nonce!);
    this.loginFailures.delete(clientKey);
    const p = pending.params;
    const code = randomToken("ac_");
    this.codes.set(code, {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      resource: p.resource ?? this.resource,
      scope: p.scope ?? SCOPE,
      expires_at: this.now() + CODE_TTL_MS
    });
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", this.issuer);
    this.opts.log?.info?.(`[ekho-mcp] OAuth consent granted to client ${p.client_id}`);
    return u.toString();
  }

  // ---- token -----------------------------------------------------------

  token(form: Record<string, string | undefined>): { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string } {
    const grant = form.grant_type;
    const client = form.client_id ? this.getClient(form.client_id) : undefined;
    if (!client) throw new OAuthError(401, "invalid_client", "unknown client_id");
    if (grant === "authorization_code") {
      const code = form.code ? this.codes.get(form.code) : undefined;
      if (form.code) this.codes.delete(form.code); // single use, even on failure
      if (!code || code.expires_at <= this.now()) throw new OAuthError(400, "invalid_grant", "unknown or expired code");
      if (code.client_id !== client.client_id) throw new OAuthError(400, "invalid_grant", "code was issued to another client");
      if (form.redirect_uri !== undefined && form.redirect_uri !== code.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri mismatch");
      const verifier = form.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError(400, "invalid_grant", "code_verifier required (PKCE)");
      const expected = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
      if (!constantTimeEqual(expected, code.code_challenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      if (form.resource !== undefined && form.resource !== code.resource) throw new OAuthError(400, "invalid_target", `resource must be ${code.resource}`);
      return this.issueTokens(client.client_id, code.resource, code.scope);
    }
    if (grant === "refresh_token") {
      const presented = form.refresh_token ?? "";
      const hash = sha256Hex(presented);
      const idx = this.tokens.findIndex((t) => t.kind === "refresh" && t.hash === hash);
      const stored = idx >= 0 ? this.tokens[idx] : undefined;
      if (!stored || stored.expires_at <= this.now()) throw new OAuthError(400, "invalid_grant", "unknown or expired refresh_token");
      if (stored.client_id !== client.client_id) throw new OAuthError(400, "invalid_grant", "refresh_token was issued to another client");
      if (form.resource !== undefined && form.resource !== stored.resource) throw new OAuthError(400, "invalid_target", `resource must be ${stored.resource}`);
      this.tokens.splice(idx, 1); // rotation: the old refresh token dies here
      return this.issueTokens(client.client_id, stored.resource, stored.scope);
    }
    throw new OAuthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  private issueTokens(clientId: string, resource: string, scope: string) {
    const access = randomToken("at_");
    const refresh = randomToken("rt_");
    const t = this.now();
    this.tokens.push(
      { hash: sha256Hex(access), kind: "access", client_id: clientId, resource, scope, expires_at: t + ACCESS_TOKEN_TTL_SECONDS * 1000 },
      { hash: sha256Hex(refresh), kind: "refresh", client_id: clientId, resource, scope, expires_at: t + REFRESH_TOKEN_TTL_SECONDS * 1000 }
    );
    this.persist();
    return { access_token: access, token_type: "Bearer" as const, expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope };
  }

  // ---- resource server -------------------------------------------------

  verifyAccessToken(token: string): { ok: true; clientId: string } | { ok: false; reason: string } {
    const hash = sha256Hex(token);
    const stored = this.tokens.find((t) => t.kind === "access" && t.hash === hash);
    if (!stored) return { ok: false, reason: "unknown token" };
    if (stored.expires_at <= this.now()) return { ok: false, reason: "token expired" };
    if (stored.resource !== this.resource) return { ok: false, reason: "token is for another resource" };
    return { ok: true, clientId: stored.client_id };
  }

  authenticator(): Authenticator {
    const challenge = `Bearer realm="ekho-mcp", resource_metadata="${this.resourceMetadataUrl}"`;
    return {
      authenticate: (header: string | undefined): AuthDecision => {
        const presented = bearerFromHeader(header);
        if (!presented) return { ok: false, status: 401, wwwAuthenticate: challenge, error: "unauthorized", description: "a bearer access token is required" };
        const v = this.verifyAccessToken(presented);
        if (v.ok) return { ok: true, subject: v.clientId };
        return { ok: false, status: 401, wwwAuthenticate: `${challenge}, error="invalid_token"`, error: "invalid_token", description: v.reason };
      }
    };
  }

  /** The consent page. Inline, dependency-free; CSP forbids everything but
   *  inline styles and a same-origin form post. */
  renderConsentPage(params: AuthorizeParams, nonce: string, clientName: string, error?: string): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ekho MCP — authorize</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}
label{display:block;margin:1rem 0 .25rem}input[type=password]{width:100%;padding:.5rem;font-size:1rem}
button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem}.err{color:#b00020}.muted{color:#555;font-size:.9rem}</style></head>
<body><h1>Authorize ${esc(clientName)}</h1>
<p class="muted">This client wants to read and send Ekho messages as <strong>this connector's agent</strong>. Every tool argument and result will be visible to the client's provider. Only authorize a client you added yourself.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="consent" value="${esc(nonce)}">
<label for="password">Operator password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Authorize</button>
</form>
<p class="muted">Redirects to ${esc(params.redirect_uri)}</p>
</body></html>`;
  }
}
