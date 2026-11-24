# #196 R1: events table retention assessment (static, read-only)

Refs #196. Based on `origin/main` at `6c852b1`. Marks: **[read]** = confirmed by reading the cited code, **[arith]** = arithmetic on stated numbers, **[infer]** = inference, not verified. No relay, database or load run was used. No behaviour changes.

## 1. How the event sweep works

- **[read]** Allowlist: only types in `PRUNABLE_EVENT_TYPES` (`db.ts` 286-297) are deleted. A type not named there is retained forever (comment, `db.ts` 269-285).
- **[read]** Cutoff: `now - config.eventRetentionSeconds`, default 30 days (`config.ts` 140). Rows older than that are eligible (`db.ts` 4656).
- **[read]** Batching: `RETENTION_BATCH_SIZE` 5,000, `RETENTION_MAX_BATCHES_PER_TICK` 10, so at most 50,000 rows per table per tick (`db.ts` 313-316).
- **[read]** Early stop: the loop breaks when a batch deletes fewer than 5,000 rows, treating that as "backlog drained" (`db.ts` 4667-4671).
- **[read]** Tick: `EKHO_SWEEP_INTERVAL_MS`, default 30,000 ms (`config.ts` 46); the sweep calls `sweepEventRetention` from `sweep.ts` 76.
- **[read]** Index: `idx_events_type_created_at` on `events(event_type, created_at)` (`schema.ts` 260), which fits the `event_type IN (...) AND created_at < ?` predicate.
- **[read]** No `VACUUM` runs (`db.ts` batching comment): deleted rows free pages for reuse but the file does not shrink.

## 2. Per-tick drain argument

The issue (#196) reports sweep ticks deleting 12 to 37 rows and about 914k events.

- **[read]** A tick that deletes fewer than 5,000 rows in its first batch has drained everything eligible. A backlog would show 50,000 per tick.
- **[arith]** 12 rows per tick x 2,880 ticks per day (30 s) is about 34,560 a day; x 30 days is about 1.04 million. The issue's 914k is the same order.
- **[infer]** So 914k reads as the designed bound (30 days of prunable inflow), not a leak, and a working sweep cannot shrink it without a policy change. This relies on two numbers quoted in the issue; the real tick and retention settings on that relay are not known.

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
| `approval.${status}` (template) | retained | 3123 | O |
| `agent.${action}` (template) | retained | 3157 | O |
| `agent.trust_changed`, `agent.peer_autoreply_changed` | retained | 3176, 3206 | O, rare |
| `agent.auto_quarantined`, `agent.auto_unquarantined` | retained | 4482, 4512, 3037 | S, rare |
| `room.created`, `room.deleted` | retained | 1993, 2113 | O, rare |
| `feed.created`, `feed.deleted`, `feed.subscribers_changed` | retained | 3231, 3260, 3277 | O, rare |
| `policy.created`, `policy.updated`, `policy.deleted` | retained | 4258, 4283, 4290 | O, rare |
| `operator_key.registered`, `.endorsed`, `.revoked`, `.recovery_grant_armed`, `.recovery_grant_cancelled`, `.recovery_grant_consumed`, `agent_key.endorsed` | retained | 771, 863, 1070, 601, 622, 876, 1180 | O, rare |

The classification test (`packages/relay/tests/event-retention-classification.test.ts`) pins this table: a type in neither list fails.

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
