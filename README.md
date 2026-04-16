# Ekho

> Private messaging infrastructure for distributed AI agents.

Ekho is a **store-and-forward relay** for agent-to-agent communication on private networks. It gives each agent an identity, an inbox, delivery guarantees, and a complete audit trail — without depending on a public message broker.

Built for [Tailscale](https://tailscale.com) meshes, homelabs, edge nodes, and any environment where agents need to coordinate securely.

## Features

- **Signed messaging** — HMAC-SHA256 per-agent authentication with replay protection
- **Store-and-forward delivery** — messages wait in recipient inboxes until collected
- **Exponential backoff retry** — unacked messages retry with increasing delays, then dead-letter
- **Rate limiting** — per-agent message throttling with automatic quarantine on abuse
- **Policy engine** — deny/allow rules for message routing based on sender, recipient, type, priority
- **Quarantine automation** — agents auto-quarantined on missed heartbeats or repeated violations
- **Operator console** — React dashboard for fleet monitoring, approvals, policies, and intervention
- **Approval workflows** — gate high-risk agent actions behind operator review
- **Extension hooks** — plugin system for custom message scanning, memory extraction, security gates
- **A2A protocol native** — [A2A v1.0](https://a2a-protocol.org/latest/specification/) endpoints alongside the proprietary API, so any A2A client can discover and message Ekho agents out of the box ([docs](./docs/a2a.md))
- **Open-core licensing** — free OSS relay with Pro tier for multi-fleet, advanced policies, analytics

## Quick Start

```bash
git clone https://github.com/Drakon-Systems-Ltd/ekho.git
cd ekho
npm install
npm run build
npm run setup
npm start
```

Then open [http://localhost:4000/ui/](http://localhost:4000/ui/) to access the operator console.

### Docker

```bash
docker compose up -d
```

The relay starts on port 4000 with SQLite persistence in `./data/`.

## Architecture

```
┌─────────┐     HTTPS      ┌─────────────┐     HTTPS      ┌─────────┐
│ Agent A  │ ──────────────▶│  Ekho Relay  │◀────────────── │ Agent B  │
└─────────┘   signed req    │   (Fastify)  │   signed req   └─────────┘
                            │      │       │
                            │   SQLite     │
                            │  messages    │
                            │  policies    │
                            │  events      │
                            └──────┬───────┘
                                   │
                            ┌──────┴───────┐
                            │  Operator UI │
                            │  (React)     │
                            └──────────────┘
```

**Flow:** Agent enrolls → sends signed messages → relay stores in recipient inbox → recipient polls and ACKs → relay tracks delivery state with retry/dead-letter lifecycle.

## Packages

This is a monorepo with four packages:

| Package | Description |
|---------|-------------|
| [`@ekho/relay`](packages/relay/) | Fastify relay server with SQLite, operator console, sweep jobs |
| [`@ekho/sdk`](packages/sdk/) | Zero-dependency agent client and adapter for Node.js |
| [`@ekho/openclaw-plugin`](packages/openclaw-plugin/) | OpenClaw agent runtime integration plugin |
| [`@ekho/shieldcortex-bridge`](packages/shieldcortex-bridge/) | ShieldCortex defence pipeline and Iron Dome security extension |

## SDK Usage

Install the SDK in your agent project:

```typescript
import { EkhoAgentClient, EkhoAgentAdapter } from "@ekho/sdk";

// Low-level client
const client = new EkhoAgentClient({
  agentId: "agent_abc123",
  secret: "your_agent_secret",
  relayBaseUrl: "http://your-relay:4000",
});

await client.sendMessage({
  recipient: { kind: "agent", id: "agent_def456" },
  message_type: "direct",
  body: { text: "Hello from agent A" },
  conversation_id: "conv-1",
  correlation_id: "corr-1",
});

const inbox = await client.getInbox();

// High-level adapter with auto-polling and heartbeats
const adapter = new EkhoAgentAdapter(
  { agentId: "agent_abc123", secret: "...", relayBaseUrl: "..." },
  {
    onMessage: async (msg) => console.log("Received:", msg),
    onControl: async (ctrl) => console.log("Control:", ctrl),
  }
);
adapter.start();
```

## API

Full specification: [openapi.yaml](openapi.yaml)

### Agent API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/enroll` | Register agent with one-time token |
| POST | `/v1/messages` | Send message to agent/group/broadcast |
| GET | `/v1/inbox` | Poll pending messages and control actions |
| POST | `/v1/acks` | Acknowledge delivered messages |
| POST | `/v1/heartbeats` | Report agent liveness and status |
| POST | `/v1/actions/propose` | Propose high-risk action for approval |
| POST | `/v1/actions/result` | Report action completion |
| GET | `/v1/actions/{id}` | Check approval status |

### Operator API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/operator/login` | Authenticate operator session |
| GET | `/v1/operator/overview` | Fleet KPIs and recent events |
| GET | `/v1/operator/agents` | List agents with search/filter/sort |
| POST | `/v1/operator/agents/{id}/{action}` | Pause, resume, or quarantine agent |
| GET | `/v1/operator/approvals` | Pending approval queue |
| POST | `/v1/operator/approvals/{id}/{decision}` | Approve or reject |
| GET/POST/PUT/DELETE | `/v1/operator/policies` | Policy CRUD |
| GET | `/v1/operator/dead-letters` | Failed message archive |
| GET | `/v1/operator/events` | Full audit log |

All agent endpoints require HMAC-SHA256 signed requests. All operator endpoints require a bearer token from login.

## Message Types

| Type | Purpose |
|------|---------|
| `direct` | One-to-one agent message |
| `broadcast` | One-to-many notification |
| `alert` | High-priority notification |
| `handoff` | Work package passed between agents |
| `claim` | Agent claims ownership of work |
| `complete` | Agent reports task completion |
| `heartbeat` | Liveness signal |
| `control` | System control message |

## Configuration

Environment variables (see `packages/relay/.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `EKHO_HOST` | `127.0.0.1` | Bind address |
| `EKHO_PORT` | `4000` | Server port |
| `EKHO_DB_PATH` | `./data/ekho.sqlite` | SQLite database path |
| `EKHO_OPERATOR_SESSION_SECRET` | `change-me` | Operator auth secret |
| `EKHO_RATE_LIMIT_MAX_MESSAGES` | `30` | Messages per agent per minute |
| `EKHO_HEARTBEAT_TIMEOUT_SECONDS` | `90` | Heartbeat liveness threshold |
| `EKHO_LICENSE_KEY` | — | Pro license JWT (optional) |

## Pricing

| | OSS (Free) | Pro |
|---|---|---|
| Fleets | 1 | Unlimited |
| Agents | Unlimited | Unlimited |
| Messaging + retry + dead-letter | Yes | Yes |
| Policy engine | Basic (deny/allow) | Advanced |
| Rate limiting + quarantine | Yes | Yes |
| Operator console | Yes | Yes |
| **Multi-fleet / multi-tenant** | — | Yes |
| **Advanced policies** | — | Yes |
| **Analytics dashboard** | — | Yes |

## Development

```bash
npm install                  # Install all workspace dependencies
npm run typecheck            # TypeScript check across all packages
npm test                     # Run full test suite (35 tests)
npm run dev                  # Start relay in watch mode
npm run ui:dev -w @ekho/relay  # Vite dev server for console
```

## Project Status

Ekho is in **active development**. The core relay, SDK, and operator console are functional and tested. The project is preparing for its first public release.

## License

[MIT](LICENSE)

## Built by Drakon Systems

[drakonsystems.com](https://drakonsystems.com)

*Ekho takes its name from Echo — the voice that carries.*
