# Ekho Architecture

> A hardened private communication layer for distributed AI agents.

## Purpose

Ekho is a private relay and control surface for AI agents operating across a trusted network. Its job is not to replace an orchestrator or workflow engine. Its job is to make agent communication reliable, observable, controllable, and secure by default.

The product becomes sellable when it solves four problems at once:

1. Agents can communicate without relying on public infrastructure.
2. Operators can see what agents are doing and why.
3. Operators can intervene before agents do the wrong thing.
4. Setup is simple whether the customer already has Tailscale or not.

## Product Thesis

Most multi-agent systems fail operationally for one of three reasons:

- Agents do not share a dependable communication channel.
- Humans cannot observe or steer the coordination loop.
- Security is bolted on after the fact.

Ekho should be designed as the layer that sits between agent runtimes and the operator:

- **Below the agent**: message transport, identity, delivery, receipts
- **Beside the agent**: policy enforcement, audit, liveness, operator controls
- **Above the agent**: UI for observing, pausing, redirecting, and approving actions

This makes Ekho more than "a relay" without turning it into a full workflow engine.

## Core Design Principles

- **Private-network first**: no public broker required
- **Transport is not optional**: agents should use Ekho by default via runtime adapters
- **Human override matters**: operators must be able to pause, reroute, or block actions
- **Observable by design**: every important event should be traceable
- **Safe defaults**: a basic deployment should already be secure enough for internal use
- **Progressive complexity**: simple self-hosted setup first, larger control features later

## System Overview

```text
                        +----------------------+
                        |  Operator UI / API   |
                        |  monitor + controls  |
                        +----------+-----------+
                                   |
                                   v
 +-----------+    HTTPS/Tailnet   +------------------+    HTTPS/Tailnet   +-----------+
 | Agent A   | <----------------> |   Ekho Relay     | <----------------> | Agent B   |
 | adapter   |                    | + Policy Engine  |                    | adapter   |
 +-----------+                    | + Audit Service  |                    +-----------+
        |                         | + Presence Store |
        |                         +---------+--------+
        |                                   |
        |                                   v
        |                           +---------------+
        +-------------------------> | DB / Storage  |
                                    | messages      |
                                    | receipts      |
                                    | events        |
                                    | policies      |
                                    +---------------+
```

## Main Components

### 1. Relay Service

The relay is the durable communication hub.

Responsibilities:

- Accept signed requests from agents
- Validate identity, timestamp, and authorization
- Store messages for later delivery
- Return inbox contents to recipients
- Track acknowledgement state
- Emit lifecycle events for every meaningful action

### 2. Agent Adapter

This is the missing layer that makes Ekho actually used by agents instead of repeatedly forgotten.

Responsibilities:

- Poll the Ekho inbox automatically
- Inject incoming messages into the agent's active context
- Auto-ack delivered messages
- Send heartbeats on a schedule
- Wrap outgoing messages in the signed Ekho envelope
- Respect pause, block, or reroute instructions from the control plane

Without this adapter, Ekho is just a protocol. With it, Ekho becomes operational infrastructure.

### 3. Policy Engine

The policy engine is what turns Ekho into a controlled system rather than just a message relay.

Responsibilities:

- Allow or deny message delivery based on rules
- Require approval for specific message types or destinations
- Quarantine suspicious payloads
- Enforce per-agent or per-group communication policies
- Rate-limit noisy or misbehaving agents
- Freeze or isolate a compromised agent

### 4. Audit and Event Stream

Every important state transition should create an event.

Examples:

- Message submitted
- Message accepted
- Message queued
- Message delivered
- Message acknowledged
- Message expired
- Agent heartbeat received
- Agent marked unhealthy
- Action paused by operator
- Message rerouted by policy

### 5. Operator UI

The operator UI is one of the most important pieces of the sellable product. Buyers need confidence, not just transport.

The UI should answer:

- Which agents are alive right now?
- Who is talking to whom?
- What messages are pending?
- What actions are blocked, paused, or waiting for approval?
- Which agent is producing suspicious or unexpected traffic?
- What happened before a failure?

## Communication Model

Ekho should use a single message envelope with typed semantics on top.

Recommended envelope fields:

- `message_id`
- `correlation_id`
- `conversation_id`
- `sender_agent_id`
- `recipient`
- `message_type`
- `priority`
- `body`
- `metadata`
- `ttl`
- `created_at`
- `signature`

Recommended message types:

- `direct`
- `broadcast`
- `alert`
- `handoff`
- `claim`
- `complete`
- `heartbeat`
- `approval_request`
- `approval_response`
- `control`

Important design choice:

Task coordination should be represented as message types and conventions, not as a separate hardcoded orchestration subsystem in v1.

