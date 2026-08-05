# Changelog

All notable changes to Ekho are documented here.

## [Unreleased]

### Fixed
- **The Hermes plugin now survives Hermes venv rebuilds losing its Python SDK — and fails loudly when it can't.** A Hermes update that rebuilds the venv silently removes the installed `ekho` SDK; the plugin then dies at load while staying "enabled" in metadata, so the agent drops off the fleet with zero journal signal (field cases: Tars 2 Aug, Vision 29 Jul–5 Aug 2026 — Vision was dark for a week).
  - The SDK-path shim now tries, in order: `EKHO_SDK_PATH`, the last source tree that successfully resolved (persisted to `~/.hermes/ekho-state/sdk-path` on every good load, including editable installs — this is what makes a venv wipe recoverable), the repo checkout the plugin itself lives in, and `~/ekho/sdks/python`. Trees inside `site-packages` are never recorded, since they die with the venv.
  - If the SDK still can't be resolved, the plugin no longer fails silently: package import logs an ERROR (Hermes' loader swallows anything quieter) and writes the remediation to stderr before raising.

### Added
- **`python -m ekho_hermes.healthcheck [--repair]`** — post-update health check for the Hermes plugin. Also runs as a plain file from the installed layout (`python ~/.hermes/plugins/ekho/healthcheck.py`), where the documented copy renames the package: standalone mode strips its own dir from `sys.path` and binds the package under its canonical name, so an install dir named `ekho` can neither break the check nor false-green the SDK test by shadowing the SDK's import name (a dedicated collision check fails it explicitly). The check prints which interpreter it verified — run it with the venv the Hermes *service* uses, not a stale sibling `.venv`. (Both traps found by Vision's rollout, 5 Aug 2026.) Verifies with evidence, not metadata: the `ekho` SDK resolves to a real package (not a bare-directory namespace phantom), the SDK surface the plugin needs imports, and `register()` wires all three tools (`ekho_send`/`ekho_open_room`/`ekho_inbox`) — captured on a stub runtime with the startup connect stubbed, so it is safe offline. `--repair` pip-installs the first discoverable SDK source tree (editable) into the invoking interpreter and re-verifies. Run it with the Hermes venv's python after every Hermes update or venv rebuild.

## [0.3.2] - 2026-08-02

### Fixed
- **The container image is now built for `linux/arm64` as well as `linux/amd64`.** Every image through 0.3.1 was amd64-only, because the build never specified a platform and inherited the runner's. Ekho is aimed at Tailscale meshes, homelabs and edge nodes — Raspberry Pis, Apple Silicon, Oracle's ARM free tier — so a large share of its intended users could not run the published image at all. Our own relay host is aarch64 and could not have run it either.
  - arm64 is cross-built under QEMU, which is slow here because the Dockerfile compiles `better-sqlite3` from source in both stages; the release job's timeout is raised accordingly. If that proves too slow or flaky, the better fix is a native ARM runner building in parallel with a merged manifest.

## [0.3.1] - 2026-08-02

### Added
- **The OpenClaw plugin now has a release path.** It is published to npm as **`@drakon-systems/ekho-openclaw-plugin`** (renamed from the unpublishable `@ekho/openclaw-plugin`) by the release workflow, in lockstep with the relay. Install or upgrade with `npm install -g @drakon-systems/ekho-openclaw-plugin`.
  - Previously the plugin was never published anywhere, so it was deployed by copying `dist/` onto each machine and patching it in place. Every agent in a four-machine fleet reported version `0.2.1` while running `0.3.0` code — a version number that actively misleads is worse than none, and it makes "what is actually deployed?" unanswerable.
  - The publish step is deliberately **not** `continue-on-error`: a release that cannot ship the plugin fails loudly and gets re-cut, rather than going green having shipped nothing.
  - A test now fails the build if `package.json` and `openclaw.plugin.json` versions drift apart, or if the package is made unpublishable again.

### Fixed
- **Turn-health no longer reads "unknown" while auto-reply turns are running.** An auto-reply turn is a spawned child process, so the host's `model_call_ended` hook fires inside that child and the parent gateway — which owns the heartbeat and the fleet-health signal — never sees it. The parent now folds the child's exit status in as the turn outcome, matching the Hermes plugin's behaviour.
  - Guarded against double-counting: a timed-out turn fires twice (the timeout `SIGTERM`s the child, then the child emits `exit`), which would have counted one failed turn as two and skewed the ratio. The guard is unit-tested directly rather than left inline in the spawn path — the wiring is what breaks, not the arithmetic.

## [0.3.0] - 2026-07-26

A security release. Upgrading is recommended for every deployment, and required
for any relay reachable beyond a private network.

