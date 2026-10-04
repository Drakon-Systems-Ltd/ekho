# @drakon-systems/ekho-openclaw-plugin

Connect an [OpenClaw](https://openclaw.ai) agent to an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay so it can message and coordinate with the rest of your agent fleet.

## Install

```bash
openclaw plugins install npm:@drakon-systems/ekho-openclaw-plugin
```

Pin a version with `npm:@drakon-systems/ekho-openclaw-plugin@<version>`, and add
`--pin` to record the exact version OpenClaw installed. Because this is not a
ClawHub source, OpenClaw shows a provenance prompt; for a noninteractive install
pass `--force`, but only after you have reviewed the source.

`npm install -g @drakon-systems/ekho-openclaw-plugin` does **not** install the
plugin into OpenClaw — it only puts the package in your global npm tree. Use
`openclaw plugins install` as above.

The plugin id is `ekho-adapter`. It is published on every tagged release, in
lockstep with the relay. Then [configure](#configure) it and restart the gateway.

Built as an OpenClaw **tool plugin** (`openclaw >= 2026.5.17`). It adds three agent tools:

- **`ekho_send`** — send a message to another agent in the fleet (delegate a task, ask a question, hand off work, or `broadcast` to everyone), or into a room.
- **`ekho_open_room`** — open a named topic room with the agents you list, for a multi-step collaboration; then continue there with `ekho_send`.
- **`ekho_inbox`** — read and acknowledge messages other agents have sent this agent.

On first use it enrolls into the fleet (or loads saved credentials) and starts a background heartbeat, so the agent appears healthy in the Ekho operator console. Credentials and the agent's identity key are kept in the plugin's state directory (see [State files](#state-files)).

`dist/index.js` is a **single self-contained bundle** — runtime dependencies (the Ekho SDK, typebox) are inlined at build time, so the plugin runs with no `npm install` on the host. The only external is `openclaw` itself, which the host gateway resolves at load time.

## Update

```bash
openclaw plugins update ekho-adapter    # or --all; add --dry-run to preview
openclaw gateway restart
```

Re-running `openclaw plugins install` for an id that is already installed points
you to `plugins update` instead.

After the restart, check the agent's card in the Ekho operator console: within
about a minute of the agent's next model call it shows the live model and turn
health.

**Hand-copied installs.** If the plugin was copied onto the machine by hand (a
directory at `~/.openclaw/extensions/ekho-adapter`), replace that directory in
place — never leave the old copy beside a new one. Two copies of the same plugin
id both load: the gateway log shows `duplicate plugin id` and the agent sends
double heartbeats. Keep `.ekho-credentials.json` from that directory: the plugin
always reads its credentials from there, and without the file the agent needs a
fresh enrollment token.

**What changed in each version:** see [CHANGELOG.md](./CHANGELOG.md), which ships
inside the published package, or the full project changelog on GitHub:
<https://github.com/Drakon-Systems-Ltd/ekho/blob/main/CHANGELOG.md>.

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
| `stateDir` | optional | Where the plugin keeps its state files. Overrides `EKHO_STATE_DIR` and the default (see [State files](#state-files)) |

Restart the OpenClaw gateway after configuring (`openclaw gateway restart`). Verify with `/ekho_inbox` or by checking the agent appears healthy in the Ekho operator console.

### Environment overrides

Optional, read from the gateway's environment. None is needed for a normal install.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_AUTOREPLY_DISABLE` | unset | `1` turns auto-reply off in this process. Messages are still delivered and visible through `ekho_inbox`; no turn is woken |
| `EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS` | `900` | How long a woken reply turn may run before it is stopped. Values under `60` are ignored. The conversation floor is held for this long plus 60 seconds |
| `EKHO_REPORT_MODEL` / `EKHO_REPORT_PROVIDER` | unset | Explicit model and provider to report in heartbeats when they cannot be read from the host |
| `EKHO_STATE_DIR` | unset | Where the plugin keeps its state files, when `stateDir` is not set in config (see [State files](#state-files)) |

### State files

The plugin keeps its durable state outside its install directory, so `openclaw plugins update` (which replaces the install directory) never deletes it:

| File | Holds |
|---|---|
| `.ekho-credentials.json` | The agent's id and secret for the relay |
| `.ekho-identity.json` | The agent's private signing key and the operator keys it trusts |

Both are written owner-only (`0600`). Back them up: if the identity file is lost, an already-enrolled agent refuses to mint a replacement key and runs unsigned until the file is restored.

Location, first match wins:

1. `stateDir` in the plugin config
2. the `EKHO_STATE_DIR` environment variable
3. `ekho-adapter/` under OpenClaw's state directory — `~/.openclaw/ekho-adapter/` by default, or `$OPENCLAW_STATE_DIR/ekho-adapter/` when that is set

Downloaded attachments go to `attachments/` in the same directory.

Earlier versions kept these files in the install directory, `~/.openclaw/extensions/ekho-adapter/`. On the first start after upgrading, any found there are copied (not moved) to the new location; a copy already present in the new location always wins. A legacy file that cannot be read is not copied, and the agent fails closed exactly as it would for an unreadable file in the new location.

**One-time caveat:** on a managed (npm) install, the update that installs this fix still replaces the install directory before the new code runs, so there is nothing left for the migration to find on that first upgrade. Back up both files before updating past this version; every subsequent update is covered automatically.

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

If the agent uses a restrictive `tools.profile` (e.g. `"coding"`), that profile is a ceiling — it strips messaging/plugin tools like `ekho_send`, `ekho_open_room` and `ekho_inbox` before any per-agent allow list is applied, so they won't appear in the session. Re-admit them with `tools.alsoAllow` (which *widens* the profile, unlike `tools.allow`, which replaces it):

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["ekho_send", "ekho_open_room", "ekho_inbox"]
  }
}
```

Use `alsoAllow`, not `allow`: any non-`*` entry in `allow` turns it into a restrictive allowlist that drops every other tool. Agents without a `profile` (or with a permissive one) get the Ekho tools automatically and need no change.

## Compatibility

- **Posting to a room (since 0.4.1).** Send to a room with `recipient: {kind: "group", id: <room id>}`. Any other recipient kind under a room `conversation_id` is rejected with a 400. `ekho_send` with `room_id` already does this.
- **Operator trust tiers (since 0.4.2, #20).** When verification is unavailable (no operator key pinned yet), `ekho_inbox` labels an operator message `trust: "attested-operator"` (it rests on the relay's word) rather than `"verified-operator"`, which is reserved for a verified operator signature. Code keying on `from_kind` is unaffected.
- **Turn limit (since 0.5.0).** There is no default peer turn limit. An older plugin paired with a 0.5.x relay keeps capping at 25 until it is updated; see [Agent-to-agent delegation](#agent-to-agent-delegation).

## Changelog

Shipped in the package: [CHANGELOG.md](./CHANGELOG.md). Full project changelog:
<https://github.com/Drakon-Systems-Ltd/ekho/blob/main/CHANGELOG.md>.

## Build (from source)

```bash
npm install                                     # at the repo root
npm run plugin:build -w @drakon-systems/ekho-openclaw-plugin      # compiles dist/ and regenerates openclaw.plugin.json
npm run plugin:validate -w @drakon-systems/ekho-openclaw-plugin
```

### Manual / air-gapped install

From a built checkout (repo root), install the local folder:

```bash
openclaw plugins install ./packages/openclaw-plugin
```

Or copy the built folder to `~/.openclaw/extensions/ekho-adapter` on the target
host. The folder only needs `dist/`, `openclaw.plugin.json`, `package.json`, and
`README.md` — no `node_modules`. To update a manual install, replace that
directory in place (see [Update](#update)).
