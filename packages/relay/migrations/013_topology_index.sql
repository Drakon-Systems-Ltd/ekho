-- Topology map: the collaboration-edge query joins messages -> message_deliveries
-- by message_id. message_deliveries had no index leading with message_id, so that
-- join full-scanned the whole delivery history on every operator-console poll
-- (regardless of the time window). This index drives the join from messages into
-- deliveries instead.
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON message_deliveries(message_id, recipient_agent_id);
