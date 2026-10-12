import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { startRelay, connectAgent, startServer, rpc, INITIALIZE, TEST_OAUTH_PASSWORD, type LiveRelay, type RunningServer } from "./helpers";
import { LOGIN_MAX_FAILURES, MAX_CLIENTS } from "../src/oauth";

const relays: LiveRelay[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.close();
});
async function up(opts: { now?: () => number; env?: Record<string, string> } = {}) {
  const r = await startRelay();
  relays.push(r);
  const agent = await connectAgent(r);
  const s = await startServer(agent, { auth: "oauth", now: opts.now, env: opts.env });
  servers.push(s);
  return s;
}

const REDIRECT = "https://client.example/callback";
const pkce = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier, "ascii").digest("base64url") };
};
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function register(s: RunningServer, body: unknown = { client_name: "Grok", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) {
  const res = await fetch(`${s.baseUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Drive the consent page as a browser would: GET the form, POST the password. */
async function consent(s: RunningServer, authorizeUrl: string, password = TEST_OAUTH_PASSWORD) {
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  if (page.status !== 200) return { status: page.status, location: page.headers.get("location") };
  const html = await page.text();
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const nonce = /name="consent" value="([^"]+)"/.exec(html)![1];
  const post = await fetch(`${s.baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ consent: nonce, password }),
    redirect: "manual"
  });
  return { status: post.status, location: post.headers.get("location") };
}