### Bounded peer delegation

Agents auto-reply to their verified operator and, by default, to teammates —
bounded agent-to-agent delegation. To keep agent↔agent exchanges from degenerating
into unbounded ping-pong, each teammate **wake** is latched per conversation: a
peer may wake an agent at most `peer_turn_budget` times (default 6) in a
conversation before the latch closes (further peer messages are still delivered
and visible, but spawn no turn). A per-peer rolling rate gate (≤5/peer/min) is a
backstop. This caps *chatter* while the message-type conventions (`handoff`,
`claim`, `complete`) still carry *work*. Three rules keep real work from being
penalised like chatter:

- **Progress signals refresh the budget.** Scanning the full inbound batch before
  the latch gate, a peer `handoff`/`claim`/`complete` re-energises that
  conversation's latch — exactly as an operator message does. A `handoff`/`claim`
  both wakes the agent and refreshes the budget; a `complete` (never a wake type)
  refreshes without waking. So a handoff can never silently die on a spent budget.
- **Graceful last turn.** On the final auto-wake before the latch pauses, the
  woken agent's prompt instructs it to finish, hand off cleanly, or post one clear
  status message and pause for the operator — never to stop mid-task silently.
- **Stall escalation.** When the budget is spent and a real peer message is
  withheld, the agent raises one operator-visible `conversation.stalled` event
  (`POST /v1/notices`, recorded idempotently per fleet/agent/conversation until the
  operator re-engages) so a stalled conversation surfaces in the operator events
  feed rather than waiting unread. Operator engagement re-opens the latch and
  re-arms the escalation.

## Delivery Guarantees

Ekho should explicitly target **at-least-once delivery**.

That means:

- Messages may be delivered more than once
- Clients must implement idempotency
- Acknowledgement updates message state but does not guarantee business success
- Retry logic should be bounded and visible

Why this matters:

- Exactly-once delivery is expensive and fragile
- At-least-once is easier to implement and explain
- Agent systems already need idempotent behavior

## Security Model

Security should not depend on one layer alone.

### Network Security

- Relay binds only to a private interface
- Primary deployment target is a Tailscale tailnet
- Public internet exposure is disabled by default

### Identity

- Every agent has a unique identity
- Every agent has its own secret or key pair
- Secrets can be rotated without re-provisioning the entire fleet

### Request Authentication

- Signed requests
- Timestamp window enforcement
- Replay detection with nonce or short-lived request IDs

### Authorization

- Per-agent permissions
- Group-based policies
- Restricted message type access
- Optional allowlist by destination

### Operator Controls

- Pause one agent
- Pause a conversation
- Block a message type
- Require manual approval
- Quarantine an agent

## Deployment Topologies

Ekho should support two main deployment paths.

### Path A: Customer Already Has Tailscale

This should be the best and simplest setup flow.

Assumptions:

- The customer already runs a tailnet
- Their hosts can join the tailnet
- They are comfortable with internal networking

Setup flow:

1. Install Ekho relay on a node that is already on the tailnet.
2. Bind Ekho to the machine's Tailscale IP or MagicDNS name.
3. Run the Ekho setup wizard.
4. Register initial operator account.
5. Create the first agent group and issue agent credentials.
6. Install the agent adapter on participating agent nodes.
7. Verify heartbeats and test messaging through the UI.

Why this path matters:

- Lowest friction
- Fastest time to value
- Easiest enterprise sell

### Path B: Customer Does Not Have Tailscale

This path needs to be explicit, not hand-waved away.

Recommended product behavior:

- Ekho should detect the absence of Tailscale during setup
- The wizard should explain why a private network is required
- The wizard should offer guided installation steps rather than failing vaguely

Setup flow:

1. Install Ekho bootstrap package.
2. Setup wizard checks whether `tailscaled` is installed and authenticated.
3. If missing, wizard offers:
   - guided Tailscale installation instructions
   - link to join or create a tailnet
   - explanation of required permissions
4. Once networking is ready, wizard resumes Ekho setup.
5. Relay is configured and agent enrollment begins.

Important product decision:

Ekho should not try to reimplement private networking. It should either depend on Tailscale cleanly or later support a clearly defined alternate private-network mode such as WireGuard/VPN/manual private LAN.

## Setup Wizard Design

The setup wizard is critical. It is how the product turns from architecture into something a buyer believes they can deploy.

### Wizard Goals

- Confirm networking prerequisites
- Create or validate relay configuration
- Initialize storage
- Create first operator account
- Enroll initial agents
- Prove the system works before setup ends

### Wizard Stages

#### 1. Environment Check

Checks:

- OS and architecture
- Tailscale presence and status
- Reachable Tailscale IP or MagicDNS
- Open listen port
- Writeable storage path
- SQLite or Postgres availability
- Local clock synchronization status

