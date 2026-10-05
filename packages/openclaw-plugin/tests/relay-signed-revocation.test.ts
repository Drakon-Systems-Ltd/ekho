import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  b64url,
  fromB64url,
  keyId,
  signCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
  revocationPayload,
} from "../src/identity";
import { syncPinnedOperatorKeys, resetAdvisoryRevocationWarningStateForTests, type OperatorKeyEntryLike } from "../src/verification";
import type { EkhoIdentity } from "../src/credentials";
// The relay's own test harness: a real relay (fastify + SQLite in a temp dir)
// whose /v1/inbox and /v1/enroll responses are what this agent-side code reads.
import { createTestRelay, type TestRelay } from "../../relay/tests/setup";

/**
 * END TO END: the relay signs and distributes an operator-key revocation, and
 * this plugin's pin sync honours it.
 *
 * Before the relay change, the inbox entry for a revoked key was
 * `{ key_id, public_key, revoked: true, endorsed_by_key_id, endorsement_sig }`
 * — no `revoked_at`, no `revocation_sig`. `applySignedRevocations` (#27)
 * rightly treats that as advisory, so every agent kept the key pinned (this
 * box's gateway journal: "relay reports 7 operator keys as REVOKED without a
 * valid revocation signature ... NOT unpinned"). These tests feed the relay's
 * REAL output, not a hand-built fixture, into syncPinnedOperatorKeys.
 */

let fill = 200;
function makeKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}
type K = ReturnType<typeof makeKey>;

const QUIET = { warn: () => {}, info: () => {} };

