# #155: Reply latency. Tell delivery apart from floor and busy-turn waiting, and isolate independent direct work

- **Issue:** Drakon-Systems-Ltd/ekho#155
- **Date:** 2026-11-01. **Base:** `origin/main` 0a2ebe8 (v0.7.5)
- **Revision:** round 3, folding review round 2. Round 2 covered covering-turn
  absorption (§4.3), mixed-version lane conflicts (§4.2), attempt-aware turn
  records (§2.4) and the honest "turn sent output" wording (§3.3). Round 3 adds
  a rollback that keeps live pair leases (§4.2 (e)), merging of slices that
  collapse onto one floor key (§4.2 adapters), the Python inbox model in
  Phase 6a, a validated floor holder in phase reports (§2.2), the reason for
  the attempt cap (§2.4), and a plainer I7 (§4.1).
- **This pass:** a design doc plus deterministic characterisation tests. It
  changes **no product behaviour**: nothing under `packages/*/src` or
  `packages/hermes-plugin/ekho_hermes`, no version bump, no CHANGELOG entry.
- **Characterisation tests added in this pass** (they pin today's behaviour, and
  §6 lists which ones later PRs flip or extend):
  - `packages/relay/tests/reply-latency-characterisation.test.ts`
  - `packages/openclaw-plugin/tests/reply-latency-characterisation.test.ts`
  - `packages/hermes-plugin/tests/test_issue155_reply_latency.py`

All line references are to the tree at 0a2ebe8.

**Delivery status (updated as phases land):**

- **Phase 1a shipped, reduced scope.** `agents.last_inbox_poll_at` and
  `message_deliveries.ack_recorded_at` (§2.2, relay-observed rows), migration
  `025_delivery_phases.sql`, additive read-back on `/v1/messages/:id/status`
  and `/v1/operator/fleet-health`, tests in
  `packages/relay/tests/delivery-phases.test.ts`. The delivery summary
  columns, `delivery_turn_attempts` and `agent_turn_replies` (§2.4) were
  **not** created in 1a: nothing writes them until `POST /v1/delivery-phases`
  exists, so they move to Phase 1b and land together with their writers and
  the R1–R4 tests. `fetch_wait` (§2.3) also waits for 1b, because without
  retained turn intervals every slow fetch would read `inbox_stalled`, which
  mislabels a busy adapter.

---

## 0. Summary

The perceived "slow replies" are at least four different waits, and today the
operator sees none of them as distinct states:

1. **Transport.** Relay queue to adapter fetch. Measured live at 0.8–2.8 s. Not
   the problem.
2. **Floor wait.** A peer-triggered turn defers because another agent holds the
   *conversation's* floor. The floor covers the whole conversation, so unrelated
   1:1 work that reuses an operator broadcast's conversation id queues behind
   whoever holds it.
3. **Busy adapter.** Each adapter runs one turn at a time and does not poll while
   that turn runs, so new messages stay `queued` at the relay for the whole turn.
   At the relay this looks exactly like a dead inbox.
4. **Agent work.** Runtime start, model calls, tools. The Hermes example in the
   issue spent about 78 s between poll and first reply, almost all of it here.

Meanwhile the relay's last recorded state is `acked`, which the adapters send
*before* the turn. The console renders that as "Acknowledged" / "read by N", and
nothing anywhere records that a message was **answered**.

**Recommendation (§4.7):** Option A, the *audience-scoped floor*. A peer-triggered
turn whose reply goes to a single peer (a 1:1-addressed message on a
non-room conversation) contends on a **pair lane** of the conversation, not on the
conversation-wide floor. Room and broadcast turn-taking stay exactly as they are:
a conversation-wide lease and a pair lane on the same conversation exclude each
other, so old and new adapters sharing one relay still take turns (§4.2). Every
peer turn still takes a floor. A covering turn absorbs only the stashes whose
exact floor it holds (§4.3). No signed field changes. A new adapter on an old
relay degrades to today's floor scope (§4.1 I7). Instrumentation (§2) and honest console
states (§3) ship first, so the improvement can be measured (§5).

---

## 1. Current-state map (a)

### 1.1 Lifecycle phases: where each is decided or recorded, and whether it is observable today

| Phase | Decided / recorded where | Observable today? |
|---|---|---|
| **Queued** | `message_deliveries` row with `status='queued'`, `queued_at`. Written by `createMessage` (agent sends, `packages/relay/src/db.ts:1405`) and `createOperatorMessage` (`db.ts:1614`). Broadcast fan-out goes to every active agent (`db.ts:1745-1746`). | **Yes, at the relay** (`getSentMessageStatus`, `db.ts:2353-2397`). Not per agent in the console. The console's `received_1h` counts delivery rows by `queued_at` (`db.ts:2933-2935`), so a message the agent never fetched still counts as "recv" (`packages/relay/frontend/src/App.jsx:1454`). |
| **Fetched** ("delivered") | `getInbox` selects `queued` rows (`db.ts:1939-1951`), sets `status='delivered'`, `delivered_at` (`db.ts:1953`) and records a `message.delivered` event (`db.ts:1964`). Adapter side: Hermes `client.get_inbox()` (`packages/hermes-plugin/ekho_hermes/autoreply.py:1890`); OpenClaw `client.getInbox()` (`packages/openclaw-plugin/src/autoreply.ts:2311`). | **Yes** (`delivered_at`, event). The relay records **no per-agent "last poll" time**, so "this agent stopped polling" can only be inferred from the age of queued rows, and nothing does that. |
| **Acked** | Adapters ack the **whole batch BEFORE any turn**: Hermes builds `ack_all` (`autoreply.py:1896-1900`) and calls `_ack()` before spawning (`autoreply.py:2375-2377`); OpenClaw does the same (`autoreply.ts:2596-2606`). Relay `ackMessages` sets `acked_at` **from the adapter-supplied `received_at`** (adapter clock, `db.ts:2527`), and marks the message `acked` once every recipient has (`db.ts:2532-2538`). The ack schema only allows `status: "received"` (`packages/relay/src/types.ts:28-34`). | **Yes**, but it is **misread**. The console shows it as "Acknowledged" / "read by N" (`App.jsx:780-785`, from `consoleState.js:1360-1368`) and the CommandDeck as "ACK … acknowledged a message" (`CommandDeck.jsx:115`). An ack means "received". The relay has no state after `acked`. |
| **Waiting on floor** | Adapter only. `plan_floor_turn` (`autoreply.py:1805-1857`) / `planFloorTurn` (`autoreply.ts:1894-1937`) call `POST /v1/conversations/:id/floor` (`packages/relay/src/routes-agent.ts:329-348`), which uses `db.acquireFloor` (`db.ts:2240-2259`). A refused conversation is stashed in memory (`deferred_by_conversation`, `autoreply.py:484-494`; `deferredByConversation`, `autoreply.ts:770-774`) and retried on later ticks (`autoreply.py:2092-2179`; `serviceDeferredTurn`, `autoreply.ts:2099`) until `DEFERRED_RETRY_TTL` (`autoreply.py:141-154`; `autoreply.ts:247-260`). After that it is delivered late without the floor (`autoreply.py:2181-2260`). | **Adapter log line only** ("floor for X held by Y; deferring", `autoreply.py:1843-1847`, `autoreply.ts:1935`). The relay keeps the *current* holder (the `conversation_floors` table) but no record of who waited or for how long. The console has no floor concept: the only "floor" strings in `frontend/src` are a radar graphic (`CommandDeck.jsx:82-89`) and a pagination variable (`consoleState.js:639-643`). |
| **Waiting on active turn** (busy adapter) | Adapter only, and **implicit**. Hermes: `process_inbox_once` returns at once if `state.in_flight` (`autoreply.py:1885-1886`). In production the loop thread is in fact blocked inside the spawn: `_default_spawn` waits for the one-shot child to exit (`proc.communicate(timeout=TURN_TIMEOUT_S)`, `autoreply.py:1734`), and the loop is a single thread calling the tick serially (`autoreply.py:2521-2541`). OpenClaw: `triggerTurn` awaits the child's `exit` (`autoreply.ts:2141-2181`). The tick awaits `triggerTurn` (`autoreply.ts:2670`), and the interval skips while `tickRunning` (`autoreply.ts:2729`, `2743-2750`). | **No.** The adapter does not poll during a turn, so the waiting messages stay **`queued`** at the relay. That looks identical to an unresponsive inbox. Heartbeats keep flowing because they run on an independent thread/timer (Hermes `_heartbeat_loop`, `packages/hermes-plugin/ekho_hermes/connection.py:193-201`; OpenClaw `maybeStartHeartbeat`, `packages/openclaw-plugin/src/connection.ts:580-603`). Both send a hardcoded `status: "healthy"` (`connection.py:197`, `connection.ts:600`). |
| **Turn started** | Adapter: `state.in_flight = True` then `trigger_turn` (`autoreply.py:2431-2448`), logged as "waking agent to handle N message(s)" (`autoreply.py:1799-1801`); OpenClaw `state.inFlight = true` / `triggerTurn` (`autoreply.ts:2663-2681`). | **Adapter log only.** Nothing is sent to the relay. |
| **First reply sent** | Inside the spawned child: the agent calls `ekho_send`, which sends `POST /v1/messages` (`routes-agent.ts:120-201`) to `createMessage`. When an agent replies to the operator, the relay re-threads the reply into the sender's canonical DM (`db.ts:1439-1447`). | **Only indirectly.** The reply is an ordinary message. Nothing links it to the delivery it answers. Conversation matching is unreliable because of the DM re-threading, and replies carry no reply-to marker for the inbound. |
| **Completed / error** | Adapter: Hermes `_default_spawn` classifies the exit as `completed` / `error(exit_N|timeout)` (`autoreply.py:1735-1755`). OpenClaw classifies `exit` / `error` / timer (`autoreply.ts:2150-2178`). Both fold this into a 1 h rolling turn-health window (`_note_turn_outcome`, `autoreply.py:1697-1708`; `createTurnOutcomeReporter`, `autoreply.ts:690`). | **Aggregate only.** `metrics.turn_health` / `model_errors_1h` on the heartbeat feed `deriveAgentHealth` (`packages/relay/src/fleet-health.ts:51-80`). Nothing is recorded per delivery. Relay dead-letters only cover `delivered`-but-never-acked rows (`sweepRetryDeliveries`, `db.ts:3754-3801` → `moveToDeadLetter`, `db.ts:3803-3830`). Queued rows that are never fetched just **expire** with no dead letter (`sweepExpiredMessages`, `db.ts:3975-4001`; acknowledged in the status read-back, `db.ts:2381-2383`). Adapter-side dead letters (stash eviction, spawn failure) are a local JSONL file (`autoreply.py:1110-1176`), invisible to the relay. |