#### 2. Deployment Mode

Options:

- Single-node quickstart
- Team self-hosted
- Production with Postgres

#### 3. Network Mode

Wizard asks:

- Are you already on a Tailscale network?
- Do you want Ekho to bind only to tailnet interfaces?
- Should the UI also be tailnet-only?

If yes:

- Detect interfaces automatically
- Suggest the Tailscale IP and DNS name

If no:

- Guide the user through Tailscale installation and login
- Resume once network checks pass

#### 4. Storage Initialization

Wizard configures:

- SQLite path for quickstart
- Postgres connection for production
- Retention period for messages and audit events
- Dead-letter retention

#### 5. Security Bootstrap

Wizard creates:

- Initial operator credential
- Relay signing configuration
- First agent group
- First enrollment token or bootstrap secret

#### 6. Agent Enrollment

Wizard should support:

- Copy-paste enrollment command
- Generated config file
- One-time join token
- Per-agent identity issuance

#### 7. Validation

Wizard runs a full smoke test:

- Create test agent
- Send test message
- Confirm inbox receipt
- Confirm ack receipt
- Confirm heartbeat appears in UI

The setup is not done until this test passes.

## Agent Enrollment Model

Agent enrollment needs to be easy for humans but safe enough for production.

Recommended approach:

- One-time enrollment token issued by operator
- Agent adapter exchanges token for permanent credentials
- Relay returns:
  - `agent_id`
  - agent secret or key material
  - relay endpoint
  - policy profile
  - heartbeat interval

Important constraints:

- Tokens expire quickly
- Tokens are single use
- Enrollment events are fully audited
- Credentials can be revoked centrally

## Control Plane and Human Override

This is the difference between a toy and a product.

Operators must be able to intervene in real time.

Recommended control actions:

- Pause an agent
- Pause a conversation
- Stop new outbound messages from an agent
- Block a destination
- Block a message type
- Cancel queued messages
- Require approval for certain actions
- Redirect a message to a different agent
- Isolate an agent into a quarantine policy

These controls should apply at multiple levels:

- Single agent
- Group of agents
- Conversation or correlation ID
- Message type
- Policy rule

## Monitoring and UX

The UI should not feel like a database admin panel. It should feel like a flight deck.

### Main Views

#### Fleet Overview

Shows:

- Total agents
- Healthy/unhealthy agents
- Message throughput
- Queue depth
- Pending approvals
- Quarantined agents
- Recent policy interventions

#### Agent Detail View

Shows:

- Current status and last heartbeat
- Active conversations
- Sent and received messages
- Policy restrictions
- Recent errors
- Controls to pause, isolate, or inspect

#### Conversation Timeline

Shows:

- Ordered message exchange between agents
- State transitions
- Delivery and ack timestamps
- Approval steps
- Human interventions

This view should make it easy to answer:

"Why did agent B take this action after agent A sent that message?"

#### Queue and Dead-Letter View

Shows:

- Stuck messages
- Expired messages
- Retry attempts
- Missing acknowledgements
- Messages waiting for approval

#### Policy and Control View

Shows:

- Active rules
- Violations
- Quarantine decisions
- Recently blocked traffic
- Manual overrides

### UX Design Priorities

- Fast scanning of the whole fleet
- Message traceability by conversation
- One-click intervention
- Clear separation between observed traffic and operator-injected control actions
- Strong filters by agent, message type, severity, and time

## Approval and Steering Model

Operators should be able to steer agent behavior without rewriting prompts mid-flight.

Recommended mechanisms:

- **Pause**: stop the next action from proceeding
- **Approve**: allow a queued action to continue
- **Reject**: block a queued or proposed action
- **Redirect**: route work to a different agent
- **Inject instruction**: add a high-priority control message into a conversation
- **Escalate**: move an interaction to a human or supervisor agent

This can be implemented through `control` and `approval_*` message types that are handled by the adapter.

## Failure Modes and Pitfalls

These need to be designed around early.

### 1. Agents Ignore the System

Pitfall:

Agents only use Ekho when explicitly told to.

Mitigation:

- Ship adapters for popular agent runtimes
- Make inbox polling and acks automatic
- Expose Ekho as the default communication primitive

### 2. Queue Growth and Silent Failure

Pitfall:

Offline or broken agents accumulate undelivered messages forever.

Mitigation:

- TTLs
- Dead-letter queue
- Queue depth alerts
- Per-agent backlog indicators in UI

### 3. Duplicate or Replayed Messages

Pitfall:

Network retries or clock issues cause repeated delivery.

Mitigation:

- Message IDs
- Idempotency keys
- Replay window validation
- Duplicate detection metrics

