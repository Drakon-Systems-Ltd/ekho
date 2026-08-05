# @ekho/hermes-plugin

Connect a [Hermes](https://github.com/) agent to an [Ekho](https://github.com/Drakon-Systems-Ltd/ekho) relay so it can message and coordinate with the rest of your agent fleet — the Hermes counterpart to the OpenClaw `ekho-adapter` plugin.

It's a Hermes **standalone plugin** that adds two agent tools and connects on startup:

- **`ekho_send`** — message another agent in the fleet (delegate, ask, hand off, or `broadcast` to everyone). Optionally attach local files via `attachment_paths`.
- **`ekho_inbox`** — read messages other agents have sent this agent. Operator messages are labelled with their verified trust state, the live fleet **roster** is included, and any attachments are downloaded to a scoped local dir and their paths returned.

On load it enrolls into the fleet (or loads saved credentials) and starts a background heartbeat, so the agent shows **healthy** in the Ekho operator console. Credentials are cached at `~/.hermes/ekho/credentials.json`; downloaded attachments live under `~/.hermes/ekho/attachments/`. All identity (relay URL, fleet, token) comes from environment config — nothing is hardcoded.

## Install

```bash
# 1. Install the Ekho Python SDK into the Hermes agent's venv
<hermes-venv>/bin/python -m pip install ./sdks/python      # or: pip install ekho-sdk

# 2. Drop the plugin into the Hermes plugins dir
cp -R packages/hermes-plugin/ekho_hermes ~/.hermes/plugins/ekho

# 3. Enable it
hermes plugins enable ekho
```

> If the venv was created `--without-pip`, the SDK is pure-Python with a single dependency (`requests`, already present in a Hermes venv) — you can instead copy `sdks/python/ekho` straight into the venv's `site-packages/`.

## Configure

Add to the agent's environment (e.g. `~/.hermes/.env`):

```bash
EKHO_RELAY_URL=https://your-relay.example.ts.net   # required
EKHO_FLEET_ID=flt_xxxxxxxx                          # first run
EKHO_ENROLLMENT_TOKEN=ent_xxx.tok_xxx              # first run (mint from the operator console)
EKHO_DISPLAY_NAME=My Agent                          # optional — shown in the console
# EKHO_AGENT_ID / EKHO_AGENT_SECRET                 # optional — pre-provisioned creds instead of enrolling
# EKHO_HEARTBEAT_INTERVAL=30                        # optional — seconds
# EKHO_PEER_AUTOREPLY=0                             # optional — opt OUT of bounded agent-to-agent delegation (default on)
# EKHO_PEER_TURN_BUDGET=6                           # optional — peer wakes per conversation before the latch closes
```

After the first enrollment the saved credentials are reused and the token can be dropped. Restart the Hermes gateway, then confirm the agent appears healthy in the Ekho operator console.

### Agent-to-agent delegation

By default the agent auto-replies to both its **verified operator** and its
**teammates** — bounded agent-to-agent delegation is **on**. Set
`EKHO_PEER_AUTOREPLY=0` to opt out (teammate messages are then still delivered to
its inbox but don't wake it, so no quota is spent on agent chatter). The operator
console is the live source of truth and overrides this default per agent. It
stays bounded: a teammate may wake the agent at most `EKHO_PEER_TURN_BUDGET`
(default 6) times per conversation before the latch closes (messages still
delivered, just no turn); an **operator** message in that conversation re-opens
it. When a teammate wakes the agent, the prompt also tells it **how many wakes
remain** in that conversation, so it can front-load the work before the latch
auto-pauses. A per-peer rate gate (≤5/peer/min) is a further backstop, and the
prompt tells agents to reply only when it materially advances the work — never
just to acknowledge. A manual `ekho_inbox` read surfaces the remaining budget
(`peer_turn_budget` + per-conversation `peer_remaining`).

The budget caps *chatter*, not *work*, so real handoffs never silently die:

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

## Health check (run after every Hermes update)

A Hermes update that rebuilds the venv removes the installed `ekho` SDK, and
through 0.3.2 the plugin then died at load while staying "enabled" in
metadata — the agent silently dropped off the fleet. Verify after any update
or venv rebuild, with the **Hermes venv's** python:

```bash
python -m ekho_hermes.healthcheck            # verify: SDK real, surface imports, 3 tools register
python -m ekho_hermes.healthcheck --repair   # pip-install the SDK into this venv, then verify
```

Exit 0 = healthy. The check is offline-safe (startup connect is stubbed). The
plugin also self-heals where it can: every successful SDK resolution records
the source tree to `~/.hermes/ekho-state/sdk-path`, which is tried on the next
load if the venv-installed SDK vanishes; `EKHO_SDK_PATH` overrides everything.

## Develop

```bash
cd packages/hermes-plugin
PYTHONPATH=.:../../sdks/python python -m pytest -q
```

Pure logic (message mapping, credential enroll/load, attachment safety) is unit-tested; the Hermes runtime imports are lazy, so the package imports without Hermes present.
