import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import {
  b64url,
  fromB64url,
  keyId,
  signCanonical,
  verifyCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
  revocationPayload,
} from "../src/operator-identity";
import { applyMigration } from "../src/db";

/**
 * Signed operator-key revocation, end to end on the relay side.
 *
 * Until this change the relay revoked a key by setting `revoked_at` and telling
 * agents `revoked: true`. Both plugins (since #27) treat an UNSIGNED revocation
 * claim as advisory — the key is skipped for new adoption and nothing else — so
 * no revocation ever reached an agent: a lost or stolen operator key stayed a
 * valid signer on every box forever. The agent half (`applySignedRevocations`)
 * was already built; this is the relay half: a revocation is a signature by a
 * DIFFERENT, live, trusted operator key over
 * revocationPayload(fleet, key_id, revoked_at), stored verbatim and served in
 * the inbox and at enrolment.
 */

let fill = 100;
function makeKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}
type K = ReturnType<typeof makeKey>;

const MIN = 60_000;

/** The signed block a device sends to revoke `target`, signed by `signer`. */
function signedRevocation(fleetId: string, signer: K, target: K, revokedAt = new Date().toISOString()) {
  return {
    revokedByKeyId: signer.id,
    revokedAt,
    signature: signCanonical(revocationPayload(fleetId, target.id, revokedAt), signer.seed),
  };
}

function wireBody(fleetId: string, signer: K, target: K, revokedAt = new Date().toISOString()) {
  const s = signedRevocation(fleetId, signer, target, revokedAt);
  return { revoked_by_key_id: s.revokedByKeyId, revoked_at: s.revokedAt, signature: s.signature };
}

