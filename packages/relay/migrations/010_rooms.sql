-- Rooms: named conversations with a chosen set of member agents, so the operator
-- can run parallel projects with agent subsets. A message whose conversation_id
-- is a room is fanned out to all members (minus the sender).
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
CREATE INDEX IF NOT EXISTS idx_rooms_fleet ON rooms(fleet_id, created_at);
