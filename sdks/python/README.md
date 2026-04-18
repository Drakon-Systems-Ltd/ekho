# Ekho Python SDK

Python client for the [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay — signed, store-and-forward messaging for AI agent fleets.

Mirrors the Node.js `@ekho/sdk` package: same method names, same wire format, same HMAC-SHA256 auth scheme.

## Install

```bash
pip install ekho-sdk   # pending publish — see "From source" below
```

### From source

```bash
git clone https://github.com/Drakon-Systems-Ltd/ekho.git
cd ekho/sdks/python
pip install -e .
```

## Requirements

- Python 3.9+
- `requests` (installed automatically)

## Quick start

### Low-level client

```python
from ekho import EkhoAgentClient, AgentCredentials

client = EkhoAgentClient(AgentCredentials(
    agent_id="agent_abc123",
    secret="your_agent_secret",
    relay_base_url="http://localhost:4000",
))

# Send
client.send_message({
    "recipient": {"kind": "agent", "id": "agent_def456"},
    "message_type": "direct",
    "body": {"text": "Hello from Python"},
    "conversation_id": "conv-1",
    "correlation_id": "corr-1",
})

# Poll + ack
inbox = client.get_inbox()
for msg in inbox.messages:
    print(msg.sender_agent_id, msg.body)

from datetime import datetime, timezone
client.ack_messages([
    {
        "message_id": msg.message_id,
        "status": "received",
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    for msg in inbox.messages
])
```

### Enrollment

```python
from ekho import EkhoAgentClient, AgentCredentials

bootstrap = EkhoAgentClient(AgentCredentials(
    agent_id="", secret="", relay_base_url="http://localhost:4000",
))

result = bootstrap.enroll({
    "fleet_id": "fleet_primary",
    "token": "one-time-enrolment-token",
    "display_name": "python-worker-1",
    "runtime": "custom",
})

client = EkhoAgentClient(result.to_credentials())
```

### High-level adapter (auto-poll + heartbeat)

```python
from ekho import EkhoAgentAdapter, AdapterHooks, AgentCredentials

def on_message(msg, adapter):
    print(f"[{msg.conversation_id}] {msg.body}")

def on_control(ctrl, adapter):
    print(f"control: {ctrl.action} — {ctrl.reason}")

adapter = EkhoAgentAdapter(
    AgentCredentials(
        agent_id="agent_abc123",
        secret="...",
        relay_base_url="http://localhost:4000",
    ),
    AdapterHooks(on_message=on_message, on_control=on_control),
)

adapter.start()   # background heartbeat + inbox threads (daemons)

# ... your agent does work ...

adapter.stop(join=True)   # graceful shutdown
```

Or use it as a context manager:

```python
with EkhoAgentAdapter(creds, hooks) as adapter:
    adapter.send({...})
    # loops run until the block exits
```

### Approvals

```python
decision = adapter.propose_action({
    "conversation_id": "conv-1",
    "action_type": "send_email",
    "summary": "Send follow-up to customer",
    "risk_level": "medium",
    "payload": {"to": "customer@example.com"},
})
# Blocks until allowed or raises on deny / rejection.
```

## Auth scheme

Every request is HMAC-SHA256 signed. Headers sent:

| Header | Contents |
|---|---|
| `x-ekho-agent-id` | your agent id |
| `x-ekho-agent-secret` | your shared secret |
| `x-ekho-timestamp` | ISO 8601 UTC, ms precision, `Z` suffix |
| `x-ekho-nonce` | random UUID (one-time use) |
| `x-ekho-signature` | hex HMAC-SHA256 over the canonical payload |

Canonical payload:

```
METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(BODY)
```

This matches the Node SDK and the relay's `requireAgentAuth` middleware exactly.

## License

MIT © Drakon Systems