describe("signed operator-key revocation (db)", () => {
  let relay: TestRelay;
  let root: K; // trust root: the agent's identity key is endorsed by it
  let second: K; // endorsed by root → trusted by the chain rule
  let victim: K; // endorsed by root; the key being revoked in most scenarios
  let agentId: string;

  const register = (k: K, label: string, endorser?: K) =>
    relay.db.registerOperatorKey(
      relay.fleetId,
      k.pubB64,
      label,
      endorser
        ? {
            endorsedByKeyId: endorser.id,
            signature: signCanonical(endorsementPayload(relay.fleetId, k.id, k.pubB64), endorser.seed),
          }
        : undefined
    );
  const row = (k: K) => relay.db.listOperatorKeys(relay.fleetId).find((x) => x.key_id === k.id)!;
  const liveIds = () => relay.db.getActiveOperatorKeys(relay.fleetId).map((x) => x.key_id);
  const revoke = (signer: K, target: K, revokedAt?: string) =>
    relay.db.revokeOperatorKey(relay.fleetId, target.id, signedRevocation(relay.fleetId, signer, target, revokedAt));
  const revokedEvents = () =>
    relay.db
      .getActivity(relay.fleetId, { limit: 50, type: "operator_key" })
      .filter((e) => e.event_type === "operator_key.revoked");

  beforeEach(async () => {
    relay = await createTestRelay();
    root = makeKey();
    second = makeKey();
    victim = makeKey();
    register(root, "phone");
    register(second, "laptop", root);
    register(victim, "tablet", root);
    // An endorsed agent makes `root` a real trust root, so the authority rule
    // (`endorserIsTrusted`) is live rather than in its fresh-fleet exemption.
    agentId = (await relay.enrollAgent("Case")).agent_id;
    const ak = makeKey();
    const akId = relay.db.setAgentIdentityKey(agentId, relay.fleetId, ak.pubB64).keyId;
    relay.db.endorseAgentKey(relay.fleetId, agentId, akId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agentId, akId, ak.pubB64), root.seed),
    });
  });
  afterEach(() => relay.cleanup());

  it("a trusted live key revokes another key; the SIGNED revoked_at, signer and signature are stored", () => {
    const at = new Date().toISOString();
    const out = revoke(root, victim, at);
    expect(out).toEqual({ revoked_at: at, revoked_by_key_id: root.id });

    const r = row(victim);
    expect(r.revoked_at).toBe(at); // the signed value, not the relay's clock
    expect(r.revoked_by_key_id).toBe(root.id);
    expect(r.revocation_sig).toBeTruthy();
    expect(verifyCanonical(revocationPayload(relay.fleetId, victim.id, at), r.revocation_sig!, root.pub)).toBe(true);
    expect(liveIds()).not.toContain(victim.id);
    expect(liveIds()).toEqual(expect.arrayContaining([root.id, second.id]));
  });

  it("a key endorsed by the root (chain rule) may revoke too", () => {
    revoke(second, victim);
    expect(row(victim).revoked_by_key_id).toBe(second.id);
  });

  it("writes operator_key.revoked with the verified signer in the payload and keeps the unverified hint", () => {
    relay.db.revokeOperatorKey(
      relay.fleetId,
      victim.id,
      signedRevocation(relay.fleetId, root, victim),
      relay.operatorId,
      "claimed-device-id"
    );
    const ev = revokedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_id).toBe(relay.operatorId);
    expect(ev[0].resource_id).toBe(victim.id);
    expect(ev[0].payload.revoked_by_key_id).toBe(root.id);
    expect(ev[0].payload.revoked_at).toBe(row(victim).revoked_at);
    expect(ev[0].payload.claimed_actor_key_id_unverified).toBe("claimed-device-id");
  });

  it("REFUSES a signature that does not verify, and the key stays live", () => {
    const at = new Date().toISOString();
    expect(() =>
      relay.db.revokeOperatorKey(relay.fleetId, victim.id, {
        revokedByKeyId: root.id,
        revokedAt: at,
        // signed by `second`, presented as root's
        signature: signCanonical(revocationPayload(relay.fleetId, victim.id, at), second.seed),
      })
    ).toThrow(/invalid revocation signature/i);
    expect(() =>
      relay.db.revokeOperatorKey(relay.fleetId, victim.id, {
        revokedByKeyId: root.id,
        revokedAt: at,
        // right key, wrong bytes: signed over a different revoked_at
        signature: signCanonical(revocationPayload(relay.fleetId, victim.id, "2026-01-01T00:00:00.000Z"), root.seed),
      })
    ).toThrow(/invalid revocation signature/i);
    expect(row(victim).revoked_at).toBeNull();
    expect(revokedEvents()).toHaveLength(0);
  });

  it("REFUSES a key revoking itself", () => {
    expect(() => revoke(victim, victim)).toThrow(/cannot revoke itself/i);
    expect(row(victim).revoked_at).toBeNull();
  });

  it("REFUSES a revoked signer", () => {
    revoke(root, victim);
    expect(() => revoke(victim, second)).toThrow(/revoked/i);
    expect(row(second).revoked_at).toBeNull();
  });

  it("REFUSES a signer this fleet has never registered", () => {
    const ghost = makeKey();
    expect(() => revoke(ghost, victim)).toThrow(/unknown/i);
    expect(row(victim).revoked_at).toBeNull();
  });

  it("REFUSES a live but untrusted (orphan) signer — agents would not honour it either", () => {
    const orphan = makeKey();
    register(orphan, "stolen-session"); // live, unendorsed, no dependents
    expect(() => revoke(orphan, victim)).toThrow(/no agent trusts it/i);
    expect(row(victim).revoked_at).toBeNull();
  });

  it("REFUSES revoked_at more than 5 minutes from the relay clock, or unparseable", () => {
    const past = new Date(Date.now() - 6 * MIN).toISOString();
    const future = new Date(Date.now() + 6 * MIN).toISOString();
    expect(() => revoke(root, victim, past)).toThrow(/revoked_at/i);
    expect(() => revoke(root, victim, future)).toThrow(/revoked_at/i);
    expect(() => revoke(root, victim, "yesterday")).toThrow(/revoked_at/i);
    expect(row(victim).revoked_at).toBeNull();
    // Inside the window is fine in both directions (clock skew between devices).
    revoke(root, victim, new Date(Date.now() - 4 * MIN).toISOString());
    expect(row(victim).revoked_at).toBeTruthy();
  });

  it("REFUSES to revoke an already-revoked key and leaves the original revoked_at and signature alone", () => {
    const first = new Date(Date.now() - 1 * MIN).toISOString();
    revoke(root, victim, first);
    const before = row(victim);
    expect(() => revoke(second, victim)).toThrow(/already revoked/i);
    const after = row(victim);
    expect(after.revoked_at).toBe(first);
    expect(after.revoked_by_key_id).toBe(before.revoked_by_key_id);
    expect(after.revocation_sig).toBe(before.revocation_sig);
    expect(revokedEvents()).toHaveLength(1);
  });

  it("reports an unknown target as not found", () => {
    const ghost = makeKey();
    expect(() => revoke(root, ghost)).toThrow(/not found/i);
  });

  it("serves revoked_at / revoked_by_key_id / revocation_sig in the inbox, verifiable with the signer's key", async () => {
    const at = new Date().toISOString();
    revoke(root, victim, at);
    const agent = await relay.enrollAgent("Poller");
    const inbox = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox?limit=10");
    const keys = inbox.body.operator_keys as Array<Record<string, unknown>>;
    const dead = keys.find((k) => k.key_id === victim.id)!;
    expect(dead.revoked).toBe(true);
    expect(dead.revoked_at).toBe(at);
    expect(dead.revoked_by_key_id).toBe(root.id);
    expect(
      verifyCanonical(revocationPayload(relay.fleetId, victim.id, dead.revoked_at as string), dead.revocation_sig as string, root.pub)
    ).toBe(true);
    // Live keys carry the same shape, nulled, so a plugin can read every entry
    // the same way.
    const live = keys.find((k) => k.key_id === second.id)!;
    expect(live).toMatchObject({ revoked: false, revoked_at: null, revoked_by_key_id: null, revocation_sig: null });
  });

  it("serves the same fields at enrolment, INCLUDING tombstones, so a fresh agent learns the key is dead", async () => {
    const at = new Date().toISOString();
    revoke(root, victim, at);
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const res = await relay.app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { fleet_id: relay.fleetId, token, display_name: "Newcomer", runtime: "custom" },
    });
    const keys = JSON.parse(res.body).operator_keys as Array<Record<string, unknown>>;
    const dead = keys.find((k) => k.key_id === victim.id)!;
    expect(dead).toBeTruthy();
    expect(dead.revoked).toBe(true);
    expect(dead.revoked_at).toBe(at);
    expect(dead.revoked_by_key_id).toBe(root.id);
    expect(
      verifyCanonical(revocationPayload(relay.fleetId, victim.id, at), dead.revocation_sig as string, fromB64url(root.pubB64))
    ).toBe(true);
    const live = keys.find((k) => k.key_id === root.id)!;
    expect(live).toMatchObject({ revoked: false, revoked_at: null, revocation_sig: null });
  });
});

