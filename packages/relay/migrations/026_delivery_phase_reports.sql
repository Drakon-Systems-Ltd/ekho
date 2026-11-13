-- #155 Phase 1b relay phase storage. Statements are deliberately idempotent on fresh schema.
ALTER TABLE message_deliveries ADD COLUMN floor_wait_started_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN floor_holder_agent_id TEXT;
ALTER TABLE message_deliveries ADD COLUMN floor_granted_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN floor_overrun_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN adapter_dead_lettered_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN adapter_dead_letter_reason TEXT;
ALTER TABLE message_deliveries ADD COLUMN turn_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_deliveries ADD COLUMN latest_attempt INTEGER;
ALTER TABLE message_deliveries ADD COLUMN latest_turn_id TEXT;
ALTER TABLE message_deliveries ADD COLUMN latest_turn_started_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN latest_turn_outcome TEXT;
ALTER TABLE message_deliveries ADD COLUMN latest_turn_category TEXT;
ALTER TABLE message_deliveries ADD COLUMN attempts_capped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_deliveries ADD COLUMN first_reply_at TEXT;
ALTER TABLE message_deliveries ADD COLUMN first_reply_turn_id TEXT;
ALTER TABLE message_deliveries ADD COLUMN phase_recorded_at TEXT;
CREATE TABLE IF NOT EXISTS delivery_turn_attempts (
  delivery_id TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 8),
  started_at TEXT,
  ended_at TEXT,
  outcome TEXT,
  category TEXT,
  phase_recorded_at TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient_agent_id, turn_id),
  UNIQUE (message_id, recipient_agent_id, attempt),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (recipient_agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_turn_attempts_reply ON delivery_turn_attempts(recipient_agent_id, turn_id, delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_turn_attempts_delivery ON delivery_turn_attempts(delivery_id);
CREATE TABLE IF NOT EXISTS agent_turn_replies (
  fleet_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  first_reply_at TEXT NOT NULL,
  PRIMARY KEY (fleet_id, agent_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_turn_replies_at ON agent_turn_replies(first_reply_at);