### 1.2 Why a direct that shares a broadcast conversation id serialises behind that conversation's floor

The mechanism, step by step:

1. **The broadcast mints one shared conversation.** An operator broadcast with no
   explicit id gets `op-<ms>-<rand>` (`db.ts:1670-1681`) and fans out to every
   active agent (`db.ts:1745-1746`).
2. **Operator-only turns take no floor.** Each recipient wakes immediately (§1.3).
3. **The id spreads into peer traffic.** Both prompts tell the agent to reply with
   the exact conversation id it was given: Hermes `conversation_id="…"`
   (`autoreply.py:1609-1613`); OpenClaw the same (`autoreply.ts:1843`), restated
   as "the exact recipient_agent_id and conversation_id shown"
   (`autoreply.ts:1863`). `ekho_send` honours an explicit id and only mints a
   fresh one when none is passed (OpenClaw `packages/openclaw-plugin/src/index.ts:161`;
   Hermes `packages/hermes-plugin/ekho_hermes/messages.py:153`). So when agent A,
   working on the broadcast, asks agent B a *direct* question, it naturally reuses
   the `op-…` id.
4. **The relay stores that id unchanged.** A peer direct keeps its
   `conversation_id` (`db.ts:1447`). The id is also inside the **signed
   canonical** (§1.6), so nothing downstream may change it.
5. **B's turn is peer-triggered, so B contends for the floor.** `plan_floor_turn`
   only skips the floor when the slice has no peer message (`autoreply.py:1828`;
   `autoreply.ts:1922`). B acquires (`autoreply.py:2384-2386`; `autoreply.ts:2618`).
6. **There is one floor per conversation.** `acquireFloor` grants only when the
   conversation's floor is free, expired or already the caller's
   (`db.ts:2240-2259`). So **every** peer-triggered turn in the fleet that
   touches `op-…` competes for **one** floor, whoever it is talking to.
7. **The holder keeps the floor for its whole turn.** The adapter acquires before
   the spawn and releases only in the `finally` after the spawn returns (Hermes
   `autoreply.py:2466-2474`; OpenClaw `autoreply.ts:2712-2718`). It asks for
   `FLOOR_TTL_SECONDS = TURN_TIMEOUT + 60` = 960 s at defaults
   (`autoreply.py:138`; `autoreply.ts:239`), and the relay clamps that to
   `floorTtlMaxSeconds` = 600 s (`routes-agent.ts:338-339`;
   `packages/relay/src/config.ts:76-77`). Every live floor row therefore shows a
   **ten-minute lease**, whatever the real turn length. The lease is an upper
   bound. The actual wait is the holder's turn: runtime start plus model plus
   tools, roughly a minute in the live reports.
8. **Everyone else defers and polls the floor.** Agent D, given an *unrelated*
   direct on `op-…`, is refused and stashed. It retries once per poll tick (5 s
   default; `autoreply.py:168`; `autoreply.ts:2219`), at most one deferred turn
   per tick (`autoreply.py:2262-2268`). Its message is already **acked**, so the
   relay and console say "received/read" while D is waiting on B's unrelated turn.
9. **Worst case.** If the floor never frees, D runs late *without* the floor after
   `DEFERRED_RETRY_TTL = FLOOR_TTL + 120 s` (1080 s at defaults,
   `autoreply.py:153-154`; `autoreply.ts:259-260`). Nothing is dropped, but the
   operator waits up to about 18 min.

