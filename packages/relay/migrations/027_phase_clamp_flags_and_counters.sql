-- #155 clamp flag and counters (design 2.2, 2.4). Additive, defaulted columns only; no row is rewritten.
ALTER TABLE message_deliveries ADD COLUMN phase_time_clamped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_turn_attempts ADD COLUMN time_clamped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN phase_invalid_holder_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN phase_refused_attempt_reports INTEGER NOT NULL DEFAULT 0;
