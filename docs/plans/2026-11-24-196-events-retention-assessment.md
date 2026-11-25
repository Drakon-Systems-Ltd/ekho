# #196 R1: events table retention assessment (static, read-only)

Refs #196. Based on `origin/main` at `6c852b1`. Marks: **[read]** = confirmed by reading the cited code, **[arith]** = arithmetic on stated numbers, **[infer]** = inference, not verified. No relay, database or load run was used. No behaviour changes.

## 1. How the event sweep works

- **[read]** Allowlist: only types in `PRUNABLE_EVENT_TYPES` (`db.ts` 286-297) are deleted. A type not named there is retained forever (comment, `db.ts` 269-285).
- **[read]** Cutoff: `now - config.eventRetentionSeconds`, default 30 days (`config.ts` 140). Rows of prunable types older than that are eligible (`db.ts` 4656).
- **[read]** Batching: `RETENTION_BATCH_SIZE` 5,000, `RETENTION_MAX_BATCHES_PER_TICK` 10, so at most 50,000 rows per table per tick (`db.ts` 313-316).
- **[read]** Early stop: the loop breaks when a batch deletes fewer than 5,000 rows, treating that as "backlog drained" (`db.ts` 4667-4671).
- **[read]** Tick: `EKHO_SWEEP_INTERVAL_MS`, default 30,000 ms (`config.ts` 46); the sweep calls `sweepEventRetention` from `sweep.ts` 76.
- **[read]** Index: `idx_events_type_created_at` on `events(event_type, created_at)` (`schema.ts` 260), which fits the `event_type IN (...) AND created_at < ?` predicate.
- **[read]** No `VACUUM` runs (`db.ts` batching comment): deleted rows free pages for reuse but the file does not shrink.

## 2. What the reported deletion counts show, and what they do not