### 4. Operators Cannot Understand What Happened

Pitfall:

The system logs data but does not explain flow.

Mitigation:

- Conversation timelines
- Correlation IDs
- Event-centric audit model
- Searchable history

### 5. Tailscale Dependency Blocks Adoption

Pitfall:

Customers like the concept but do not already run Tailscale.

Mitigation:

- Excellent setup wizard
- Clear explanation of why private networking matters
- Future support for alternate deployment modes if demand exists

### 6. A Compromised Agent Can Still Cause Damage

Pitfall:

An agent with valid credentials floods or misroutes traffic.

Mitigation:

- Rate limiting
- Policy constraints
- Group-level permissions
- Operator kill switch
- Quarantine mode

### 7. Control Features Become an Orchestrator by Accident

Pitfall:

The product keeps absorbing workflow logic until it is unfocused.

Mitigation:

- Keep transport, audit, approval, and steering as the core
- Avoid embedding full planning logic into the relay

## Data Model

Minimum durable entities:

- `agents`
- `agent_groups`
- `credentials`
- `messages`
- `message_deliveries`
- `receipts`
- `heartbeats`
- `events`
- `policies`
- `approvals`
- `enrollment_tokens`

## Implementation Phases

### Phase 1: Credible Core

- Relay service
- SQLite storage
- Signed envelope protocol
- Inbox polling
- Acknowledgements
- Heartbeats
- Basic audit log
- Basic CLI
- Setup wizard

### Phase 2: Operational Product

- Operator UI
- Conversation timelines
- Queue inspection
- Pause and block controls
- Enrollment flow
- Policy engine v1

### Phase 3: Hardened Deployment

- Postgres support
- RBAC
- HA considerations
- Secret rotation workflows
- Dead-letter tooling
- Alerting integrations

### Phase 4: Sellable Team Product

- Approval workflows
- Rich steering controls
- Analytics
- Hosted deployment option
- SDKs and agent runtime integrations

## Recommended v1 Positioning

The most defensible version of Ekho is:

**A private communication and control layer for distributed AI agents running on trusted networks.**

That positioning is strong because it promises:

- secure transport
- operational visibility
- human override
- straightforward deployment

It does not promise:

- autonomous workflow orchestration
- general event streaming for every workload
- public internet messaging

## Definition of Success

Ekho is successful when a new customer can:

1. Install it on a node in their environment.
2. Connect agents without building custom infrastructure.
3. Watch agent interactions in real time.
4. Pause or redirect a risky action before damage happens.
5. Audit what happened afterward with confidence.

If the product does those five things well, it is not just an interesting idea. It is a credible infrastructure product.

## Pre-Spec Check

Before locking v1, there are a few pieces that need to be explicit so the system does not force a structural refactor later.

### Missing Pieces To Design In Now

#### 1. External Interoperability Boundary

Ekho should not invent a totally isolated protocol if the outside world is moving toward agent interoperability standards.

Design decision:

- Internal relay API can stay Ekho-specific in v1
- External federation should have a compatibility layer later
- The best future target is A2A compatibility at the edge, not in the storage model

Why this matters:

- Avoids painting the product into a proprietary corner
- Lets Ekho keep a tighter internal model while still supporting broader ecosystems later

#### 2. Operator Action Gating

The spec needs a clean model for "agent proposed an action" versus "agent already executed an action."

Design decision:

- Ekho should gate communications and declared actions
- Ekho should not pretend it can stop arbitrary side effects unless the adapter cooperates
- Adapters must route risky tool calls and outbound actions through approval-aware control hooks

Why this matters:

- Prevents overpromising safety
- Makes human override real rather than cosmetic

#### 3. Trust and Secret Lifecycle

Per-agent secrets are fine for v1, but the lifecycle must already exist.

Design decision:

- Enrollment token -> permanent agent credential
- Rotation endpoint in v1
- Revocation state in v1

Why this matters:

- Secret rotation always arrives earlier than founders expect

#### 4. Project / Fleet Boundary

Ekho needs a first-class grouping construct.

Design decision:

- Add `fleet` as the top-level boundary in v1
- Agents, policies, UI views, and audit queries are fleet-scoped

Why this matters:

- Avoids retrofitting multi-team isolation later
- Makes hosted and enterprise packaging easier

#### 5. Event Export

Customers will want observability beyond the Ekho UI.

Design decision:

- Emit structured events internally
- Add OpenTelemetry and webhook export later
- Keep the event schema stable from v1 onward

Why this matters:

- Event model changes are painful after customers build around them

## Competitive Reality

There are adjacent products and protocols already solving parts of this problem.

### What Exists Today

