-- Feeds: operator-configured sources (RSS/Atom) the relay polls and delivers to
-- subscribed agents as non-waking context (message_type 'feed' is not in any
-- agent's trigger set, so it never spends a turn).
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
-- Doubles as the dedup ledger AND the recent-items list for the console.
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
