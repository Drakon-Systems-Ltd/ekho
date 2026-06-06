-- Bounded agent-to-agent delegation, tunable per agent from the operator console.
ALTER TABLE agents ADD COLUMN peer_autoreply INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN peer_turn_budget INTEGER NOT NULL DEFAULT 6;