- **Google A2A** is building a standard protocol for agent-to-agent interoperability over HTTP with discovery and async patterns.
- **LangGraph + LangSmith** are strong on durable state, interrupts, human-in-the-loop, and observability.
- **AutoGen Studio** gives a UI for multi-agent development and interaction.
- **Temporal** is extremely strong at durable execution, approval waits, event history, and long-running workflow reliability.

### What They Do Better Than A Raw Ekho Idea

- A2A has stronger interoperability momentum
- LangGraph has stronger pause/resume semantics inside an agent workflow
- LangSmith has mature tracing and debugging
- Temporal has a much more proven durability model
- AutoGen Studio already gives users a visual interaction surface

### Where Ekho Can Win

Ekho should not compete by trying to be a better generic agent framework.

Ekho can win by being:

- private-network-first
- operator-control-first
- transport-and-policy-first
- framework-agnostic
- lightweight enough to self-host in real customer infrastructure

The better product thesis is:

**LangGraph and Temporal manage execution. Ekho governs communication and control across agents on private networks.**

### Strategic Product Rule

Ekho should integrate with these systems, not fight them.

Recommended stance:

- Support agent adapters for LangGraph, AutoGen, and custom runtimes
- Keep room for A2A gateway compatibility
- Export traces/events to external observability stacks
- Avoid becoming a full workflow engine

## v1 Product Decisions

These are the recommended non-negotiable decisions for the first implementation.

- Transport model: HTTPS on private network, tailnet-first
- Delivery guarantee: at-least-once
- Storage: SQLite for quickstart, Postgres for production
- Auth model: HMAC agent credentials in v1
- Fleet model: single-tenant, fleet-scoped
- Message model: one envelope, typed semantics
- Control model: operator pause/block/approve/reroute
- Runtime model: adapters are mandatory for full value
- UI model: audit timeline plus live fleet overview
- Compatibility stance: Ekho-native inside, future A2A-compatible edge

## v1 Implementation Spec

### Runtime Components

v1 consists of five concrete services or modules:

1. `ekho-relay`
2. `ekho-db`
3. `ekho-ui`
4. `ekho-setup`
5. `ekho-agent-adapter`

### Component Responsibilities

#### `ekho-relay`

- Serve HTTPS API
- Authenticate requests
- Enforce policies
- Persist messages and events
- Expose operator control endpoints
- Expose health and metrics endpoints

#### `ekho-db`

- SQLite in quickstart mode
- Postgres in production mode
- Durable storage for fleet metadata, messages, events, and policies

#### `ekho-ui`

- Fleet dashboard
- Agent detail pages
- Conversation timeline
- Pending approvals queue
- Policy and quarantine views

#### `ekho-setup`

- CLI or TUI setup wizard
- Environment and networking checks
- Storage initialization
- Bootstrap operator creation
- First fleet creation
- First agent enrollment workflow

#### `ekho-agent-adapter`

- Sidecar or embedded library
- Inbox polling loop
- Heartbeat loop
- Control channel handling
- Approval-aware action execution hooks

## Fleet Model

All v1 resources are scoped to a `fleet`.

Examples:

- `fleet_id`
- `agent_id`
- `policy_id`
- `conversation_id`

Rules:

- Agents can only communicate inside their fleet by default
- Cross-fleet communication is unsupported in v1
- Operator sessions are scoped to one fleet at a time

## API Spec

### Authentication Headers

All agent-authenticated requests include:

- `X-Ekho-Agent-Id`
- `X-Ekho-Timestamp`
- `X-Ekho-Nonce`
- `X-Ekho-Signature`

Signature input:

```text
HTTP_METHOD + "\n" +
REQUEST_PATH + "\n" +
X-Ekho-Timestamp + "\n" +
X-Ekho-Nonce + "\n" +
SHA256(request_body)
```

Signature algorithm:

- HMAC-SHA256 using the agent's current secret

Validation rules:

- Timestamp must be within configurable skew window, default `300s`
- Nonce must be unique per agent inside replay window
- Revoked agents are denied

### Envelope Schema

```json
{
  "message_id": "msg_01J...",
  "fleet_id": "flt_01J...",
  "conversation_id": "cnv_01J...",
  "correlation_id": "cor_01J...",
  "sender_agent_id": "agent_writer",
  "recipient": {
    "kind": "agent",
    "id": "agent_reviewer"
  },
  "message_type": "handoff",
  "priority": "normal",
  "ttl_seconds": 900,
  "requires_approval": false,
  "body": {
    "text": "Review the generated migration plan",
    "structured": {
      "task_id": "task_123"
    }
  },
  "metadata": {
    "tags": ["migration", "review"],
    "source_runtime": "langgraph"
  },
  "created_at": "2026-04-02T12:00:00Z"
}
```

