-- Operator display name: a team-visible name for the operator (e.g. "Michael").
-- Stamped into the sender_label of operator messages so agents see who is
-- talking to them, and mirrored onto the synthetic operator node's display_name
-- so topology/health/roster read it too. NULL falls back to "Operator".
ALTER TABLE operators ADD COLUMN display_name TEXT;
