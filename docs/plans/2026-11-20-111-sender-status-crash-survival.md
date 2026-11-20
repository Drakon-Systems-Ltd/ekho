# #111 residuals: sender-visible withheld status and restart/crash survival

Status: **design only**. This file changes no code, schema, migration, workflow
or CHANGELOG. It records what was found on `main` at
`5d814b88f8209c23a29999dadf12125249bdf1d1` (#193 merged, #192 closed), what can
honestly be promised, the alternatives, and the exact slices a later,
separately approved build would follow. Refs #111. Part 1 (same-process reload
hand-off, #191) and its hardening (#193) are already on `main` and are not
revisited here.

Every claim below about current behaviour was read from the files named in it at
that commit. Items marked **to verify** were not run and must be checked by the
slice that depends on them.

## 1. What is still open

From the CHANGELOG "Still open in #111" list, this design covers two of the
residuals and records the other two:

| Residual | Covered here |
|---|---|
| Telling the sender when a message is withheld | Part A |
| Surviving a process restart or crash | Part B |
| The full plugin swap on a single config-key change | No. OpenClaw host behaviour, left as the documented upstream question |
| Exactly-once or lossless delivery | Never promised; see section 2 |

## 2. Non-goals and what this design does not promise

- **No exactly-once and no lossless delivery.** A turn that started and then
  died still counts as delivered. The loop acks before the turn
  (`autoreply.ts`, "ACK BEFORE the turn", at-most-once by design so that a slow
  or crashed turn can never cause a redelivery that re-triggers the agent). This
  design keeps that rule. It narrows the window in which acked work vanishes
  silently and makes the remaining loss visible; it does not close the window.
- **The dead-letter file is never read back as work.** `.ekho-dead-letter.jsonl`
  is an append-only, mutable, locally writable evidence file. Nothing in this
  design uses its contents as a source of messages, verdicts or trust.
- **No carried-over verdicts.** Anything recovered is verified again under the
  trust configuration, pinned keys, roster and policy of the process that
  recovers it, as the hand-off already does.
- **No relay-side claim about what the recipient did.** The relay can only
  record what the recipient reports about its own deliveries. Sender-visible
  fields stay labelled as recipient-reported.
- No new protocol surface is added to anything other than the additive reason values section 4.2 proposes.

## 3. Verified current state

### 3.1 What the sender can see today

- `GET /v1/messages/{message_id}/status` (`packages/relay/src/routes-agent.ts`)
  is scoped to the sending agent (`getSentMessageStatus`, `db.ts`). A foreign or
  unknown id returns 404.
- Each `deliveries[]` row carries `status` (`queued | delivered | acked |
  dead_lettered`, the relay's own transport state), plus
  `adapter_dead_lettered_at` and `adapter_dead_letter_reason`, plus phase fields
  (`floor_wait_*`, `floor_granted_at`, `floor_overrun_at`, turn attempts,
  `first_reply_at`).
- `acked` means the recipient's adapter acknowledged receipt. It does not mean a
  turn ran.

### 3.2 A route for recipient-reported loss already exists

This corrects the shape of the "Telling the sender" item in the CHANGELOG, which
says a truthful sender-visible status "needs a relay protocol addition: an agent
route, or an ack status". Reading `main`:

- `POST /v1/delivery-phases` (agent-authenticated, `routes-agent.ts`) accepts a
  `dead_lettered` phase with a required `reason`, writes
  `message_deliveries.adapter_dead_lettered_at` and
  `adapter_dead_letter_reason` for **the caller's own delivery only**
  (`WHERE message_id = ? AND recipient_agent_id = <authenticated agent>`), first
  write wins, and stamps `phase_recorded_at` on the relay clock.
- Both fields are already returned to the sender by the status route above.
- The 155 design (`docs/plans/2026-11-01-155-reply-latency-design.md`, section
  2.2) specifies this phase for "wherever the adapter already dead-letters acked
  work". Migration 026 added both columns (`026_delivery_phase_reports.sql`); no further migration is needed for
  this part.

What is missing is everything around it:

1. **The reason set is closed and too small.** `phaseEntrySchema.reason` is
   `z.enum([deferred_evicted_cap, deferred_overflow_per_conv,
   deferred_expired_spawn_failed, deferred_retry_spawn_failed,
   deferred_loop_stopped])` in `packages/relay/src/types.ts`. It has no value
   for `inflight_loop_stopped`, for a withheld re-admission, or for anything
   about crash recovery.
2. **No client calls it.** `packages/sdk/CHANGELOG.md` says the SDK has no
   method for `POST /v1/delivery-phases`; the README says adapters do not send
   these reports. A search of `packages/sdk/src`, `packages/openclaw-plugin/src`
   and `packages/mcp-connector/src` found no caller.
3. **Senders have no reader.** The same search found no SDK or connector method
   for the sender-side status route. An agent today would need to issue the raw
   HTTP request itself.
4. **First write wins and cannot be retracted.** If the stopping generation
   reported `deferred_loop_stopped` at stop time and the successor then
   re-admitted the message, the sender would be told "dead-lettered" about a
   message that got its turn. Reporting must therefore happen at the *decision
   point*, not at stop time (section 4.2).
5. **The existing notices route is not a substitute.** `POST /v1/notices` is
   operator-visible only, recorded as `conversation.stalled`, and deduplicated
   per conversation whatever the reason (`db.ts`, the agent-raised
   notice recorder near line 4718). It cannot carry a per-message, sender-addressed status.

### 3.3 What a recovering process could rely on

- `GET /v1/delivered-messages/{id}` (SDK `getDeliveredMessage`) is a
  non-consuming read, scoped to a delivery row addressed to the authenticated
  agent, with status `delivered` or `acked`, and only while the message's
  `expires_at` is in the future (`getDeliveredMessage`, `db.ts`). It returns the
  inbox message shape including `agent_sig` / `operator_sig`, `key_id`,
  `sig_canonical` and `deadline_at` (= `expires_at`). Today it is used by
  `index.ts` for spawned turns that have no inbox ring.
- **To verify in S6:** that the returned shape is sufficient for the
  plugin's existing verification pipeline without a second code path, and that
  the relay keeps acked rows readable for the whole deadline window.

### 3.4 Where acked work lives, and what each failure does to it

| Situation | What happens now | What the sender sees now |
|---|---|---|
| Crash between poll and ack | The relay redelivers after `EKHO_DELIVERY_TIMEOUT_SECONDS` (default 120). Nothing lost. | `delivered`, then `acked` |
| Reload, successor claims the hand-off (#191/#193) | Re-admitted once, or withheld with a dead-letter record | `acked` either way |
| Reload, no successor claims it | Dropped after 24 h 5 min (`RELOAD_HANDOFF_MAX_AGE_MS`); recorded only if a matching copy finds it | `acked` |
| Gateway shutdown, crash or restart after ack | Hand-off is process memory only; stash and in-flight messages are gone. A clean shutdown writes `deferred_loop_stopped` / `inflight_loop_stopped` records; a crash writes nothing | `acked` |
| Turn spawned, then the process or turn dies | Counts as delivered | `acked`, possibly turn phases if reporting is wired |

The sender's view in the last three rows is the problem: the relay says `acked`
and nothing ever corrects it.

## 4. Part A: sender-visible withheld and post-ack status

### 4.1 Goal and honest wording

A sender that reads its message status should be able to tell apart:

1. the recipient took it and a turn started (turn phases, once reported);
2. the recipient took it and **deliberately did not run a turn**, with a coarse
   reason;
3. nothing is known beyond `acked` (the unavoidable fallback).

The status is **recipient-reported**. A recipient can fail to report, and a
crashed recipient reports nothing. Absence of a withheld marker is therefore
never evidence that a turn ran. Documentation and field descriptions must say
so in those words.

### 4.2 When to report: at the final disposition, never at stop

Report a `dead_lettered` phase only when the message's disposition is final and
no later generation or recovery can still serve it:

| Event | Report? | Reason value (proposed) |
|---|---|---|
| Stop with a successful hand-off deposit | **No.** The successor may serve it. | none |
| Successor withholds on re-admission: deadline passed or missing | Yes | `deadline_passed` |
| Successor withholds: signature, policy, latch, malformed, stash failure, or served-evidence lost | Yes, **collapsed to one coarse value** | `withheld_by_recipient` |
| Hand-off entry dropped as unclaimed too long (when a matching copy finds it) | Yes | `handoff_unclaimed` |
| Stop with no hand-off available (no registry, deposit refused) and flush writes `inflight_loop_stopped` / `deferred_loop_stopped` | Yes, best effort inside the stop budget | `inflight_loop_stopped` / `deferred_loop_stopped` (the latter already in the enum) |
| Existing stash drops (`deferred_evicted_cap`, `deferred_overflow_per_conv`, `deferred_expired_spawn_failed`, `deferred_retry_spawn_failed`) | Yes | existing values |
| Re-admitted and served | No. Turn phases carry it once wired. | none |
| Crash recovery refetch is 404 or past deadline (Part B) | Yes | `deadline_passed` |
| Crash recovery withholds (Part B) | Yes | `withheld_by_recipient` |

Why the trust and policy reasons collapse into one value: a sender-visible,
per-message reason that distinguishes "your signature failed here" from "latch
closed" from "not delegated" would tell any sender how the recipient's trust and
policy are configured. The recipient's own dead-letter record and log line keep
the precise reason; the sender gets the coarse one. This is a deliberate
disclosure limit, not an omission.

A report at stop time is best effort: the stop hook has a short budget
(`autoreply.ts` documents a 5 s bound for the unload wait) and the relay may be
unreachable. A report that could not be sent is **not** retried from the
dead-letter file after restart, because that would be reading the mutable file
as a work or state source. The sender simply keeps `acked`.

### 4.3 Reporter design (plugin)

- A small in-memory ring (bounded, same order of size as the hand-off cap of 500)
  of pending `dead_lettered` entries, flushed once per tick with the rest of the
  tick's work, as the 155 design describes for phase reporting.
- Feature-detected and best-effort. A relay that does not know the route
  (404) or the reason value (400) stops reporting for the life of the process
  and logs once. A reporting failure must never break the tick, never delay
  an ack and never change a disposition.
- **Batch hazard.** `deliveryPhasesSchema` is strict and the reason is a closed
  enum, so an older relay that does not know a new reason value rejects the
  **whole** request with 400. New-reason entries therefore go in their own
  request, separate from turn phases, so one unknown value cannot take down
  unrelated reports. On 400 the entry is dropped (not downgraded to a different
  reason, which would be untrue).
- **Upgrade order.** Relay first, then SDK and plugin. A plugin newer than its
  relay degrades to no sender-visible status, which is today's behaviour.

### 4.4 Alternatives considered

| Option | Verdict |
|---|---|
| **A1. Extend the existing `dead_lettered` phase with new closed reasons** (recommended) | Smallest change: no new route, no migration (the reason column is free text), existing status route already returns it, scoped to the caller's own delivery. |
| A2. New relay ack status that moves the delivery to `dead_lettered` | Rejected for now. It conflates the relay's transport state with a recipient claim, would need a state-machine and migration change, and `dead_lettered` is today the relay's own verdict (`dead_letters` table). |
| A3. Use `POST /v1/notices` | Rejected. Operator-visible only and deduplicated per conversation. |
| A4. Nack the held messages back to the relay at stop so it redelivers | Rejected for this design. There is no nack route; adding one changes the ack contract, and redelivery would re-trigger the agent, which is what at-most-once exists to prevent. Revisit only with its own scope question. |
| A5. Relay derives a "no sign of work" status from phases it already holds (acked, but no `turn_started` and no `first_reply_at` after N seconds) | Complementary, not a replacement: it needs no recipient cooperation, so it also covers crashes. It is a new derived API field and needs a threshold decision, so it is held as an optional slice (S4) behind its own scope question. It must be labelled "no sign of work", never "lost". |
| A6. Do nothing; document the limitation | The floor. Slices S0 to S3 are independently shippable and stop here if later parts are not approved. |

### 4.5 Sender-facing copy (proposed, for docs and the field description)

- `acked`: "The recipient's adapter acknowledged receipt. This does not mean a
  turn ran."
- `adapter_dead_letter_reason = withheld_by_recipient`: "The recipient received
  this message and deliberately gave it no turn. It was reported by the
  recipient, so its absence does not prove a turn ran."
- `deadline_passed`: "The message's deadline passed before the recipient could
  serve it."
- `handoff_unclaimed`, `inflight_loop_stopped`, `deferred_loop_stopped`: "The
  recipient stopped or restarted holding this message and it was not served."

## 5. Part B: restart and crash survival

### 5.1 What can be survived, and what cannot

Honest ceiling for any design here:

- **Survivable with care:** messages acked by a process that then stopped or
  crashed **before** a turn was handed the message, provided a record of which
  message ids were pending was durably written **before** the ack.
- **Not survivable:** a message whose turn started. By the at-most-once rule it
  counts as delivered even if the turn died. Recovery must prefer not
  duplicating over not losing.
- **Not survivable without a journal write:** anything held only in memory when
  the process died. A crash with no pre-ack record is the same unreported loss
  as today.
- A sender is told of a recovery outcome only when the recovering process can
  reach the relay.

### 5.2 Chosen shape: an id-only, write-ahead journal used as a hint

Store **message ids and bookkeeping only**, never message bodies, verdicts or
signature results. On cold start, treat each id as a *candidate* and obtain the
content again from the relay with `getDeliveredMessage`, which returns the
authoritative stored message, then push it through the **same** re-admission
decision the same-process hand-off uses.

Why ids only:

- The journal is a local, mutable file. If it carried bodies or verdicts it
  would become the mutable-replay source this design forbids. With ids only, the
  worst a corrupted or edited entry can do is name a message that the relay
  either returns (it is addressed to this agent and not expired, and then it is
  fully verified like any delivery) or refuses (404).
- Anyone who can write the plugin state directory also sits beside the agent's
  identity file, so the journal does not widen the set of principals that matter.
  This is a boundary statement, not a hardening claim.

Journal record (proposed): `message_id`, `conversation_id`, `deadline_at`
(advisory only; recovery uses the relay's copy), `journaled_at`, and a
`turn_marked` boolean. File lives in the plugin state directory (`state-dir.ts`)
with mode `0600`, next to but separate from the dead-letter file.

### 5.3 Write ordering (the part that decides honesty)

1. Before the ack of a batch, append (and flush) one record per `kept` message
   that is about to be held or served. An ack that fails after the journal write
   leaves a record for a message the relay will redeliver; recovery must treat
   "relay still shows it as not acked or delivered again" as already handled by
   the normal inbox path (the refetch endpoint only returns `delivered | acked`,
   so this is a no-op or a dedupe case, **to verify**).
2. **Before** spawning a turn for a message, set `turn_marked`. A crash after the
   mark and before the spawn therefore loses the message rather than risking a
   second turn. This is the at-most-once side of the trade and is intentional.
3. Remove a record when its message reaches any final disposition: turn spawned
   and finished, withheld, dead-lettered with a report, or expired.
4. Bounds: at most 500 records (`RELOAD_HANDOFF_CAP`) and 24 h 5 min age
   (`RELOAD_HANDOFF_MAX_AGE_MS`), the same bounds as the hand-off. Over the
   bound, the oldest are dropped, and each drop is reported as
   `handoff_unclaimed`-class loss where the relay is reachable.

Cost: a flushed append per acked batch that keeps anything. That is a measurable
latency cost on the poll tick and is why the journal ships behind an option that
defaults to off until measured (section 7, S5).

### 5.4 Recovery on cold start

Run once, only on a cold start of the process (no prior generation in the
process-global registry; **to verify** how the registry distinguishes cold start
from reload), and only when the journal option is on:

1. Take a single-owner lock on the journal. If it cannot be taken (another live
   process for the same agent owns it), do nothing and leave the journal
   untouched. Two live processes must never both recover the same record.
2. For each record without `turn_marked` that is inside its age bound,
   `getDeliveredMessage(id)`:
   - 404 or past `deadline_at` on the relay copy: report `deadline_passed`,
     remove the record;
   - otherwise run the existing re-admission decision (fresh signature check
     under the current pins and roster, peer delegation, `requireSigned`,
     operator trust, closed latch, deadline, floor). Re-admit once or withhold,
     with a report as in section 4.2, and remove the record.
3. Records with `turn_marked` are removed without replay. They are not reported
   as lost: the sender cannot be told truthfully whether the turn finished.
4. Recovery does not charge the per-peer rate limit or latch again (same rule as
   the hand-off) and does not carry over any counter from the previous process.
5. Recovery never reads `.ekho-dead-letter.jsonl`.

### 5.5 Hazards the build must test

- **Double recovery** by two processes or a reload racing a cold start.
- **Replay of an already-served message.** The in-memory served ledger is lost on
  a crash, so a journal record whose turn did run but was not yet removed can be
  recovered a second time. The `turn_marked` write-ahead rule is what prevents
  this; any path that spawns without the mark is a bug.
- **Recovered work outliving its trust.** A key removed or a peer un-delegated
  between crash and restart must make the recovery withhold, which is why
  verdicts are never stored.
- **Relay clock versus local clock.** Deadline decisions use the relay's
  `deadline_at`, as the hand-off does.
- **Reporting after recovery** must use the same coarse reasons and the same
  best-effort, drop-on-400 rules as section 4.3.

### 5.6 Alternatives considered

| Option | Verdict |
|---|---|
| **B1. Id-only write-ahead journal plus refetch** (recommended) | Keeps at-most-once, never trusts local content, bounded, optional. |
| B2. Journal full message bodies and replay them | Rejected. Makes a mutable local file a source of trusted work, and still needs fresh trust and deadline checks. |
| B3. Replay `.ekho-dead-letter.jsonl` | Rejected outright; it is evidence, not a queue, and is rotated at 5 MiB. |
| B4. Ack after the turn starts so the relay redelivers on crash | Rejected. It reverses the at-most-once rule, makes a slow turn cause redelivery that re-triggers the agent, and the relay's default 120 s delivery timeout is shorter than the minutes a real turn can take (`autoreply.ts` notes handoff work routinely needs minutes). |
| B5. Durable queue in the relay | Out of scope: relay-side protocol and storage change. Would need its own scope question and migration plan. |
| B6. Relay-derived "no sign of work" status only (A5) | Honest and cheap, but does not recover anything; kept as the complementary visibility slice. |
| B7. Do nothing beyond Part A | The floor: crash loss stays, but is no longer indistinguishable from success whenever a recipient can report. |

## 6. Honest limitations (restated for the PR and docs)

1. No exactly-once and no lossless delivery; a started turn that dies is
   delivered.
2. Sender-visible status is recipient-reported and best effort. A crashed or
   unreachable recipient reports nothing; the sender then sees only `acked`.
3. Reasons shown to senders are coarse by design; precise reasons stay in the
   recipient's log and dead-letter file.
4. Crash survival exists only for messages journaled before the ack, only when
   the option is on, and only for those whose turn had not been marked.
5. The upstream full-swap question (one config key change replaces the whole
   plugin) is unchanged.
6. Senders still need a reader for the status route (the optional reader in S1); until it
   exists they must call the HTTP route directly.
7. Hermes (Python) plugin parity is not covered; it would need its own issue.
8. Nothing here verifies behaviour on a live gateway or relay. All acceptance is
   by tests in GitHub CI.

## 7. Future implementation slices

Each slice is its own PR, `Refs #111`, plugin/SDK/relay boundaries kept
separate, and none starts without the scope question named for it. Test
execution is GitHub CI only; no full suite is run on the build box.

| Slice | Content | Files (expected) | Needs |
|---|---|---|---|
| **S0** Relay: coarse reasons | Add `deadline_passed`, `withheld_by_recipient`, `handoff_unclaimed`, `inflight_loop_stopped` to the `dead_lettered` reason enum. Additive only. No migration, no `db.ts` change expected (reason column is text). | `packages/relay/src/types.ts`, `openapi.yaml`, `packages/relay/tests/delivery-phases.test.ts` | Scope question |
| **S1** SDK: `reportDeliveryPhases` | Method for `POST /v1/delivery-phases`, typed to the closed enums. Optional sender reader `getMessageStatus` in the same or a following PR. | `packages/sdk/src/client.ts`, SDK tests, `packages/sdk/CHANGELOG.md` | S0 merged and released together with the relay |
| **S2** Plugin: report final dispositions | Ring plus per-tick flush, separate request for new reasons, 404/400 feature detection, reports at the decision points in section 4.2 only. Update the CHANGELOG limitation text that currently says a protocol addition is required. | `packages/openclaw-plugin/src/autoreply.ts`, new small reporter module, plugin tests, `packages/openclaw-plugin/CHANGELOG.md`, `CHANGELOG.md` | S0, S1 |
| **S3** Docs | Sender-facing wording from 4.5 in `docs/agent-adapter.md`, `openapi.yaml` descriptions and the plugin README. | docs only | S2 |
| **S4** (optional) Relay "no sign of work" derivation | Derived read-time field, threshold setting bounded like the existing `EKHO_INBOX_STALE_SECONDS`, labelled never as "lost". | relay `db.ts`-adjacent derivation, `openapi.yaml`, tests | **Separate scope question**: new API field and threshold |
| **S5** Plugin: write-ahead journal, no recovery | Option defaulting to off; id-only records; flush before ack; `turn_marked` before spawn; bounds; removal on final disposition. Measure tick latency before any default change. | `packages/openclaw-plugin/src/` new journal module, `autoreply.ts` call sites, plugin config schema, tests | **Own scope question** (new durable file and option) |
| **S6** Plugin: cold-start recovery | Lock, refetch with `getDeliveredMessage`, existing re-admission decision, reports via S2, no replay of marked records. | `autoreply.ts`, `runtime-registry.ts`, journal module, tests | S2, S5 |
| **S7** Hermes parity | Only if wanted; separate issue. | `packages/hermes-plugin` | Separate issue |

S0 to S3 deliver Part A and can ship without any of S4 to S7. S5 and S6 deliver
Part B and are deliberately last.

## 8. Acceptance criteria (per slice)

All as CI-run tests, written to fail without the change.

**S0**
- Each new reason is accepted for `dead_lettered`, stored, and returned in the
  sender's status as `adapter_dead_letter_reason`.
- A value outside the closed set is still refused; `dead_lettered` without a
  reason, and a reason on any other phase, are still refused.
- First write wins: a second `dead_lettered` report with a different reason does
  not change the stored reason.
- A report for another agent's delivery is refused and indistinguishable from an
  unknown id.

**S1**
- The method posts the documented body and surfaces the response counts; a 404
  and a 400 reach the caller as errors, not as silent success.

**S2**
- Successor withholds a re-admitted message for each of: deadline passed,
  signature failure, closed latch, malformed entry, served-evidence lost. In each
  case exactly one `dead_lettered` report is made, with only the coarse value,
  and no turn is spawned.
- A stop with a successful deposit makes **no** `dead_lettered` report; the
  successor serving the message makes none either.
- Stop with no hand-off available reports `inflight_loop_stopped` or
  `deferred_loop_stopped` best effort and does not exceed the stop budget with
  an unreachable relay.
- 404 from the relay stops reporting for the process and logs once; 400 on a new
  reason drops that entry, does not retry it and does not affect a concurrent
  turn-phase report.
- A throwing reporter never breaks the tick, delays an ack or changes a
  disposition.
- A second reload does not produce a duplicate report.

**S4** (if approved)
- A delivery with `acked`, no turn phase and no reply past the threshold reads
  "no sign of work"; one with a `turn_started` or `first_reply_at` does not; the
  wording never says lost.

**S5**
- With the option off, behaviour and tick timing are unchanged and no file is
  created.
- With it on, a record is durable before the ack call returns, holds no body,
  verdict or signature result, and file mode is `0600`.
- `turn_marked` is written before the spawn call; a simulated crash between the
  mark and the spawn leaves no recoverable record.
- Bounds hold at 500 records and the age limit.

**S6**
- Cold start with unmarked records inside deadline and valid trust: each is
  re-admitted once; a second cold start does not replay it.
- Records with `turn_marked` are never replayed and never reported lost.
- Past deadline or relay 404: not served, `deadline_passed` reported, record
  removed.
- Pinned key removed, peer un-delegated or latch closed between crash and
  restart: withheld, coarse report, no turn.
- A tampered or garbage journal line naming an unknown id yields a 404 and no
  turn; a line with a body field is ignored.
- A second live process holding the lock: no recovery, journal untouched.
- Reload (not cold start) never reads the journal.
- `.ekho-dead-letter.jsonl` is never read by recovery (test asserts no read).

## 9. Recommendation

Approve S0 to S3 as one build sequence: they close the honest part of "telling
the sender" with an additive relay enum, an SDK method and plugin reporting at
decision points, and they correct the CHANGELOG's stale statement that a new
protocol route is required. Hold S4 to S6 for separate scope questions. Ship
none of this as a lossless-delivery claim.

Open questions for the scope decision (product copy and engineering only):

1. Is `withheld_by_recipient` as one collapsed reason acceptable, or does a
   given audience need more detail?
2. Is the "no sign of work" derivation (S4) wanted, and what default threshold?
3. Does Part B justify a new on-disk journal and option, given it narrows rather
   than closes the loss window?
