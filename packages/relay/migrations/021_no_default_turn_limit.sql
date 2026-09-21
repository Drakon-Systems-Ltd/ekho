-- Peer turn budgets become opt-in: 0 = no limit, and that is the new default.
-- Rows still holding a value the relay used to hard-wire are converted to 0:
--   agents.peer_turn_budget    6   (column default from migration 009)
--                              25  (enrollment default since project mode shipped)
--   rooms.project_turn_budget  100 (column default from migration 017)
-- Any other value was typed in by an operator and is preserved as their cap.
--
-- Runs exactly once, gated by schema_migrations like every other migration, so
-- an operator who LATER sets a cap of 6, 25 or 100 keeps it across restarts.
-- Unavoidable trade-off: a cap of exactly 6/25 (agent) or 100 (room) chosen
-- deliberately BEFORE this upgrade is indistinguishable from the old default
-- and is cleared too - re-enter it from the console after upgrading.
--
-- SQLite cannot change a column DEFAULT in place, so upgraded databases keep
-- the old DEFAULT in their table definition. The relay therefore always writes
-- the budget explicitly on INSERT (enrollAgent, createRoom) and never relies on it.
UPDATE agents SET peer_turn_budget = 0 WHERE peer_turn_budget IN (6, 25);
UPDATE rooms SET project_turn_budget = 0 WHERE project_turn_budget = 100;
