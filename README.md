# Ekho

> Private messaging infrastructure for distributed AI agents.

**Ekho** is a Tailscale-native relay for agent-to-agent communication inside a private network. It gives each agent an identity, an inbox, delivery acknowledgements, and an audit trail without depending on a public message broker.

Use it when you want agents running across laptops, VMs, homelabs, or edge nodes to exchange work safely over a private mesh.

For the hardened product design, setup flows, operator controls, and deployment model, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Current Repo State

This repository now includes a runnable v1 scaffold:

- Fastify relay server
- SQLite-backed storage
- Agent enrollment and signed request flow
- Inbox, ack, heartbeat, and approval endpoints
- React + Vite operator console built to `/ui-dist` and served at `/ui/`
- Bootstrap setup command

Quickstart:

```bash
npm install
npm run ui:build
npm run setup
npm start
```

Frontend workflow:

```bash
npm run ui:dev
npm run ui:build
```

Supporting artifacts:

- API surface: [openapi.yaml](./openapi.yaml)
- SQL schema: [migrations/001_init.sql](./migrations/001_init.sql)
- Setup flow notes: [docs/setup-wizard.md](./docs/setup-wizard.md)
- Reference agent adapter: [docs/agent-adapter.md](./docs/agent-adapter.md)

## Why Ekho

Most agent systems can reason locally, but coordination usually falls back to brittle hacks:

- Shared files
- Public queues
- Ad hoc webhooks
- Cloud services that do not fit private-network deployments

Ekho is the narrow layer between "single agent" and "fleet coordination":

- **Private by default**: intended to run only on a Tailscale network
- **Agent-scoped identity**: every agent has its own secret
- **Store-and-forward delivery**: messages wait in a recipient inbox until collected
- **Auditable events**: sends, receipts, and heartbeats are recorded
- **Simple protocol**: HTTP plus signed requests

## Product Scope

Ekho is not a full orchestration platform. It is the communication fabric underneath one.

Ekho is responsible for:

- Direct agent messaging
- Broadcast notifications
- Delivery acknowledgements
- Heartbeats and liveness reporting
- Lightweight task handoff signals
- Durable audit logging

Ekho is not responsible for:

- Scheduling agent execution
- Running workflows
- Planning or routing tasks intelligently
- Replacing a general-purpose event bus
- Exposing a public multi-tenant API in the OSS core

## How It Works

Each agent talks to a single Ekho relay over HTTPS on the tailnet.

```text
[Agent A]  -- HTTPS -->  [Ekho Relay]  <-- HTTPS --  [Agent B]
                             |
                           SQLite
                    (messages, receipts, audit)
```

Basic flow:

1. An agent signs a request with its per-agent secret.
2. Ekho validates the signature and timestamp window.
3. The relay stores the message in the recipient inbox.
4. The recipient polls `/inbox` and receives pending messages.
5. The recipient sends `/ack`, and Ekho records delivery state.

## Core Concepts

### Agent Identity

Every agent has:

- An `agent_id`
- A per-agent shared secret
- Optional metadata such as role, hostname, or capabilities

### Inbox

Each agent has a private queue of pending messages. Delivery is store-and-forward, not peer-to-peer.

### Receipts

Receipts confirm that a message was received by the destination agent. This is acknowledgement of delivery to the client, not proof that downstream work completed successfully.

### Audit Log

Ekho records lifecycle events such as:

- Message accepted
- Message delivered
- Message acknowledged
- Heartbeat received
- Task claimed
- Task completed

## Message Types

| Type | Purpose |
|---|---|
| `direct` | One agent sends a message to one other agent |
| `broadcast` | One agent sends a message to many agents |
| `heartbeat` | Liveness or health signal from an agent |
| `claim` | An agent claims ownership of a unit of work |
| `complete` | An agent reports task completion or result |
| `alert` | High-priority notification |
| `handoff` | Context or work package passed between agents |

## API Surface

```text
POST /send
POST /ack
GET  /inbox
POST /heartbeat
POST /claim
POST /complete
GET  /audit
GET  /agents
```

Expected behavior:

- `POST /send`: enqueue a message for one or more recipients
- `POST /ack`: acknowledge a previously delivered message
- `GET /inbox`: fetch pending messages for the calling agent
- `POST /heartbeat`: update liveness state for an agent
- `POST /claim`: publish that an agent has taken responsibility for a task
- `POST /complete`: publish completion status or task result
- `GET /audit`: inspect historical events
- `GET /agents`: list registered agents and current status

## Protocol Notes

The protocol is intentionally simple:

- Transport: HTTPS over Tailscale
- Authentication: HMAC-SHA256 using a per-agent shared secret
- Replay defense: signed timestamp plus a bounded validity window
- Delivery model: at-least-once delivery
- Storage: SQLite by default

That implies:

- Clients must tolerate duplicate delivery
- Handlers should be idempotent
- Clocks must be roughly synchronized

## Planned Packaging

| Tier | Description |
|---|---|
| **OSS core** | Self-hosted relay, SQLite storage, signed messaging, inboxes, receipts, audit log |
| **Pro** | Dashboard, retries, analytics, RBAC, Postgres support, stronger storage controls |
| **Hosted** | Optional managed deployment for teams that want Ekho operated for them |

The OSS core remains private-network-first. A hosted offering, if built, would be an additional deployment model rather than the default architecture.

## Client Integration

Ekho is designed to be easy to wrap in agent runtimes and CLIs.

Example workflow for an agent integration:

- Poll inbox on an interval
- Verify and process pending messages
- Send acknowledgements automatically
- Emit heartbeats on a schedule
- Publish claim and completion events for task coordination

Illustrative CLI shape:

```bash
ekho inbox
ekho send --to tars --type direct --body "Check the fleet handoffs"
ekho broadcast --type alert --body "New deployment incoming"
ekho heartbeat --status healthy --agent jarvis
```

## Current Status

Ekho is currently **pre-alpha**. The project is in architecture and protocol definition, not production release.

Areas still being finalized:

- Message schema
- Agent registration and secret provisioning
- Retry and dead-letter behavior
- Postgres support
- SDK and CLI shape

## Built by Drakon Systems

[drakonsystems.com](https://drakonsystems.com)

*Ekho takes its name from Echo, the voice that carries.*
