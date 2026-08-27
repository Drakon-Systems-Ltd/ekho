# A2A Protocol Support

Ekho speaks [A2A v1.0](https://a2a-protocol.org/latest/specification/) natively alongside its proprietary `/v1/*` API. Any A2A-compliant client can discover and message agents in an Ekho fleet without writing custom code.

## What's supported

| Capability | Supported |
|---|---|
| Agent Card (fleet + per-agent) | Yes |
| `message/send` | Yes |
| `message/stream` (SSE) | Yes |
| `tasks/get` | Yes |
| `tasks/list` | Yes |
| `tasks/cancel` | Yes |
| `tasks/resubscribe` (SSE) | Yes |
| `tasks/pushNotificationConfig/*` | Not yet (v1.1) |
| gRPC binding | Not yet (v1.1) |
| State transition history | Yes |

**Protocol version:** `0.3.0`
**Preferred transport:** JSON-RPC 2.0 over HTTP POST

## Endpoints

```
GET  /.well-known/agent-card.json                     Fleet-level card (directory)
GET  /agents/{agentId}/.well-known/agent-card.json    Per-agent card
POST /a2a                                             Fleet-level JSON-RPC hub
POST /agents/{agentId}/a2a                            Per-agent JSON-RPC endpoint
```

Streaming methods (`message/stream`, `tasks/resubscribe`) respond with `text/event-stream` and keep the connection open until the task reaches a terminal state or the client disconnects.

## Authentication

A2A requests reuse Ekho's existing HMAC-SHA256 scheme. The required headers:

| Header | Purpose |
|---|---|
| `x-ekho-agent-id` | Your agent identifier |
| `x-ekho-agent-secret` | Shared secret received at enrollment |
| `x-ekho-timestamp` | ISO 8601 timestamp, must be within 5 minutes |
| `x-ekho-nonce` | Random UUID — one-time use |
| `x-ekho-signature` | HMAC signature over `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(BODY)` |

The Agent Card declares this as security scheme `ekho_hmac`. Clients that already speak Ekho can send A2A messages with no additional auth setup.

## Authorization

Authenticating is not the same as being allowed. **Tasks are scoped to their two
participants**: a task is visible to the agent that created it and the agent it
was addressed to, and to nobody else. Everything is fleet-scoped first — an agent
can never name, message, read or cancel anything belonging to another fleet.

| Method | Who may call it |
|---|---|
| `message/send`, `message/stream` | Any live agent, to a live agent in its own fleet. Continuing an existing `taskId` requires being on that task, and the message must go to the other party on it. |
| `tasks/get`, `tasks/resubscribe` | The task's sender or recipient |
| `tasks/list` | Returns only the caller's own tasks. On `/agents/{id}/a2a` it narrows to the tasks the caller shares with that agent. |
| `tasks/cancel` | The task's sender or recipient |

A task the caller is not on is reported as `TaskNotFound` (`-32001`) rather than a
forbidden, so the endpoint never confirms that another agent's task exists.

**Sending clears the same gate as `POST /v1/messages`.** Quarantine/pause, rate
limits, the policy engine and licensed extension hooks are evaluated by shared
code (`src/message-gate.ts`) before any task row or message is created — the two
transports cannot drift. Denials map to these JSON-RPC error codes:

| Code | Meaning | `data` |
|---|---|---|
| `-32050` | Sender is quarantined or paused | `status` |
| `-32051` | Sender is over its rate limit | `retryAfterSeconds`, `limit` |
| `-32052` | Blocked by a fleet policy | `policy` |
| `-32053` | Blocked by an extension | `extension` |

These live in the JSON-RPC implementation-defined server-error range
(`-32000`..`-32099`), clear of the codes A2A reserves. Like all JSON-RPC errors
they are returned in the response body with HTTP 200; `message/stream` returns the
error object instead of opening an SSE stream.

## Quick example

Send a message to `agent_executor`:

```bash
curl -sS -X POST https://relay.example.com/agents/agent_executor/a2a \
  -H 'Content-Type: application/json' \
  -H 'x-ekho-agent-id: agent_planner' \
  -H 'x-ekho-agent-secret: ...' \
  -H 'x-ekho-timestamp: 2026-04-16T18:22:01.000Z' \
  -H 'x-ekho-nonce: 6c7f...' \
  -H 'x-ekho-signature: ...' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "messageId": "msg_abc",
        "role": "user",
        "parts": [{"kind": "text", "text": "Prepare the daily brief"}],
        "kind": "message"
      }
    }
  }'
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task_c3f...",
    "contextId": "ctx_91a...",
    "status": { "state": "submitted", "timestamp": "2026-04-16T18:22:01.005Z" },
    "history": [ { "messageId": "msg_abc", "role": "user", "parts": [...] } ],
    "artifacts": [],
    "kind": "task"
  }
}
```

The task is now queued for delivery via Ekho's store-and-forward mechanism. Poll `tasks/get` or subscribe via `message/stream` for updates.

## Mapping to Ekho internals

Each A2A task is backed by a row in `a2a_tasks` and joined to one or more `messages` rows via `a2a_task_messages`. The task row records both participants — `sender_agent_id` (the creator) and `agent_id` (the recipient) — which is what scopes the task methods above. The underlying Ekho message carries `message_type: "a2a.message"` with the full A2A message envelope in `body_json`, so a policy matching on `message_type` can target A2A traffic specifically.

This gives A2A tasks the same guarantees as native Ekho messages: signed delivery, retry/backoff, dead-letter, rate limiting, and operator visibility.

## Positioning

Ekho doesn't compete with A2A — it **carries** A2A. Write agents against A2A, run them on Ekho, and get:

- One binary to operate (no external broker)
- Signed, auditable delivery
- Operator console, policy engine, quarantine automation
- $99 one-time Pro for multi-fleet — no Kafka licensing tax

See also: [ARCHITECTURE.md](../ARCHITECTURE.md), [agent-adapter.md](./agent-adapter.md)
