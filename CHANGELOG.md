# Changelog

All notable changes to Ekho are documented here.

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
