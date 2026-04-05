#!/usr/bin/env npx tsx
/**
 * Ekho Load Test
 *
 * Tests relay throughput and latency under various agent/message loads.
 * Starts a real relay instance on a random port with a temp database.
 *
 * Usage:
 *   npx tsx scripts/load-test.ts
 *   npx tsx scripts/load-test.ts --agents 50 --messages 500
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

// Parse args
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--")) {
    args[process.argv[i].slice(2)] = process.argv[i + 1] ?? "true";
    i++;
  }
}

const AGENT_COUNT = parseInt(args.agents ?? "20", 10);
const MESSAGES_PER_AGENT = parseInt(args.messages ?? "100", 10);
const TOTAL_MESSAGES = AGENT_COUNT * MESSAGES_PER_AGENT;

// Setup temp environment
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-loadtest-"));
const dbPath = path.join(tmpDir, "loadtest.sqlite");

process.env.EKHO_DB_PATH = dbPath;
process.env.EKHO_OPERATOR_SESSION_SECRET = "loadtest-secret";
process.env.EKHO_SWEEP_INTERVAL_MS = "999999"; // Disable sweep during test
process.env.EKHO_RATE_LIMIT_MAX_MESSAGES = "999999"; // No rate limiting during test

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function signedHeaders(agentId: string, secret: string, method: string, urlPath: string, body: string) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payload = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "content-type": "application/json",
    "x-ekho-agent-id": agentId,
    "x-ekho-agent-secret": secret,
    "x-ekho-timestamp": timestamp,
    "x-ekho-nonce": nonce,
    "x-ekho-signature": signature,
  };
}

interface AgentCreds {
  agent_id: string;
  secret: string;
}

async function run() {
  console.log("\n  === Ekho Load Test ===\n");
  console.log(`  Agents:            ${AGENT_COUNT}`);
  console.log(`  Messages/agent:    ${MESSAGES_PER_AGENT}`);
  console.log(`  Total messages:    ${TOTAL_MESSAGES}`);
  console.log(`  Database:          ${dbPath}`);
  console.log("");

  // Start relay
  const fastify = (await import("fastify")).default;
  const { db } = await import("../packages/relay/src/db");
  const { registerAgentRoutes } = await import("../packages/relay/src/routes-agent");
  const { registerOperatorRoutes } = await import("../packages/relay/src/routes-operator");
  const { sign } = await import("../packages/relay/src/utils");

  const app = fastify({ logger: false });
  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Bootstrap fleet
  const { fleetId, operatorId } = db.createBootstrap("loadtest", "admin@loadtest.com", "loadtestpassword");

  // --- Benchmark 1: Agent Enrollment ---
  console.log("  [1/5] Enrolling agents...");
  const enrollStart = performance.now();
  const agents: AgentCreds[] = [];

  for (let i = 0; i < AGENT_COUNT; i++) {
    const token = db.issueEnrollmentToken(fleetId, operatorId);
    const res = await fetch(`${baseUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fleet_id: fleetId, token, display_name: `agent-${i}`, runtime: "custom" }),
    });
    const body = await res.json() as AgentCreds;
    agents.push(body);
  }

  const enrollMs = performance.now() - enrollStart;
  console.log(`        ${AGENT_COUNT} agents enrolled in ${enrollMs.toFixed(0)}ms (${(enrollMs / AGENT_COUNT).toFixed(1)}ms/agent)`);

  // --- Benchmark 2: Message Sending ---
  console.log("  [2/5] Sending messages...");
  const sendStart = performance.now();
  const messageIds: string[] = [];
  let sendErrors = 0;

  for (let i = 0; i < AGENT_COUNT; i++) {
    const sender = agents[i];
    const receiver = agents[(i + 1) % AGENT_COUNT]; // Ring topology

    for (let j = 0; j < MESSAGES_PER_AGENT; j++) {
      const body = JSON.stringify({
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: `load test message ${j}`, index: j },
        conversation_id: `loadtest-${i}-${j}`,
        correlation_id: `corr-${i}-${j}`,
      });
      const urlPath = "/v1/messages";
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method: "POST",
        headers: signedHeaders(sender.agent_id, sender.secret, "POST", urlPath, body),
        body,
      });
      if (res.ok) {
        const data = await res.json() as { message_id: string };
        messageIds.push(data.message_id);
      } else {
        sendErrors++;
      }
    }
  }

  const sendMs = performance.now() - sendStart;
  const sendThroughput = (TOTAL_MESSAGES / (sendMs / 1000)).toFixed(0);
  console.log(`        ${messageIds.length} messages sent in ${sendMs.toFixed(0)}ms (${sendThroughput} msg/s, ${sendErrors} errors)`);

  // --- Benchmark 3: Inbox Polling ---
  console.log("  [3/5] Polling inboxes...");
  const pollStart = performance.now();
  let totalDelivered = 0;

  for (const agent of agents) {
    const urlPath = "/v1/inbox?limit=100";
    const body = "";
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: "GET",
      headers: signedHeaders(agent.agent_id, agent.secret, "GET", "/v1/inbox", body),
    });
    if (res.ok) {
      const data = await res.json() as { messages: unknown[] };
      totalDelivered += data.messages.length;
    }
  }

  const pollMs = performance.now() - pollStart;
  console.log(`        ${totalDelivered} messages delivered in ${pollMs.toFixed(0)}ms (${(pollMs / AGENT_COUNT).toFixed(1)}ms/agent)`);

  // --- Benchmark 4: ACK ---
  console.log("  [4/5] Acknowledging messages...");
  const ackStart = performance.now();
  let totalAcked = 0;

  // ACK in batches per agent (up to 100 per call)
  for (const agent of agents) {
    const acks = messageIds.slice(0, Math.min(MESSAGES_PER_AGENT, 100)).map((mid) => ({
      message_id: mid,
      status: "received" as const,
      received_at: new Date().toISOString(),
    }));
    if (acks.length === 0) continue;

    const ackBody = JSON.stringify({ acks });
    const urlPath = "/v1/acks";
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: signedHeaders(agent.agent_id, agent.secret, "POST", urlPath, ackBody),
      body: ackBody,
    });
    if (res.ok) {
      const data = await res.json() as { updated: number };
      totalAcked += data.updated;
    }
  }

  const ackMs = performance.now() - ackStart;
  console.log(`        ${totalAcked} messages ACKed in ${ackMs.toFixed(0)}ms`);

  // --- Benchmark 5: Heartbeats ---
  console.log("  [5/5] Sending heartbeats...");
  const hbStart = performance.now();

  for (const agent of agents) {
    const hbBody = JSON.stringify({ status: "healthy", active_conversation_ids: [], metrics: {} });
    const urlPath = "/v1/heartbeats";
    await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: signedHeaders(agent.agent_id, agent.secret, "POST", urlPath, hbBody),
      body: hbBody,
    });
  }

  const hbMs = performance.now() - hbStart;
  console.log(`        ${AGENT_COUNT} heartbeats in ${hbMs.toFixed(0)}ms (${(hbMs / AGENT_COUNT).toFixed(1)}ms/agent)`);

  // --- Database stats ---
  const dbSize = fs.statSync(dbPath).size;
  const msgCount = (db.raw().prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  const eventCount = (db.raw().prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  const deliveryCount = (db.raw().prepare("SELECT COUNT(*) AS c FROM message_deliveries").get() as { c: number }).c;

  // Summary
  console.log("\n  === Results ===\n");
  console.log(`  Send throughput:   ${sendThroughput} msg/s`);
  console.log(`  Avg send latency:  ${(sendMs / TOTAL_MESSAGES).toFixed(2)}ms`);
  console.log(`  Avg poll latency:  ${(pollMs / AGENT_COUNT).toFixed(2)}ms`);
  console.log(`  Avg enroll time:   ${(enrollMs / AGENT_COUNT).toFixed(2)}ms`);
  console.log(`  Avg heartbeat:     ${(hbMs / AGENT_COUNT).toFixed(2)}ms`);
  console.log(`  Messages in DB:    ${msgCount}`);
  console.log(`  Deliveries in DB:  ${deliveryCount}`);
  console.log(`  Events in DB:      ${eventCount}`);
  console.log(`  Database size:     ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
  console.log("");

  // Cleanup
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
