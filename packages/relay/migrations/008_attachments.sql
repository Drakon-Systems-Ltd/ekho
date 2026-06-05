-- File attachments: metadata only. Bytes live on disk at storage_path,
-- keyed by the generated id (never the user filename → no path traversal).
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  uploader_kind TEXT NOT NULL,          -- 'operator' | 'agent'
  uploader_id TEXT NOT NULL,            -- operator id or agent id
  filename TEXT NOT NULL,               -- sanitized display filename
  mime TEXT NOT NULL,                   -- validated against the allowlist
  size_bytes INTEGER NOT NULL,          -- actual decoded byte length
  storage_path TEXT NOT NULL,           -- absolute path on disk
  created_at TEXT NOT NULL,
  FOREIGN KEY (fleet_id) REFERENCES fleets(id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_fleet_created ON attachments(fleet_id, created_at);