describe("relay-signed revocation → plugin pin sync", () => {
  let relay: TestRelay;
  let root: K;
  let successor: K;
  let agent: { agent_id: string; secret: string };

  const inboxKeys = async (): Promise<OperatorKeyEntryLike[]> => {
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox?limit=10");
    expect(res.status).toBe(200);
    return res.body.operator_keys as OperatorKeyEntryLike[];
  };
  /** An identity shaped like a long-enrolled agent that pins both keys. */
  const pinnedBoth = (): EkhoIdentity => ({
    seedHex: "00".repeat(32),
    pinnedOperatorKeys: { [root.id]: root.pubB64, [successor.id]: successor.pubB64 },
    tofuAt: "2026-08-01T00:00:00.000Z",
  });

  beforeEach(async () => {
    resetAdvisoryRevocationWarningStateForTests();
    relay = await createTestRelay();
    root = makeKey();
    successor = makeKey();
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: root.pubB64, label: "lost-browser" });
    await relay.operatorRequest("POST", "/v1/operator/keys", {
      public_key: successor.pubB64,
      label: "new-browser",
      endorsement: {
        endorsed_by_key_id: root.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, successor.id, successor.pubB64), root.seed),
      },
    });
    agent = await relay.enrollAgent("Jarvis");
    // Make root a genuine trust root (an endorsed agent key) so the relay's
    // authority rule is engaged, exactly as on the live fleet.
    const ak = makeKey();
    const akId = relay.db.setAgentIdentityKey(agent.agent_id, relay.fleetId, ak.pubB64).keyId;
    relay.db.endorseAgentKey(relay.fleetId, agent.agent_id, akId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agent.agent_id, akId, ak.pubB64), root.seed),
    });
  });
  afterEach(() => relay.cleanup());

  it("a revocation signed on the console by the successor tombstones AND unpins the lost root on the agent", async () => {
    const identity = pinnedBoth();
    // Steady state: nothing to change.
    expect(syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, QUIET)).toBe(false);

    // The console (holding `successor`) revokes `root` through the new route.
    const revokedAt = new Date().toISOString();
    const res = await relay.operatorRequest("POST", `/v1/operator/keys/${root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, root.id, revokedAt), successor.seed),
    });
    expect(res.status).toBe(200);

    // The agent's next poll.
    const keys = await inboxKeys();
    const dead = keys.find((k) => k.key_id === root.id)!;
    expect(dead.revoked).toBe(true);
    expect(dead.revoked_at).toBe(revokedAt);
    expect(dead.revocation_sig).toBeTruthy();

    const warnings: string[] = [];
    const changed = syncPinnedOperatorKeys(identity, keys, relay.fleetId, {
      warn: (...a: unknown[]) => warnings.push(a.join(" ")),
      info: () => {},
    });
    expect(changed).toBe(true);
    expect(identity.pinnedOperatorKeys[root.id]).toBeUndefined();
    expect(identity.pinnedOperatorKeys[successor.id]).toBe(successor.pubB64);
    expect(identity.revokedOperatorKeys?.[root.id]).toBe(revokedAt);
    expect(warnings.join("\n")).toMatch(/is revoked \(signed/);
    expect(warnings.join("\n")).not.toMatch(/ADVISORY/);

    // And it sticks: the next poll re-adds nothing (tombstone wins over the
    // still-present endorsement chain).
    expect(syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, QUIET)).toBe(false);
    expect(identity.pinnedOperatorKeys[root.id]).toBeUndefined();
  });

  it("the OLD inbox shape (no revocation_sig) is only advisory: the key stays pinned, nothing is tombstoned", async () => {
    const revokedAt = new Date().toISOString();
    await relay.operatorRequest("POST", `/v1/operator/keys/${root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, root.id, revokedAt), successor.seed),
    });
    // What the relay emitted before this change.
    const legacy = (await inboxKeys()).map(({ key_id, public_key, revoked, endorsed_by_key_id, endorsement_sig }) => ({
      key_id,
      public_key,
      revoked,
      endorsed_by_key_id,
      endorsement_sig,
    }));
    expect(legacy.find((k) => k.key_id === root.id)?.revoked).toBe(true);

    const identity = pinnedBoth();
    const warnings: string[] = [];
    const changed = syncPinnedOperatorKeys(identity, legacy, relay.fleetId, {
      warn: (...a: unknown[]) => warnings.push(a.join(" ")),
      info: () => {},
    });
    expect(changed).toBe(false);
    expect(identity.pinnedOperatorKeys[root.id]).toBe(root.pubB64); // still trusted — the defect
    expect(identity.revokedOperatorKeys ?? {}).toEqual({});
    expect(warnings.join("\n")).toMatch(/REVOKED without a valid revocation signature/);
  });

  it("a fresh agent enrolling after the revocation TOFU-pins only the live key — the tombstone is skipped", async () => {
    const revokedAt = new Date().toISOString();
    await relay.operatorRequest("POST", `/v1/operator/keys/${root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, root.id, revokedAt), successor.seed),
    });
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const res = await relay.app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { fleet_id: relay.fleetId, token, display_name: "Newcomer", runtime: "custom" },
    });
    const enrollKeys = JSON.parse(res.body).operator_keys as OperatorKeyEntryLike[];
    expect(enrollKeys.map((k) => k.key_id).sort()).toEqual([root.id, successor.id].sort());

    const fresh: EkhoIdentity = { seedHex: "11".repeat(32), pinnedOperatorKeys: {} };
    expect(syncPinnedOperatorKeys(fresh, enrollKeys, relay.fleetId, QUIET)).toBe(true);
    expect(fresh.pinnedOperatorKeys).toEqual({ [successor.id]: successor.pubB64 });
    expect(fresh.tofuAt).toBeTruthy();
    // With no pins yet the signature cannot be checked against a pinned key, so
    // the entry is advisory here (not tombstoned) — but it is never adopted.
    expect(fresh.revokedOperatorKeys ?? {}).toEqual({});
  });

  it("the relay's signature is over the exact bytes this plugin reconstructs (payload parity)", async () => {
    const revokedAt = new Date().toISOString();
    await relay.operatorRequest("POST", `/v1/operator/keys/${root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, root.id, revokedAt), successor.seed),
    });
    const dead = (await inboxKeys()).find((k) => k.key_id === root.id)!;
    const { verifyCanonical } = await import("../src/identity");
    expect(
      verifyCanonical(revocationPayload(relay.fleetId, root.id, dead.revoked_at!), dead.revocation_sig!, fromB64url(successor.pubB64))
    ).toBe(true);
  });
});
