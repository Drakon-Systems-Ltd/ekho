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
lockstep with the relay. Then [configure](#configure) it, enable it and restart
the gateway.

Built as an OpenClaw **tool plugin** (`openclaw >= 2026.5.17`). It adds three agent tools:

- **`ekho_send`** — send a message to another agent in the fleet (delegate a task, ask a question, hand off work, or `broadcast` to everyone), or into a room.
- **`ekho_open_room`** — open a named topic room with the agents you list, for a multi-step collaboration; then continue there with `ekho_send`.
- **`ekho_inbox`** — read and acknowledge messages other agents have sent this agent.

On first use it enrolls into the fleet (or loads saved credentials) and starts a background heartbeat, so the agent appears healthy in the Ekho operator console.

### State files

The plugin keeps two files in `~/.openclaw/extensions/ekho-adapter/`. That path is fixed, whichever directory OpenClaw installed the plugin into:

| File | Holds | If it is lost |
|---|---|---|
| `.ekho-credentials.json` | The enrollment result: agent id, agent secret, relay URL and fleet id. This is how the agent authenticates to the relay. | The agent cannot reconnect as itself and needs a fresh enrollment token (or `agentId` + `agentSecret` in the config). |
| `.ekho-identity.json` | The agent's signing identity and trust state: its private Ed25519 signing seed, the operator keys it pins and why each was admitted, the first-contact (trust-on-first-use) latch, and the ledger of operator keys it has seen revoked. | The plugin silently generates a new signing identity with no pinned keys except any `operatorPubkey` you configured, which it re-applies on connect. The new key needs endorsing again, an agent left with no pins trusts the relay's operator keys afresh on first contact, and it forgets which keys were revoked. |

Keeping only the credentials file is not enough: the agent still reconnects, but with a new identity and none of its trust state. Back up **both** files before any update, reinstall or uninstall.

`dist/index.js` is a **single self-contained bundle** — runtime dependencies (the Ekho SDK, typebox) are inlined at build time, so the plugin runs with no `npm install` on the host. The only external is `openclaw` itself, which the host gateway resolves at load time.

## Update

How you update depends on how the plugin was installed. `openclaw plugins
inspect ekho-adapter` prints the install record; read the `Source:` line under its
**Install** section (a separate top-level `Source` line is the plugin's path):
`npm` is an npm-managed install; `path` is a local-folder install (copied, or
linked with `--link`). A folder copied by hand has no install record.

Run these steps from an interactive shell. In a noninteractive one,
`openclaw gateway stop` refuses unless you add `--force`. If the stop or the
backup fails, do not continue.

### npm-managed installs (recommended)

```bash
# 1. Stop the gateway, so the plugin cannot start without its state files
openclaw gateway stop

# 2. Back up the plugin's state files (see State files above)
mkdir -p ~/ekho-adapter-state
cp -p ~/.openclaw/extensions/ekho-adapter/.ekho-identity.json \
      ~/.openclaw/extensions/ekho-adapter/.ekho-credentials.json ~/ekho-adapter-state/

# 3. Update
openclaw plugins update ekho-adapter    # or --all; add --dry-run to preview

# 4. Check both files are still there; if either is missing, copy it back from ~/ekho-adapter-state/
ls -a ~/.openclaw/extensions/ekho-adapter/

# 5. Start the gateway
openclaw gateway start
```

Current OpenClaw keeps a managed npm install in its own npm project directory,
apart from `~/.openclaw/extensions/ekho-adapter`, so the update does not touch
the state files; the backup is insurance in case your install differs. With the
gateway running, an update also refreshes the gateway itself, and a plugin that
starts without its files creates new ones, which is why the gateway is stopped
first.

Re-running `openclaw plugins install` for an id that is already installed points
you to `plugins update` instead.

**Pinned installs.** If you installed an exact version
(`npm:@drakon-systems/ekho-openclaw-plugin@<version>`) or used `--pin`,
`openclaw plugins update ekho-adapter` keeps that recorded version. To move to
another version, update by package spec instead:

```bash
openclaw plugins update @drakon-systems/ekho-openclaw-plugin@<version>   # a specific version
openclaw plugins update @drakon-systems/ekho-openclaw-plugin             # back to the default release line
```

OpenClaw maps the package back to the installed `ekho-adapter` and records the new
spec, so later `openclaw plugins update ekho-adapter` runs follow it.

### Local-folder and hand-copied installs

`openclaw plugins update` does not update these. It updates only npm,
marketplace, ClawHub and git installs, and skips a local-folder install with
`Skipping "ekho-adapter" (source: path)`, leaving the old build in place. Both
kinds put the plugin itself in `~/.openclaw/extensions/ekho-adapter`, the same
directory that holds the [state files](#state-files), and replacing it replaces
the whole directory. To update:

1. In your Ekho checkout, pull and rebuild: the SDK first, then the plugin (see
   [Build (from source)](#build-from-source)).
2. Stop the gateway (`openclaw gateway stop`).
3. Copy `.ekho-identity.json` and `.ekho-credentials.json` out of the plugin
   discovery tree, for example to `~/ekho-adapter-state/` (not to another folder
   under `~/.openclaw/extensions/`).
4. Install the new build:
   - local-folder install: `openclaw plugins install ./packages/openclaw-plugin --force`
     from the checkout root (`--force` overwrites the existing install);
   - hand-copied install: replace the `ekho-adapter` directory with the new build.
5. Check both files are in `~/.openclaw/extensions/ekho-adapter/`; copy back
   any that are missing from `~/ekho-adapter-state/`.
6. Start the gateway (`openclaw gateway start`).
7. Check the version: `openclaw plugins inspect ekho-adapter`.

A linked install (`openclaw plugins install --link`) loads the plugin from your
checkout rather than a copy, so updating it is rebuilding the checkout and
restarting the gateway; the state files stay in
`~/.openclaw/extensions/ekho-adapter/`.

Never leave an old copy of the plugin (a backup folder, say) under
`~/.openclaw/extensions/`. OpenClaw discovers it as a second plugin with the same
id, loads only one of them and disables the other ("overridden by …"), and the
copy that wins may be the stale one.

After the gateway starts, check the agent's card in the Ekho operator console:
within about a minute of the agent's next model call it shows the live model and
turn health.

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

Then enable the plugin and restart the gateway:

```bash
openclaw plugins enable ekho-adapter
openclaw gateway restart
```

On a fresh install the enable step is needed: when a newly installed plugin's
required config (here `relayBaseUrl`) is missing, OpenClaw records the install
as disabled. Verify with `/ekho_inbox` or by checking the agent appears healthy
in the Ekho operator console.

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
npm run build -w @drakon-systems/ekho-sdk       # the plugin bundles the SDK's built output
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
`README.md` — no `node_modules`. To update either kind of manual install,
follow [Local-folder and hand-copied installs](#local-folder-and-hand-copied-installs),
keeping both state files.
