# Performance & Scaling Guide

## Benchmark Results

Tested on a single-instance relay with SQLite (WAL mode) on macOS, Node.js 22. All tests run sequentially (not concurrent) — real-world throughput with concurrent agents will vary.

| Metric | 20 agents / 2K msgs | 50 agents / 25K msgs | 100 agents / 100K msgs |
|--------|---------------------|----------------------|------------------------|
| **Send throughput** | 1,630 msg/s | 1,586 msg/s | 1,516 msg/s |
| **Avg send latency** | 0.61ms | 0.63ms | 0.66ms |
| **Avg poll latency** | 1.93ms | 4.28ms | 6.11ms |
| **Avg enroll time** | 2.66ms | 1.39ms | 1.15ms |
| **Avg heartbeat** | 0.43ms | 0.69ms | 1.13ms |
| **Database size** | 4.5 MB | 39.9 MB | 151.2 MB |
| **Events recorded** | 6,020 | 35,050 | 120,100 |

### Key Findings

- **Send throughput is stable** at ~1,500 msg/s regardless of database size
- **Poll latency scales linearly** with agents (more agents = more rows to scan)
- **SQLite handles 100K+ messages** without degradation in write performance
- **Database grows ~1.5 MB per 1,000 messages** (including events and delivery tracking)
- **Zero errors** across all test runs — no dropped messages

## Recommended Limits

| Dimension | Recommended | Hard Limit |
|-----------|-------------|------------|
| Agents per fleet | Up to 200 | SQLite can handle thousands, but poll latency increases |
| Messages per second | Up to 1,000 sustained | ~1,500 peak before write contention |
| Message body size | < 64 KB | Limited by request body parsing, not Ekho |
| Concurrent pollers | Up to 50 | SQLite WAL allows concurrent reads |
| Database size | Up to 1 GB | SQLite handles multi-GB, but backup/recovery slows |
| Event retention | 30 days (automatic, `EKHO_EVENT_RETENTION_SECONDS`) | Events table grows 3x faster than messages |

## Tuning

### Sweep interval

The default sweep runs every 30 seconds. For high-volume deployments, increase to 60-120s to reduce write contention:

```
EKHO_SWEEP_INTERVAL_MS=60000
```

### Rate limiting

Default: 30 messages per agent per minute. For trusted internal agents, increase:

```
EKHO_RATE_LIMIT_MAX_MESSAGES=100
EKHO_RATE_LIMIT_WINDOW_SECONDS=60
```

### Heartbeat timeout

Default: 90 seconds. For agents with long-running tasks, increase:

```
EKHO_HEARTBEAT_TIMEOUT_SECONDS=300
EKHO_HEARTBEAT_LIVENESS_THRESHOLD=5
```

### Retention

The sweep prunes history automatically — nothing to run by hand, and no query
that could take the audit trail with it:

```
EKHO_EVENT_RETENTION_SECONDS=2592000      # operational events: 30 days (default)
EKHO_HEARTBEAT_RETENTION_SECONDS=172800   # heartbeat history: 48h (default)
```

- **Events** are pruned by an **allowlist** of high-volume operational types
  (`agent.heartbeat`, `message.queued`/`acked`/`policy_denied`, rate-limit
  strikes, `feed.delivered`, conversation resumed/stalled, room project-mode
  changes). Anything not on that list — the operator-key audit trail, policy,
  approvals, trust changes, quarantine decisions, room and feed lifecycle, and
  any event type added in a future release — is **kept forever**, whatever the
  retention is set to.
- **Heartbeats** older than the window are dropped, except each agent's most
  recent row, which is always kept so a quiet agent never vanishes from the
  health board.
- Replay nonces and attachments have their own retention
  (`EKHO_ENVELOPE_NONCE_RETENTION_SECONDS`, `EKHO_ATTACHMENT_RETENTION_SECONDS`).

Pruning happens in bounded batches, capped per sweep tick, so a large backlog
drains over several ticks instead of holding the write lock through one long
`DELETE`.

### Reclaiming disk space

Deleting rows does not shrink the SQLite file — freed pages are reused for new
writes. To hand the space back to the filesystem, run `VACUUM` **manually**,
during a quiet window:

```sql
VACUUM;
```

It needs roughly the database's own size again in free disk and holds an
exclusive lock for the duration, so the relay never runs it automatically.

## When to Scale Beyond SQLite

Consider PostgreSQL (Pro tier) when:

- You need **multi-instance relay** (SQLite is single-writer)
- Your database exceeds **2 GB** and backup windows become problematic
- You need **concurrent write throughput** above 1,500 msg/s
- You're running **multiple fleets** with cross-fleet isolation requirements

## Running the Load Test

```bash
npx tsx scripts/load-test.ts                        # Default: 20 agents, 2K messages
npx tsx scripts/load-test.ts --agents 50 --messages 500   # Custom
npx tsx scripts/load-test.ts --agents 100 --messages 1000  # Stress test
```

The test creates a temporary database, starts a relay on a random port, runs all benchmarks, and cleans up.