The issue (#196) reports sweep ticks deleting 12 to 37 rows and about 914k events.

- **[read]** 50,000 per table is the **cap** of one tick, not the signature of a backlog. A tick can start with 6,000 eligible rows and drain them in two batches (5,000, then 1,000). The loop stops after the first batch that deletes fewer than 5,000.
- **[read]** What a low count does show: little was eligible at that sweep. A tick that deletes 12 rows found about 12 rows of prunable types older than the cutoff. It does not say how fast rows arrive over a day, or how many rows are retained.
- **[infer]** So the counts support only "no large eligible backlog at those sweeps". They do not show that the table is bounded or that it cannot grow without limit.

### Scenario (assumption, not a finding)

Assumptions: stable prunable inflow of about 12 rows per 30 s tick, default retention (30 days), default tick (30 s), sweep keeping up.

- **[arith]** 12 x 2,880 ticks per day = 34,560 prunable rows a day; x 30 days = 1,036,800 rows. Under these assumptions the prunable part would settle near 1.04 million.
- **[infer]** The reported 914k is the same order of magnitude, but the comparison illustrates scale only; it is not evidence for the scenario. The 914k total cannot contain the scenario's full steady-state prunable population (1.04 million), it includes an unknown share of retained types (section 3, notably `message.delivered`), the real inflow rate is unknown, and 12 to 37 rows per tick is a handful of samples, not a measured steady state.
- **[infer]** Two different questions follow. Today's eligible backlog looks small (low counts). Longer-term growth is a separate question: the retained-forever types have no upper bound at all, and `message.delivered` grows with message volume (section 4). Neither can be settled without the real type mix and age profile (section 6).

## 3. Every event type the relay writes

Written through `recordEvent` (`db.ts` 4828) or the one direct `INSERT INTO events` in the inbox path (`db.ts` 2142-2160). Lines are call sites in `db.ts` **[read]**. Volume driver: H = per agent heartbeat, M = per message, O = per operator action, S = system or sweep event, rare = low volume.

| Type | Class | Written at | Driver |
|---|---|---|---|
| `agent.heartbeat` | pruned | 3044 | H (the bulk, per the allowlist comment) |
| `message.queued` | pruned | 1668, 1931, 2093 | M |
| `message.acked` | pruned | 2971 | M |
| `message.policy_denied` | pruned | 1715, 4216 | M, rare |
| `agent.rate_limit_exceeded` | pruned | 4401 | S |
| `attachment.rate_limit_exceeded` | pruned | 4593 | S |
| `feed.delivered` | pruned | 3365 | S per feed run |
| `conversation.resumed` | pruned | 2053, 2100 | O |
| `conversation.stalled` | pruned | 4819 | S |
| `room.project_mode_changed` | pruned | 2038 | O |
| `message.delivered` | **retained forever** | 2142-2160 (direct insert) | **M, one per delivery** |
| `message.expired` | retained | 4536 | S per expiry |
| `message.retry_requeued` | retained | 4333 | S per retry |
| `message.dead_lettered` | retained (named deliberate) | 4368 | S per dead letter |
| `attachment.uploaded` | retained | 4563 | per upload |
| `approval.requested`, `approval.result` | retained | 3072, 3094 | per approval |
| `approval.approved`, `approval.rejected` (from `approval.${status}`) | retained | 3123 | O |
| `agent.pause`, `agent.resume`, `agent.quarantine` (from `agent.${action}`) | retained | 3157 | O |
| `agent.trust_changed`, `agent.peer_autoreply_changed` | retained | 3176, 3206 | O, rare |
| `agent.auto_quarantined`, `agent.auto_unquarantined` | retained | 4482, 4512, 3037 | S, rare |
| `room.created`, `room.deleted` | retained | 1993, 2113 | O, rare |
| `feed.created`, `feed.deleted`, `feed.subscribers_changed` | retained | 3231, 3260, 3277 | O, rare |
| `policy.created`, `policy.updated`, `policy.deleted` | retained | 4258, 4283, 4290 | O, rare |
| `operator_key.registered`, `.endorsed`, `.revoked`, `.recovery_grant_armed`, `.recovery_grant_cancelled`, `.recovery_grant_consumed`, `agent_key.endorsed` | retained | 771, 863, 1070, 601, 622, 876, 1180 | O, rare |

The two template types are resolved to concrete names **[read]**: `approval.${status}` is built from `status: "approved" | "rejected"` and `agent.${action}` from `action: "pause" | "resume" | "quarantine"`, both finite unions in the method signatures.

The classification test (`packages/relay/tests/event-retention-classification.test.ts`) pins this table. It is a text scan with fixed patterns, not proof about the relay. For the current forms in `packages/relay/src`:

- It reads `db.ts` as text (it does not import it or open a database). A literal event type in neither `PRUNABLE_EVENT_TYPES` nor the test's retained list fails.
- Templates: for each `` this.recordEvent(..., `prefix${name}`, ...) ``, `name` must be a parameter of the method that contains the call, and the whole declared type of that parameter must be a union of string literals. A non-literal member, `?`, a default value, a type alias, a destructured parameter, or a name that is not a parameter of that method fails. The union must equal the five concrete names above; widening or narrowing it fails until the new name is classified and the expected list is updated.
- Inserts: the only recognised spelling is a double-quoted SQL literal that starts `INSERT [OR x] INTO events` (any case) with a column list and a `VALUES` list. `event_type` must appear once, every value must be a bare `?`, and the placeholder, column and `.run` argument counts must be equal. The event type is read from the `.run` argument at the `event_type` column. Inline form (in `recordEvent`): that argument must be `eventType`, and `eventType` must be `recordEvent`'s second parameter. Prepared form (`const X = this.db.prepare("...")`): every `X.run(...)` from the end of that SQL literal to the end of the enclosing block must carry a classified literal type, and `X` must be run at least once. Any other `INSERT INTO events` text fails as unrecognised.
- `recordEvent` may only be referenced as `this.recordEvent(...)`; any other reference fails.

Blind spots, in plain words. The test does **not** see:

- an events table name that is quoted, bracketed or schema-qualified (for example `"events"`, `main.events`);
- `REPLACE INTO events`;
- SQL assembled from variables or concatenated pieces, or a backtick literal that does not spell `INSERT INTO events` in the pattern above;
- a statement prepared in one block and run in another;
- any write made outside `packages/relay/src`.

The check for other source files is the same kind of text pattern (`into events` or `recordEvent`, any case). It is not proof that no other file writes events.

Evidence for this round (synthetic fixtures, no relay or database run): F0 to F3 and new fixtures A1 to A7 (parameter type) and B1 to B8 (SQL binding). Against the previous scanner 11 of the 24 tests failed; A2, A3, A5 and A7 already failed closed for incidental reasons and are guards. Four temporary text mutations of `db.ts` (`| string` appended to `action`; `event_type` moved in the first insert's column list; `recordEvent`'s second parameter renamed; `status` given a default) each made the new test fail and were reverted; the first two passed the previous test (9 of 9). Details are in the PR comment.

## 4. Finding: `message.delivered` is never pruned

- **[read]** It is written once per delivery handed to an agent, by a direct insert, not through `recordEvent` (`db.ts` 2142-2160).
- **[read]** It is not in `PRUNABLE_EVENT_TYPES`. Its siblings `message.queued` and `message.acked` are.
- **[read]** The allowlist comment lists what is absent on purpose (operator_key.*, agent_key.*, policy.*, approval.*, trust, quarantine, room and feed lifecycle, dead-lettering). `message.delivered` is not on that list.
- **[read]** The console treats it as noise next to heartbeats and acks (`frontend/src/consoleState.js` 206).
- **[infer]** Nothing in the code says retaining it forever was a decision. It was most likely never classified because it bypasses `recordEvent`.
- **[infer]** The part of `events` that grows without bound is therefore per-message volume. Whether that matters on a given relay is unknown without data.

## 5. What static reading cannot tell

- The real type mix and age profile on any relay.
- Whether the database file shrinks. By design no `VACUUM` runs, so it will not on its own.
- The query plan of the `DELETE ... WHERE rowid IN (SELECT ...)` statement on a large table.
- Whether any other source file writes events: a text search found `recordEvent` only in `db.ts`, but other files were not read in full **[infer]**.

## 6. Optional operator query (read-only, offered, not requested)

An operator who wants the real mix can run this against a read-only copy or a quiet window. It writes nothing:

```sql
SELECT event_type, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
FROM events GROUP BY event_type ORDER BY n DESC;
```

The `idx_events_type_created_at` index covers it, but a full group-by on a large table still reads every index entry, so run it off-peak.

## 7. Open policy question (not decided here)

Should `message.delivered` become prunable, and if so after what window? Pruning deletes history on every relay that upgrades, so it is a retention policy change and needs its own decision. This document is its input; nothing here recommends or enacts it.
