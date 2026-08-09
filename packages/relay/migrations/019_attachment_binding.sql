-- #7: attachments need a lifecycle. bound_message_id/bound_at mark an upload as
-- referenced by a message. The sweep GCs unbound uploads after a short TTL and
-- bound ones after the retention window, deleting bytes on disk with the row.
-- NOTE: keep these comments free of semicolons and quote characters, because
-- the migration runner splits statements naively.
ALTER TABLE attachments ADD COLUMN bound_message_id TEXT;
ALTER TABLE attachments ADD COLUMN bound_at TEXT;
CREATE INDEX IF NOT EXISTS idx_attachments_bound_created ON attachments(bound_at, created_at);
