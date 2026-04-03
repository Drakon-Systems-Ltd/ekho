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
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (recipient_agent_id) REFERENCES agents(id)
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
