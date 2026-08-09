// #7: the attachment upload path had a 25 MiB per-file cap and nothing else —
// no upload rate limit, no per-fleet quota, no GC, and no unlink anywhere in
// the codebase. One enrolled agent looping uploads could fill the disk under
// the relay's SQLite DB and take the whole fleet down. These tests pin the
// three missing controls. Env caps are set small BEFORE any relay module loads
// (config reads process.env at import).
process.env.EKHO_ATTACHMENT_UPLOAD_MAX_PER_WINDOW = "3";
process.env.EKHO_ATTACHMENT_FLEET_QUOTA_BYTES = "12000";

import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay } from "./setup";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(size: number): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, size - PNG_MAGIC.length), 1)]);
}

describe("attachment quota, GC and upload rate-limit (#7)", () => {
  let relay: Awaited<ReturnType<typeof createTestRelay>>;
  let agent: { agent_id: string; secret: string };
  let peer: { agent_id: string; secret: string };

  beforeAll(async () => {
    relay = await createTestRelay();
    agent = await relay.enrollAgent("uploader");
    peer = await relay.enrollAgent("receiver");
  });

  afterAll(() => { relay.cleanup(); });

  function uploadPayload(size: number, filename = "shot.png") {
    const bytes = pngBytes(size);
    return { filename, mime: "image/png", size_bytes: bytes.length, data_base64: bytes.toString("base64") };
  }

  it("rate-limits the upload path independently of message sends", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", uploadPayload(400));
      statuses.push(res.status);
    }
    // Cap is 3/window: the first three land, the rest are refused.
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it("enforces the per-fleet storage quota", async () => {
    // A second agent — the quota is per FLEET, so the earlier uploads count.
    // ~1.2KB used so far; a 15KB upload must breach the 12KB quota outright.
    const res = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/attachments", uploadPayload(15000));
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/quota/i);

    // And a small one still fits.
    const ok = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/attachments", uploadPayload(500));
    expect(ok.status).toBe(201);
  });

  it("the operator upload path is under the same quota", async () => {
    const res = await relay.operatorRequest("POST", "/v1/operator/attachments", uploadPayload(15000));
    expect(res.status).toBe(413);
  });

  it("binding a message stamps the attachment as bound", async () => {
    const up = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/attachments", uploadPayload(600));
    expect(up.status).toBe(201);
    const attId = up.body.id as string;

    const send = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: agent.agent_id },
      message_type: "direct",
      priority: "normal",
      body: { text: "with file", attachments: [attId] },
      conversation_id: "conv-att-test",
      correlation_id: "corr-att-bind"
    });
    expect(send.status).toBe(200);

    const row = (relay.db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } })
      .db.prepare("SELECT bound_at, bound_message_id FROM attachments WHERE id = ?")
      .get(attId) as { bound_at: string | null; bound_message_id: string | null };
    expect(row.bound_at).toBeTruthy();
    expect(row.bound_message_id).toBeTruthy();
  });

  it("GC removes stale unbound and expired bound attachments — files included", async () => {
    const db = relay.db as unknown as {
      db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown } };
      sweepAttachments: () => { deleted: number };
    };
    // Dynamic import: a static one would hoist above the env caps set up top.
    const { writeAttachmentBytes } = await import("../src/attachments");

    const mk = (attId: string, createdAt: string, boundAt: string | null) => {
      const p = writeAttachmentBytes(relay.fleetId, attId, pngBytes(300));
      db.db.prepare(
        `INSERT INTO attachments (id, fleet_id, uploader_kind, uploader_id, filename, mime, size_bytes, storage_path, created_at, bound_message_id, bound_at)
         VALUES (?, ?, 'agent', ?, 'x.png', 'image/png', 300, ?, ?, ?, ?)`
      ).run(attId, relay.fleetId, agent.agent_id, p, createdAt, boundAt ? "msg_x" : null, boundAt);
      return p;
    };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

    const staleUnbound = mk("att_gc_stale_unbound", hoursAgo(10), null);      // > unbound TTL (6h)
    const freshUnbound = mk("att_gc_fresh_unbound", hoursAgo(1), null);       // inside TTL
    const expiredBound = mk("att_gc_expired_bound", hoursAgo(24 * 40), hoursAgo(24 * 40)); // > retention (30d)
    const liveBound = mk("att_gc_live_bound", hoursAgo(24 * 2), hoursAgo(24 * 2));         // inside retention

    db.sweepAttachments();

    const exists = (attId: string) =>
      (db.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE id = ?").get(attId) as { n: number }).n === 1;
    expect(exists("att_gc_stale_unbound")).toBe(false);
    expect(fs.existsSync(staleUnbound)).toBe(false);
    expect(exists("att_gc_expired_bound")).toBe(false);
    expect(fs.existsSync(expiredBound)).toBe(false);
    expect(exists("att_gc_fresh_unbound")).toBe(true);
    expect(fs.existsSync(freshUnbound)).toBe(true);
    expect(exists("att_gc_live_bound")).toBe(true);
    expect(fs.existsSync(liveBound)).toBe(true);
  });
});