describe("signed operator-key revocation — last live key", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  it("REFUSES to revoke the fleet's only live operator key, whoever signs", () => {
    const solo = makeKey();
    const other = makeKey();
    relay.db.registerOperatorKey(relay.fleetId, solo.pubB64, "solo");
    relay.db.registerOperatorKey(relay.fleetId, other.pubB64, "other");
    relay.db.revokeOperatorKey(relay.fleetId, other.id, signedRevocation(relay.fleetId, solo, other));
    expect(relay.db.getActiveOperatorKeys(relay.fleetId).map((k) => k.key_id)).toEqual([solo.id]);

    // The dead key trying to take the last live one down with it.
    expect(() =>
      relay.db.revokeOperatorKey(relay.fleetId, solo.id, signedRevocation(relay.fleetId, other, solo))
    ).toThrow(/only live operator key/i);
    // ...and the last key trying to revoke itself.
    expect(() =>
      relay.db.revokeOperatorKey(relay.fleetId, solo.id, signedRevocation(relay.fleetId, solo, solo))
    ).toThrow(/only live operator key/i);
    expect(relay.db.getActiveOperatorKeys(relay.fleetId).map((k) => k.key_id)).toEqual([solo.id]);
  });
});

describe("signed operator-key revocation (HTTP)", () => {
  let relay: TestRelay;
  let root: K;
  let victim: K;
  const liveViaApi = async (k: K) => {
    const list = await relay.operatorRequest("GET", "/v1/operator/keys");
    return list.body.keys.find((x: { key_id: string }) => x.key_id === k.id);
  };

  beforeEach(async () => {
    relay = await createTestRelay();
    root = makeKey();
    victim = makeKey();
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: root.pubB64, label: "phone" });
    await relay.operatorRequest("POST", "/v1/operator/keys", {
      public_key: victim.pubB64,
      label: "tablet",
      endorsement: {
        endorsed_by_key_id: root.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, victim.id, victim.pubB64), root.seed),
      },
    });
  });
  afterEach(() => relay.cleanup());

  it("POST /v1/operator/keys/:keyId/revoke with a signed block revokes and echoes what was stored", async () => {
    const body = wireBody(relay.fleetId, root, victim);
    const res = await relay.operatorRequest("POST", `/v1/operator/keys/${victim.id}/revoke`, body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      revoked: true,
      key_id: victim.id,
      revoked_at: body.revoked_at,
      revoked_by_key_id: root.id,
    });
    const r = await liveViaApi(victim);
    expect(r.revoked_at).toBe(body.revoked_at);
    expect(r.revoked_by_key_id).toBe(root.id);
    expect(r.revocation_sig).toBe(body.signature);
  });

  it("DELETE /v1/operator/keys/:keyId is REFUSED (400) and leaves the key live", async () => {
    const del = await relay.operatorRequest("DELETE", `/v1/operator/keys/${victim.id}`);
    expect(del.status).toBe(400);
    expect(String(del.body.error)).toMatch(/signed revocation/i);
    expect(String(del.body.error)).toMatch(/POST \/v1\/operator\/keys\/\{keyId\}\/revoke/);
    expect((await liveViaApi(victim)).revoked_at).toBeNull();
    // And it is not a 404-shaped refusal for an unknown key either: the unsigned
    // path is gone regardless of what it names.
    const del2 = await relay.operatorRequest("DELETE", "/v1/operator/keys/unknownkey00");
    expect(del2.status).toBe(400);
  });

  it("maps an unknown target to 404 and everything else to 400", async () => {
    const ghost = makeKey();
    const nf = await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${ghost.id}/revoke`,
      wireBody(relay.fleetId, root, ghost)
    );
    expect(nf.status).toBe(404);

    const bad = wireBody(relay.fleetId, root, victim);
    bad.signature = signCanonical(revocationPayload(relay.fleetId, victim.id, bad.revoked_at), victim.seed);
    const badSig = await relay.operatorRequest("POST", `/v1/operator/keys/${victim.id}/revoke`, bad);
    expect(badSig.status).toBe(400);
    expect(String(badSig.body.error)).toMatch(/invalid revocation signature/i);

    const self = await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${victim.id}/revoke`,
      wireBody(relay.fleetId, victim, victim)
    );
    expect(self.status).toBe(400);

    const stale = await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${victim.id}/revoke`,
      wireBody(relay.fleetId, root, victim, new Date(Date.now() - 10 * MIN).toISOString())
    );
    expect(stale.status).toBe(400);

    const malformed = await relay.operatorRequest("POST", `/v1/operator/keys/${victim.id}/revoke`, {
      revoked_by_key_id: root.id,
    });
    expect(malformed.status).toBe(400);

    expect((await liveViaApi(victim)).revoked_at).toBeNull();
  });

  it("requires operator auth", async () => {
    const res = await relay.app.inject({
      method: "POST",
      url: `/v1/operator/keys/${victim.id}/revoke`,
      payload: wireBody(relay.fleetId, root, victim),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("migration 024 (revoked_by_key_id, revocation_sig)", () => {
  const sql = fs.readFileSync(
    fileURLToPath(new URL("../migrations/024_operator_key_revocation_sig.sql", import.meta.url)),
    "utf-8"
  );
  const cols = (db: Database.Database) =>
    (db.prepare("PRAGMA table_info(fleet_operator_keys)").all() as { name: string }[]).map((c) => c.name);

  it("adds both columns to a pre-024 fleet_operator_keys exactly once, and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE fleets (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.exec(`CREATE TABLE fleet_operator_keys (
      fleet_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL, label TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, endorsed_by_key_id TEXT, endorsement_sig TEXT,
      PRIMARY KEY (fleet_id, key_id))`);
    expect(cols(db)).not.toContain("revocation_sig");

    applyMigration(db, 24, sql, new Date().toISOString());
    expect(cols(db)).toEqual(expect.arrayContaining(["revoked_by_key_id", "revocation_sig"]));
    expect(cols(db).filter((c) => c === "revocation_sig")).toHaveLength(1);

    // A fresh DB already has the columns from schema.ts; re-applying must not throw.
    expect(() => applyMigration(db, 25, sql, new Date().toISOString())).not.toThrow();
    expect(cols(db).filter((c) => c === "revocation_sig")).toHaveLength(1);
  });
});
