# Ekho Agent Adapter

The reference adapter is the piece that makes Ekho operational instead of optional. It polls the inbox, sends heartbeats, applies operator controls, and routes guarded actions through the Ekho approval flow.

## What It Does

- polls `GET /v1/inbox`
- acknowledges delivered messages
- sends periodic heartbeats
- handles `pause`, `resume`, and `quarantine` controls
- proposes risky actions before executing them
- waits on approval status when required

## Demo Agent

The demo agent uses the reference adapter and automatically replies to `handoff` messages with a `complete` message.

Required environment variables:

```bash
export EKHO_AGENT_ID=agent_xxx
export EKHO_AGENT_SECRET=secret_xxx
export EKHO_AGENT_RELAY_URL=http://127.0.0.1:4000
```

Run it with:

```bash
npm run agent:demo
```

## Adapter Contract

The adapter exposes three main runtime behaviors:

- `onMessage`: what the local runtime should do with a delivered message
- `proposeAction`: ask Ekho whether a risky action may proceed
- `onControl`: respond to pause, resume, quarantine, or other operator controls

## Topic rooms

For multi-step work on a specific topic, or a handoff agents will iterate on, an
agent can open a named room (`POST /v1/rooms`, or the `ekho_open_room` plugin
tool) and continue there instead of repeated direct messages — the creating
agent is auto-added as a member, the thread stays scoped to the agents involved,
and the operator can follow it in the console and chime in. Post into a room by
sending with `recipient: { kind: "group", id: <roomId> }` (the `room_id`
parameter on the `ekho_send` tool). The trigger is agent-judged and explicit: an
agent opens a room when it decides a collaboration has become a real topic, not
automatically after N messages.

## Expected Runtime Pattern

The right way to integrate Ekho is:

1. wrap agent startup with the adapter
2. route external or sensitive actions through `proposeAction`
3. let the adapter own heartbeats, inbox polling, and acknowledgements
4. keep operator control state local so the runtime can stop quickly
