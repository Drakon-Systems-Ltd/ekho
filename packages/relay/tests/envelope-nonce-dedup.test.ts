import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay } from "./setup";

// #10: the envelope signature nonce (sig_canonical.nonce) was relayed verbatim
// and never deduped server-side — the only replay defence was each recipient's
// in-memory seenNonces set (FIFO-500, lost on gateway restart) against a 24h
// acceptance window. These tests pin server-side dedup at ingest: a captured
// signed envelope re-POSTed as a new message is refused, so the recipient-side
// window stops being the only line.
describe("envelope nonce is deduped server-side (#10)", () => {
  let relay: Awaited<ReturnType<typeof createTestRelay>>;
  let sender: { agent_id: string; secret: string };
  let peer: { agent_id: string; secret: string };

  beforeAll(async () => {
    relay = await createTestRelay();
    sender = await relay.enrollAgent("sender");
    peer = await relay.enrollAgent("peer");
  });

  afterAll(() => { relay.cleanup(); });

  function signedMessage(nonce: string, body = "hello") {
    return {
      recipient: { kind: "agent", id: peer.agent_id },
      message_type: "direct",
      priority: "normal",
      body: { text: body },
      conversation_id: "conv-replay-test",
      correlation_id: `corr-${nonce.slice(0, 24)}`,
      agent_sig: "c2lnbmF0dXJlLWJ5dGVz",
      key_id: "k1234567",
      sig_canonical: { v: 1, nonce, body_sha256: "x", sent_at: new Date().toISOString() }
    };
  }

  it("accepts a signed message once and refuses the same envelope nonce again", async () => {
    const first = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", signedMessage("nonce-replay-1"));
    expect(first.status).toBe(200);

    // Same envelope, re-POSTed (fresh transport auth, fresh relay message_id
    // on the old code) — must be refused now.
    const replay = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", signedMessage("nonce-replay-1"));
    expect(replay.status).toBe(409);
    expect(String(replay.body.error)).toMatch(/replay|nonce/i);
  });

  it("a fresh nonce from the same sender is accepted", async () => {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", signedMessage("nonce-replay-2"));
    expect(res.status).toBe(200);
  });

  it("the same nonce from a different agent is independent", async () => {
    const payload = {
      ...signedMessage("nonce-replay-1"),
      recipient: { kind: "agent", id: sender.agent_id }
    };
    const res = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/messages", payload);
    expect(res.status).toBe(200);
  });

  it("unsigned messages are unaffected", async () => {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: peer.agent_id },
      message_type: "direct",
      priority: "normal",
      body: { text: "unsigned" },
      conversation_id: "conv-replay-test",
      correlation_id: "corr-unsigned-1"
    });
    expect(res.status).toBe(200);
  });

  it("an absurdly long envelope nonce is rejected outright, not stored", async () => {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", signedMessage("x".repeat(4096)));
    expect(res.status).toBe(400);
  });

  it("envelope nonces outlive the transport-nonce sweep for the full acceptance window", () => {
    const db = relay.db as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown } };
      sweepStaleNonces: () => number;
    };
    const insert = db.db.prepare("INSERT INTO replay_nonces (id, agent_id, nonce, created_at) VALUES (?, ?, ?, ?)");
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const dayPlusAgo = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    insert.run("rpl_t_old", sender.agent_id, "transport-old", hourAgo);
    insert.run("rpl_e_mid", sender.agent_id, "env:envelope-mid", hourAgo);
    insert.run("rpl_e_old", sender.agent_id, "env:envelope-old", dayPlusAgo);

    db.sweepStaleNonces();

    const rows = (nonce: string) =>
      db.db.prepare("SELECT COUNT(*) AS n FROM replay_nonces WHERE nonce = ?").get(nonce) as { n: number };
    // Transport nonce (2x skew retention) is gone; the mid-window envelope
    // nonce must survive — pruning it early would reopen the replay window.
    expect(rows("transport-old").n).toBe(0);
    expect(rows("env:envelope-mid").n).toBe(1);
    expect(rows("env:envelope-old").n).toBe(0);
  });
});
