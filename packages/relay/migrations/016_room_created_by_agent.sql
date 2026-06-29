-- Agent-opened topic rooms. Until now a room could only be created by the
-- operator (created_by_operator_id). Agents that judge a thread has become a
-- real topic now open a named room themselves (POST /v1/rooms), so the creator
-- may be an agent. Add a nullable created_by_agent_id alongside the existing
-- created_by_operator_id — exactly one is set per room, recording who opened it.
ALTER TABLE rooms ADD COLUMN created_by_agent_id TEXT;