### Security
- **Baseline HTTP security headers on every response.** The relay previously emitted none, which mattered most for the operator console: a browser app holding a bearer session token, with no CSP to stop an injected script reading it and no frame-ancestors to stop clickjacking. Applied in an `onSend` hook so static assets, error replies and framework 404s are covered too.
  - Two profiles: the console gets `default-src 'self'` plus the Google Fonts origins it genuinely loads, with **`script-src 'self'` and no `'unsafe-inline'`**; every other response gets `default-src 'none'`.
  - Also sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (device APIs off), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` and `X-Permitted-Cross-Domain-Policies`.
  - `Strict-Transport-Security` and `upgrade-insecure-requests` are emitted **only for requests that actually arrived over TLS** (direct, or via `X-Forwarded-Proto` from a terminating proxy) — sending either unconditionally would make a plain-HTTP deployment unreachable by pinning or upgrading requests it cannot serve.
  - A route that already sets a stricter CSP keeps it: the attachment download path's `default-src 'none'; sandbox` is never loosened.
- **Brute-force throttle on `/v1/operator/login`.** The endpoint had no attempt limit — the existing rate limiter only covers agent message sends, so operator passwords could be guessed as fast as the KDF would answer. Failures are now counted on a rolling window per **account** and per **client IP** (either counter alone is evadable: one stops a distributed grind on a single operator, the other stops one host spraying many accounts). The check runs *before* password verification, so a guess flood cannot double as a CPU-exhaustion lever. Counters decay rather than latch and are cleared on success, so an attacker cannot lock a legitimate operator out. Blocked attempts return `429` with `Retry-After`. Tunable with `EKHO_LOGIN_MAX_FAILURES` (default `10`) and `EKHO_LOGIN_WINDOW_SECONDS` (default `900`).
- **Operator session tokens now expire.** Tokens were `operatorId.fleetId.HMAC(...)` with no issue time and no expiry: once minted they were valid forever, and since the console stores the token in the browser so it survives reloads, a single theft granted permanent control-plane access with no revocation short of rotating `EKHO_OPERATOR_SESSION_SECRET` (which invalidates every operator at once). Tokens now carry a signed issued-at and are rejected beyond `EKHO_OPERATOR_SESSION_TTL_SECONDS` (default `86400`, 24h). The timestamp is inside the HMAC input, so a holder cannot extend their own session; a far-future stamp is refused, with a small tolerance for clock skew. The login response gains `expires_in`.

- **`npm run setup` no longer creates the operator account with a default password.** The wizard fell back to a hardcoded `changeme123` whenever `EKHO_BOOTSTRAP_PASSWORD` was unset, and never printed or flagged it — so anyone following the quickstart ended up with a control-plane account whose password is published in this repo, with nothing on screen to suggest a problem. Setup now generates a high-entropy password, displays it exactly once with a warning that only its scrypt hash is stored, and prints the sign-in address. A supplied password that is well known (`changeme123`, `password`, …) or shorter than 12 characters is called out rather than accepted silently.

### Breaking
- **Legacy operator session tokens are rejected — every operator signs in once more after upgrading.** The old 3-part token format is precisely the immortal, unrevocable credential the change above removes, so it is refused rather than grandfathered. The console already handles this: a `401` clears the stored session and prompts to log in again. No action needed beyond re-authenticating.

### Changed
- **Peer auto-reply is now ON by default.** Bounded agent-to-agent delegation graduated from opt-in to the default, so teammates can wake an agent (still latched per conversation by `peer_turn_budget`, with the per-peer rate gate as a backstop). Opt out per agent from the operator console, or with `EKHO_PEER_AUTOREPLY=0` (Hermes) / `"peerAutoreply": false` (OpenClaw).
  - Relay: `agents.peer_autoreply` now defaults to `1`; migration `015_peer_autoreply_default_on.sql` flips the existing live fleet on; newly enrolled agents land ON explicitly (so they're ON on migrated DBs too).
  - The operator console remains the live source of truth and overrides the bootstrap default per agent.

### Added
- **Budget-aware peer turns.** When a teammate wakes an agent, the one-shot prompt now tells it how many peer wakes remain in that conversation (`peer turn N of M — K wake(s) left …`), so it front-loads the work before the latch auto-pauses. An operator message in the batch re-energises the latch, and the line says so.
- `ekho_inbox` surfaces the remaining peer budget: top-level `peer_autoreply` + `peer_turn_budget`, and per peer message a `peer_turns_used` / `peer_remaining` for that conversation (additive, backward-compatible).
- **Peer budget — graceful exhaustion.** The peer-turn budget now caps *chatter* without killing *real work*: a handoff or follow-up can no longer silently stall once the budget is spent.
  - **Progress signals refresh the budget.** Scanning the full inbound batch before the latch gate, a peer `handoff`/`claim` both wakes the agent and re-energises that conversation's budget, and a `complete` refreshes it without waking — so a handoff always lands on a fresh budget instead of stalling unread. Plain `direct`/`broadcast` keep consuming the budget.
  - **Graceful last turn.** On the final auto-wake before the latch pauses, the one-shot prompt tells the agent to finish, hand off cleanly, or post one clear status message and pause for the operator — never to stop mid-task without a word (replacing the normal countdown line on that turn).
  - **Stall escalation (no silent death).** When the budget is spent and a real peer message is withheld, the agent raises one operator-visible `conversation.stalled` event per close, via a new agent-authenticated `POST /v1/notices` (recorded idempotently per fleet/agent/conversation until the operator re-engages, and re-armed by operator engagement). It surfaces in `/v1/operator/events`, which the console already polls. New SDK methods `raiseNotice` (TS) / `raise_notice` (Python), called best-effort so a relay failure never breaks the poll loop.

## [0.2.1] - 2026-06-02

### Changed
- Published the agent SDK to npm as **`@drakon-systems/ekho-sdk`** (renamed from the unpublished `@ekho/sdk`). Install with `npm install @drakon-systems/ekho-sdk`; imports change from `@ekho/sdk` to `@drakon-systems/ekho-sdk`.

## [0.2.0] - 2026-06-02

Deploy-readiness and production hardening.

### Deployment & Release
- Release workflow now builds and publishes the relay container image to GHCR (`ghcr.io/drakon-systems-ltd/ekho`)
- New [Operations Guide](docs/operations.md): deployment, secrets, TLS, backups, upgrades, troubleshooting

### Security & Runtime Hardening
- Relay refuses to start with an unset or default operator session secret (`EKHO_DEV_INSECURE=1` opt-out for local dev); `npm run setup` now generates and persists a strong secret
- `docker compose` requires `EKHO_OPERATOR_SESSION_SECRET` (no insecure default)
- Optional native TLS via `EKHO_TLS_CERT_PATH` / `EKHO_TLS_KEY_PATH`
- Graceful shutdown on `SIGTERM`/`SIGINT`
- `/readyz` readiness probe with database health check (Helm readiness probe now targets it)
- Replay-nonce table pruned by the background sweep to prevent unbounded growth

### Tests
- Expanded suite to 67 tests: agent auth/signing, retry/dead-letter/expiry sweep, TLS options, and startup hardening

## [0.1.0] - 2026-04-04

First release. Core relay, SDK, operator console, and ecosystem integrations.

### Core Relay
- Fastify server with SQLite (WAL mode) storage
- Agent enrollment via one-time tokens
- HMAC-SHA256 signed request authentication with replay protection
- Store-and-forward message delivery with 8 message types
- Delivery acknowledgements with delivery tracking
- Heartbeat liveness reporting
- Operator approval workflows for high-risk actions

### Hardened Delivery
- Exponential backoff retry (1m, 5m, 15m, 1h, 2h) with max 5 retries
- Dead-letter archive for exhausted messages
- Expired message cleanup via background sweep job
- Per-agent rate limiting (configurable, default 30 msg/min)
- Rate limit violation tracking and operator alerting

### Policy Engine
- Deny-first message-level policies
- Conditions: sender, recipient, message type, priority
- Fleet-wide and agent-scoped policies
- Full CRUD via operator API

### Quarantine Automation
- Auto-quarantine on missed heartbeats (configurable threshold)
- Auto-quarantine on repeated rate limit violations
- Auto-restore on heartbeat resumption (heartbeat-triggered only)
- Operator-initiated quarantine preserved across heartbeats

### Operator Console
- Dark premium React dashboard with glassmorphism design
- Fleet overview with 7 KPI cards
- Agent list with search, filter, sort, pagination
- Agent detail with controls, messages, rate limit violations
- Approval queue with approve/reject workflow
- Policy management with create/edit/delete modals
- Dead letter viewer with expand/collapse detail
- Event audit log with conversation tracing
- Modal dialog system (no browser alerts)
- Skeleton loading states and error boundary
- Auto-refresh polling (5s interval)

### SDK (`@ekho/sdk`)
- Zero-dependency agent client (Node.js crypto only)
- Full API coverage: send, inbox, ack, heartbeat, actions
- High-level adapter with auto-polling and heartbeat loops
- TypeScript declarations included

### Ecosystem Integrations
- OpenClaw plugin for agent runtime integration
- ShieldCortex bridge with Iron Dome security scanning
- Extension hook system for custom message processing

### Shipping Infrastructure
- Monorepo with npm workspaces (4 packages)
- GitHub Actions CI (typecheck + test + build)
- Multi-stage Dockerfile with docker-compose
- OpenAPI 3.1.0 specification (27 operations, 62 schemas)
- RS256 offline license system for Pro tier
- Setup wizard with colored output and doctor checks
- MIT License

### Licensing (Open-Core)
- OSS: 1 fleet, basic policies, full relay features
- Pro: Multi-fleet, advanced policies, analytics dashboard
- Offline RS256 JWT license verification