Pinned by `relay …characterisation.test.ts` ("delivers and acks a direct on a
floor-held broadcast conversation…"), the Hermes tests
`test_direct_on_a_held_floor_…_155`, `test_independent_recipients_sharing_one_conversation_id_…_155`
and the OpenClaw test "a direct on a conversation whose floor another agent holds…".

### 1.3 Where operator-only turns bypass the floor, and where they don't

- **Bypass.** In both adapters, a conversation slice made up only of operator
  messages skips the acquire entirely (`autoreply.py:1823-1831`;
  `autoreply.ts:1917-1925`), so every addressed member replies independently.
  Pinned: `test_operator_only_messages_bypass_the_floor_…_155`,
  `test_operator_broadcast_wakes_at_once_while_a_peer_holds_its_floor_…_155`, and
  the OpenClaw "operator-only messages bypass the floor…".
- **Exception: a mixed slice.** If one poll batch carries an operator message
  *and* a peer message on the **same** conversation, the slice contends as a
  whole, and a refused floor defers the **operator's message too**
  (`deferred[conv] = msgs`, `autoreply.py:1842`; `autoreply.ts:1936`). Pinned by
  the "mixed batch … same conversation" tests in both adapters.
- **Inconsistency, and a turn-taking bypass that exists today.** If the same
  operator message arrives one tick *later*, it bypasses the floor, and the
  covering-turn rule (`merge_covered_stashes`, `autoreply.py:719-760`, called at
  `autoreply.py:2418`; `mergeCoveredStashes`, `autoreply.ts:1051-1061`, called at
  `autoreply.ts:2649`) delivers the stashed peer message inside the operator's
  turn. The merge picks stashes by conversation id, not by the floor the turn
  holds, so **the agent replies to that peer while another agent still holds the
  floor.** That is a bypass of peer turn-taking in v0.7.5, introduced by the #78
  covering-turn fix (which stopped the stash from being dropped). The upstream
  #78 test `test_autoreply.py::test_tick_covering_turn_delivers_the_stash_instead_of_clearing_it`
  pins it as intended. The #155 tests pin it as a characterisation:
  `test_operator_turn_absorbs_a_peer_message_stashed_behind_another_agents_floor_…_155`
  and the OpenClaw "an operator turn absorbs a peer message stashed behind
  agent_c's floor…". Whether the operator waits also depends on poll timing.
  §4.3 fixes both: the operator never waits, and the peer message never rides
  past a floor this agent does not hold.
- Slices on **different** conversations split cleanly, because only the peer
  slice waits (pinned: "mixed batch across conversations").

### 1.4 A busy adapter is a different wait from floor waiting

The issue warns against conflating them, and the code keeps them separate:

- **Floor wait.** The adapter **has** fetched and acked the message and is
  polling normally. The message sits in its in-memory stash. Relay: `acked`.
- **Busy wait.** The adapter has **not** fetched the message. Its single loop is
  inside a turn. Relay: `queued`. Floor waiting never happens to an operator-only
  slice. Busy waiting happens to everything, operator messages included.

Pinned: Hermes
`test_busy_adapter_tick_neither_fetches_nor_acks_while_in_flight_…_155` and
`test_busy_adapter_message_arriving_mid_turn_waits_for_the_whole_turn_…_155`;
OpenClaw "does not poll the relay at all while a turn runs…".

### 1.5 Why heartbeat health is not evidence the inbox is responsive

`deriveAgentHealth` combines connection liveness (status + heartbeat age ≤ 3
min, `fleet-health.ts:36`, `fleet-health.ts:62-68`) with model turn-health
(`fleet-health.ts:70-79`). It never looks at the inbox. A process whose heartbeat
thread is alive but whose poll loop is wedged, or which is simply mid-turn, reads
`ok` / "connected (no turn data yet)". Pinned: relay "reports an inbox that
heartbeats but never fetches as healthy". This matches the live observation of a
heartbeat-healthy recipient still `queued`.

Both adapters' heartbeats also omit `active_conversation_ids`
(`connection.py:197`, `connection.ts:600`), so the console's "N active"
(`App.jsx:1431`, `1457`) is always 0 for them. Heartbeat `status: "busy"` exists
in the schema (`types.ts:46-50`), but **must not** be used for turn state: any
status other than `healthy` sets the agent to `degraded` (`db.ts:2559`).

### 1.6 What any design must not touch (read-only map of signing and verification)

- **Signed fields.** Agent v2 canonical: `v, fleet_id, sender_agent_id, key_id,
  recipient, conversation_id, body_sha256, sent_at, nonce, message_type,
  priority, attachments` (`packages/sdk/src/identity/verification.ts:545-558`;
  Hermes mirror `ekho_hermes/verification.py:224-237`; OpenClaw re-exports the
  SDK in `src/verification.ts`). Operator v1 canonical: `v, fleet_id,
  operator_id, key_id, recipient, conversation_id, body_sha256, sent_at, nonce`
  (`packages/relay/frontend/src/operatorKey.js:71-83`).
  **`conversation_id` and `recipient` are signed.** `metadata` is not.
- **Verifier.** `verifyInbound` checks the signature over the whole canonical
  (`packages/sdk/src/identity/verify.ts:94`), then binds key/fleet/sender/
  recipient/body, plus type/priority/attachments for v2 (`verify.ts:98-119`).
- **The relay relays signatures verbatim.** Agent: `routes-agent.ts:144-147`,
  plus a nonce claim at ingest (`routes-agent.ts:155-174`). Operator:
  `db.ts:1614-1644` refuses unknown or revoked keys.
- **Trust generation (OpenClaw).** `verificationGeneration`
  (`autoreply.ts:328-331`). Stash entries carry the generation they were checked
  under, and a passing verdict from another generation is dropped
  (`entryVerdict`, `autoreply.ts:820`). Hermes has no equivalent (see §9).

The rule every option in §4 follows: **floor scope, phase records and console
state are derived local metadata. No option changes any of the fields above, on
the relay or on an adapter, after signing.**

---

## 2. Phase timing instrumentation (b)

### 2.1 Principles

1. **Received is never answered.** `acked` keeps meaning "received". The only
   reply signal is `first_reply_at`: the relay saw the turn that covered the
   delivery send *something* (§2.4). That send may be a delegation to another
   teammate rather than an answer, so until open question 5 (§9) is decided it
   is labelled **"turn sent output"**, never "answered". "Completed" comes only
   from an adapter-reported turn outcome.
2. **Relay clock for transport, adapter clock labelled as such.** Each
   adapter-reported timestamp is stored next to the relay's own receive time.
3. **Ids and timestamps only.** No body, prompt, stderr, token, key, signature
   or path ever enters a phase record.
4. **Bounded.** Fixed-width summary columns on rows that already exist, plus
   two small capped tables for turn attempts and turn replies (§2.4). Every
   field is set at most once per attempt. No new per-message event stream.
5. **Never break the tick.** Reporting is best-effort, feature-detected, and
   dropped on the first 404 (older relay), like `raise_notice`
   (`autoreply.py:2331-2351`).

### 2.2 Fields

**Relay-observed (no adapter trust needed):**

| Field | Table | Set by | Meaning |
|---|---|---|---|
| `queued_at` | `message_deliveries` | exists | relay queued it |
| `delivered_at` | `message_deliveries` | exists (`db.ts:1953`) | the adapter **fetched** it. Documented as "fetched". The column is not renamed (wire compatibility). |
| `ack_recorded_at` (new) | `message_deliveries` | `ackMessages` | **relay** time the ack arrived. Today's `acked_at` is adapter-supplied (`db.ts:2527`) and stays. |
| `last_inbox_poll_at` (new) | `agents` | `getInbox` (`db.ts:1939`) | relay time of the agent's most recent `GET /v1/inbox`, written even when the batch is empty. **The key signal for an unresponsive inbox.** |
| `fetch_wait` | derived at query time, not stored | measurement queries and console (§2.3) | `prompt` (`delivered_at − queued_at ≤ inboxStaleSeconds`), `adapter_busy` (gap overlapped by a retained turn interval of this agent, §2.3), or `inbox_stalled` (any other gap). **Approximate**, see §2.3 |
| `first_reply_at`, `first_reply_turn_id` (new) | `message_deliveries` | `createMessage` or a later `turn_started` report (§2.4) | relay time of the earliest send by the recipient from **any** turn attempt that covered this delivery, and which attempt it was. Labelled "turn sent output" (§2.1) |

**Adapter-reported** through a new `POST /v1/delivery-phases`. Body:
`{ phases: [{ message_id, phase, at, turn_id?, attempt?, outcome?, category?, holder_agent_id? }] }`.
`turn_id` and `attempt` are required for `turn_started` and `turn_ended`.
`holder_agent_id` is required for `floor_wait` and rejected on every other
phase. The adapter copies it from the refusal's `holder_agent_id`
(`routes-agent.ts:344`). It is validated like `message_id` (§2.5), and the
relay stores it only if it names an agent in the caller's own fleet. Any other
value is stored as null and counted on the agent, and the response is the same
either way. The console labels it adapter-reported.
Relay-side derivation was considered and rejected. The phase record does not
carry the lane, and the report lands at least one tick after the refusal (§2.5
flushes once per tick, later if the ring is backed up). By then the holder may
have released, or another agent may hold the floor. A holder read from the
floor table at report time would be wrong in exactly the cases worth showing.
At most 100 entries, strict zod, and each update touches **only the caller's own
delivery row** (`WHERE message_id = ? AND recipient_agent_id = <auth agent>`,
the same scoping as `ackMessages`, `db.ts:2521-2527`):

| `phase` | What it writes | Emitted where |
|---|---|---|
| `floor_wait` | delivery `floor_wait_started_at`, `floor_holder_agent_id` from the validated `holder_agent_id` (first write wins) | when `plan_floor_turn` defers (`autoreply.py:1840-1847`; `autoreply.ts:1934-1936`) |
| `floor_granted` | delivery `floor_granted_at` (first write wins) | deferred retry granted (`autoreply.py:2113-2116`), or first-try grant |
| `floor_overrun` | delivery `floor_overrun_at` (first write wins) | late, floorless delivery (`autoreply.py:2181-2260`) |
| `turn_started` | an **attempt row** `(delivery, turn_id)`: `attempt`, `started_at`; then the delivery summary under §2.4 rule R1 | just before each spawn attempt (`autoreply.py:2431`; `autoreply.ts:2663`) for every message that attempt covers, held-back ones included |
| `turn_ended` | that attempt row's `ended_at`, `outcome` ∈ {`completed`,`error`,`timeout`,`spawn_failed`}, `category` ∈ a fixed enum (`exit_<n>`, `timeout`, `spawn_error`, `spawn_error_retained`); then the summary under R1 | after the spawn returns or raises (`autoreply.py:1735-1755`, `2455-2465`; `autoreply.ts:2161-2178`, `2690-2711`). `spawn_error_retained` means the message is still stashed and will get another attempt |
| `dead_lettered` | delivery `adapter_dead_lettered_at`, `adapter_dead_letter_reason` = one of the existing `DEFERRED_*_REASON` constants (`autoreply.py:160-163`; `autoreply.ts:266-275`), first write wins. Separate from the relay's own `dead_lettered_at`/`dead_letter_reason`, and outside the attempt rows, so it never reorders them (R1). Terminal: no later attempt follows | wherever the adapter already dead-letters acked work |

The relay stamps `phase_recorded_at` (relay clock) on every write. An `at` more
than 24 h from relay time is clamped and flagged, never trusted for ordering.
Ordering between attempts comes from `attempt`, never from `at` or arrival
order (§2.4).

**Adapter heartbeat metrics** (string-valued like the existing
`turn_health`). They travel on the independent heartbeat thread/timer, so they
are live **during** a turn:

- `adapter_state` ∈ {`idle`, `turn_running`, `floor_waiting`}
- `turn_started_at`, `turn_deadline_at` (= start + `TURN_TIMEOUT`)
- `deferred_conversations` (count)
- `last_poll_at` (adapter clock, diagnostic only; the relay's
  `last_inbox_poll_at` is authoritative)

### 2.3 Classifying "waiting on active turn" without fetching

The busy wait happens *before* the fetch (§1.4), so the adapter cannot attach
it to a message it has not seen. The relay derives it instead, and **not** from
the latest heartbeat at fetch time. An idle heartbeat sent between the end of a
turn and the next fetch would erase the evidence of the busy interval.

- **Source: retained turn intervals.** The agent's own turn-attempt rows (§2.4)
  are its turn history: `[started_at, ended_at]` per attempt. A row with no
  `ended_at` is capped at `started_at + TURN_TIMEOUT`. They live as long as the
  delivery rows they hang off (§2.5).
- **Rule, evaluated at query time.** A fetch gap `[queued_at, delivered_at]`
  longer than `inboxStaleSeconds` is `adapter_busy` when retained intervals of
  the same agent cover at least 80 % of it, and `inbox_stalled` otherwise.
  Nothing is frozen at fetch, so a late `turn_ended` report still reclassifies
  the gap.
- **Approximate, and labelled so.** Intervals are adapter-clock. They are
  mapped to relay time with a per-agent offset: the heartbeat's adapter-clock
  `last_poll_at` against the relay's `last_inbox_poll_at` for the same poll.
  Dropped phase reports (§2.5 ring overflow) make busy time look like
  stalls. So the console and the §5 report show W and S as approximate
  (± offset error, ± one poll interval), and W is a lower bound.
- The live heartbeat `adapter_state` is still used, but only for the *current*
  state ("working now", §3.1), never for history.

### 2.4 Turn attempts, and linking a reply to the delivery it covered

**Attempts.** One delivery can be covered by several spawn attempts. A covering
turn that fails to spawn keeps its stash (`autoreply.py:2455-2465`;
`autoreply.ts:2690-2711`), and a later floor retry, covering turn or overrun
delivery spawns it again. So the adapter mints a **fresh** random 128-bit hex
`turn_id` for every spawn attempt, never per delivery. It numbers the
attempts per message: `attempt` = 1 for a fresh message, and a stash entry
carries its attempt count forward. The stash is in memory, so an adapter
restart never continues an earlier process's attempts.

**Turn id to child.** The adapter hands `turn_id` to the child in the
environment, next to the existing `EKHO_AUTOREPLY_DISABLE` (`autoreply.py:1798`;
`autoreply.ts:2153`). `ekho_send` stamps it into **unsigned**
`metadata.turn_id`, just as #17 stamps `origin_session_id`
(`packages/openclaw-plugin/src/origin.ts`). `metadata` is outside both
canonicals (§1.6), so no signed field changes.

**Relay storage.**
- `delivery_turn_attempts`, keyed `(message_id, recipient_agent_id, turn_id)`:
  `attempt`, `started_at`, `ended_at`, `outcome`, `category`,
  `phase_recorded_at`. At most 8 rows per delivery. The cap bounds storage,
  not retries, and `DEFERRED_RETRY_TTL` does not justify it: at defaults
  that TTL allows about 216 ticks. The adapter spawns at most one turn per
  tick (one loop thread, blocked in the spawn, §1.1), so a retained stash
  gains at most one attempt per 5 s poll. Eight rows hold the first attempt
  plus seven per-tick retries, about 35 s. That covers a transient spawn
  failure and its recovery, which is the case R4 exists for. A failure that
  lasts longer already shows in `turn_health` / `model_errors_1h`. The
  adapter keeps retrying exactly as today. Only the record stops. A ninth
  report is refused, counted on the agent, and sets the delivery's
  `attempts_capped` flag. The console then shows the latest attempt as
  "unknown", not as attempt 8's outcome. A reply from an unrecorded attempt
  has no attempt row to join (R2), so `first_reply_at` stays null, which
  also shows as "unknown", never "no output".
- `agent_turn_replies`, keyed `(fleet_id, agent_id, turn_id)`: `first_reply_at`
  (relay clock). `createMessage` inserts it on the first message whose sender is
  `agent_id` and whose `metadata.turn_id` is `turn_id`, and never updates it.
  That is at most one row per turn that sent anything. It is pruned with
  heartbeats (`db.ts:4078-4157`).
- Delivery summary columns, which the console reads: `turn_attempts`,
  `latest_attempt`, `latest_turn_id`, `latest_turn_started_at`,
  `latest_turn_outcome`, `latest_turn_category`, `attempts_capped`,
  `first_reply_at`, `first_reply_turn_id`, plus `adapter_dead_lettered_at` /
  `adapter_dead_letter_reason`.

**Reconciliation rules.** Every rule is idempotent and gives the same result
whatever order the reports and replies arrive in:

- **R1. The highest attempt owns the summary.** A `turn_started`/`turn_ended`
  report always fills its own attempt row (first write wins per column, so a
  retransmitted report changes nothing). It updates the `latest_*` summary only
  when its `attempt ≥ latest_attempt`. A **delayed outcome from an earlier
  attempt** arrives after a later attempt has started (for example T1's
  `spawn_failed` after T2's `turn_started`). It fills T1's row and leaves the
  summary on T2.
- **R2. The reply join is symmetric.** When `createMessage` records
  `(sender, T)` in `agent_turn_replies`, it sets `first_reply_at` on every
  delivery of that sender that has an attempt row for `T`. When a
  `turn_started` for `(delivery, T)` arrives **after** its reply, the relay
  looks up `agent_turn_replies(recipient, T)` and fills `first_reply_at` then.
  This is the normal order in both adapters, not an edge case. The tick is
  blocked until the child exits (§1.1), and reports flush once per tick (§2.5),
  so the child's replies reach the relay before the `turn_started` report
  does. No flush is added on the spawn path. R2 makes the order irrelevant.
- **R3. Earliest reply wins, and a reply is never undone.** `first_reply_at` is
  the minimum over the delivery's attempts, and `first_reply_turn_id` names that
  attempt. A later attempt's `error`, `timeout`, `spawn_failed` or
  `dead_lettered` never clears it.
- **R4. Failed spawn, then a successful retry.** T1 fails to spawn and is
  reported `spawn_failed` / `spawn_error_retained`. A later attempt T2 (attempt
  2) starts and sends. By R1 the summary moves to T2, and by R2 T2's reply sets
  `first_reply_at`. The T1 row stays as history. The delivery is never stuck on
  T1's id. A `spawn_failed` with plain `spawn_error` (the message is not
  stashed) or a `dead_lettered` is terminal.

**Scoping.** Every join is restricted to the reply sender's **own** deliveries
(`recipient_agent_id = sender`), so a sender cannot mark anyone else's delivery.
Because the join does not match on conversation, it also works when the relay
re-threads an operator reply into the DM (`db.ts:1439-1447`). A report or reply
that never arrives (ring overflow, old adapter) leaves `turn_attempts = 0` or
`first_reply_at` null. The console renders that as "unknown", never as "no
output".

### 2.5 Storage, retention and bounds

- **Columns first, events never.** About 15 nullable columns on
  `message_deliveries` and 1 on `agents`. Per-attempt detail goes in
  `delivery_turn_attempts` (≤ 8 rows per delivery, and 1 in the normal case).
  Reply observations go in `agent_turn_replies` (≤ 1 row per turn that sent
  anything). Phase events are **not** written to `events`, which already grows
  three times faster than messages (`docs/performance.md`, "Recommended
  Limits").
- **Retention.** Delivery phase data and attempt rows live and die with their
  `message_deliveries` row. Today those rows have no retention sweep (only
  events, heartbeats and attachments are pruned, `db.ts:4078-4157`). That is
  pre-existing and not widened here. If delivery retention lands later, phases
  and attempts go with it. `agent_turn_replies` is pruned with heartbeats.
- **Adapter memory.** Unsent phase reports go into a FIFO ring capped at 200,
  flushed once per tick. On overflow the oldest are dropped and a counter goes on
  the heartbeat. Phase reporting never blocks or reorders ack → turn.
- **Validation.** `message_id`, `turn_id` and `holder_agent_id` must be ≤ 64
  characters of `[A-Za-z0-9_.:-]`. `attempt` is an integer from 1 to 8. `phase`, `outcome`
  and `category` come from closed enums.
  Unknown keys are rejected. No free text is accepted anywhere.

---

## 3. Console status design (c)

### 3.1 Per-agent inbox state (relay-derived, pure)

Add a pure `deriveInboxState(input, now)` to `fleet-health.ts`, next to
`deriveAgentHealth`. It is time-injected and unit-tested the same way. Inputs:
queued count, oldest `queued_at`, delivered-but-unacked count, `last_inbox_poll_at`,
open `floor_wait` deliveries (with holder), and the heartbeat `adapter_state` /
`turn_started_at` / `turn_deadline_at`. The output is **one** state, using the
first rule that matches:

1. **`unresponsive_inbox`** (critical). Queued > 0, the oldest queued is older
   than `inboxStaleSeconds`, **and** either the last poll is null or older than
   `inboxStaleSeconds` with no running turn reported, or a reported turn is past
   `turn_deadline_at + 60 s` (wedged). **Heartbeat freshness is deliberately not
   an input**, so an inbox that heartbeats but never fetches reads unresponsive.
   This flips the relay characterisation test.
2. **`working`**. `adapter_state=turn_running`. Shows "working Xm", plus "N
   queued behind this turn" when queued > 0. That is the busy wait, named.
3. **`floor_wait`**. Deliveries with `floor_wait_started_at`, no
   `floor_granted_at`/`floor_overrun_at`, and `turn_attempts = 0`. Shows
   "waiting on floor · held by <holder> · Xs".
4. **`queued`**. Queued > 0, but within the threshold.
5. **`idle`**.

`inboxStaleSeconds` is a **new detection threshold**, not a polling change.
Default 120 s, which is 24 of today's 5 s polls. Changing any poll interval is
out of scope (§8).

### 3.2 API and attention queue

- `GET /v1/operator/fleet-health` (`routes-operator.ts:97-102` → `getFleetHealth`,
  `db.ts:2918-2978`) gains per agent:
  `inbox: { state, queued, oldest_queued_at, delivered_unacked, last_poll_at }`
  and `activity: { state, since, floor_waits: [{conversation_id, holder_agent_id, since}] }`.
  It is additive. `health` is unchanged, so connection and model health stay one
  axis and inbox state is a second axis.
- `buildAttentionItems` (`fleet-health.ts`) gains kind `inbox_unresponsive`
  (critical) and optionally `floor_wait_long` (warn, when a floor wait exceeds
  `floorTtlMaxSeconds`).
- `received_1h` keeps its meaning for compatibility, but the UI label changes
  from "recv" to "queued". A new `fetched_1h` counts by `delivered_at`.

### 3.3 UI (`App.jsx` HealthTab `1405-1482`, CommandDeck, Wire)

- HealthTab row: a second badge for the inbox state next to the health badge,
  with the stats line "3 queued · oldest 4m · last poll 6m ago" or "working 2m ·
  1 queued behind" or "waiting on floor (held by Jarvis) 40s".
- **Delivery ticks become honest.** "Acknowledged" → **"Received by N"**, and
  "read by N" → "received by N" (`App.jsx:783-784`;
  `WireApp.jsx:268-271`; `CommandDeck.jsx:115`), and the `message.acked`
  event label "Message acknowledged" → "Message received"
  (`consoleState.js:183`). A separate **"Turn sent output
  (N)"** appears only from `first_reply_at`. It says only that the turn covering
  the delivery sent something, which may be a delegation to another teammate.
  The console never says "Answered" unless open question 5 (§9) decides
  otherwise. "Completed" (a turn outcome) is shown only in the agent detail and
  never mixed into delivery ticks. No path renders an ack as turn output,
  answered or completed.
- Agent detail: a per-message phase strip, queued → fetched → (floor wait) →
  turn attempt(s) → first turn output → ended. A failed attempt that will be
  retried shows as "spawn failed · retrying" (§2.4 R4). Each segment is labelled
  relay-clock or adapter-clock, and busy/stalled segments are marked
  approximate (§2.3).

### 3.4 Honesty rules (stated as test assertions in Phase 4)

- An agent with queued deliveries and no poll within the threshold is never
  shown green, whatever its heartbeat says.
- `acked` never contributes to "turn sent output" or "completed".
- No label says "answered" while open question 5 is undecided.
- A missing phase (old adapter, dropped report) renders "unknown", never "0 s"
  and never "no output".

---

## 4. Independent direct-work scheduling (d)

### 4.1 Invariants every option must keep

- **I1 Room turn-taking.** Peer-triggered turns in a room the agent belongs to,
  or answering a room- or broadcast-addressed peer message, contend on the
  conversation-wide floor exactly as today. A conversation-wide lease still
  excludes every other peer turn on that conversation, pair lanes included.
  No peer message is ever delivered into a turn that does not hold its floor,
  except through the existing late overrun path (§1.2 step 9) or today's
  fail-open path for a relay without floor support.
- **I2 Signed semantics.** No signed field (§1.6) is ever rewritten, on the relay
  or on an adapter. Scope is local, derived metadata.
- **I3 At-most-once wake.** Ack-before-turn ordering (`autoreply.py:2375-2377`;
  `autoreply.ts:2596-2606`) and seen/nonce dedupe are unchanged. Every acked
  message ends in exactly one of: a turn, a stash, or a dead letter.
- **I4 Trust-generation checks.** Verdicts are still computed per tick, and
  stash entries keep their generation (OpenClaw). A scope decision may use only
  relay-attested or verified fields, and must never raise trust.
- **I5 Delivery and dead-letter guarantees.** Relay retry, dead-letter and expiry
  sweeps are unchanged. Adapter stash caps and `DEFERRED_*` reasons are unchanged.
- **I6 Floors are never globally disabled.**
- **I7 Version skew degrades to today's floor scope, never past it.** A new
  adapter on an old relay, or an old adapter on a new relay, contends only on
  the conversation-wide floor, exactly as v0.7.5 does. That is all I7 promises
  to keep identical. The §4.3 rules are **not** skew-gated. Mixed operator+peer
  slices and covering turns change even when every lane is `''`, including a
  new adapter on an old relay: the operator message no longer waits, and a
  covering turn absorbs only stashes whose exact floor it holds. That change
  is the safe direction. It closes the v0.7.5 next-tick bypass (§1.3) and
  never lets a peer message skip a floor. It **must not** be disabled or
  flagged off to make skew behaviour match v0.7.5 literally. Old and new
  adapters sharing a new relay never run two turns for the same pair at once,
  in either acquisition order, including across leases that exist at rollout
  and across a relay rollback (§4.2 (e)).

### 4.2 Option A (recommended): audience-scoped floor, a "pair lane" for 1:1 replies

The floor exists so that agents replying *to the same audience* take turns. A
peer direct addressed to B, on a conversation that is not one of B's rooms,
produces a reply to **one** peer (the prompt routes it 1:1: `autoreply.py:1609-1613`;
`autoreply.ts:1843`). Its audience is the pair {A, B}, not the room.

- **Relay.**
  - (a) `getInbox` exposes a relay-attested `recipient_kind` per message,
    additively (`db.ts:2166-2200` exposes none today, and `message_type` is not a
    reliable discriminator because plugins send everything as `direct`,
    `index.ts:187`; see `db.ts:3029-3030`).
  - (b) `POST /v1/conversations/:id/floor` accepts optional
    `{ scope: "pair", peer_agent_id }`. Both caller and peer must be
    participants. Lane floors are keyed `(fleet_id, conversation_id, lane)`,
    where `lane=''` is the conversation-wide floor and
    `lane='pair:<min>:<max>'` is a pair lane. The response adds `lane`, the
    lane this request was decided for. Its absence (an old relay) means `''`.
    On a refusal it also adds `conflict_lane`, the lane of the blocking lease.
  - (c) **Lane conflict rules (multi-granularity).** These apply to live leases
    (`expires_at > now`) held by **another** agent. The same holder's
    re-acquire stays idempotent, as today.
    - A **conversation-wide** acquire on C is refused while another agent
      holds C's conversation-wide lease **or any pair lane on C**.
    - A **pair-lane** acquire on `(C, pair:P:Q)` is refused while another
      agent holds that same lane **or C's conversation-wide lease**.
    - Pair lanes on C with different pairs never conflict with each other.
      This is the #155 fix.

    A refusal names the conflicting holder and `conflict_lane`. So the
    conversation-wide lease keeps exactly today's meaning (I1): while it is
    held, nobody else takes a peer turn on C. The lanes only split work that
    used to wait on the conversation floor *between pairs*.
  - (d) **Mixed versions on a new relay.** An old adapter never sends `scope`,
    so it always takes the conversation-wide lease. By (c):
    - **Old adapter A first.** A holds C's conversation-wide lease for its
      reply to B. New adapter B's `pair:A:B` acquire is refused until A
      releases. That is today's wait.
    - **New adapter B first.** B holds `pair:A:B` for its reply to A. Old
      adapter A's conversation-wide acquire is refused until B releases.
    - In both orders A and B never run concurrent turns for their pair. While
      any old adapter is active on C, pair lanes there only help when it is not
      mid-turn, which is a degradation to v0.7.5, not past it (I7).
    - Capability-gated activation (lanes on only once every agent advertises
      support) was considered and rejected as the primary mechanism. It cannot
      cover an old adapter that rejoins after lanes are live, so it would need
      (c) anyway. And (c) alone is sufficient.
  - (e) **Leases that exist at rollout.** The migration rebuilds the floor
    table under the new key and copies every existing row as `lane=''`,
    keeping holder, `acquired_at` and `expires_at`. A turn that was mid-flight
    across the relay upgrade therefore still excludes every pair lane on its
    conversation until it releases or expires.

    **Rollback keeps every live lease.** Restarting the relay does not stop
    adapter children, so a pair-lane holder may still be mid-turn when the old
    relay comes up. Dropping its lease would let another agent take the old
    conversation-wide floor and start an overlapping turn. So the down step
    **converts** live pair leases instead of discarding them:
    - The migration runner is forward-only and applies every `migrations/*.sql`
      file (`runMigrationsOn`, `db.ts:164-177`). Phase 6b therefore ships the
      down step outside `migrations/`, as
      `packages/relay/rollback/026_floor_lanes.down.sql`. It runs in one
      transaction while the new relay is stopped, before the old binary
      starts, so no acquire can interleave. It rebuilds the old table (keyed
      by `conversation_id`) and deletes version 26 from `schema_migrations`.
    - For each conversation C, it looks only at live leases
      (`expires_at > now`). Expired rows are dropped, because the old relay
      treats a missing floor and an expired floor the same way.
    - **One holder.** All live leases on C belong to one agent H. That can be a
      `lane=''` lease, a pair lane, or several of H's own. They become one
      conversation-wide row: holder H, the earliest `acquired_at` and the
      latest `expires_at`. The old relay sees C held by H. Nobody else takes a
      peer turn on C until H releases (the old holder-only DELETE,
      `db.ts:2283-2287`) or the lease expires.
    - **Several holders.** Live pair lanes on C belong to two or more agents.
      That is different pairs turning at once, which is the case #155 enables.
      By (c), no other agent can hold C's `lane=''` lease at the same time.
      The old key holds one row, and a row naming any one of these holders
      would be freed when that holder releases while the others are still
      mid-turn. So the row names the reserved holder `rollback:026`, with the
      latest of their `expires_at`. No agent id can take that value: agent
      ids are relay-minted `agent_…` (`db.ts:1215`), and the operator's
      pseudo-agent is `op_…` (`db.ts:1564-1565`). No agent can release the
      row, because release is holder-only, and every acquire on C is refused
      until it expires.
    - **Cost, stated plainly.** After rollback, any converted holder blocks
      the **whole conversation**, not just its pair: until H releases, or
      until the latest pair-lane expiry in the several-holder case. That is at
      most `floorTtlMaxSeconds` (600 s) after the rollback. Meanwhile, peer
      turns on C defer and retry as they do today, and run late through the
      overrun path if they reach `DEFERRED_RETRY_TTL`. Operator-only turns are
      unaffected. This is the safe direction: a bounded over-serialisation,
      never overlapping turns.
    - Waiter rows ((g)) are dropped. The old relay has no waiter concept, so
      the waiter's next retry simply gets the old relay's behaviour.
    - **Drain-first rollback was considered.** It would stop new pair
      acquisitions, wait until every pair lease releases or expires (bounded
      by `floorTtlMaxSeconds`), and only then drop the lane rows. It is just as
      safe, but the operator has to keep the new relay running in a drain mode
      for up to 600 s. The conversion needs no wait, so it is the procedure.
  - (f) **Release is lane-scoped.** `DELETE /v1/conversations/:id/floor` takes
    an optional `?lane=`. Without it, it releases only the caller's
    `lane=''` lease, which is exactly what an old adapter means. With it, it
    releases only that lane. An old relay ignores the parameter, and the only
    lease there is the conversation-wide one, which is what the adapter holds.
  - (g) **Fairness.** Under (c) a conversation-wide waiter could starve while
    overlapping pair lanes keep turning over, until it overruns
    (`DEFERRED_RETRY_TTL`) and runs late without the floor. To prevent that, a
    conversation-wide acquire refused **only** because of live pair lanes
    records a waiter on C with a short TTL (`floorWaiterTtlSeconds`, default
    15 s). Each retry refreshes it. While a waiter is live, no *new* pair lane
    is granted on C. Existing holders keep theirs, and their idempotent
    re-acquire is still granted. The lanes drain within one turn, the waiter
    is granted, and a waiter that stops retrying lapses on its own.
  - (h) A pair-lane `conversation_tail` contains only messages between the
    pair.
  - An old relay ignores `scope` and `?lane=`, and grants or refuses the
    conversation-wide floor, which is today's behaviour (I7).
- **Adapters.**
  - `plan_floor_turn` / `planFloorTurn` group by `(conversation, lane)` instead
    of by conversation.
  - A peer message is lane-eligible only if `recipient_kind == 'agent'`, its
    conversation is not in `inbox.rooms`, and, when it is signed and verified,
    `sig_canonical.recipient.kind == 'agent'`.
  - Hermes reads inbox messages through `InboxMessage`
    (`sdks/python/ekho/types.py:47-106`). Its `from_dict` names every field
    explicitly, so a key it does not name, such as `recipient_kind`, is
    dropped. Hermes then sees `getattr(m, "recipient_kind", None)` as `None`,
    every message fails the predicate, and Hermes never takes a pair lane.
    Phase 6a therefore adds `recipient_kind: Optional[str] = None` to the
    model and its parser, next to the TypeScript SDK type.
  - Everything else keeps the conversation floor (I1).
  - **Floors are recorded exactly.** Every grant or refusal is recorded under
    `(conversation, response.lane ?? '')`. `to_release` holds the granted keys,
    and `release_floor` / `releaseFloor` pass that lane. A refused slice is
    stashed under its key. On an old relay every key is `(conversation, '')`,
    which is v0.7.5.
  - **A rejected scoped acquire never fails open.** Today any exception from
    the acquire is read as "relay without floor support" and the slice runs
    without a floor (`autoreply.py:1848-1854`; `autoreply.ts:1938-1942`). That
    path stays for the **unscoped** acquire only, so pre-#155 behaviour is
    unchanged. If a **scoped** acquire raises (an HTTP 4xx/5xx or a transport
    error), the adapter retries the same slice once, in the same tick, as an
    unscoped conversation-wide acquire. That attempt is granted, refused
    (stash under `(conversation, '')`), or, only if it raises too, takes
    today's fail-open path. A scoped acquire therefore never yields a
    floorless turn by itself.
  - **Slices that collapse onto one key are merged, never overwritten.** The
    planner groups by the *requested* `(conversation, lane)` but records under
    the *returned* key. A scoped acquire that falls back to unscoped, or a
    scoped acquire on an old relay that ignores `scope`, returns `(C, '')`.
    That is the same key as an ordinary conversation-wide slice on C in the
    same tick. Carrying forward today's assignment (`deferred[conv] = msgs`,
    `autoreply.py:1842`; `autoreply.ts:1936`) would let the second slice
    overwrite the first slice's messages inside the planner. The stash merge
    cannot recover them, because they never reach the stash. So:
    - the deferred map holds a list per returned key, and a slice is
      **appended**, deduplicated by `message_id`, in arrival order;
    - once a key has a decision this tick, a later slice that resolves to it
      takes that decision. A second grant is just the idempotent re-acquire
      (§4.2 (c));
    - `to_release` is a set of held keys, so each held key is released
      **once**, with its lane;
    - a refused key is stashed once, with every message from every slice that
      resolved to it.
  - **Stashes are lane-keyed.** `deferred_by_conversation` /
    `deferredByConversation` key on `(conversation, lane)`. `stash_deferred`,
    `clear_deferred` / `clearDeferred`, `list_retryable_deferred`, the overrun
    take and `merge_covered_stashes` / `mergeCoveredStashes` all take that
    key. The deferred retry acquires the stash's own `(conversation, lane)`.
    Caps, TTL, overrun and dead-letter paths stay as they are (I3, I5). The
    conversation cap counts `(conversation, lane)` keys, with the same value.
  - Operator messages are lifted out of mixed slices, and covering turns absorb
    only the stashes whose floor they hold (§4.3).
- **Trade-offs.**
  - **+** Fixes the over-serialisation at the exact point it is decided,
    whatever the caller does (LLM habits, third-party SDK users).
  - **+** The operator's broadcast thread stays one conversation.
  - **+** Every peer turn still holds a floor (I6), and pair turn-taking is
    preserved, including the fresh tail.
  - **−** A relay migration plus changes in `db.ts` and `routes-agent.ts`
    (`db.ts` is a security path).
  - **−** Two adapters must change in lockstep, though skew is safe (I7, (d)).
  - **−** A conversation-wide turn on C still serialises every pair on C, and
    so does any old adapter mid-turn on C. The benefit arrives as adapters
    upgrade.
  - **−** It deliberately does not help independent work posted *into a room*
    (that is room talk, I1).

### 4.3 Shared fix (applies to either option): operators never wait on a peer floor, and peers never skip one

Two rules, applied in the same tick. Without Option A every lane is `''`, so
"`(conversation, lane)`" reduces to the conversation:

1. **Operator lift.** In a mixed slice, the operator messages are taken out of
   contention and go into this tick's turn at once, with no floor (as an
   operator-only slice already does, §1.3). The slice's peer messages contend
   for their own `(conversation, lane)` floor as usual. If it is granted, they
   join the same turn under that floor. If it is refused, they are stashed
   under that key, exactly as a refused peer-only slice is.
