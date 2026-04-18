# Writer / Reviewer — Ekho two-agent example

A runnable, end-to-end demo of two Ekho agents holding a real conversation
through the relay:

- **Writer** drafts a short article ("Why AI Agent Messaging Matters") and
  sends it as a `direct` message to the reviewer.
- **Reviewer** polls its inbox, critiques the draft, and replies with an
  approve/revise verdict.

Both agents use [`@ekho/sdk`](../../packages/sdk) for every runtime
operation (send, inbox polling, ack, heartbeat). The only direct HTTP call
is the one-time `POST /v1/enroll` bootstrap — enrollment is intentionally
not part of the SDK.

## What you'll see

```
────────────────────────────────────────────────────────────────────
  Ekho example: writer  →  reviewer
  A writer agent drafts an article; a reviewer agent critiques it.
────────────────────────────────────────────────────────────────────

[run]      starting reviewer...
[reviewer] enrolled as agt_9c...
[run]      reviewer ready as agt_9c...
[run]      starting writer...
[writer]   enrolled as agt_7b...
[writer]   will review via agt_9c...
[writer]   sending draft "Why AI Agent Messaging Matters" for review...
[reviewer] draft received: "Why AI Agent Messaging Matters" from agt_7b...
[reviewer] verdict: APPROVE — Clear thesis, covers identity and delivery...
[reviewer] review sent. exiting.
[writer]   review received: APPROVE
[writer]   conversation complete. exiting.

Demo complete.
```

The whole thing takes under 30 seconds.

## Prerequisites

1. **A running Ekho relay.** In a separate terminal:

   ```bash
   npm install
   npm run build
   npm run setup      # creates the "default" fleet + first enrollment token
   npm start          # starts the relay on http://localhost:4000
   ```

   `npm run setup` prints your **fleet id** (`flt_...`) and a **first
   enrollment token**. Save both.

2. **A second enrollment token** — each agent consumes one on enroll, so
   you need two. Get a second token via either:

   - **Operator console:** open [http://localhost:4000/ui/](http://localhost:4000/ui/),
     sign in with `admin@example.com` / `changeme123`, then
     **Agents → Enroll Agent**, copy the token.
   - **API:**
     ```bash
     # Log in, then call the enrollment-tokens endpoint:
     curl -X POST http://localhost:4000/v1/operator/enrollment-tokens \
          -H "authorization: Bearer <operator_token>"
     ```

## Running

From the repo root:

```bash
export EKHO_FLEET_ID=flt_...
export EKHO_WRITER_TOKEN=<first token>
export EKHO_REVIEWER_TOKEN=<second token>

npm run example:writer-reviewer
```

The orchestrator (`run.ts`) spawns both agents, wires them together via
IPC so the writer learns the reviewer's agent id, and waits for both to
exit cleanly.

### Pointing at a different relay

```bash
export EKHO_RELAY_URL=http://my-relay.tailnet:4000
```

## Files

| File | Purpose |
|------|---------|
| `run.ts` | Orchestrator — spawns both agents in parallel for a one-shot demo. |
| `writer.ts` | Writer agent — enrolls, sends a draft, waits for feedback. |
| `reviewer.ts` | Reviewer agent — enrolls, receives drafts, replies with a verdict. |
| `shared.ts` | `DraftMessage` / `ReviewMessage` types, demo article, colours. |
| `enroll.ts` | One-shot `POST /v1/enroll` helper (the only raw HTTP call). |
| `package.json` | Local workspace package with an `@ekho/sdk` dependency. |

## Running the agents separately

If you'd rather run each agent in its own terminal (useful for debugging):

```bash
# Terminal 1 — reviewer
EKHO_FLEET_ID=... EKHO_REVIEWER_TOKEN=... npx tsx examples/writer-reviewer/reviewer.ts
# note the agt_... it prints

# Terminal 2 — writer (uses the agent id from Terminal 1)
EKHO_FLEET_ID=... EKHO_WRITER_TOKEN=... EKHO_REVIEWER_AGENT_ID=agt_... \
  npx tsx examples/writer-reviewer/writer.ts
```

## Extending the demo

- Swap the deterministic `critique()` in `reviewer.ts` for a real LLM call.
- Add a `handoff` step: writer proposes an action, operator approves in
  the console, writer sends the draft only once approved.
- Spin up a third agent (e.g. "editor") and chain the handoff —
  `ReviewMessage.verdict === "approve"` triggers the editor to publish.
