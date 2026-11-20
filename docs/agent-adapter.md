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

Run it with (the script lives in `packages/relay/package.json`, so from the repo root it needs `-w @ekho/relay`):

```bash
npm run agent:demo -w @ekho/relay
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

## Heartbeat identity

From the release after 0.9.0 (#97), a heartbeat (`POST /v1/heartbeats`) may carry optional fields that tell the operator console which software the agent runs. The console shows them on each agent card as, for example, `plugin 0.8.0 · OpenClaw 2026.9.8`, with an **outdated** chip when the adapter is older than the release the relay ships. An agent that sends none of them shows `version unknown`. Nothing else changes, and a relay that predates these fields ignores them.

| Field | Meaning | Sent by |
|---|---|---|
| `adapter` | `openclaw-plugin`, `hermes-plugin`, `mcp-connector`, `sdk` (TypeScript SDK used directly) or `python-sdk` | each adapter |
| `adapter_version` | the adapter's own release | each adapter (see below) |
| `sdk_version` | the Ekho SDK version inside the adapter | the TypeScript and Python SDKs, on every heartbeat |
| `host_runtime`, `host_runtime_version` | the host: `openclaw`, `hermes`, `node` or `python`, and its version where the host exposes it cheaply | each adapter |
| `instance_id` | random per process start (per loaded copy for a host that reloads plugins in-process); not a secret | the TypeScript and Python SDKs |

Where the versions come from: the TypeScript SDK and the Hermes plugin use a constant that `release-version-lockstep.test.ts` keeps equal to the release; the OpenClaw plugin uses the build stamp baked into `dist/index.js` (an unstamped bundle sends no `adapter_version`, and a bundle edited after its build reports `<version>+modified`); the MCP connector uses its own installed package version; OpenClaw's version is `api.runtime.version`; Hermes's version is read from `hermes_cli` only if the host has already loaded it. No adapter reads a `package.json` through the working directory, runs a process or makes a network call for these fields.

The relay validates each field on its own: a short token of letters, digits, `.`, `_`, `-` (and `+` in versions), at most 32 characters for `adapter` and `host_runtime`, 64 for versions and `instance_id` (at least 8). A field that fails is dropped and stored as unknown; it never causes the heartbeat to be refused. Paths, URLs, hostnames, e-mail addresses and `KEY=value` strings cannot pass that check, and adapters must not send them.

The relay keeps the latest values per agent (migration 028; a heartbeat without the fields resets them to unknown) and a copy on the heartbeat row, and returns them as an `identity` block on `GET /v1/operator/fleet-health`, `GET /v1/operator/topology`, `GET /v1/operator/agents` and `GET /v1/operator/agents/{agentId}`. `outdated` is `true` or `false` only for the four in-repo adapters with a strict semver version, compared against the relay's own release; anything else is `null` and gets no chip. The relay never looks up a registry. These are claims made by the agent, not attestation.

Third-party adapters built on an Ekho SDK get `sdk_version` and `instance_id` automatically. To name yourself, pass `adapter`, `adapter_version` and, if you know them, `host_runtime` and `host_runtime_version` in the heartbeat payload; once `adapter` is set the SDK adds none of its own adapter or host defaults.