2. **Exact-floor absorption.** A covering turn absorbs a peer stash only when
   this tick holds a **granted** floor for exactly that stash's
   `(conversation, lane)`. "Holds" means granted by the relay this tick. An
   operator-only slice holds no floor. Neither does a fail-open slice (the
   acquire raised), or a conversation-wide grant for a pair-lane stash, or the
   reverse. A stash that is not absorbed is **left in place**: not cleared,
   not merged, and not dead-lettered. Its floor retry and, as a last resort,
   the late overrun delivery are still ahead of it, as today (I3, I5).

Together these mean the operator never waits on a peer floor, whatever the poll
timing, and no peer message rides into a turn past a floor another agent
holds. That removes the inconsistency in §1.3 and **closes the next-tick
bypass that exists in v0.7.5** (§1.3). It is adapter-only and
`merge_covered_stashes` / `mergeCoveredStashes` take the set of held
`(conversation, lane)` keys instead of the floored message list. It flips:

- the two "mixed batch … same conversation" planner characterisation tests;
- the two covering-turn characterisation tests
  (`test_operator_turn_absorbs_a_peer_message_stashed_behind_another_agents_floor_…_155`;
  OpenClaw "an operator turn absorbs a peer message stashed behind agent_c's
  floor…");
- every upstream #78 test whose covering turn is operator-only, or whose stash
  came from a mixed slice. In Hermes `tests/test_autoreply.py` these include
  `test_tick_covering_turn_delivers_the_stash_instead_of_clearing_it`,
  `test_tick_covering_turn_spawn_failure_keeps_the_stash`,
  `test_tick_covered_message_never_inherits_a_filtered_replacements_verdict`
  and `test_tick_covering_two_conversations_frames_both_tails_as_unseen`. In
  OpenClaw they are the #78 r2/r3 suites in `tests/deferred-tick.test.ts`,
  plus the `mergeCoveredStashes` unit tests in `tests/deferred-overrun.test.ts`,
  whose signature changes. These tests protect more than absorption: verdict
  binding, held-back framing, and no silent drop. Phase 7a/7b rewrite them to
  cover through a granted peer turn that holds the stash's exact floor, rather
  than deleting them. The #78 guarantee (a stash is never dropped unread) still
  holds, because a stash that is not absorbed is untouched, not cleared.

`test_tick_covering_turn_also_absorbs_a_stash_when_the_floor_is_granted` stays
green: that turn holds the stash's exact floor.

### 4.4 Option B: caller-side work conversations (separate per-agent conversation ids)

This is the mitigation the issue calls immediate. Independent per-agent work
goes out on its own conversation id, chosen **before signing**, so no signed
field is rewritten (I2).

- **Prompt (both adapters).** Extend the reply rule (`autoreply.py:1609-1613`;
  `autoreply.ts:1843`, `1863`): "Use that conversation_id only to reply to that
  sender. To ask a *different* teammate for independent work, call ekho_send
  **without** conversation_id (it starts a fresh thread), or open a room for
  shared multi-agent work."
- **`ekho_send`.** It already mints a fresh id when none is given
  (`index.ts:161`; `messages.py:153`). It should **keep that default**. It
  **should not** silently replace an explicit id. An optional variant: when the
  passed id is a relay-minted operator broadcast (`op-` prefix, `db.ts:1681`)
  and the recipient has never written to us in it, use a deterministic per-pair
  id `wk-<sha256(conv|self|peer)[:16]>` and **return the id actually used** in
  the tool result. This was considered, and is not recommended as a default,
  because a tool overriding an explicit argument is surprising, and Option A
  makes it unnecessary.
- **SDK.** **No default change.** `conversation_id` is a required,
  caller-chosen field (`packages/relay/src/types.ts:19`), and the SDK is transport. Changing it
  would silently re-thread third-party integrations. At most, a documented
  helper `workConversationId(parent, self, peer)`.
- **Trade-offs.**
  - **+** No relay change, no security path, ships in one small PR.
  - **−** Relies on prompt compliance.
  - **−** The peer exchange leaves the operator's broadcast thread. It shows up
    as separate threads, linkable only through unsigned
    `metadata.parent_conversation_id`.
  - **−** Does nothing for non-plugin SDK callers.
  - **−** The over-serialisation stays latent for any caller that reuses an id.

### 4.5 Option C (complementary): a renewable short floor lease

The holder takes a short lease (for example 60 s) and renews it every 20 s while
its turn runs. Release at the end of the turn is unchanged. This caps the
**crashed-holder** wait at about 60 s instead of 600 s, and closes the gap where a
900 s turn silently loses a 600 s lease mid-turn (pinned: relay "frees an expired
floor to the next agent…"). It does **not** stop independent work serialising,
so it is not a fix for #155 on its own. Candidate follow-up.

### 4.6 Rejected

- **Concurrent turns per adapter.** It breaks "one turn at a time" (the
  `tickRunning` / `inFlight` guards, `autoreply.ts:2251-2259`) and the host
  session model. Busy waiting is addressed here by making it *visible* (§3).
- **The relay rewriting a peer direct's `conversation_id`.** It violates I2:
  `conversation_id` is signed.
- **Bypassing the floor for every 1:1-addressed message.** A direct carrying a
  room id would produce a floorless reply to the whole room, because the prompt
  routes room conversations to the room (`autoreply.py:1600-1607`;
  `autoreply.ts:1840-1842`). That violates I1 and I6.

### 4.7 Recommendation

**Option A**, with §4.3, and Option B's **prompt sentence only** shipped earlier
as the immediate caller-side mitigation.

Option A fixes the scheduler where the wrong serialisation happens
(`plan_floor_turn`). It does not depend on caller behaviour. It keeps a floor
on every peer turn and pair turn-taking intact. It changes no signed field, and it
degrades to v0.7.5's floor scope under version skew (I7). Option B alone leaves the trap in place
for every caller that reuses an id, and splits the operator's thread.
`ekho_send` keeps its current fresh-id default and does not override explicit
ids. The SDK default does not change.

| Invariant | A | B (prompt + fresh-id default) | C |
|---|---|---|---|
| I1 room turn-taking | kept: room/broadcast-addressed peer turns take the conversation-wide lease, which excludes every pair lane (§4.2 (c)). Mixed operator+peer slices change **on purpose** (§4.3): the operator message no longer waits, the peer message still contends, and a covering turn absorbs only stashes whose exact floor it holds | kept | kept |
| I2 signed fields | untouched (lane is local) | untouched (id chosen pre-signing) | untouched |
| I3 at-most-once wake | unchanged ack→turn | unchanged | unchanged |
| I4 trust generation | scope reads relay-attested/verified fields only | n/a | n/a |
| I5 delivery/dead-letter | same stash machinery per lane | unchanged | unchanged |
| I6 floors never globally off | every peer turn holds a floor | unchanged | unchanged |
| I7 skew | old relay → conversation floor; old + new adapters on a new relay serialise per pair in both orders, across rollout and rollback (§4.2 (d), (e)). §4.3 still applies under skew, on purpose (I7) | n/a | old relay → fixed lease |

---

## 5. Measurement plan (e)

Measure **transport latency** and **first-reply latency** separately, with the
same queries, **before** and **after**. "First useful reply" is
operationalised as the first message the recipient sends from any turn attempt
that covers the delivery (`first_reply_at`, §2.4). That is "turn sent output",
not "answered". Usefulness itself is not machine-judged: phase records carry no
content, by design. This proxy is open question 5 (§9).

| Metric | Formula | Clock |
|---|---|---|
| Transport T | `delivered_at − queued_at`, restricted to `fetch_wait='prompt'` | relay/relay |
| Busy wait W (approximate, lower bound) | `delivered_at − queued_at` where `fetch_wait='adapter_busy'` (§2.3) | relay/relay; the label uses offset-mapped adapter intervals |
| Stalled S (approximate) | same, where `fetch_wait='inbox_stalled'` (and the count of `unresponsive_inbox` episodes) | relay/relay; same caveat |
| Ack lag | `ack_recorded_at − delivered_at` | relay/relay |
| Floor wait F | `(floor_granted_at ∨ floor_overrun_at) − floor_wait_started_at` | adapter/adapter |
| Agent-to-first-output | `first_reply_at −` the `started_at` of attempt `first_reply_turn_id` (relay vs adapter, so report the offset-adjusted value, §2.3) | mixed, flagged |
| **First turn output R** | `first_reply_at − queued_at`, the operator-perceived number | **relay/relay** |
| Spawn retries | deliveries with `turn_attempts > 1`, and how many attempts it took to reach first output | counts |
| Completion | `ended_at − started_at` of the latest attempt, by `outcome` | adapter/adapter |

- **Slices:** runtime (Hermes / OpenClaw); trigger kind (operator-only / peer /
  mixed); conversation kind (room / broadcast / DM / other); and *shared* versus
  *private* conversation (whether ≥ 2 distinct sender→recipient pairs have
  exchanged directs in it).
- **Statistics:** count, p50, p90, p99 and max per slice.
- **Windows:**
  - **B0** baseline: after Phases 1–3 (instrumentation only, no behaviour
    change), for 7 days or ≥ 200 deliveries per runtime.
  - **B1**: after Phase 5 (prompt mitigation).
  - **B2**: after Phases 6–7 (Option A).
  - Every window keeps the same poll intervals, turn timeouts and model routing.
- **Success criteria for B2 against B0:**
  - F for 1:1 directs on *shared* conversations: p90 ≤ one poll interval (≈ 5 s).
  - F for room/broadcast-addressed peer turns: within ±10 % of B0 (turn-taking
    unchanged).
  - T: no regression above 10 %.
  - R: improves at least by the F reduction on the affected slice.
  - `unresponsive_inbox` is raised for every delivery that is still queued past
    `inboxStaleSeconds`.
- **Lab check (deterministic, CI-free):** extend `scripts/load-test.ts` with a
  scenario of one broadcast, N agents and M independent directs on the
  broadcast id, using fake turns of fixed length. Report T and F per agent
  before and after. This gives an independent signal next to the live numbers.
- The live inspection that motivated the issue (read-only DB and gateway-log
  timestamps) is the *pre-B0* anecdote. It is not a baseline, because it lacks
  per-phase records.

---

## 6. Test plan (f)

These tests ship **in this pass** and pin today's behaviour. "FLIPS" marks a
test that Phase N is expected to change. "EXTENDED" marks one that Phase N adds
fields to.

| Scenario | Test (file :: name) | Today | Later |
|---|---|---|---|
| Busy recipient | Hermes `test_issue155_reply_latency.py :: test_busy_adapter_tick_neither_fetches_nor_acks_while_in_flight_…_155` | in-flight tick does no fetch, no ack, no floor | kept. Phase 3 adds a heartbeat `adapter_state=turn_running` assertion |
| Busy recipient | Hermes `:: test_busy_adapter_message_arriving_mid_turn_waits_for_the_whole_turn_…_155` | a mid-turn message is picked up only on the tick after the turn | kept, plus `fetch_wait='adapter_busy'` in a relay test (Phase 1/2) |
| Busy recipient | OpenClaw `reply-latency-characterisation.test.ts :: "does not poll the relay at all while a turn runs…"` | no `getInbox` during a turn | kept. Phase 3 adds a heartbeat state assertion |
| Independent recipients | Hermes `:: test_independent_recipients_on_different_conversation_ids_do_not_block_each_other_…_155`; OpenClaw `"two recipients on DIFFERENT conversation ids do not block each other"`; relay `"lets independent recipients hold floors on DIFFERENT conversation ids…"`; OpenClaw `"floors are per conversation id…"` | no blocking across ids | kept (must stay green) |
| Independent recipients, shared id (direct on a held floor) | Hermes `:: test_independent_recipients_sharing_one_conversation_id_serialise_on_its_floor_…_155`, `:: test_direct_on_a_held_floor_is_acked_at_once_but_not_woken_until_the_floor_frees_…_155`; OpenClaw `"a direct on a conversation whose floor another agent holds…"`; relay `"delivers and acks a direct on a floor-held broadcast conversation…"` | the unrelated direct waits for the holder's whole turn | **FLIPS in Phase 7** (both agents take their own pair lane, so both are granted). The relay test is **EXTENDED in Phase 6b**. When A holds a pair lane for its own direct, B's `pair:B:C` acquire is granted. When A holds the conversation-wide lease, as the test does today (an old adapter, or a broadcast-addressed turn), B's pair-lane acquire is **still refused** (§4.2 (c)) |
| Operator-only messages | Hermes `:: test_operator_only_messages_bypass_the_floor_…_155`, `:: test_operator_broadcast_wakes_at_once_while_a_peer_holds_its_floor_…_155`; OpenClaw `"operator-only messages bypass the floor…"` | no acquire | kept |
| Floor expiry | Hermes `:: test_direct_on_a_floor_that_never_frees_runs_late_without_the_floor_after_expiry_…_155`, `:: test_adapter_floor_lease_request_exceeds_the_relay_cap_…_155`; relay `"clamps the floor lease to floorTtlMaxSeconds…"`, `"frees an expired floor to the next agent…"`. **OpenClaw does not pin floor expiry**: its fake floor table has no expiry, and no OpenClaw #155 test reaches `DEFERRED_RETRY_TTL` | late floorless turn after `DEFERRED_RETRY_TTL`; 960 s → 600 s clamp; the original holder silently loses an expired floor | kept. Option C would flip the clamp/loss tests. Phase 7b adds an OpenClaw overrun test on lane-keyed stashes |
| Mixed operator/peer batches | Hermes `:: test_mixed_batch_same_conversation_defers_the_operator_message_with_the_peer_…_155`, `:: test_mixed_batch_across_conversations_lets_the_operator_slice_through_…_155`; OpenClaw `"a mixed batch on ONE conversation defers…"`, `"a mixed batch across conversations…"` | the operator waits in a same-conversation mixed slice | **same-conversation FLIPS in Phase 7 (§4.3)**. Cross-conversation kept |
| Covering turn vs a held floor (today's bypass) | Hermes `:: test_operator_turn_absorbs_a_peer_message_stashed_behind_another_agents_floor_…_155`; OpenClaw `"an operator turn absorbs a peer message stashed behind agent_c's floor…"` | the next tick's operator-only turn carries the stashed peer message while agent_c still holds the floor; no acquire, no release | **FLIPS in Phase 7a/7b (§4.3)**: the operator message runs alone, and the peer message stays stashed until its own floor retry. The upstream #78 tests listed in §4.3 flip with it |
| Received ≠ answered | relay `"records acked as the last delivery state; no field says the message was answered"` | lifecycle keys end at `acked_at` | **EXTENDED in Phase 1/3** (`ack_recorded_at`, `turn_attempts`, `latest_turn_*`, `first_reply_at`). New test: acked + no reply ⇒ `first_reply_at` null and the console shows "Received", not "Turn sent output" and never "Answered" |
| Unresponsive inbox | relay `"reports an inbox that heartbeats but never fetches as healthy"` | `health.level='ok'`, no attention item | **FLIPS in Phase 2** (`inbox.state='unresponsive_inbox'` plus a critical attention item, `health` unchanged) |

Future tests per phase, all deterministic (injected clocks, fake clients, mocked
spawns):
- `deriveInboxState` table tests (every precedence edge, time-injected).
- `/v1/delivery-phases`: rejects foreign deliveries, closed enums only, first
  write wins per attempt column, 404-tolerant adapter feature detection, and a
  ninth attempt refused and counted. After a refused ninth attempt,
  `attempts_capped` is set, the summary stays on attempt 8 but renders
  "unknown", and a reply stamped with the unrecorded ninth `turn_id` leaves
  `first_reply_at` null ("unknown", not "no output").
- `floor_wait` holder: `holder_agent_id` is required on `floor_wait` and
  rejected on every other phase. A malformed value fails validation. A
  well-formed id that is not an agent in the caller's fleet is stored as null
  and counted, with the same response as an accepted one.
- **Attempt-aware turn records (Phase 1b relay, 3a/3b adapters):**
  - **Failed spawn, then a successful retry.** A covering turn T1 fails to
    spawn. The adapter reports `turn_ended{T1, attempt 1, spawn_failed,
    spawn_error_retained}`, keeps the stash, and a floor retry later runs T2
    (attempt 2), which sends. Result: `latest_turn_id = T2`,
    `first_reply_turn_id = T2`, `first_reply_at` set, T1's row kept. Run it as
    a full tick in each adapter (the attempt counter on the stash entry) and as
    a relay test.
  - **Reply before its phase report.** The reply carrying `metadata.turn_id=T`
    reaches `createMessage` before `turn_started{T}`. `first_reply_at` is
    filled when the report lands. Also the reverse order, and both orders
    give identical rows.
  - **Delayed outcome from an earlier attempt.** T1's `turn_ended` arrives after
    T2's `turn_started` and after T2's reply. The summary stays on T2, T1's
    row is filled, and `first_reply_at` is unchanged.
  - **A reply is never undone.** T1 sends, then times out, and a later
    `dead_lettered` arrives. `first_reply_at` stays set.
  - Retransmitted duplicate reports are no-ops. A `turn_id` stamped by another
    agent never touches this agent's deliveries.
- `turn_id` → `first_reply_at` link, including the operator-DM re-thread case.
- `fetch_wait` classification from retained intervals: a turn-end → idle
  heartbeat → fetch sequence still classifies the gap `adapter_busy`. A gap
  with no overlapping interval is `inbox_stalled`. A late `turn_ended`
  reclassifies.
- Pair-lane acquire/release/tail isolation: a pair-lane tail contains only
  messages between the pair. Release is lane-scoped: an unscoped DELETE frees
  only `lane=''`, and a scoped DELETE frees only its lane.
- **Lane conflicts and mixed versions (Phase 6b relay; 7a/7b adapters):**
  - A conversation-wide lease held by A refuses B's `pair:A:B` acquire, **and**
    refuses an unrelated `pair:D:E` acquire on the same conversation. A live
    `pair:A:B` refuses a conversation-wide acquire by anyone else. `pair:A:B`
    and `pair:D:E` coexist.
  - **Mixed versions, old adapter first.** An old adapter (never sends `scope`)
    holds the conversation lease for its reply to B. The new adapter B's
    `pair:A:B` acquire is refused until A releases.
  - **Mixed versions, new adapter first.** The new adapter B holds `pair:A:B`,
    and the old adapter A's unscoped acquire is refused until B releases.
  - Both orders also as a two-agent adapter test on a shared fake relay that
    implements (c). Reciprocal directs A↔B on one conversation never produce
    overlapping turns.
  - **Lease present at rollout.** Seed the old-shape floor table with a live
    lease, run the migration, and assert it is now `lane=''` with the same
    holder and expiry, and that it refuses a pair-lane acquire until it
    expires.
  - **Rollback with an active pair holder.** Seed the new-shape table with A
    holding a live `pair:A:B` on C, run
    `rollback/026_floor_lanes.down.sql`, and drive the result with a fixture
    copy of v0.7.5's acquire and release statements (`db.ts:2240-2287`).
    Assert: C has one row, holder A, A's expiry. B's and D's acquires on C
    are refused until A releases or the lease expires. A's release frees it.
    Version 26 is gone from `schema_migrations`.
  - **Rollback with several pair holders.** A holds `pair:A:B` and D holds
    `pair:D:E` on C, with different expiries. After rollback, C's row names
    `rollback:026` with the later expiry. A's and D's releases are no-ops,
    every acquire on C is refused until that expiry, and the first acquire
    after it is granted.
  - **Rollback edge rows.** Expired lane rows are dropped. A single holder
    with both a `lane=''` lease and its own pair lane becomes one row with the
    later expiry. Re-running the forward migration afterwards copies the
    rolled-back rows as `lane=''` again.
  - Fairness: a refused conversation-wide acquire registers a waiter, new pair
    lanes are refused while it is live, existing holders re-acquire, and the
    waiter is granted once the lanes drain. A waiter that stops retrying
    lapses after `floorWaiterTtlSeconds`.
  - Skew: a new adapter on an old relay (scope and `?lane=` ignored ⇒
    conversation floor, response without `lane` ⇒ the adapter records `''`).
- **Operator lift and exact-floor absorption, as full ticks (Phase 7a/7b), not
  only planner tests.** All of these run through `process_inbox_once` /
  the OpenClaw tick, with a shared fake floor table where agent_c holds the
  floor:
  - Same tick: a mixed slice `[operator, peer]` on C. The operator message is
    spawned at once. The peer message is stashed under `(C, lane)`. No release
    is sent for a floor the agent never held, and agent_c still holds the
    floor.
  - Next tick: a peer stash on `(C, '')` and then an operator-only message on
    C. The turn carries only the operator message, and the stash is still
    present, uncleared and not dead-lettered. Once agent_c releases, the floor
    retry delivers it.
  - Lane mismatch: a stash on `(C, pair:A:B)` is not absorbed by a turn holding
    `(C, '')`, nor the reverse. A turn holding `(C, pair:A:B)` absorbs it.
  - A fail-open slice (the acquire raised) absorbs nothing.
  - A covering turn that fails to spawn keeps exactly the stashes it absorbed,
    and leaves others as they were.
- **A rejected scoped acquire never fails open.** The scoped acquire raises a
  400 and the retry as an unscoped acquire is refused, so the slice is
  stashed under `(C, '')` and no floorless turn runs. If the scoped acquire
  raises and the unscoped retry raises too, today's fail-open path is taken,
  which is the pre-#155 behaviour.
- **Mixed-slice fallback onto one key (Phase 7a/7b, full ticks).** One tick
  carries a pair-eligible peer message on C, whose scoped acquire raises and
  falls back to unscoped, and a room- or broadcast-addressed peer message on
  C, which takes the conversation-wide floor. Both resolve to `(C, '')`.
  - Refused: exactly one stash under `(C, '')` holding both messages, in
    arrival order, with no message lost or duplicated.
  - Granted: one turn carries both, and exactly one release is sent, with no
    lane.
  - The same pair of slices on an old relay, where the scoped acquire returns
    no `lane`, gives the same results.

---

## 7. Phased PR plan (g)

Each PR touches ≤ 5 files where feasible. **[SEC]** marks a security path (as
listed in the task: `packages/relay/src/db.ts`, `routes-operator.ts`, `auth*`,
`openclaw-plugin/src/verification.ts`, `credentials.ts`, `state-dir.ts`,
`hermes-plugin/**/verification*`, `sdk/src/crypto*`). **No phase touches**
`verification.ts`, `verification.py`, `credentials.ts`, `state-dir.ts`, `auth*`
or `sdk/src/crypto*`, or `sdk/src/identity/*`.

| Phase | Scope | Files | SEC |
|---|---|---|---|
| **0** (this PR) | Design + characterisation tests | `docs/plans/2026-11-01-155-reply-latency-design.md`, `packages/relay/tests/reply-latency-characterisation.test.ts`, `packages/openclaw-plugin/tests/reply-latency-characterisation.test.ts`, `packages/hermes-plugin/tests/test_issue155_reply_latency.py` | none |
| **1a** | Relay-observed phases: `agents.last_inbox_poll_at`, `ack_recorded_at`. Schema for delivery summary columns, `delivery_turn_attempts`, `agent_turn_replies` | `packages/relay/migrations/025_delivery_phases.sql`, `packages/relay/src/db.ts`, `packages/relay/tests/delivery-phases.test.ts`, `packages/relay/tests/reply-latency-characterisation.test.ts`, `openapi.yaml` | **db.ts** |
| **1b** | `POST /v1/delivery-phases` with attempt rows, `turn_id` → `first_reply_at`, reconciliation rules R1–R4 (§2.4), query-time `fetch_wait` (§2.3) | `packages/relay/src/routes-agent.ts`, `packages/relay/src/types.ts`, `packages/relay/src/db.ts`, `packages/relay/tests/delivery-phases.test.ts`, `openapi.yaml` | **db.ts** |
| **2** | `deriveInboxState` + fleet-health/attention fields | `packages/relay/src/fleet-health.ts`, `packages/relay/src/db.ts`, `packages/relay/tests/fleet-health.test.ts`, `packages/relay/tests/reply-latency-characterisation.test.ts` | **db.ts** |
| **3a** | Hermes phase reports (per-attempt `turn_id`, attempt counter on stash entries) + heartbeat state + `EKHO_TURN_ID` stamp | `packages/hermes-plugin/ekho_hermes/autoreply.py`, `.../connection.py`, `.../messages.py`, `sdks/python/ekho/client.py`, `packages/hermes-plugin/tests/test_issue155_reply_latency.py` | none |
| **3b** | OpenClaw phase reports (per-attempt `turn_id`, attempt counter on stash entries) + heartbeat state + turn stamp | `packages/openclaw-plugin/src/autoreply.ts`, `.../connection.ts`, `.../index.ts`, `packages/sdk/src/client.ts`, `packages/openclaw-plugin/tests/reply-latency-characterisation.test.ts` | none |
| — | **Baseline window B0** (§5) | — | — |
| **4** | Console: inbox badge, honest tick labels ("Received", "Turn sent output"), phase strip with attempts | `packages/relay/frontend/src/App.jsx`, `.../consoleState.js`, `.../api.js`, `.../WireApp.jsx`, `.../CommandDeck.jsx` | none |
| **5** | Caller-side mitigation: prompt sentence only (§4.4) → **B1** | `packages/hermes-plugin/ekho_hermes/autoreply.py`, `packages/openclaw-plugin/src/autoreply.ts`, `packages/hermes-plugin/tests/test_autoreply.py`, `packages/openclaw-plugin/tests/autoreply.test.ts` | none |
| **6a** | Inbox `recipient_kind` (relay-attested, additive), in both SDK inbox models. The Python `InboxMessage` drops keys it does not name, so without it Hermes cannot evaluate pair eligibility (§4.2) | `packages/relay/src/db.ts`, `packages/relay/tests/inbox-recipient-kind.test.ts`, `openapi.yaml`, `packages/sdk/src/types.ts`, `sdks/python/ekho/types.py` | **db.ts** |
| **6b** | Pair-lane floors: `scope`, lane key `(fleet_id, conversation_id, lane)`, conflict rules and waiter (§4.2 (c)–(g)), rollout copy of existing leases, the rollback that converts live leases (§4.2 (e)), lane-scoped DELETE, pair-only tail | `packages/relay/migrations/026_floor_lanes.sql`, `packages/relay/rollback/026_floor_lanes.down.sql`, `packages/relay/src/db.ts`, `packages/relay/src/routes-agent.ts`, `packages/relay/src/config.ts` (`floorWaiterTtlSeconds`), `packages/relay/tests/floor-lanes.test.ts`, `openapi.yaml` | **db.ts** |
| **7a** | Hermes: lane grouping, lane-keyed stashes, §4.3 operator lift and exact-floor absorption, scoped-acquire fallback | `packages/hermes-plugin/ekho_hermes/autoreply.py`, `sdks/python/ekho/client.py`, `packages/hermes-plugin/tests/test_issue155_reply_latency.py`, `packages/hermes-plugin/tests/test_autoreply.py` | none |
| **7b** | OpenClaw: the same as 7a | `packages/openclaw-plugin/src/autoreply.ts`, `packages/sdk/src/client.ts`, `packages/openclaw-plugin/tests/reply-latency-characterisation.test.ts`, `packages/openclaw-plugin/tests/deferred-tick.test.ts`, `packages/openclaw-plugin/tests/deferred-overrun.test.ts` | none |
| — | **After window B2** (§5) | — | — |
| **8** | Docs: ARCHITECTURE floor/phase section, operations runbook, measurement report | `ARCHITECTURE.md`, `docs/operations.md`, `docs/performance.md` | none |

Ordering: 1–3 add no behaviour change, so B0 is a clean baseline. 4 is display
only. 5, 6 and 7 are the behaviour changes, each measured. 6a/6b can land before
7a/7b because of I7. Until 7a/7b ship, no adapter sends `scope`, so every lease
is `lane=''` and the relay behaves as v0.7.5. During the 7a/7b rollout, the
conflict rules (§4.2 (c)–(e)) keep old and new adapters taking turns per pair.
6b is seven files. The conflict rules, the migration, its rollback and their
tests belong together.

---

## 8. Explicitly out of scope (h)

- **#111 / PR #121**: deferred-message reliability. The stash/dead-letter
  machinery is used as-is. The phase reports only *observe* it.
- **Mobile layout** of the console.
- **Any change to polling intervals** (adapter 5 s, heartbeat 30 s, relay
  sweeps) **or to model routing**. `inboxStaleSeconds` is a detection threshold
  only.
- Concurrent turns per adapter (§4.6).
- Delivery-row retention (pre-existing gap, §2.5).

---

## 9. Open questions

1. Two pre-existing floor-path issues found during this review have been
   reported privately per SECURITY.md; Phase 6b's lane design must stay
   compatible with their fixes.
2. **Turn timeout above lease max.** The adapters' 900 s turn timeout exceeds
   the relay's 600 s lease cap, so a long turn silently loses its floor (pinned).
   Should Option C be pulled into #155?
3. **Hermes trust generation.** Hermes has no `verificationGeneration`
   equivalent. Phase 7a keeps parity of *scope* logic only. Confirm that
   trust-generation parity for the Hermes stash is tracked elsewhere.
4. **`inboxStaleSeconds` default.** 120 s is proposed. This is a product call.
5. **"First useful reply" proxy.** Is "the covering turn sent output" an
   acceptable proxy, given that phase records carry no content by design? It
   includes sends to a third party, such as a delegation to another teammate.
   Until this is decided, the console says "turn sent output" and never
   "answered" (§3.3).
