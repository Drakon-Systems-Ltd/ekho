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

/**
 * Registering a NEW operator key with an endorsement must apply the same
 * authority rule as endorsing an existing one. Before this, the register path
 * only checked that the endorser was LIVE, so a live-but-untrusted key could
 * mint a child, the "parent is live" chain rule then counted that child as
 * trusted, and the child could re-endorse every agent: the 16 Aug break in two
 * steps, and a way around the #93 recovery ceremony.
 */
describe("register-with-endorsement requires a trusted endorser", () => {
  let relay: TestRelay;
  let agentId: string;
  let agentKeyId: string;
  const agentPub = b64url(ed25519.getPublicKey(new Uint8Array(32).fill(90)));
  const root = makeOperatorKey(91);
  const stranger = makeOperatorKey(92);
  const child = makeOperatorKey(93);
  const rootChild = makeOperatorKey(94);

  const registerEndorsed = (key: ReturnType<typeof makeOperatorKey>, by: ReturnType<typeof makeOperatorKey>) =>
    relay.db.registerOperatorKey(relay.fleetId, key.pubB64, "new", {
      endorsedByKeyId: by.id,
      signature: signCanonical(endorsementPayload(relay.fleetId, key.id, key.pubB64), by.seed),
    });

  beforeEach(async () => {
    relay = await createTestRelay();
    agentId = (await relay.enrollAgent("Case")).agent_id;
    agentKeyId = relay.db.setAgentIdentityKey(agentId, relay.fleetId, agentPub).keyId;
    // root is the fleet's trust root: the agent key is endorsed by it.
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.endorseAgentKey(relay.fleetId, agentId, agentKeyId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agentId, agentKeyId, agentPub), root.seed),
    });
    // stranger is live but endorsed by nobody and pinned by no agent.
    relay.db.registerOperatorKey(relay.fleetId, stranger.pubB64, "unknown device");
  });
  afterEach(() => relay.cleanup());

  it("refuses a child minted by a live but untrusted key", () => {
    expect(() => registerEndorsed(child, stranger)).toThrow(/live but unendorsed/);
    expect(relay.db.listOperatorKeys(relay.fleetId).some((k) => k.key_id === child.id)).toBe(false);
  });

  it("so the two-step re-root cannot reach an agent", () => {
    expect(() => registerEndorsed(child, stranger)).toThrow();
    expect(() =>
      relay.db.endorseAgentKey(relay.fleetId, agentId, agentKeyId, {
        endorsedByKeyId: child.id,
        signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agentId, agentKeyId, agentPub), child.seed),
      })
    ).toThrow();
  });

  it("still lets the trust root register an endorsed child", () => {
    expect(registerEndorsed(rootChild, root).keyId).toBe(rootChild.id);
  });

  it("still allows an unendorsed registration (the console's first step)", () => {
    expect(relay.db.registerOperatorKey(relay.fleetId, child.pubB64, "laptop").keyId).toBe(child.id);
  });
});
