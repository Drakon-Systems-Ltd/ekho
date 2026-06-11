-- Floor control: at most one agent "holds the floor" of a conversation at a
-- time, so agents take turns instead of all replying at once. The floor is
-- TTL'd (auto-releases if the holder crashes) and only the holder can release.
CREATE TABLE IF NOT EXISTS conversation_floors (
  conversation_id TEXT PRIMARY KEY,
  fleet_id        TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  acquired_at     TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_floors_fleet ON conversation_floors(fleet_id, expires_at);
