// Tiny static server + mocked operator API for the mobile layout regression test.
// Serves packages/relay/ui-dist and fabricates adversarial data (long ids, hashes,
// code blocks, wide tables) so layout overflow bugs reproduce deterministically.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../ui-dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const HASH = "sha256:" + "a1b2c3d4e5f60718".repeat(8);
const LONG_ID = "conv-" + "0123456789abcdef".repeat(5);
const CODE = "const veryLongLine = await relay.send({ recipient: 'agent-with-a-very-long-name', payload: { hash: '" + HASH + "' } });";
const now = Date.now();
const iso = (m) => new Date(now - m * 60000).toISOString();

const agents = [
  { id: "agent-" + "x".repeat(40), agent_id: "agent-" + "x".repeat(40), display_name: "Jarvis", status: "healthy", last_seen_at: iso(1), fleet_id: "f1" },
  { id: "tars", agent_id: "tars", display_name: "Tars with an extraordinarily long display name for testing", status: "healthy", last_seen_at: iso(2), fleet_id: "f1" },
];
const event = (i, side, text) => ({
  id: "ev" + i, event_type: "message.queued", actor_kind: side === "op" ? "operator" : "agent",
  actor_id: side === "op" ? "operator" : agents[0].id, created_at: iso(30 - i), resource_kind: "message", resource_id: "m" + i,
  conversation_id: LONG_ID, message_body_json: JSON.stringify({ text }), payload_json: JSON.stringify({ message_type: "text" }),
});
const events = [
  event(1, "op", "hello " + HASH),
  event(2, "agent", "Here is the hash " + HASH + " and path /home/ubuntu/clawd/projects/ekho/packages/relay/frontend/src/very/long/path/to/file.jsx"),
  event(3, "agent", "```\n" + CODE + "\n```"),
  event(4, "agent", "| col a | col b | col c | col d |\n|---|---|---|---|\n| " + HASH + " | " + HASH + " | x | y |"),
  event(5, "agent", "https://example.com/" + "segment/".repeat(20) + "end"),
];
// Command Deck shapes mirror db.getTopology (getFleetHealth nodes + folded edges) and
// db.getActivity (parsed `payload`, resolved actor_name). One unit is quarantined so the
// deck shows a non-zero alert count; names, ids and models are deliberately long.
const node = (a, o = {}) => ({
  id: a.id, display_name: a.display_name, runtime: "openclaw", status: "healthy", last_seen_at: iso(1),
  consecutive_missed_heartbeats: 0, operator_trusted: true, peer_autoreply: true, peer_turn_budget: 4,
  last_heartbeat_at: iso(1), metrics: { model: "anthropic/claude-opus-5-5-with-a-very-long-model-suffix" }, health: { level: "ok" },
  active_conversations: [LONG_ID], sent_1h: 12, received_1h: 9, ...o,
});
const QUAR_ID = "agent-quarantined-" + "q".repeat(36);
const topology = {
  generated_at: iso(0), window_minutes: 60,
  nodes: [
    node(agents[0]),
    node(agents[1], { runtime: "claude-code", operator_trusted: false, peer_autoreply: false, sent_1h: 3, received_1h: 40 }),
    node({ id: QUAR_ID, display_name: "Quarantined unit with a remarkably long display name" }, { status: "quarantined", sent_1h: 0, received_1h: 1 }),
  ],
  edges: [{ source: agents[0].id, target: agents[1].id, count: 7, last_at: iso(2) }],
};
const activity = {
  events: [
    { id: "ac1", event_type: "message.queued", actor_kind: "agent", actor_id: agents[0].id, actor_name: "Jarvis", resource_kind: "message", resource_id: "m1", resource_name: "m1", conversation_id: LONG_ID, payload: { recipient_kind: "agent", recipient_id: agents[1].id, text: "Here is the hash " + HASH }, created_at: iso(3) },
    { id: "ac2", event_type: "agent.quarantined", actor_kind: "operator", actor_id: "operator", actor_name: "operator", resource_kind: "agent", resource_id: QUAR_ID, resource_name: QUAR_ID, conversation_id: null, payload: { reason: "suspicious " + HASH } , created_at: iso(5) },
    { id: "ac3", event_type: "agent.peer_autoreply_changed", actor_kind: "operator", actor_id: agents[0].id, actor_name: "Jarvis", resource_kind: "agent", resource_id: agents[0].id, resource_name: "Jarvis", conversation_id: null, payload: { peer_autoreply: true, peer_turn_budget: 4 }, created_at: iso(8) },
  ],
};
const json = (o) => JSON.stringify(o);
const api = (p) => {
  if (p.startsWith("/v1/operator/overview")) return { agents, recentConversations: [{ conversation_id: LONG_ID, last_at: iso(1), preview: "Here is the hash " + HASH, title: "", kind: "dm", participants: [agents[0].id], channel_key: "dm-f1-x" }], recentEvents: events, counts: {} };
  if (p.startsWith("/v1/operator/agents?")) return { agents, total: agents.length };
  if (p.startsWith("/v1/operator/conversations/")) return { events, total: events.length, conversation_id: LONG_ID };
  if (p.startsWith("/v1/operator/approvals")) return { approvals: [], total: 0 };
  if (p.startsWith("/v1/operator/rooms")) return { rooms: [] };
  if (p.startsWith("/v1/operator/feeds")) return { feeds: [] };
  if (p.startsWith("/v1/operator/fleet-health")) return { agents: agents.map((a) => ({ ...a, health: { level: "ok" } })) };
  if (p.startsWith("/v1/operator/attention")) return { items: [], counts: {} };
  if (p.startsWith("/v1/operator/profile")) return { display_name: "Michael", email: "m@example.com" };
  if (p.startsWith("/v1/operator/keys")) return { keys: [] };
  if (p.startsWith("/v1/operator/agent-keys")) return { agents: [] };
  if (p.startsWith("/v1/operator/topology")) return topology;
  if (p.startsWith("/v1/operator/activity")) return activity;
  return {};
};

export function startMock(port = 0) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/v1/")) {
      res.setHeader("content-type", "application/json");
      res.end(json(api(u.pathname + u.search)));
      return;
    }
    let rel = u.pathname.replace(/^\/ui\/?/, "") || "index.html";
    let f = path.join(dist, rel);
    const relToDist = path.relative(dist, f);
    const inside = relToDist && !relToDist.startsWith("..") && !path.isAbsolute(relToDist);
    if (!inside || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
    res.setHeader("content-type", mime[path.extname(f)] || "application/octet-stream");
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}
