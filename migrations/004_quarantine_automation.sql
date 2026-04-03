ALTER TABLE agents ADD COLUMN consecutive_missed_heartbeats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN auto_quarantined_at TEXT;
ALTER TABLE agents ADD COLUMN quarantine_reason TEXT;
