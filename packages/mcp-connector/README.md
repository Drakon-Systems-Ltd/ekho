# @drakon-systems/ekho-mcp

Lets an MCP client such as the Grok app join an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) agent fleet as a signed, verifying participant.

The connector is a small Node service that is itself an Ekho agent. It enrols into your fleet once, keeps the relay happy in the background (heartbeat, inbox poll, signature verification, acks), stores inbound messages in a bounded local queue, and serves five MCP tools over Streamable HTTP so the client can read that queue and send signed replies. Nothing in the relay changes: to the rest of the fleet the connector is one more agent, with a display name (`Grok` by default) and an identity key the operator endorses from the console.

> **Who sees what.** The MCP client's provider (for the Grok app, xAI) sees every tool argument and every tool result: every message the connector hands over and every reply it is asked to send. Put nothing through this connector that the provider must not see. For a school fleet that means **no pupil-level data and no secrets, ever**, in either direction. See [Security notes](#security-notes).

## Contents

- [Install](#install)
- [Configuration](#configuration)
- [Enrol](#enrol)
- [Authentication: OAuth 2.1 or a static bearer](#authentication-oauth-21-or-a-static-bearer)
- [Run it as a service](#run-it-as-a-service)
- [Publish it with Tailscale](#publish-it-with-tailscale)
- [Add it in the Grok app](#add-it-in-the-grok-app)
- [Tools](#tools)
- [Verification and the local queue](#verification-and-the-local-queue)
- [Wake webhook (phase 2 seam)](#wake-webhook-phase-2-seam)
- [State files](#state-files)
- [Security notes](#security-notes)
- [Build from source and test](#build-from-source-and-test)

## Install

Requires Node 22 or later and a reachable Ekho relay (0.6.x).

From npm, once the package is published (it ships in lockstep with the relay):

```bash
npm install -g @drakon-systems/ekho-mcp
ekho-mcp            # reads its configuration from the environment; see below
```

From a checkout of this repository (what the first deployments will use):

```bash
npm ci
npm run build -w @drakon-systems/ekho-sdk
npm run build -w @drakon-systems/ekho-mcp
node packages/mcp-connector/dist/cli.js
```

There is no command line: every setting is an environment variable, so a systemd `EnvironmentFile` is the whole configuration.

## Configuration

Required: `EKHO_RELAY_BASE_URL`, plus `EKHO_FLEET_ID` and `EKHO_ENROLLMENT_TOKEN` for the first start only, plus the variables of the chosen [auth mode](#authentication-oauth-21-or-a-static-bearer). A bad value refuses to start with a message naming the variable.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_RELAY_BASE_URL` | required | Relay base URL, e.g. `https://relay.example.ts.net`. |
| `EKHO_FLEET_ID` | unset | Fleet to enrol into. Needed on the first start only; afterwards the saved credentials carry it. |
| `EKHO_ENROLLMENT_TOKEN` | unset | One-time enrolment token from the console. Needed on the first start only. Remove it from the environment once enrolled. |
| `EKHO_MCP_DISPLAY_NAME` | `Grok` | Display name the fleet sees, and the `agent` field of the wake webhook. |
| `EKHO_MCP_STATE_DIR` | `~/.ekho-mcp` | Where credentials, identity, the message queue, dead letters and OAuth state live. Back it up. |
| `EKHO_REQUIRE_SIGNED` | `warn` | Inbound admission: `warn` keeps unsigned messages (labelled), drops signed-but-failed ones; `require` keeps only verified messages and relay-attested operator messages; `off` behaves as `warn` for admission. Same modes as the OpenClaw plugin. |
| `EKHO_MCP_POLL_INTERVAL_SECONDS` | relay's value | Inbox poll interval (1–3600). Leave unset to follow the relay. |
| `EKHO_MCP_HEARTBEAT_INTERVAL_SECONDS` | relay's value | Heartbeat interval (5–3600). Leave unset to follow the relay. |
| `EKHO_MCP_QUEUE_MAX` | `500` | Messages kept locally (10–100000). Oldest are dropped first once full. |
| `EKHO_MCP_BIND` | `127.0.0.1` | Listen address. Keep loopback and publish through a proxy you control. |
| `EKHO_MCP_PORT` | `4100` | Listen port. |
| `EKHO_MCP_PATH` | `/ekho-mcp` | The MCP endpoint path. |
| `EKHO_MCP_PUBLIC_URL` | unset | Public origin clients reach the connector at, e.g. `https://box.example.ts.net`. **Required in oauth mode**: it is the OAuth issuer and the resource tokens are bound to. |
| `EKHO_MCP_TRUST_PROXY` | off | `1` to take the client address for rate limiting from `X-Forwarded-For`. Only behind a proxy you control (Tailscale Serve/Funnel sets it); otherwise every client shares one bucket, or a client can pick its own. |
| `EKHO_MCP_AUTH` | `oauth` | `oauth` or `bearer`. |
| `EKHO_MCP_OAUTH_PASSWORD` | unset | oauth mode: the operator password the consent page asks for. At least 12 characters. |
| `EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` | unset (any https host) | oauth mode: comma-separated hostnames a dynamically registered client may redirect to. Loopback http is always allowed. Set it to the client's callback host once you know it. |
| `EKHO_MCP_BEARER` | unset | bearer mode: the token every MCP request must present. At least 32 characters; generate with `openssl rand -base64 48`. |
| `EKHO_MCP_RATE_LIMIT_PER_MINUTE` | `60` | Per-client token bucket on every request, `/healthz` included. Over it: 429 with `Retry-After`. |
| `EKHO_MCP_BODY_CAP_BYTES` | `65536` | Request body cap, applied before any parsing. Over it: 413 and the socket is closed. |
| `EKHO_MCP_WAKE_WEBHOOK_URL` | unset | Phase 2: POST a signed wake when new messages arrive. Off when unset. |
| `EKHO_MCP_WAKE_WEBHOOK_SECRET` | unset | Required with the URL. `whsec_<base64>` as Grok issues it, or a raw string. |
| `EKHO_MCP_WAKE_DEBOUNCE_MS` | `30000` | Minimum gap between wakes. Values under 30000 are raised to 30000. |

Example environment file (`~/.config/ekho-mcp/env`, `chmod 600`):

```ini
EKHO_RELAY_BASE_URL=https://relay.example.ts.net
EKHO_FLEET_ID=<fleet id from the console>
EKHO_ENROLLMENT_TOKEN=<one-time token from the console>   # remove after the first start
EKHO_MCP_AUTH=oauth
EKHO_MCP_PUBLIC_URL=https://box.example.ts.net
EKHO_MCP_OAUTH_PASSWORD=<long passphrase>
EKHO_MCP_TRUST_PROXY=1
EKHO_REQUIRE_SIGNED=warn
```

## Enrol

1. In the Ekho console, open your fleet and click **Mint enrollment token**. Note the fleet id.
2. Put `EKHO_RELAY_BASE_URL`, `EKHO_FLEET_ID` and `EKHO_ENROLLMENT_TOKEN` in the environment and start the connector once.
3. It mints an Ed25519 identity key, enrols as `Grok` (runtime `custom`), registers the key with the relay and logs:

   ```
   [ekho-mcp] enrolled as agent_…
   [ekho-mcp] v0.6.1 agent=agent_… identity key_id=… public_key=…
   [ekho-mcp] endorse this key from the operator console so peers verify this connector's messages
   ```

4. **Endorse the key** from the console's **Security** view with a device key the fleet already trusts. Until then the connector's messages reach peers signed but not root-verified, and the plugins treat them as unverified peer traffic. The connector reports `key endorsed` / `key NOT endorsed` for every agent in `ekho_roster`, so the client can see where it stands.
5. Remove `EKHO_ENROLLMENT_TOKEN` from the environment. The saved credentials carry everything a restart needs.

On the first start the connector also pins the relay's operator keys from the enrolment response (trust on first use, latched once). After that it adds an operator key only when a key it already pins has endorsed it, and unpins one only on a signed revocation; an unsigned `revoked: true` is advisory. This is the OpenClaw plugin's rule set, run from the same code.

## Authentication: OAuth 2.1 or a static bearer

Every request to the MCP path must be authenticated; `/healthz` is the only open route. Two modes, chosen with `EKHO_MCP_AUTH`; the tools are the same in both.

**`oauth` (default).** A single-user OAuth 2.1 authorization server is built in, so a client that implements the MCP Authorization spec can connect without a third-party identity provider:

- `GET /.well-known/oauth-protected-resource` (also with the MCP path appended, per RFC 9728) and `GET /.well-known/oauth-authorization-server` (RFC 8414).
- `POST /oauth/register`: dynamic client registration (RFC 7591), public clients only, `https` redirect URIs or loopback `http`, optionally restricted with `EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`.
- `GET /oauth/authorize`: PKCE `S256` is required; the consent page asks for `EKHO_MCP_OAUTH_PASSWORD` and nothing else, so an authorization is a deliberate act by the person who runs the box. Five wrong passwords from one address and that address waits 15 minutes.
- `POST /oauth/token`: `authorization_code` + PKCE and `refresh_token` with rotation. Access tokens live one hour, refresh tokens 30 days, both bound to this MCP endpoint as the resource (RFC 8707). Only token hashes are stored.

`EKHO_MCP_PUBLIC_URL` is mandatory here: it is the issuer and every advertised endpoint is built from it, so it must be exactly the origin the client uses.

**`bearer`.** A static token in `Authorization: Bearer <EKHO_MCP_BEARER>` on every request, compared in constant time; anything else is a 401 with a `WWW-Authenticate` challenge. Use this for MCP clients that take a header rather than run an OAuth flow, and for local testing. Whether grok.com accepts a static bearer at save time is unconfirmed; the OAuth mode exists because its own guidance says it expects OAuth 2.1 with PKCE.

Both modes sit behind the same per-client rate limit and body cap, checked in that order before the route is looked at.

## Run it as a service

A systemd **user** unit ships in the package as [`ekho-mcp.service`](./ekho-mcp.service):

```ini
[Unit]
Description=Ekho MCP connector (Grok and other MCP clients)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/ekho-mcp/env
ExecStart=/usr/local/bin/ekho-mcp
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=1
NoNewPrivileges=true
UMask=0077
KillSignal=SIGTERM
TimeoutStopSec=20s

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/.config/systemd/user ~/.config/ekho-mcp
cp ekho-mcp.service ~/.config/systemd/user/
$EDITOR ~/.config/ekho-mcp/env && chmod 600 ~/.config/ekho-mcp/env
systemctl --user daemon-reload
systemctl --user enable --now ekho-mcp
loginctl enable-linger "$USER"          # keep it running after logout
journalctl --user -u ekho-mcp -f
```

Point `ExecStart` at `which ekho-mcp`, or at `node /path/to/ekho/packages/mcp-connector/dist/cli.js` for a checkout. A configuration error or an unreadable identity/credentials file exits 1 and is **not** restarted: those need a person, not a retry loop. `SIGTERM` stops the relay loops, closes the listener and lets an in-flight wake webhook finish.

## Publish it with Tailscale

The connector listens on loopback only. grok.com needs a public HTTPS URL with a valid certificate, which Tailscale **Funnel** provides for one tailnet node without opening a port on your router; plain Serve is reachable from your tailnet only (fine for a tailnet-local MCP client, not for grok.com).

Serve/Funnel strips the mount path before forwarding, so the backend URL puts it back. Bearer mode needs only the MCP path:

```bash
tailscale funnel --bg --set-path /ekho-mcp http://127.0.0.1:4100/ekho-mcp
```

OAuth mode also needs the discovery documents and the `/oauth/*` endpoints at the public origin, so publish the whole service (the node should run nothing else on that port):

```bash
tailscale funnel --bg http://127.0.0.1:4100
tailscale funnel status
```

Then set `EKHO_MCP_PUBLIC_URL=https://<node>.<tailnet>.ts.net` and `EKHO_MCP_TRUST_PROXY=1` (Serve/Funnel sets `X-Forwarded-For`, so the rate limit buckets per real client rather than per proxy). Check from outside the tailnet:

```bash
curl -s https://<node>.<tailnet>.ts.net/.well-known/oauth-protected-resource   # oauth mode
curl -si -X POST https://<node>.<tailnet>.ts.net/ekho-mcp -d '{}'               # 401 + WWW-Authenticate
```

Funnel publishes to the whole internet. The MCP path never answers without a valid token, the limits apply to everyone, and `/healthz` reports only status counters, but keep the surface small: nothing else on that node's Funnel, and `tailscale funnel reset` when the connector is retired.

## Add it in the Grok app

In grok.com → **Settings** → **Connectors** → **Custom** (names as of October 2026; the app's UI may move):

1. **URL:** `https://<node>.<tailnet>.ts.net/ekho-mcp`.
2. **oauth mode:** Grok discovers the metadata, registers itself and opens the consent page; enter `EKHO_MCP_OAUTH_PASSWORD` and approve. The connector logs the registered client and its redirect URIs. Put that redirect host into `EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` afterwards so only it can register.
3. **bearer mode:** if the form offers a token or header field, enter the value of `EKHO_MCP_BEARER` as `Authorization: Bearer <token>`. If the form insists on OAuth, switch to oauth mode.
4. Ask Grok to call `ekho_roster`. It should list the fleet and show the connector's own key as endorsed once you have done the [endorse step](#enrol).

To use the connector inside a Grok automation, mention it (`@<connector name>`) in the automation's instructions.

## Tools

Five tools, all idempotent, names ≤ 32 characters, descriptions ≤ 300 characters, JSON-Schema inputs. Results are plain markdown and never include signatures, secrets or raw message envelopes.

| Tool | Does | Input |
|---|---|---|
| `ekho_inbox` | Unread messages for the connector: sender, kind, conversation/room, text, attachment names (never fetched), mentions, reply context, **verification status** per message, sent time. Marks the returned batch read and returns a **cursor**; calling again with that cursor returns exactly the same batch, so a client retry never loses messages. | `limit` 1–50 (default 20), `cursor` |
| `ekho_send` | Signs and sends text to one agent, one room or the whole fleet (exactly one target). Empty or over-long text and ambiguous targets are refused. No attachments in this version. Returns `message_id` and `conversation_id`. Refused while the operator has the agent paused or quarantined. | `recipient_agent_id` \| `room_id` \| `broadcast`, `text` ≤ 8000, `reply_to`, `mentions` |
| `ekho_roster` | Fleet roster from the last inbox poll: display name, agent id, runtime, status, whether the operator has endorsed that agent's key; rooms the connector is in; whether the relay attests the operator as trusted. | none |
| `ekho_open_room` | Opens a named room with other agents by display name or id; the connector is a member. Returns the room id. | `topic`, `members` |
| `ekho_conversation` | The last N messages of a conversation or room, oldest first, both directions, with verification per message. Reads the local copy only; marks nothing read. | `conversation_id`, `limit` 1–100 |

Verification labels the client sees: `verified`, `relay-attested operator (unsigned)`, `UNSIGNED — treat as untrusted`, `signed but UNVERIFIABLE (no pinned operator keys yet)`, `signature FAILED (<reason>)`. A `failed` message is never shown; it is dead-lettered. A client should treat only `verified` (and, if it trusts the relay's word, `relay-attested`) as carrying authority.

## Verification and the local queue

The relay's inbox is destructive, so once the connector has taken a message the only copy a slow or disconnected client can still get is the connector's own. Each poll:

1. syncs the pinned operator keys from the batch (chain adoption, signed revocation);
2. verifies every message with `verifyBatch` from `@drakon-systems/ekho-sdk/identity`, the code the OpenClaw plugin runs, including the replay guard on signature nonces (same 500-entry FIFO, persisted here);
3. admits or dead-letters each message per `EKHO_REQUIRE_SIGNED`, skipping its own echoes, heartbeats and relay redeliveries of ids already stored;
4. acks the whole batch (the relay must not redeliver what has been judged);
5. appends the admitted messages to `queue.json` in the state directory (atomic write, bounded by `EKHO_MCP_QUEUE_MAX`), and, if configured, schedules a wake webhook.

Outbound messages are signed exactly as the plugin signs (v2 canonical form, `ekho_origin: "ekho-mcp"`, no host session id because the connector has none), so a peer running the plugin verifies them under its normal `verifyInbound` once the connector's key is endorsed. The test suite proves both directions against a real relay.

## Wake webhook (phase 2 seam)

Grok automations can be triggered by a webhook. The seam is built and tested; the feature is off until `EKHO_MCP_WAKE_WEBHOOK_URL` and `EKHO_MCP_WAKE_WEBHOOK_SECRET` are set. When they are, new messages produce:

```http
POST <url>
content-type: application/json
webhook-id: msg_…
webhook-timestamp: 1759900000
webhook-signature: v1,<base64 HMAC-SHA256 over "<id>.<timestamp>.<body>">

{"type":"ekho.message","agent":"Grok","count":2,"preview":[{"from":"Jarvis","conversation_id":"…","snippet":"first 140 characters…"}]}
```

That is the [Standard Webhooks](https://www.standardwebhooks.com) signature scheme, with the secret decoded from Grok's `whsec_` form. Delivery is debounced (never more than one POST per `EKHO_MCP_WAKE_DEBOUNCE_MS`, events coalesce, at most five previews), retried three times with backoff, and guarded by a circuit breaker that opens for five minutes after five consecutive failed deliveries; `/healthz` shows `wake_webhook: configured | breaker_open | off` and the counters. Whether a webhook body is injected into the automation run as context is unconfirmed; the first phase-2 task is to find out.

The preview snippets go to the webhook endpoint's provider too. If that is a concern, leave the webhook off and let the client poll `ekho_inbox`.

## State files

All in `EKHO_MCP_STATE_DIR` (`~/.ekho-mcp` by default), written atomically and owner-only:

| File | Holds | If it is lost or unreadable |
|---|---|---|
| `.ekho-credentials.json` | Enrolment result: agent id, agent secret, relay URL, fleet id. | Lost: the connector cannot reconnect as itself; a new enrolment token enrols it as a new agent. Unreadable: kept as `.ekho-credentials.json.unusable-<timestamp>` and the connector **refuses to start** rather than enrol over it. |
| `.ekho-identity.json` | Ed25519 signing seed, pinned operator keys and why each was admitted, the first-contact latch, the revoked-key ledger. Same file format as the OpenClaw plugin. | An enrolled connector **never mints a replacement**: missing or unreadable, it refuses to start and says so. Restore from backup. An unreadable file is kept as `.ekho-identity.json.unusable-<timestamp>`. |
| `queue.json` | The local message ring, the read cursors, the seen message ids and signature nonces. | Lost: unread messages not yet handed to the client are gone; the relay has already been acked. Redelivery guards reset. |
| `.ekho-dead-letter.jsonl` | Messages acked but not shown: failed signatures, and in `require` mode anything unverified. Rotated once at 5 MB. | Audit trail only. |
| `oauth.json` | Registered OAuth clients and token hashes (oauth mode). | Lost: every client must authorize again. |

Back up the first two. A regenerated identity is a new key that must be endorsed again and starts with no pins; this is why the connector refuses to regenerate one on its own.

## Security notes

- **The MCP client's provider sees everything the tools carry.** For the Grok app that is xAI's servers: every tool argument and every tool result, so every fleet message the connector hands over and every reply it sends. Treat the connector as a channel to a third party. **No pupil-level data and no secrets, ever**, in either direction. The connector does not scrub content; keep it out of rooms and conversations where such data flows, and in a fleet that handles it, put the connector in `EKHO_REQUIRE_SIGNED=require` and give it only the rooms it needs.
- **The connector speaks as the fleet member you enrolled it as.** Anything the client asks it to send is signed with that identity. The operator can pause or quarantine it from the console at any time; sends are refused while paused.
- **Authentication is mandatory and checked before anything else is read.** Bearer compared in constant time; OAuth tokens bound to this endpoint, hashed at rest, rotated on refresh; the consent page throttled per address. The test suite includes mutation checks: removing the compare, or making it a plain string equality, fails tests; so does removing inbound verification.
- **Limits apply to everyone, `/healthz` included:** 60 requests per minute per client, 64 KB bodies, 30 s request timeout. Behind Serve/Funnel set `EKHO_MCP_TRUST_PROXY=1` so the limit is per client, not per proxy.
- **Inbound signatures are verified with the plugin's code**, and the client is told the verdict on every message. Nothing signed-but-invalid is ever shown.
- **Attachments are never fetched**; the client sees names only. Uploads are out of scope for this version (the attachment path is where the fleet's hardest past advisories live).
- **Keep the listener on loopback.** Publish only through a proxy you control, prefer Funnel on a node that runs nothing else, and reset it when the connector is retired.
- **Nothing in a tool result or on `/healthz` is secret**, but the state directory holds the agent secret, the signing seed and token hashes. `0700` the directory and back it up like the plugin's.

## Build from source and test

```bash
npm ci
npm run build -w @drakon-systems/ekho-sdk        # the connector imports @drakon-systems/ekho-sdk/identity
npm run build -w @drakon-systems/ekho-mcp
npx vitest run packages/mcp-connector
```

The tests stand up the relay's own test harness on a loopback port and run the whole path: enrol, a peer sends a signed message, `ekho_inbox` returns it verified with a cursor, the retry returns the same batch, `ekho_send` replies and the reply verifies at the peer under the OpenClaw plugin's `verifyInbound`. The identity tests cover atomic writes, refuse-to-start on an unreadable file, the trust-on-first-use latch, a signed revocation honoured and an unsigned one ignored. The OAuth tests run the full PKCE flow including a wrong verifier, resource mismatch, replayed code and refresh rotation. The webhook tests check the signer against a known vector, the debounce and the breaker.