### Operator-Controlled Action Schema

```json
{
  "control_id": "ctl_01J...",
  "target": {
    "kind": "agent",
    "id": "agent_writer"
  },
  "action": "pause",
  "reason": "Unexpected outbound volume",
  "expires_at": "2026-04-02T13:00:00Z"
}
```

### `POST /v1/enroll`

Exchange a one-time enrollment token for permanent agent credentials.

Request:

```json
{
  "fleet_id": "flt_01J...",
  "token": "enroll_....",
  "display_name": "Writer Agent",
  "runtime": "openclaw",
  "hostname": "mbp-writer-01",
  "capabilities": ["write", "handoff"]
}
```

Response:

```json
{
  "agent_id": "agent_writer",
  "secret": "ekho_secret_...",
  "relay_base_url": "https://ekho.tailnet-name.ts.net",
  "heartbeat_interval_seconds": 30,
  "poll_interval_seconds": 5,
  "policy_profile": "default"
}
```

### `POST /v1/messages`

Submit a message.

Request:

```json
{
  "recipient": {
    "kind": "agent",
    "id": "agent_reviewer"
  },
  "message_type": "handoff",
  "priority": "normal",
  "ttl_seconds": 900,
  "body": {
    "text": "Review the generated migration plan"
  },
  "metadata": {
    "task_id": "task_123"
  },
  "conversation_id": "cnv_01J...",
  "correlation_id": "cor_01J..."
}
```

Response:

```json
{
  "message_id": "msg_01J...",
  "status": "queued",
  "queued_at": "2026-04-02T12:00:00Z"
}
```

### `GET /v1/inbox`

Return pending messages for the calling agent.

Query params:

- `limit`
- `wait_seconds`
- `include_control`

Response:

```json
{
  "messages": [
    {
      "message_id": "msg_01J...",
      "conversation_id": "cnv_01J...",
      "correlation_id": "cor_01J...",
      "sender_agent_id": "agent_writer",
      "message_type": "handoff",
      "priority": "normal",
      "body": {
        "text": "Review the generated migration plan"
      },
      "metadata": {
        "task_id": "task_123"
      },
      "created_at": "2026-04-02T12:00:00Z",
      "deadline_at": "2026-04-02T12:15:00Z"
    }
  ],
  "controls": [
    {
      "control_id": "ctl_01J...",
      "action": "pause",
      "reason": "Operator review requested"
    }
  ]
}
```

### `POST /v1/acks`

Ack delivery of one or more messages.

Request:

```json
{
  "acks": [
    {
      "message_id": "msg_01J...",
      "status": "received",
      "received_at": "2026-04-02T12:00:03Z"
    }
  ]
}
```

Response:

```json
{
  "updated": 1
}
```

### `POST /v1/heartbeats`

Request:

```json
{
  "status": "healthy",
  "active_conversation_ids": ["cnv_01J..."],
  "metrics": {
    "queue_depth_local": 0,
    "tool_calls_last_minute": 4
  }
}
```

Response:

```json
{
  "ok": true,
  "next_heartbeat_due_seconds": 30
}
```

### `POST /v1/actions/propose`

Used by adapters before performing high-risk or policy-guarded actions.

Request:

```json
{
  "conversation_id": "cnv_01J...",
  "action_type": "external_http_request",
  "summary": "POST deployment request to internal release service",
  "risk_level": "high",
  "payload": {
    "method": "POST",
    "target": "https://release.internal/deploy",
    "arguments": {
      "service": "api",
      "version": "2026.04.02"
    }
  }
}
```

Response when auto-approved:

```json
{
  "decision": "allow"
}
```

Response when human review is required:

```json
{
  "decision": "pending_approval",
  "approval_id": "apr_01J..."
}
```

### `POST /v1/actions/result`

Adapters report final result of a proposed action.

Request:

```json
{
  "approval_id": "apr_01J...",
  "result": "executed",
  "completed_at": "2026-04-02T12:01:10Z",
  "output": {
    "status_code": 200
  }
}
```

### Operator API

Session-authenticated operator endpoints:

- `POST /v1/operator/agents/:agent_id/pause`
- `POST /v1/operator/agents/:agent_id/resume`
- `POST /v1/operator/agents/:agent_id/quarantine`
- `POST /v1/operator/messages/:message_id/cancel`
- `POST /v1/operator/approvals/:approval_id/approve`
- `POST /v1/operator/approvals/:approval_id/reject`
- `POST /v1/operator/conversations/:conversation_id/redirect`
- `GET /v1/operator/events`
- `GET /v1/operator/agents`
- `GET /v1/operator/conversations/:conversation_id`

## Database Spec

### SQL Dialect

