import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import { b64url, keyId } from "../src/operator-identity";

function makeOperatorKey(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}

function revokedEvents(relay: TestRelay) {
  return relay.db
    .getActivity(relay.fleetId, { limit: 50, type: "operator_key" })
    .filter((e) => e.event_type === "operator_key.revoked");
}

// #53: `?actor_key_id=` is client-supplied. Writing it to the audit trail's
// actor_id let any authenticated session mint a revoke attributed to someone
// else's device key — the audit log then blames the wrong operator.
describe("#53 revoke audit actor is the authenticated session", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  it("never persists a client-supplied actor_key_id as the event actor_id", async () => {
    const victim = makeOperatorKey(31);
    const target = makeOperatorKey(32);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: victim.pubB64, label: "victim" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    const del = await relay.operatorRequest(
      "DELETE",
      `/v1/operator/keys/${target.id}?actor_key_id=${victim.id}`
    );
    expect(del.status).toBe(200);

    const revoked = revokedEvents(relay);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actor_id).toBe(relay.operatorId);
    expect(revoked[0].actor_id).not.toBe(victim.id);
  });

  it("keeps the claimed device key id in the payload, clearly unverified", async () => {
    const victim = makeOperatorKey(33);
    const target = makeOperatorKey(34);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: victim.pubB64, label: "victim" });
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    await relay.operatorRequest("DELETE", `/v1/operator/keys/${target.id}?actor_key_id=${victim.id}`);

    const revoked = revokedEvents(relay);
    expect(revoked[0].payload.claimed_actor_key_id_unverified).toBe(victim.id);
  });

  it("records no claimed key id when the caller sends none", async () => {
    const target = makeOperatorKey(35);
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: target.pubB64, label: "target" });

    await relay.operatorRequest("DELETE", `/v1/operator/keys/${target.id}`);

    const revoked = revokedEvents(relay);
    expect(revoked[0].actor_id).toBe(relay.operatorId);
    expect(revoked[0].payload.claimed_actor_key_id_unverified).toBeNull();
  });
});
