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
| Event retention | Prune after 30 days | Events table grows 3x faster than messages |

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

### Database maintenance

SQLite databases grow over time. Periodically run:

```sql
-- Remove old events (keep 30 days)
DELETE FROM events WHERE created_at < datetime('now', '-30 days');

-- Remove old nonces (keep 24 hours)
DELETE FROM replay_nonces WHERE created_at < datetime('now', '-1 day');

-- Reclaim disk space
VACUUM;
```

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
