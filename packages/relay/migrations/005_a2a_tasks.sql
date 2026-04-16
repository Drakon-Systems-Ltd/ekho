CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  state TEXT NOT NULL,
  history_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_agent ON a2a_tasks(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_fleet ON a2a_tasks(fleet_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);

CREATE TABLE IF NOT EXISTS a2a_task_messages (
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id),
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);
