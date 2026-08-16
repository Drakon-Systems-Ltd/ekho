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

/**
 * #19, second half — the guard that was only ever in the browser.
 *
 * The fix shipped at 08:45Z on 16 Aug (endorseAuthority) asked the right
 * question — "would the fleet actually believe this key?" — but asked it in
 * `frontend/src/operatorTrust.js`. A client-side check is a usability feature,
 * not a control: the relay itself still accepted an endorsement signed by any
 * live key, so the exact request that re-rooted all 8 agents onto an orphan at
 * 08:33Z was still reachable by anyone holding an operator token and curl.
 *
 * These tests exercise the server. The rule is the same one the console shows:
 * "live" is not "trusted". A key may endorse only if the fleet would follow it —
 * it already has agents pinned to it, or it chains to a live key.
 *
 * The second describe covers the residue that incident left in the live relay:
 * 2T8znI7sDIHiwaL1 records endorsed_by = X6NvGXWiMP32k0J6 (written by the
 * laptop at 08:33) while X6Nv records endorsed_by = 2T8zn (written by the phone
 * at 09:52). Each key vouches for the other and neither is rooted in anything.
 * It cannot loop an agent — adoption is a single-level check that short-circuits
 * on an already-pinned key — but a trust chain with no root is a lie about where
 * trust comes from, and the next reader of that table has no way to tell which
 * of the two is the real one.
 */
describe("#19 the relay enforces endorse authority, not just the console", () => {
  let relay: TestRelay;
  let agentId: string;
  let agentKeyId: string;
  const agentKey = makeAgentKey(70);

  beforeEach(async () => {
    relay = await createTestRelay();
    agentId = (await relay.enrollAgent("Case")).agent_id;
    agentKeyId = relay.db.setAgentIdentityKey(agentId, relay.fleetId, agentKey.pubB64).keyId;
  });
  afterEach(() => relay.cleanup());

  const endorseAgent = (endorser: ReturnType<typeof makeOperatorKey>) =>
    relay.db.endorseAgentKey(relay.fleetId, agentId, agentKeyId, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(
        agentKeyEndorsementPayload(relay.fleetId, agentId, agentKeyId, agentKey.pubB64),
        endorser.seed
      ),
    });

  const endorseOperator = (
    endorser: ReturnType<typeof makeOperatorKey>,
    target: ReturnType<typeof makeOperatorKey>
  ) =>
    relay.db.endorseOperatorKey(relay.fleetId, target.id, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(
        endorsementPayload(relay.fleetId, target.id, target.pubB64),
        endorser.seed
      ),
    });

  it("REFUSES an agent endorsement from a live but untrusted key — the 08:33 break, at the API", () => {
    const root = makeOperatorKey(71);
    const orphan = makeOperatorKey(72);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop");
    endorseAgent(root); // the agent is pinned to the phone, as the fleet was

    expect(() => endorseAgent(orphan)).toThrow(/no agent trusts it|not trusted|untrusted/i);

    // and the agent is still where it was, not moved onto the orphan
    const row = relay.db.getAgentIdentityKeys(relay.fleetId).find((k) => k.agent_id === agentId);
    expect(row?.endorsed_by_key_id).toBe(root.id);
  });

  it("allows an agent endorsement from a key the agents already pin — the 08:52 recovery", () => {
    const root = makeOperatorKey(73);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    expect(endorseAgent(root)).toBe(true); // bootstrap: nothing pinned yet
    expect(endorseAgent(root)).toBe(true); // and again, now that it has a dependent
  });

  it("allows an agent endorsement from a key that chains to a live key — #13 adoption", () => {
    const root = makeOperatorKey(74);
    const rescued = makeOperatorKey(75);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, rescued.pubB64, "laptop");
    endorseAgent(root);
    endorseOperator(root, rescued); // phone vouches for laptop

    expect(endorseAgent(rescued)).toBe(true);
  });

  it("refuses an agent endorsement from a key whose only endorser has since been revoked", () => {
    const root = makeOperatorKey(76);
    const rescued = makeOperatorKey(77);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, rescued.pubB64, "laptop");
    endorseAgent(root);
    endorseOperator(root, rescued);
    relay.db.revokeOperatorKey(relay.fleetId, root.id);

    expect(() => endorseAgent(rescued)).toThrow(/no agent trusts it|not trusted|untrusted/i);
  });

  it("REFUSES an operator endorsement from a live but untrusted key", () => {
    const root = makeOperatorKey(78);
    const orphan = makeOperatorKey(79);
    const target = makeOperatorKey(80);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop");
    relay.db.registerOperatorKey(relay.fleetId, target.pubB64, "tablet");
    endorseAgent(root);

    expect(() => endorseOperator(orphan, target)).toThrow(/no agent trusts it|not trusted|untrusted/i);
  });

  it("still bootstraps a fresh fleet that has no agent identity keys yet", async () => {
    const fresh = await createTestRelay();
    try {
      const first = makeOperatorKey(81);
      const second = makeOperatorKey(82);
      fresh.db.registerOperatorKey(fresh.fleetId, first.pubB64, "phone");
      fresh.db.registerOperatorKey(fresh.fleetId, second.pubB64, "laptop");
      expect(() =>
        fresh.db.endorseOperatorKey(fresh.fleetId, second.id, {
          endorsedByKeyId: first.id,
          signature: signCanonical(
            endorsementPayload(fresh.fleetId, second.id, second.pubB64),
            first.seed
          ),
        })
      ).not.toThrow();
    } finally {
      fresh.cleanup();
    }
  });
});