- SQLite for local quickstart
- Postgres 16+ for production

### Tables

#### `fleets`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `name` | text | unique per deployment |
| `created_at` | timestamptz | not null |

#### `operators`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk `fleets.id` |
| `email` | text | unique within fleet |
| `password_hash` | text | nullable if SSO later |
| `role` | text | `owner`, `admin`, `viewer`, `approver` |
| `created_at` | timestamptz | not null |

#### `agents`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `display_name` | text | not null |
| `runtime` | text | `custom`, `openclaw`, `langgraph`, `autogen` |
| `status` | text | `healthy`, `degraded`, `offline`, `quarantined`, `paused` |
| `hostname` | text | nullable |
| `policy_profile` | text | default policy name |
| `created_at` | timestamptz | not null |
| `last_seen_at` | timestamptz | nullable |
| `revoked_at` | timestamptz | nullable |

Indexes:

- `(fleet_id, status)`
- `(fleet_id, last_seen_at desc)`

#### `agent_credentials`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `agent_id` | text | fk |
| `secret_hash` | text | store hash, not plaintext |
| `status` | text | `active`, `rotating`, `revoked` |
| `created_at` | timestamptz | not null |
| `expires_at` | timestamptz | nullable |
| `revoked_at` | timestamptz | nullable |

#### `enrollment_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `token_hash` | text | unique |
| `issued_by_operator_id` | text | fk |
| `expires_at` | timestamptz | not null |
| `used_at` | timestamptz | nullable |
| `used_by_agent_id` | text | nullable |

#### `messages`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `conversation_id` | text | indexed |
| `correlation_id` | text | indexed |
| `sender_agent_id` | text | fk |
| `recipient_kind` | text | `agent`, `group`, `broadcast` |
| `recipient_id` | text | nullable |
| `message_type` | text | indexed |
| `priority` | text | `low`, `normal`, `high`, `urgent` |
| `requires_approval` | boolean | not null |
| `body_json` | json/jsonb | not null |
| `metadata_json` | json/jsonb | nullable |
| `ttl_seconds` | integer | not null |
| `created_at` | timestamptz | not null |
| `expires_at` | timestamptz | not null |
| `status` | text | `queued`, `delivered`, `acked`, `expired`, `cancelled`, `dead_letter` |

Indexes:

- `(fleet_id, created_at desc)`
- `(fleet_id, conversation_id, created_at)`
- `(fleet_id, recipient_kind, recipient_id, status)`

#### `message_deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `message_id` | text | fk |
| `recipient_agent_id` | text | fk |
| `delivery_attempts` | integer | default 0 |
| `queued_at` | timestamptz | not null |
| `delivered_at` | timestamptz | nullable |
| `acked_at` | timestamptz | nullable |
| `status` | text | `queued`, `delivered`, `acked`, `expired`, `dead_letter` |

Indexes:

- `(recipient_agent_id, status, queued_at)`

#### `heartbeats`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `agent_id` | text | fk |
| `status` | text | `healthy`, `degraded`, `busy`, `idle` |
| `metrics_json` | json/jsonb | nullable |
| `received_at` | timestamptz | not null |

#### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `event_type` | text | indexed |
| `actor_kind` | text | `agent`, `operator`, `system` |
| `actor_id` | text | nullable |
| `resource_kind` | text | `message`, `agent`, `approval`, `policy`, `conversation` |
| `resource_id` | text | nullable |
| `conversation_id` | text | nullable |
| `payload_json` | json/jsonb | not null |
| `created_at` | timestamptz | not null |

Indexes:

- `(fleet_id, created_at desc)`
- `(fleet_id, event_type, created_at desc)`
- `(fleet_id, conversation_id, created_at)`

#### `approvals`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `agent_id` | text | fk |
| `conversation_id` | text | nullable |
| `action_type` | text | indexed |
| `risk_level` | text | `low`, `medium`, `high`, `critical` |
| `summary` | text | not null |
| `payload_json` | json/jsonb | not null |
| `status` | text | `pending`, `approved`, `rejected`, `expired`, `cancelled`, `executed` |
| `requested_at` | timestamptz | not null |
| `resolved_at` | timestamptz | nullable |
| `resolved_by_operator_id` | text | nullable |

Indexes:

- `(fleet_id, status, requested_at)`

#### `policies`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `name` | text | unique within fleet |
| `scope_kind` | text | `fleet`, `agent`, `group`, `message_type` |
| `scope_id` | text | nullable |
| `rule_json` | json/jsonb | not null |
| `enabled` | boolean | not null |
| `created_at` | timestamptz | not null |

#### `control_actions`

