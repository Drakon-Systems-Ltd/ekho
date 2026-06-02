-- Support efficient pruning of stale replay nonces by age.
CREATE INDEX IF NOT EXISTS idx_replay_nonces_created_at ON replay_nonces(created_at);
