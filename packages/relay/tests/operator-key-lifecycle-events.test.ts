import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import {
  b64url,
  keyId,
  signCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
} from "../src/operator-identity";

function makeOperatorKey(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}

function makeAgentKey(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(seed);
  return { pubB64: b64url(pub) };
}

function lifecycle(relay: TestRelay) {
  return relay.db.listEvents(relay.fleetId, { type: "operator_key", limit: 50, offset: 0 }) as {
    items: Array<{ event_type: string; actor_id: string | null; resource_id: string | null }>;
  };
}

describe("#50 operator-key lifecycle writes events", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  it("revoke writes operator_key.revoked with actor and target", () => {
    const actor = makeOperatorKey(21);
    const target = makeOperatorKey(22);
    relay.db.registerOperatorKey(relay.fleetId, actor.pubB64, "actor", undefined, actor.id);
    relay.db.registerOperatorKey(relay.fleetId, target.pubB64, "target", undefined, actor.id);
    expect(relay.db.revokeOperatorKey(relay.fleetId, target.id, actor.id)).toBe(true);
    const revoked = lifecycle(relay).items.filter((e) => e.event_type === "operator_key.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actor_id).toBe(actor.id);
    expect(revoked[0].resource_id).toBe(target.id);
  });

  it("a revoke that changes nothing writes no event", () => {
    expect(relay.db.revokeOperatorKey(relay.fleetId, "missing-key", "actor-key")).toBe(false);
    expect(lifecycle(relay).items.filter((e) => e.event_type === "operator_key.revoked")).toHaveLength(0);
  });

  it("endorse writes operator_key.endorsed with actor and target", async () => {
    const root = makeOperatorKey(23);
    const rescued = makeOperatorKey(24);
    const agentKey = makeAgentKey(25);
    const enrolled = await relay.enrollAgent("Peer");
    const agentKeyId = relay.db.setAgentIdentityKey(enrolled.agent_id, relay.fleetId, agentKey.pubB64).keyId;
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone", undefined, root.id);
    relay.db.registerOperatorKey(relay.fleetId, rescued.pubB64, "laptop", undefined, root.id);
    relay.db.endorseAgentKey(relay.fleetId, enrolled.agent_id, agentKeyId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(
        agentKeyEndorsementPayload(relay.fleetId, enrolled.agent_id, agentKeyId, agentKey.pubB64),
        root.seed
      ),
    }, root.id);
    relay.db.endorseOperatorKey(
      relay.fleetId,
      rescued.id,
      {
        endorsedByKeyId: root.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, rescued.id, rescued.pubB64), root.seed),
      },
      root.id
    );
    const endorsed = lifecycle(relay).items.filter((e) => e.event_type === "operator_key.endorsed");
    expect(endorsed).toHaveLength(1);
    expect(endorsed[0].actor_id).toBe(root.id);
    expect(endorsed[0].resource_id).toBe(rescued.id);

    const { items: agentEvents } = relay.db.listEvents(relay.fleetId, { type: "agent_key", limit: 20, offset: 0 }) as {
      items: Array<{ event_type: string; actor_id: string | null; resource_id: string | null }>;
    };
    const agentEndorsed = agentEvents.filter((e) => e.event_type === "agent_key.endorsed");
    expect(agentEndorsed).toHaveLength(1);
    expect(agentEndorsed[0].actor_id).toBe(root.id);
    expect(agentEndorsed[0].resource_id).toBe(agentKeyId);
  });
});