describe("OAuth 2.1 built-in authorization server", () => {
  it("serves protected-resource and authorization-server metadata that point at itself", async () => {
    const s = await up();
    const prm = (await (await fetch(`${s.baseUrl}/.well-known/oauth-protected-resource${s.config.mcpPath}`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: s.mcpUrl, authorization_servers: [s.baseUrl], bearer_methods_supported: ["header"] });
    const rootPrm = (await (await fetch(`${s.baseUrl}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(rootPrm.resource).toBe(s.mcpUrl);
    const as = (await (await fetch(`${s.baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: s.baseUrl,
      authorization_endpoint: `${s.baseUrl}/oauth/authorize`,
      token_endpoint: `${s.baseUrl}/oauth/token`,
      registration_endpoint: `${s.baseUrl}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    });
  });

  it("401 on the MCP path names the resource metadata so a spec client can discover the flow", async () => {
    const s = await up();
    const res = await rpc(s.mcpUrl, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${s.baseUrl}/.well-known/oauth-protected-resource${s.config.mcpPath}"`);
  });

  it("dynamic registration: public PKCE clients only, https or loopback redirects, host allow-list", async () => {
    const s = await up({ env: { EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS: "client.example" } });
    const ok = await register(s);
    expect(ok.status).toBe(201);
    expect(ok.body.client_id).toMatch(/^cl_/);
    expect(ok.body).not.toHaveProperty("client_secret");
    expect((await register(s, { redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register(s, { redirect_uris: ["https://other.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register(s, { redirect_uris: ["http://127.0.0.1:9/cb"] })).status).toBe(201);
    expect((await register(s, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" })).body.error).toBe("invalid_client_metadata");
    expect((await register(s, { redirect_uris: [] })).status).toBe(400);
  });

  it("full code flow with PKCE, resource binding, single-use codes and refresh rotation", async () => {
    const s = await up();
    const { client_id } = (await register(s)).body as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${s.baseUrl}/oauth/authorize?${form({
      response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: s.mcpUrl
    })}`;

    // Wrong password: 401, no code.
    const denied = await consent(s, authorizeUrl, "wrong password here");
    expect(denied.status).toBe(401);

    const granted = await consent(s, authorizeUrl);
    expect(granted.status).toBe(302);
    const loc = new URL(granted.location!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.get("iss")).toBe(s.baseUrl);
    const code = loc.searchParams.get("code")!;
    expect(code).toMatch(/^ac_/);

    // Wrong verifier burns the code.
    const badV = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: "x".repeat(50) }) });
    expect(badV.status).toBe(400);
    expect(((await badV.json()) as { error: string }).error).toBe("invalid_grant");
    const replay = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
    expect(replay.status).toBe(400); // single use: already consumed by the failed attempt

    // A fresh code with the right verifier.
    const granted2 = await consent(s, authorizeUrl);
    const code2 = new URL(granted2.location!).searchParams.get("code")!;
    const tok = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code: code2, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: s.mcpUrl }) });
    expect(tok.status).toBe(200);
    const tokens = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toMatch(/^at_/);

    // The access token opens the MCP path.
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${tokens.access_token}` })).status).toBe(200);
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${tokens.access_token.slice(0, -1)}` })).status).toBe(401);

    // Refresh rotates; the old refresh token is dead.
    const ref = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }) });
    expect(ref.status).toBe(200);
    const rotated = (await ref.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    const dead = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }) });
    expect(dead.status).toBe(400);
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${rotated.access_token}` })).status).toBe(200);

    // Another client cannot use this client's refresh token.
    const { client_id: other } = (await register(s)).body as { client_id: string };
    const stolen = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: other }) });
    expect(stolen.status).toBe(400);
  });

  it("refuses a foreign resource indicator and non-S256 PKCE by redirecting an error, and unknown clients without redirecting", async () => {
    const s = await up();
    const { client_id } = (await register(s)).body as { client_id: string };
    const { challenge } = pkce();
    const foreign = await fetch(`${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" })}`, { redirect: "manual" });
    expect(foreign.status).toBe(302);
    expect(new URL(foreign.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const plain = await fetch(`${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "plain" })}`, { redirect: "manual" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const unknown = await fetch(`${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id: "cl_unknown", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" });
    expect(unknown.status).toBe(400);
    const wrongUri = await fetch(`${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: "https://attacker.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" });
    expect(wrongUri.status).toBe(400);
  });

  it("throttles the consent password after repeated failures", async () => {
    const s = await up();
    const { client_id } = (await register(s)).body as { client_id: string };
    const { challenge } = pkce();
    const authorizeUrl = `${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await consent(s, authorizeUrl, "bad")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await consent(s, authorizeUrl)).status).toBe(429); // even the right password waits now
  });

  it("a spoofed leftmost X-Forwarded-For does not reset the consent throttle (B1)", async () => {
    const s = await up({ env: { EKHO_MCP_TRUST_PROXY: "1", EKHO_MCP_RATE_LIMIT_PER_MINUTE: "1000" } });
    const { client_id } = (await register(s)).body as { client_id: string };
    const { challenge } = pkce();
    const authorizeUrl = `${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`;
    const page = await fetch(authorizeUrl);
    const nonce = /name="consent" value="([^"]+)"/.exec(await page.text())![1];
    // One real peer (203.0.113.9, appended by the proxy) rotates a fake
    // address in the client-controlled first position on every attempt.
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${s.baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${(i % 250) + 1}, 203.0.113.9` },
        body: form({ consent: nonce, password: `wrong-${i}` }),
        redirect: "manual"
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, LOGIN_MAX_FAILURES)).toEqual(Array(LOGIN_MAX_FAILURES).fill(401));
    expect(statuses.slice(LOGIN_MAX_FAILURES)).toEqual(Array(50 - LOGIN_MAX_FAILURES).fill(429));
    // The right password from that peer waits too; a different real peer does not.
    expect((await fetch(`${s.baseUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: form({ consent: nonce, password: TEST_OAUTH_PASSWORD }), redirect: "manual" })).status).toBe(429);
    expect((await fetch(`${s.baseUrl}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.10" },
      body: form({ consent: nonce, password: TEST_OAUTH_PASSWORD }), redirect: "manual" })).status).toBe(302);
  });

  it("a flood of anonymous registrations past MAX_CLIENTS cannot evict a consented client (B2)", async () => {
    const s = await up({ env: { EKHO_MCP_RATE_LIMIT_PER_MINUTE: "1000" } });
    const { client_id } = (await register(s)).body as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorizeUrl = `${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: s.mcpUrl })}`;
    const code = new URL((await consent(s, authorizeUrl)).location!).searchParams.get("code")!;
    const tok = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: s.mcpUrl }) });
    expect(tok.status).toBe(200);
    const tokens = (await tok.json()) as { access_token: string; refresh_token: string };

    // Anonymous burst well past the cap; every one of these is accepted
    // because the never-consented ones are the ones that get recycled.
    for (let i = 0; i < MAX_CLIENTS + 8; i++) expect((await register(s, { client_name: `anon-${i}`, redirect_uris: [REDIRECT] })).status).toBe(201);

    // The established client is untouched: refresh works, access token works.
    const ref = await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }) });
    expect(ref.status).toBe(200);
    const rotated = (await ref.json()) as { access_token: string };
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${rotated.access_token}` })).status).toBe(200);
  });

  it("when every slot holds a client with a live refresh token, registration is refused rather than evicting one", async () => {
    let t = 1_700_000_000_000;
    const s = await up({ now: () => t, env: { EKHO_MCP_RATE_LIMIT_PER_MINUTE: "100000" } });
    const oauth = s.oauth!;
    const live: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const c = oauth.registerClient({ client_name: `established-${i}`, redirect_uris: [REDIRECT] });
      ids.push(c.client_id);
      const { verifier, challenge } = pkce();
      const v = oauth.validateAuthorizeRequest({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
      if (!v.ok) throw new Error("authorize rejected");
      const code = new URL(oauth.completeConsent(oauth.beginConsent(v.params), TEST_OAUTH_PASSWORD, `peer-${i}`)).searchParams.get("code")!;
      live.push(oauth.token({ grant_type: "authorization_code", code, client_id: c.client_id, code_verifier: verifier }).access_token);
    }
    const refused = await register(s, { client_name: "late", redirect_uris: [REDIRECT] });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe("too_many_clients");
    for (const at of live) expect(oauth.verifyAccessToken(at).ok).toBe(true);

    // Once a refresh token has expired that client becomes evictable again,
    // and its remaining tokens die with it (N4).
    t += 31 * 24 * 3600 * 1000;
    expect(oauth.getClient(ids[0]!)).toBeDefined();
    expect((await register(s, { client_name: "late-again", redirect_uris: [REDIRECT] })).status).toBe(201);
    expect(oauth.getClient(ids[0]!)).toBeUndefined(); // oldest evictable slot recycled
    expect(oauth.getClient(ids[1]!)).toBeDefined();
    expect(oauth.verifyAccessToken(live[0]!).ok).toBe(false);
  });

  it("access tokens expire", async () => {
    let t = Date.now();
    const s = await up({ now: () => t });
    const { client_id } = (await register(s)).body as { client_id: string };
    const { verifier, challenge } = pkce();
    const granted = await consent(s, `${s.baseUrl}/oauth/authorize?${form({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`);
    const code = new URL(granted.location!).searchParams.get("code")!;
    const tok = (await (await fetch(`${s.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).json()) as { access_token: string };
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${tok.access_token}` })).status).toBe(200);
    t += 3601 * 1000;
    expect((await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${tok.access_token}` })).status).toBe(401);
  });

  it("the official MCP client completes discovery → registration → consent → PKCE exchange → tools/list", async () => {
    const s = await up();
    // A provider that behaves like a client app: stores what the SDK hands
    // it, and "opens the browser" by driving our consent page itself.
    let clientInfo: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = "";
    let capturedCode: string | null = null;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return REDIRECT; },
      get clientMetadata() { return { client_name: "Grok (test)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }; },
      clientInformation: () => clientInfo,
      saveClientInformation: (info) => { clientInfo = info; },
      tokens: () => tokens,
      saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: async (url) => {
        const r = await consent(s, url.toString());
        expect(r.status).toBe(302);
        capturedCode = new URL(r.location!).searchParams.get("code");
      },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier
    };
    const client = new Client({ name: "grok-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(s.mcpUrl), { authProvider: provider });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(capturedCode).toMatch(/^ac_/);
    expect(clientInfo?.client_id).toMatch(/^cl_/);
    await transport.finishAuth(capturedCode!);
    expect(tokens?.access_token).toMatch(/^at_/);
    const client2 = new Client({ name: "grok-test", version: "0" });
    const transport2 = new StreamableHTTPClientTransport(new URL(s.mcpUrl), { authProvider: provider });
    await client2.connect(transport2);
    const { tools } = await client2.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ekho_conversation", "ekho_inbox", "ekho_open_room", "ekho_roster", "ekho_send"]);
    await client2.close();
  });
});
