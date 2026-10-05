import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import { b64url, keyId, signCanonical, revocationPayload } from "../src/operator-identity";

function makeOperatorKey(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}

/** Wire body for POST /v1/operator/keys/:keyId/revoke, signed by `signer`. */
function revokeBody(fleetId: string, signer: ReturnType<typeof makeOperatorKey>, targetKeyId: string) {
  const revoked_at = new Date().toISOString();
  return {
    revoked_by_key_id: signer.id,
    revoked_at,
    signature: signCanonical(revocationPayload(fleetId, targetKeyId, revoked_at), signer.seed),
  };
}

function revokedEvents(relay: TestRelay) {
  return relay.db
    .getActivity(relay.fleetId, { limit: 50, type: "operator_key" })
    .filter((e) => e.event_type === "operator_key.revoked");
}

// #53: `?actor_key_id=` is client-supplied. Writing it to the audit trail's
// actor_id let any authenticated session mint a revoke attributed to someone
// else's device key — the audit log then blames the wrong operator. Revocation
// is now signed, so the SIGNER is a verified identity (revoked_by_key_id); the
// query hint stays exactly what it was: an unverified debugging note.
describe("#53 revoke audit actor is the authenticated session", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  it("never persists a client-supplied actor_key_id as the event actor_id", async () => {
    const victim = makeOperatorKey(31);
    const signer = makeOperatorKey(36);
    const target = makeOperatorKey(32);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: victim.pubB64, label: "victim" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: signer.pubB64, label: "signer" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    const res = await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${target.id}/revoke?actor_key_id=${victim.id}`,
      revokeBody(relay.fleetId, signer, target.id)
    );
    expect(res.status).toBe(200);

    const revoked = revokedEvents(relay);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actor_id).toBe(relay.operatorId);
    expect(revoked[0].actor_id).not.toBe(victim.id);
    // The signer is verified by its signature and recorded as such.
    expect(revoked[0].payload.revoked_by_key_id).toBe(signer.id);
  });

  it("keeps the claimed device key id in the payload, clearly unverified", async () => {
    const victim = makeOperatorKey(33);
    const signer = makeOperatorKey(37);
    const target = makeOperatorKey(34);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: victim.pubB64, label: "victim" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: signer.pubB64, label: "signer" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${target.id}/revoke?actor_key_id=${victim.id}`,
      revokeBody(relay.fleetId, signer, target.id)
    );

    const revoked = revokedEvents(relay);
    expect(revoked[0].payload.claimed_actor_key_id_unverified).toBe(victim.id);
    expect(revoked[0].payload.revoked_by_key_id).toBe(signer.id);
  });

  it("records no claimed key id when the caller sends none", async () => {
    const signer = makeOperatorKey(38);
    const target = makeOperatorKey(35);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: signer.pubB64, label: "signer" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    await relay.operatorRequest(
      "POST",
      `/v1/operator/keys/${target.id}/revoke`,
      revokeBody(relay.fleetId, signer, target.id)
    );

    const revoked = revokedEvents(relay);
    expect(revoked[0].actor_id).toBe(relay.operatorId);
    expect(revoked[0].payload.claimed_actor_key_id_unverified).toBeNull();
  });
});
