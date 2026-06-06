-- Indexes for the fleet-health board's per-agent lookups (the heartbeats table
-- grows ~once per agent every 30s, so the "latest heartbeat per agent" + the
-- last-hour throughput counts need index support).
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_recency ON heartbeats(agent_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(fleet_id, sender_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_queued ON message_deliveries(recipient_agent_id, queued_at);
