export const schemaSql = `
CREATE TABLE IF NOT EXISTS fleets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (fleet_id, email),
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL,
  hostname TEXT,
  policy_profile TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  consecutive_missed_heartbeats INTEGER NOT NULL DEFAULT 0,
  auto_quarantined_at TEXT,
  quarantine_reason TEXT,
  operator_trusted INTEGER NOT NULL DEFAULT 0,
  peer_autoreply INTEGER NOT NULL DEFAULT 0,
  peer_turn_budget INTEGER NOT NULL DEFAULT 6,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE TABLE IF NOT EXISTS agent_credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_by_operator_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_agent_id TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id),
  FOREIGN KEY (issued_by_operator_id) REFERENCES operators(id),
  FOREIGN KEY (used_by_agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT,
  message_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  metadata_json TEXT,
  ttl_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id),
  FOREIGN KEY (sender_agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  delivered_at TEXT,
  acked_at TEXT,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_failure_reason TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (recipient_agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_operator_id TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics_json TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  resource_kind TEXT NOT NULL,
  resource_id TEXT,
  conversation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_id TEXT,
  action_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_operator_id TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (resolved_by_operator_id) REFERENCES operators(id)
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  rule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (fleet_id, name),
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE TABLE IF NOT EXISTS control_actions (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  issued_by_operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id),
  FOREIGN KEY (issued_by_operator_id) REFERENCES operators(id)
);

CREATE TABLE IF NOT EXISTS replay_nonces (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, nonce),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_agents_fleet_status ON agents(fleet_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_status ON messages(fleet_id, recipient_kind, recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(fleet_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status ON message_deliveries(recipient_agent_id, status, queued_at);
CREATE INDEX IF NOT EXISTS idx_events_fleet_created_at ON events(fleet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_fleet_status ON approvals(fleet_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_controls_target ON control_actions(fleet_id, target_kind, target_id, created_at);

CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  original_delivery_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  metadata_json TEXT,
  retry_count INTEGER NOT NULL,
  failure_reason TEXT NOT NULL,
  dead_lettered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  agent_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, window_start)
);

CREATE TABLE IF NOT EXISTS rate_limit_violations (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_fleet ON dead_letters(fleet_id, dead_lettered_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON message_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_rate_violations_agent ON rate_limit_violations(agent_id, created_at);

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

-- File attachments: metadata only. Bytes live on disk at storage_path,
-- keyed by the generated id (never the user filename → no path traversal).
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  uploader_kind TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_fleet_created ON attachments(fleet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_recency ON heartbeats(agent_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(fleet_id, sender_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_queued ON message_deliveries(recipient_agent_id, queued_at);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 30,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  created_by_operator_id TEXT,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);
CREATE TABLE IF NOT EXISTS feed_subscribers (
  feed_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (feed_id, agent_id),
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);
CREATE TABLE IF NOT EXISTS feed_seen (
  feed_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT,
  link TEXT,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (feed_id, guid),
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);
CREATE INDEX IF NOT EXISTS idx_feeds_fleet ON feeds(fleet_id);
CREATE INDEX IF NOT EXISTS idx_feed_seen_recent ON feed_seen(feed_id, delivered_at);
`;
