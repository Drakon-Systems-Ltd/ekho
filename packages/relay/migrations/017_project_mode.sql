-- Project mode: designated working rooms carry a higher per-conversation peer
-- turn budget than the per-agent default, so long collaborative threads don't
-- exhaust bounded delegation mid-project. Off by default.
ALTER TABLE rooms ADD COLUMN project_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN project_turn_budget INTEGER NOT NULL DEFAULT 100;
