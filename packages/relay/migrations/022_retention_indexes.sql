-- Retention pruning for events and heartbeats (#75). Both tables grew without
-- bound — a small long-running fleet accumulates millions of rows — and the
-- sweep that now prunes them selects by AGE, which neither existing index
-- supports. idx_events_fleet_created_at leads on fleet_id and
-- idx_heartbeats_agent_recency leads on agent_id, so a global age scan reads
-- every row. These two put the sweep's leading column first.
--
-- Existing databases get them here, fresh ones get them from schema.sql. Runs
-- exactly once, gated by schema_migrations like every other migration, and both
-- statements are IF NOT EXISTS so the two paths never collide.
--
-- No VACUUM: deleting rows leaves the SQLite file the same size, but reclaiming
-- it needs ~2x the database in free disk and an exclusive lock, which is an
-- explicit operator decision rather than something a migration or a sweep tick
-- should do behind their back.
CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_heartbeats_received_at ON heartbeats(received_at);
