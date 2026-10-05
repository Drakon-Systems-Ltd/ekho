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

/**
 * Legacy UNSIGNED tombstones. Before signed revocation the relay's DELETE path
 * set `revoked_at` and nothing else. Agents treat that as advisory (#27), so
 * those keys are still pinned and trusted on every agent — and as long as the
 * relay refused any revocation of a key with `revoked_at` set, there was no way
 * to finish the job. A legacy tombstone (revoked_at set, revocation_sig NULL)
 * may now be signed once by a trusted live key; a SIGNED tombstone never
 * changes.
 */
describe("signed operator-key revocation — legacy unsigned tombstones", () => {
  let relay: TestRelay;
  let root: K;
  let second: K;
  let legacy: K; // tombstoned by the pre-024 unsigned DELETE path
  const LEGACY_AT = "2026-06-07T21:22:53.694Z";

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
  /** Exactly what the old DELETE /v1/operator/keys/:keyId wrote: a time, no signature. */
  const tombstoneUnsigned = (k: K, at = LEGACY_AT) =>
    relay.db
      .raw()
      .prepare("UPDATE fleet_operator_keys SET revoked_at = ? WHERE fleet_id = ? AND key_id = ?")
      .run(at, relay.fleetId, k.id);
  /** The whole stored row, every column, for byte-for-byte comparisons. */
  const fullRow = (k: K) =>
    relay.db
      .raw()
      .prepare("SELECT * FROM fleet_operator_keys WHERE fleet_id = ? AND key_id = ?")
      .get(relay.fleetId, k.id) as Record<string, unknown>;
  const row = (k: K) => relay.db.listOperatorKeys(relay.fleetId).find((x) => x.key_id === k.id)!;
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
    legacy = makeKey();
    register(root, "phone");
    register(second, "laptop", root);
    register(legacy, "old-browser", root);
    const agentId = (await relay.enrollAgent("Case")).agent_id;
    const ak = makeKey();
    const akId = relay.db.setAgentIdentityKey(agentId, relay.fleetId, ak.pubB64).keyId;
    relay.db.endorseAgentKey(relay.fleetId, agentId, akId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agentId, akId, ak.pubB64), root.seed),
    });
    tombstoneUnsigned(legacy);
    expect(row(legacy)).toMatchObject({ revoked_at: LEGACY_AT, revoked_by_key_id: null, revocation_sig: null });
  });
  afterEach(() => relay.cleanup());

  it("a legacy unsigned tombstone CAN be signed: the signed revoked_at, signer and signature replace it", () => {
    const at = new Date().toISOString();
    expect(revoke(root, legacy, at)).toEqual({ revoked_at: at, revoked_by_key_id: root.id });
    const r = row(legacy);
    expect(r.revoked_at).toBe(at);
    expect(r.revoked_by_key_id).toBe(root.id);
    expect(verifyCanonical(revocationPayload(relay.fleetId, legacy.id, at), r.revocation_sig!, root.pub)).toBe(true);
  });

  it("records operator_key.revoked with legacy_resign and the prior unsigned revoked_at", () => {
    const at = new Date().toISOString();
    relay.db.revokeOperatorKey(relay.fleetId, legacy.id, signedRevocation(relay.fleetId, root, legacy, at), relay.operatorId);
    const ev = revokedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_id).toBe(relay.operatorId);
    expect(ev[0].resource_id).toBe(legacy.id);
    expect(ev[0].payload).toMatchObject({
      revoked_at: at,
      revoked_by_key_id: root.id,
      legacy_resign: true,
      prior_unsigned_revoked_at: LEGACY_AT,
    });
  });

  it("a normal revocation of a live key carries no legacy_resign flag", () => {
    revoke(root, second);
    const ev = revokedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.legacy_resign).toBeUndefined();
    expect(ev[0].payload.prior_unsigned_revoked_at).toBeUndefined();
  });

  it("a SIGNED tombstone is immutable: a second signed revocation is refused and the row is unchanged byte-for-byte", () => {
    revoke(root, legacy);
    const before = fullRow(legacy);
    expect(before.revocation_sig).toBeTruthy();
    expect(() => revoke(second, legacy)).toThrow(/already revoked/i);
    expect(() => revoke(root, legacy)).toThrow(/already revoked/i);
    expect(fullRow(legacy)).toEqual(before);
    expect(revokedEvents()).toHaveLength(1);
  });

  it("the last-live rule does not block signing a legacy tombstone (it cannot shrink the live set) and still guards live keys", () => {
    // Leave `root` as the ONLY live key: the legacy target is already out of
    // the live set, so signing its tombstone keeps exactly one live key.
    revoke(root, second);
    expect(relay.db.getActiveOperatorKeys(relay.fleetId).map((k) => k.key_id)).toEqual([root.id]);
    revoke(root, legacy);
    expect(row(legacy).revocation_sig).toBeTruthy();
    expect(relay.db.getActiveOperatorKeys(relay.fleetId).map((k) => k.key_id)).toEqual([root.id]);
    // ...while the last live key itself is still protected.
    expect(() => revoke(legacy, root)).toThrow(/only live operator key/i);
    expect(row(root).revoked_at).toBeNull();
  });

  it("every other guard still applies to a legacy target, which stays unsigned when refused", () => {
    const orphan = makeKey();
    register(orphan, "stolen-session");
    const at = new Date().toISOString();
    expect(() => revoke(legacy, legacy)).toThrow(/cannot revoke itself|itself revoked/i);
    expect(() => revoke(orphan, legacy)).toThrow(/no agent trusts it/i);
    expect(() => revoke(makeKey(), legacy)).toThrow(/unknown/i);
    expect(() => revoke(root, legacy, new Date(Date.now() - 6 * MIN).toISOString())).toThrow(/revoked_at/i);
    expect(() =>
      relay.db.revokeOperatorKey(relay.fleetId, legacy.id, {
        revokedByKeyId: root.id,
        revokedAt: at,
        signature: signCanonical(revocationPayload(relay.fleetId, legacy.id, at), second.seed),
      })
    ).toThrow(/invalid revocation signature/i);
    // A revoked signer — including another legacy tombstone — cannot sign.
    tombstoneUnsigned(second);
    expect(() => revoke(second, legacy)).toThrow(/itself revoked/i);
    expect(row(legacy)).toMatchObject({ revoked_at: LEGACY_AT, revoked_by_key_id: null, revocation_sig: null });
    expect(revokedEvents()).toHaveLength(0);
  });

  it("HTTP: signing a legacy tombstone is 200; re-signing a signed tombstone is 400 and changes nothing", async () => {
    const body = wireBody(relay.fleetId, root, legacy);
    const ok = await relay.operatorRequest("POST", `/v1/operator/keys/${legacy.id}/revoke`, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ revoked: true, key_id: legacy.id, revoked_at: body.revoked_at, revoked_by_key_id: root.id });
    const listed = (await relay.operatorRequest("GET", "/v1/operator/keys")).body.keys.find(
      (x: { key_id: string }) => x.key_id === legacy.id
    );
    expect(listed).toMatchObject({ revoked_at: body.revoked_at, revoked_by_key_id: root.id, revocation_sig: body.signature });

    const before = fullRow(legacy);
    const again = await relay.operatorRequest("POST", `/v1/operator/keys/${legacy.id}/revoke`, wireBody(relay.fleetId, second, legacy));
    expect(again.status).toBe(400);
    expect(String(again.body.error)).toMatch(/already revoked/i);
    expect(fullRow(legacy)).toEqual(before);

    const ghost = makeKey();
    const nf = await relay.operatorRequest("POST", `/v1/operator/keys/${ghost.id}/revoke`, wireBody(relay.fleetId, root, ghost));
    expect(nf.status).toBe(404);
  });

  it("the inbox serves a legacy tombstone with no signature, and the signed fields once it is signed", async () => {
    const agent = await relay.enrollAgent("Poller");
    const inboxEntry = async () =>
      ((await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox?limit=10")).body.operator_keys as Array<
        Record<string, unknown>
      >).find((k) => k.key_id === legacy.id)!;
    expect(await inboxEntry()).toMatchObject({ revoked: true, revoked_at: LEGACY_AT, revoked_by_key_id: null, revocation_sig: null });
    const at = new Date().toISOString();
    revoke(root, legacy, at);
    const signed = await inboxEntry();
    expect(signed).toMatchObject({ revoked: true, revoked_at: at, revoked_by_key_id: root.id });
    expect(verifyCanonical(revocationPayload(relay.fleetId, legacy.id, at), signed.revocation_sig as string, root.pub)).toBe(true);
  });
});

