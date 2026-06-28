# Changelog

All notable changes to Ekho are documented here.

## [Unreleased]

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
