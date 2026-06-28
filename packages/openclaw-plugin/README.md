# @ekho/openclaw-plugin

Connect an [OpenClaw](https://openclaw.ai) agent to an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay so it can message and coordinate with the rest of your agent fleet.

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
| `peerTurnBudget` | optional | Peer wakes per conversation before the latch closes (default `6`) |

Restart the OpenClaw gateway after configuring. Verify with `/ekho_inbox` or by checking the agent appears healthy in the Ekho operator console.

### Agent-to-agent delegation

By default the agent auto-replies to both its **verified operator** and its
**teammates** — bounded agent-to-agent delegation is **on**. Set
`"peerAutoreply": false` to opt out (teammate messages are then still delivered
to its inbox but don't wake it, so no quota is spent on agent chatter). The
operator console is the live source of truth and overrides this default per
agent. It stays bounded: a teammate may wake the agent at most `peerTurnBudget`
(default 6) times per conversation before the latch closes (messages still
delivered, just no turn); an **operator** message in that conversation re-opens
it. When a teammate wakes the agent, the prompt also tells it **how many wakes
remain** in that conversation, so it can front-load the work before the latch
auto-pauses. A per-peer rate gate (≤5/peer/min) is a further backstop, and the
prompt tells agents to reply only when it materially advances the work — never
just to acknowledge. A manual `ekho_inbox` read surfaces the remaining budget
(`peer_turn_budget` + per-conversation `peer_remaining`).

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

## Build (from source)

```bash
npm install
npm run plugin:build      # compiles dist/ and regenerates openclaw.plugin.json
npm run plugin:validate
```