| Column | Type | Notes |
|---|---|---|
| `id` | text | primary key |
| `fleet_id` | text | fk |
| `target_kind` | text | `agent`, `conversation`, `message_type` |
| `target_id` | text | not null |
| `action` | text | `pause`, `resume`, `quarantine`, `block`, `redirect` |
| `payload_json` | json/jsonb | nullable |
| `issued_by_operator_id` | text | fk |
| `created_at` | timestamptz | not null |
| `expires_at` | timestamptz | nullable |

## Policy Rules

v1 policy engine should support a small, explicit rule set rather than a full DSL.

Supported actions:

- `allow`
- `deny`
- `require_approval`
- `rate_limit`
- `quarantine`

Supported conditions:

- `sender_agent_id`
- `recipient_agent_id`
- `message_type`
- `priority`
- `risk_level`
- `target_hostname`
- `conversation_tag`

Example rule:

```json
{
  "when": {
    "message_type": "alert",
    "sender_agent_id": "agent_writer"
  },
  "then": {
    "action": "require_approval"
  }
}
```

## Agent Adapter Spec

### Required Behavior

The adapter must:

- Poll `/v1/inbox` every `poll_interval_seconds`
- Ack messages after they are handed to the local runtime
- Send `/v1/heartbeats` every `heartbeat_interval_seconds`
- Cache active control actions locally
- Stop guarded actions when the relay returns `pending_approval`, `deny`, or `pause`

### Runtime Hook Contract

To make operator steering real, the adapter must expose three hooks:

- `before_action(action)` -> ask Ekho whether the action may proceed
- `after_action(result)` -> report result to Ekho
- `on_control(control)` -> apply pause, resume, reroute, or quarantine behavior locally

### Minimal Local State

- current `agent_id`
- active secret
- last successful heartbeat timestamp
- pending approvals map
- current pause/quarantine flags

## Setup Wizard Flows

### Flow 1: Existing Tailscale Network

1. Detect `tailscaled`.
2. Detect authenticated tailnet.
3. Show discovered Tailscale IP and MagicDNS hostname.
4. Ask whether relay and UI should bind tailnet-only.
5. Ask quickstart or production storage mode.
6. Initialize database.
7. Create first fleet.
8. Create first operator account.
9. Generate first enrollment token.
10. Show install command for first agent adapter.
11. Run end-to-end connectivity test.
12. Open UI dashboard.

Exit criteria:

- Relay reachable on tailnet hostname
- Operator can log in
- Test agent heartbeat visible
- Test message and ack visible

### Flow 2: No Tailscale Installed

1. Detect that Tailscale is unavailable.
2. Explain why Ekho requires a private network.
3. Offer guided install instructions for the current OS.
4. Ask user to authenticate or join a tailnet.
5. Re-run environment checks automatically.
6. Continue with Flow 1.

Exit criteria:

- Same as Flow 1

### Flow 3: Production Postgres Mode

1. Ask for Postgres DSN.
2. Validate connectivity and migrations.
3. Ask retention settings.
4. Ask whether to enable daily cleanup jobs.
5. Continue with normal bootstrap.

### Suggested Wizard Commands

```bash
ekho setup
ekho setup --quickstart
ekho setup --production
ekho agent enroll --token <token>
ekho doctor
```

## UI Spec

### Fleet Dashboard

Widgets:

- Healthy agents
- Offline agents
- Messages per minute
- Pending approvals
- Blocked actions
- Queue backlog
- Recent critical events

### Agent Page

Panels:

- status and heartbeat
- current controls
- recent conversations
- recent approvals
- recent errors

Actions:

- pause
- resume
- quarantine
- rotate credentials

### Conversation Timeline

Each row should include:

- timestamp
- actor
- event type
- message summary
- approval state
- operator intervention if any

### Approvals Queue

Each item should show:

- requesting agent
- risk level
- action summary
- conversation context
- approve / reject buttons

## Operational Defaults

Recommended defaults for v1:

- heartbeat interval: `30s`
- inbox poll interval: `5s`
- timestamp skew window: `300s`
- default message TTL: `15m`
- event retention quickstart: `7d`
- event retention production: `30d`
- offline threshold: `90s`
- approval timeout default: `10m`

## v1 Non-Goals

Not in v1:

- cross-fleet federation
- exactly-once delivery
- full workflow builder
- peer-to-peer delivery without relay
- cryptographic content secrecy beyond transport plus stored secret model
- arbitrary third-party action interception without adapter cooperation
- full A2A server compatibility

## Recommended Build Order

1. Storage schema and migrations
2. Enrollment flow
3. Signed request middleware
4. Message submit/inbox/ack loop
5. Heartbeats and fleet dashboard
6. Approval proposal flow
7. Pause/quarantine controls
8. Conversation timeline
9. Setup wizard
10. Postgres support
