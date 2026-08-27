-- #58: A2A tasks were only stamped with their RECIPIENT (agent_id), so the relay
-- had no way to answer who owns this task for the agent that created it.
-- tasks/list therefore fell back to a fleet-wide scan and tasks/get / tasks/cancel
-- did no scoping at all, letting any enrolled agent read another agents task
-- history and cancel its work. sender_agent_id records the creating agent so
-- every read/cancel can be scoped to a participant of the task.
--
-- Backfill: existing rows recover their sender from the Ekho message the task was
-- linked to at creation. Rows with no linked message stay NULL and are visible
-- only to their recipient, which fails closed.
--
-- NOTE: keep these comments free of semicolons and quote characters, because the
-- migration runner splits statements naively.
-- NOTE: the sender index lives here and NOT in schema.ts. schema.ts is exec-d on
-- every boot BEFORE migrations run, so on an existing database the column does
-- not exist yet and a CREATE INDEX over it would abort the whole boot.
ALTER TABLE a2a_tasks ADD COLUMN sender_agent_id TEXT;
UPDATE a2a_tasks SET sender_agent_id = (SELECT m.sender_agent_id FROM a2a_task_messages tm JOIN messages m ON m.id = tm.message_id WHERE tm.task_id = a2a_tasks.id ORDER BY m.created_at ASC LIMIT 1) WHERE sender_agent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_sender ON a2a_tasks(sender_agent_id, updated_at DESC);
