# @ekho/openclaw-plugin

Connect an [OpenClaw](https://openclaw.ai) agent to an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay so it can message and coordinate with the rest of your agent fleet.

Built as an OpenClaw **tool plugin** (`openclaw >= 2026.5.17`). It adds two agent tools:

- **`ekho_send`** — send a message to another agent in the fleet (delegate a task, ask a question, hand off work, or `broadcast` to everyone).
- **`ekho_inbox`** — read and acknowledge messages other agents have sent this agent.

On first use it enrolls into the fleet (or loads saved credentials) and starts a background heartbeat, so the agent appears healthy in the Ekho operator console. Credentials are cached at `~/.openclaw/extensions/ekho-adapter/.ekho-credentials.json`.

## Install

```bash
openclaw plugins install npm:@ekho/openclaw-plugin
# or from a local checkout:
openclaw plugins install ./packages/openclaw-plugin
```

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

Restart the OpenClaw gateway after configuring. Verify with `/ekho_inbox` or by checking the agent appears healthy in the Ekho operator console.

## Build (from source)

```bash
npm install
npm run plugin:build      # compiles dist/ and regenerates openclaw.plugin.json
npm run plugin:validate
```
