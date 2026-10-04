-- One-off operator-key recovery grants (#93).
--
-- A grant lets ONE named operator key (the "recovering" key, e.g. the key that
-- endorsed a trust root whose browser passphrase was lost) endorse exactly ONE
-- named, already-registered, unendorsed successor operator key, once, before
-- expires_at. It is armed only from the relay host (src/recovery-grant.ts, run
-- by whoever operates the relay box after the operator confirms to them out of
-- band) and never through the HTTP API. It is consumed in the same transaction
-- as the endorsement it permits. It never applies to agent-key endorsements.
--
-- Existing databases get the table here, fresh ones from schema.ts. Both are
-- IF NOT EXISTS so the two paths never collide.
CREATE TABLE IF NOT EXISTS operator_recovery_grants (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  endorser_key_id TEXT NOT NULL,
  target_key_id TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);
CREATE INDEX IF NOT EXISTS idx_operator_recovery_grants_fleet ON operator_recovery_grants(fleet_id, endorser_key_id);