describe("signed operator-key revocation — authority must survive the revocation", () => {
  // "Two live keys" is not proof that anything can still endorse afterwards.
  // Agents pin R; C is endorsed by R; C signs R's revocation. Every other guard
  // passes, and then C's chain runs through a revoked hop: no key in the fleet
  // could endorse an agent again.
  let relay: TestRelay;
  const SURVIVING = /surviving key/i;

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
  const endorseOperator = (endorser: K, target: K) =>
    relay.db.endorseOperatorKey(relay.fleetId, target.id, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(endorsementPayload(relay.fleetId, target.id, target.pubB64), endorser.seed),
    });
  type Agent = { agentId: string; keyId: string; pubB64: string };
  const addAgent = async (name: string): Promise<Agent> => {
    const agentId = (await relay.enrollAgent(name)).agent_id;
    const k = makeKey();
    return { agentId, keyId: relay.db.setAgentIdentityKey(agentId, relay.fleetId, k.pubB64).keyId, pubB64: k.pubB64 };
  };
  const endorseAgent = (endorser: K, a: Agent) =>
    relay.db.endorseAgentKey(relay.fleetId, a.agentId, a.keyId, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, a.agentId, a.keyId, a.pubB64), endorser.seed),
    });
  const revoke = (signer: K, target: K) =>
    relay.db.revokeOperatorKey(relay.fleetId, target.id, signedRevocation(relay.fleetId, signer, target));
  const row = (k: K) => relay.db.listOperatorKeys(relay.fleetId).find((x) => x.key_id === k.id)!;
  const mayEndorse = (k: K) => relay.db.operatorKeyMayEndorse(relay.fleetId, k.id);

  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  describe("one pinned root R, child C endorsed by R", () => {
    let r: K;
    let c: K;
    let agent: Agent;
    beforeEach(async () => {
      r = makeKey();
      c = makeKey();
      register(r, "root");
      register(c, "child", r);
      agent = await addAgent("Case");
      endorseAgent(r, agent);
      expect(mayEndorse(c)).toBe(true);
    });

    it("REFUSES C revoking R: afterwards nothing could endorse; R stays live and the error names the way out", () => {
      expect(() => revoke(c, r)).toThrow(SURVIVING);
      expect(() => revoke(c, r)).toThrow(/Endorse the agents under a successor key first/);
      expect(() => revoke(c, r)).toThrow(/POST \/v1\/operator\/agents\/\{agentId\}\/endorse-key/);
      expect(row(r)).toMatchObject({ revoked_at: null, revoked_by_key_id: null, revocation_sig: null });
      expect(mayEndorse(c)).toBe(true);
    });

    it("R revoking C still succeeds", () => {
      revoke(r, c);
      expect(row(c).revocation_sig).toBeTruthy();
      expect(mayEndorse(r)).toBe(true);
    });

    it("C may revoke R once the agents are endorsed under C (the documented order)", () => {
      endorseAgent(c, agent);
      revoke(c, r);
      expect(row(r).revoked_by_key_id).toBe(c.id);
      expect(mayEndorse(c)).toBe(true);
    });
  });

  describe("two pinned roots R1 and R2, C endorsed by R1", () => {
    let r1: K;
    let r2: K;
    let c: K;
    beforeEach(async () => {
      r1 = makeKey();
      r2 = makeKey();
      c = makeKey();
      register(r1, "root-1");
      // R2 needs authority to endorse its agent at all; once it has one, it is
      // a root in its own right (the walk stops at a pinned key).
      register(r2, "root-2", r1);
      register(c, "child", r1);
      endorseAgent(r1, await addAgent("Case"));
      endorseAgent(r2, await addAgent("Edith"));
    });

    it("REFUSES C revoking R1 while C chains only through R1", () => {
      expect(() => revoke(c, r1)).toThrow(SURVIVING);
      expect(() => revoke(c, r1)).toThrow(new RegExp(`${c.id} is trusted only through ${r1.id}`));
      expect(row(r1).revoked_at).toBeNull();
    });

    it("ALLOWS C revoking R1 when C chains to R2 (re-endorsed by R2), and C can still endorse afterwards", async () => {
      endorseOperator(r2, c);
      revoke(c, r1);
      expect(row(r1).revoked_by_key_id).toBe(c.id);
      expect(mayEndorse(c)).toBe(true);
      expect(endorseAgent(c, await addAgent("Tars"))).toBe(true);
    });
  });

  describe("recovery-granted successor (#93)", () => {
    // The live shape: origin bootstraps the agents and vouches for root; the
    // agents move onto root; root's passphrase is lost; a grant lets origin
    // endorse a fresh successor once.
    let origin: K;
    let root: K;
    let successor: K;
    let agents: Agent[];
    beforeEach(async () => {
      origin = makeKey();
      root = makeKey();
      successor = makeKey();
      register(origin, "old browser");
      register(root, "lost browser");
      agents = [await addAgent("Jarvis"), await addAgent("Edith")];
      for (const a of agents) endorseAgent(origin, a);
      endorseOperator(origin, root);
      for (const a of agents) endorseAgent(root, a);
      register(successor, "new browser");
      relay.db.createOperatorRecoveryGrant(relay.fleetId, {
        endorserKeyId: origin.id,
        targetKeyId: successor.id,
        confirmedBy: "operator, out of band (test)",
      });
      endorseOperator(origin, successor); // consumes the grant
      expect(relay.db.listOperatorRecoveryGrants(relay.fleetId)[0].consumed_at).not.toBeNull();
      expect(mayEndorse(successor)).toBe(true);
    });

    it("REFUSES the successor revoking the old root while the agents are still endorsed by it", () => {
      expect(() => revoke(successor, root)).toThrow(SURVIVING);
      expect(row(root).revoked_at).toBeNull();
    });

    it("ALLOWS the successor revoking the old root once the agents are re-endorsed under it", () => {
      for (const a of agents) expect(endorseAgent(successor, a)).toBe(true);
      revoke(successor, root);
      expect(row(root).revoked_by_key_id).toBe(successor.id);
      expect(mayEndorse(successor)).toBe(true);
    });
  });

  it("a legacy unsigned tombstone is already not live: signing it passes the rule", async () => {
    const r = makeKey();
    const legacy = makeKey();
    register(r, "root");
    register(legacy, "old browser", r);
    endorseAgent(r, await addAgent("Case"));
    relay.db
      .raw()
      .prepare("UPDATE fleet_operator_keys SET revoked_at = ? WHERE fleet_id = ? AND key_id = ?")
      .run("2026-06-07T21:22:53.694Z", relay.fleetId, legacy.id);
    revoke(r, legacy);
    expect(row(legacy).revoked_by_key_id).toBe(r.id);
  });

  it("the fresh-fleet exemption is unchanged: with no agent endorsed, a child may revoke its parent", () => {
    const r = makeKey();
    const c = makeKey();
    register(r, "root");
    register(c, "child", r);
    revoke(c, r);
    expect(row(r).revoked_by_key_id).toBe(c.id);
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
