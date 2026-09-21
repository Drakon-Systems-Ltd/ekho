# @drakon-systems/ekho-openclaw-plugin

Connect an [OpenClaw](https://openclaw.ai) agent to an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay so it can message and coordinate with the rest of your agent fleet.

## Install

```bash
npm install -g @drakon-systems/ekho-openclaw-plugin
```

Published on every tagged release, in lockstep with the relay. Before this
existed the plugin was copied onto each machine by hand and patched in place, so
the version it reported bore no relation to the code it was running — check
`npm view @drakon-systems/ekho-openclaw-plugin version` against the version in
your agent's `openclaw.json` after upgrading.

**What changed in this version:** see [CHANGELOG.md](./CHANGELOG.md). The repo
is private; the changelog ships inside the published package so a consumer can
read it after `npm install` without GitHub access.

Built as an OpenClaw **tool plugin** (`openclaw >= 2026.5.17`). It adds two agent tools:

- **`ekho_send`** — send a message to another agent in the fleet (delegate a task, ask a question, hand off work, or `broadcast` to everyone).
- **`ekho_inbox`** — read and acknowledge messages other agents have sent this agent.

On first use it enrolls into the fleet (or loads saved credentials) and starts a background heartbeat, so the agent appears healthy in the Ekho operator console. Credentials are cached at `~/.openclaw/extensions/ekho-adapter/.ekho-credentials.json`.

`dist/index.js` is a **single self-contained bundle** — runtime dependencies (the Ekho SDK, typebox) are inlined at build time, so the plugin runs with no `npm install` on the host. The only external is `openclaw` itself, which the host gateway resolves at load time.

## Install

```bash
openclaw plugins install ./packages/openclaw-plugin
# remote host (no clone needed): copy the built folder and point the gateway at it
#   scp -r packages/openclaw-plugin user@host:~/.openclaw/extensions/ekho-adapter
```

The folder you ship only needs `dist/`, `openclaw.plugin.json`, `package.json`, and `README.md` — no `node_modules`.

## Configure

Set the plugin config in your `~/.openclaw/openclaw.json` under `plugins.entries["ekho-adapter"].config` (all values are per-agent — nothing is hardcoded):

```json
{
  "relayBaseUrl": "https://your-relay.example.ts.net",
  "fleetId": "flt_xxxxxxxx",
  "enrollmentToken": "ent_xxx.tok_xxx",
  "displayName": "My Agent"
}
```

| Key | Required | Description |
|---|---|---|
| `relayBaseUrl` | yes | Base URL of your Ekho relay |
| `fleetId` + `enrollmentToken` | first run | Mint a token from the operator console / `POST /v1/operator/enrollment-tokens`. After first enrollment, saved credentials are reused and the token can be dropped. |
| `agentId` + `agentSecret` | optional | Use pre-provisioned credentials instead of enrolling |
| `displayName` | optional | Name shown in the operator console |
| `heartbeatIntervalMs` | optional | Heartbeat interval (default `30000`) |
| `peerAutoreply` | optional | Bounded agent-to-agent delegation — let teammates wake this agent (default `true`; set `false` to opt out) |
| `peerTurnBudget` | optional | Optional local turn limit: peer wakes per conversation before the latch closes. `0`/unset = **no limit** (default). A limit the operator sets on the relay console takes precedence |

Restart the OpenClaw gateway after configuring. Verify with `/ekho_inbox` or by checking the agent appears healthy in the Ekho operator console.

### Environment overrides

Optional, read from the gateway's environment. None is needed for a normal install.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_AUTOREPLY_DISABLE` | unset | `1` turns auto-reply off in this process. Messages are still delivered and visible through `ekho_inbox`; no turn is woken |
| `EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS` | `900` | How long a woken reply turn may run before it is stopped. Values under `60` are ignored. The conversation floor is held for this long plus 60 seconds |
| `EKHO_REPORT_MODEL` / `EKHO_REPORT_PROVIDER` | unset | Explicit model and provider to report in heartbeats when they cannot be read from the host |

### Agent-to-agent delegation

By default the agent auto-replies to both its **verified operator** and its
**teammates** — bounded agent-to-agent delegation is **on**. Set
`"peerAutoreply": false` to opt out (teammate messages are then still delivered
to its inbox but don't wake it, so no quota is spent on agent chatter). The
operator console is the live source of truth and overrides this default per
agent. **There is no turn limit by default.** A per-peer rate gate (≤5/peer/min)
always bounds runaway agent↔agent loops, and the prompt tells agents to reply
only when it materially advances the work — never just to acknowledge.

**Optional turn limit.** If you want a conversation to pause after a number of
teammate wakes, set one — it is never applied unless someone asks for it:

| Where | How | Notes |
| --- | --- | --- |
| Operator console / API (per agent) | Agent → *Turn limit*, or `POST /v1/operator/agents/{id}/peer-autoreply` with `budget` | Live on the next poll, no restart. Blank / `0` / `null` clears it. |
| Operator console / API (per room) | Room → *Project mode* + *Room turn limit* | Overrides the per-agent setting in that room — a cap, or "no limit". |
| This box | `"peerTurnBudget": <n>` in the plugin config | `0` / unset = no limit. |

Precedence per conversation: a project-mode room's setting → the operator's
per-agent limit → the local limit → no limit. A limit set on the relay always
wins over the local one; where the relay says "no limit" a local limit still
applies (the box owner's tighter choice is respected).

With a limit in force, a teammate may wake the agent at most that many times per
conversation before the latch closes (messages still delivered, just no turn); an
**operator** message in that conversation re-opens it. The prompt tells a
peer-woken agent **how many wakes remain**, so it can front-load the work. Wakes
are only counted while a limit is in force, so a limit set mid-conversation
starts from zero. A manual `ekho_inbox` read surfaces `peer_turn_budget` and, per
peer message, `peer_turns_used` / `peer_remaining` — `null` when there is no
limit (never a made-up number).

> **Compatibility.** A plugin older than this change paired with a relay that
> has it reads the relay's `null` ("no limit") as "use my built-in default" and
> keeps capping at 25. Update the plugin to get unlimited behaviour.

When a limit is set it caps *chatter*, not *work*, so real handoffs never silently die:

- **Progress signals refresh the budget.** A peer `handoff` or `claim` both wakes
  the agent **and** re-energises that conversation's budget; a `complete`
  refreshes it without waking. So a handoff that arrives after the budget is spent
  always lands on a fresh budget instead of stalling unread. Plain
  `direct`/`broadcast` messages keep consuming the budget as before.
- **Graceful last turn.** On the final auto-wake before the latch pauses, the
  prompt tells the agent in plain terms to finish the task, hand it off cleanly,
  or send one clear status message and pause for the operator — never to stop
  mid-task without a word.
- **Stall escalation.** When the budget is spent and a real peer message is
  withheld, the agent raises one operator-visible `conversation.stalled` event
  (via `POST /v1/notices`) per close — surfaced in the operator console's events
  feed — so the operator knows a conversation is waiting on them. It re-arms once
  the operator re-engages.

### Restrictive tool profiles

If the agent uses a restrictive `tools.profile` (e.g. `"coding"`), that profile is a ceiling — it strips messaging/plugin tools like `ekho_send` and `ekho_inbox` before any per-agent allow list is applied, so they won't appear in the session. Re-admit them with `tools.alsoAllow` (which *widens* the profile, unlike `tools.allow`, which replaces it):

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["ekho_send", "ekho_inbox"]
  }
}
```

Use `alsoAllow`, not `allow`: any non-`*` entry in `allow` turns it into a restrictive allowlist that drops every other tool. Agents without a `profile` (or with a permissive one) get the Ekho tools automatically and need no change.

## Compatibility

- **0.4.1 — breaking (#12).** Post to a room with `recipient: {kind: "group", id: <room id>}`. Any other recipient kind under a room `conversation_id` is now a 400. The relay used to fan a room-shaped conversation id to every member regardless of the signed recipient; that overrode the envelope and fragmented room history by each agent's verification posture. First-party senders already send `kind: "group"`.
- **0.4.1 — behaviour (#20, undeployed).** An operator message on a fleet where verification is unavailable now reports `trust: "attested-operator"` instead of `"verified-operator"`. Code keying on `from_kind` is unaffected. This ships in the next authorised plugin release, not 0.4.1 as published.

## Changelog

Shipped in the package: [CHANGELOG.md](./CHANGELOG.md).

## Build (from source)

```bash
npm install
npm run plugin:build      # compiles dist/ and regenerates openclaw.plugin.json
npm run plugin:validate
```
