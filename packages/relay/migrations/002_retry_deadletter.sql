-- Retry tracking on existing deliveries table
ALTER TABLE message_deliveries ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_deliveries ADD COLUMN next_retry_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN last_failure_reason TEXT;

-- Dead-letter archive
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  original_delivery_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  metadata_json TEXT,
  retry_count INTEGER NOT NULL,
  failure_reason TEXT NOT NULL,
  dead_lettered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_fleet ON dead_letters(fleet_id, dead_lettered_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON message_deliveries(status, next_retry_at);
