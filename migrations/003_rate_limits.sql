CREATE TABLE IF NOT EXISTS rate_limit_counters (
  agent_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, window_start)
);

CREATE TABLE IF NOT EXISTS rate_limit_violations (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_violations_agent ON rate_limit_violations(agent_id, created_at);