describe("#19 an endorsement chain may not close on itself", () => {
  let relay: TestRelay;
  let agentId: string;
  let agentKeyId: string;
  const agentKey = makeAgentKey(90);

  beforeEach(async () => {
    relay = await createTestRelay();
    agentId = (await relay.enrollAgent("Case")).agent_id;
    agentKeyId = relay.db.setAgentIdentityKey(agentId, relay.fleetId, agentKey.pubB64).keyId;
  });
  afterEach(() => relay.cleanup());

  const register = (k: ReturnType<typeof makeOperatorKey>, label: string) =>
    relay.db.registerOperatorKey(relay.fleetId, k.pubB64, label);

  const endorseOperator = (
    endorser: ReturnType<typeof makeOperatorKey>,
    target: ReturnType<typeof makeOperatorKey>
  ) =>
    relay.db.endorseOperatorKey(relay.fleetId, target.id, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(
        endorsementPayload(relay.fleetId, target.id, target.pubB64),
        endorser.seed
      ),
    });

  const pinAgentTo = (k: ReturnType<typeof makeOperatorKey>) =>
    relay.db.endorseAgentKey(relay.fleetId, agentId, agentKeyId, {
      endorsedByKeyId: k.id,
      signature: signCanonical(
        agentKeyEndorsementPayload(relay.fleetId, agentId, agentKeyId, agentKey.pubB64),
        k.seed
      ),
    });

  it("REFUSES the two-key ouroboros the live relay is carrying", () => {
    const phone = makeOperatorKey(91);
    const laptop = makeOperatorKey(92);
    register(phone, "Mike iPhone 15 Pro Max");
    register(laptop, "m.kyriacou101@gmail.com");
    pinAgentTo(phone);
    // The laptop's 08:33 write, which the console can no longer produce but the
    // table still holds: the root records the orphan as its parent.
    relay.db
      .raw()
      .prepare("UPDATE fleet_operator_keys SET endorsed_by_key_id = ? WHERE fleet_id = ? AND key_id = ?")
      .run(laptop.id, relay.fleetId, phone.id);

    // The phone then rescues the laptop, as it did at 09:52 — and closes the loop.
    expect(() => endorseOperator(phone, laptop)).toThrow(/chain|cycle|circular/i);
  });

  it("REFUSES a longer cycle: A endorses B endorses C, C may not endorse A", () => {
    const a = makeOperatorKey(93);
    const b = makeOperatorKey(94);
    const c = makeOperatorKey(95);
    register(a, "a");
    register(b, "b");
    register(c, "c");
    pinAgentTo(a);
    endorseOperator(a, b);
    endorseOperator(b, c);

    expect(() => endorseOperator(c, a)).toThrow(/chain|cycle|circular/i);
  });

  it("still allows a legitimate re-parenting that does not close a loop", () => {
    const phone = makeOperatorKey(96);
    const laptop = makeOperatorKey(97);
    const tablet = makeOperatorKey(98);
    register(phone, "phone");
    register(laptop, "laptop");
    register(tablet, "tablet");
    pinAgentTo(phone);
    endorseOperator(phone, laptop);

    expect(() => endorseOperator(phone, tablet)).not.toThrow();
    expect(() => endorseOperator(laptop, tablet)).not.toThrow();
  });
});
