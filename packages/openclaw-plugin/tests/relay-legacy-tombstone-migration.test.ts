import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  b64url,
  keyId,
  signCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
  revocationPayload,
} from "../src/identity";
import {
  syncPinnedOperatorKeys,
  resetAdvisoryRevocationWarningStateForTests,
  type OperatorKeyEntryLike,
} from "../src/verification";
import type { EkhoIdentity } from "../src/credentials";
// The relay's own harness: a real fastify + SQLite relay. Its /v1/inbox is what
// this plugin's pin sync reads.
import { createTestRelay, type TestRelay } from "../../relay/tests/setup";

/**
 * The upgrade path for a key revoked BEFORE signed revocation existed, end to
 * end and on real rows:
 *
 *  1. a relay database in its pre-024 shape (`fleet_operator_keys` without
 *     `revoked_by_key_id` / `revocation_sig`, migration 24 not applied) holding
 *     a key the old `DELETE /v1/operator/keys/:keyId` path tombstoned: a
 *     `revoked_at` and nothing else;
 *  2. the relay's own migration runner applies the real `024_*.sql` to it, as it
 *     does at boot after the upgrade — the row keeps its unsigned time and gets
 *     NULL in both new columns;
 *  3. the inbox serves that row and the agent verifier keeps the key pinned
 *     (advisory: no agent ever honoured an unsigned revocation, #27);
 *  4. an EPHEMERAL signer — a key that did not exist before the upgrade,
 *     endorsed by the root the agent pins — signs the revocation through the
 *     supported route, `POST /v1/operator/keys/:keyId/revoke`;
 *  5. the resulting real inbox row makes the same verifier tombstone and unpin
 *     the key;
 *  6. control: a tombstone that already carries a signature is never
 *     overwritten by that route, byte for byte, whoever signs — including the
 *     just-signed legacy one.
 *
 * Nothing here is a hand-built fixture: the pre-024 shape is produced by
 * dropping the two columns the migration adds and un-recording the migration,
 * the migration is the file in packages/relay/migrations run by `runMigrationsOn`,
 * and every row the verifier sees comes from the relay's inbox route.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../relay/migrations", import.meta.url));
/** What the old unsigned DELETE path left behind: a time, no signer, no signature. */
const LEGACY_AT = "2026-06-07T21:22:53.694Z";

let fill = 230;
function makeKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}
type K = ReturnType<typeof makeKey>;

const QUIET = { warn: () => {}, info: () => {} };
const collecting = (into: string[]) => ({ warn: (...a: unknown[]) => into.push(a.join(" ")), info: () => {} });

describe("legacy unsigned tombstone: pre-024 row → migration 024 → signed via the route by an ephemeral trusted signer → agent verifier", () => {
  let relay: TestRelay;
  let root: K; // the key the agent pins and the agents are endorsed by
  let old: K; // the pre-upgrade browser the old DELETE path "revoked"
  let ctl: K; // control: revoked through the signed route after the upgrade
  let agent: { agent_id: string; secret: string };

  const registerKey = async (k: K, label: string, endorser?: K) => {
    const res = await relay.operatorRequest("POST", "/v1/operator/keys", {
      public_key: k.pubB64,
      label,
      ...(endorser
        ? {
            endorsement: {
              endorsed_by_key_id: endorser.id,
              signature: signCanonical(endorsementPayload(relay.fleetId, k.id, k.pubB64), endorser.seed),
            },
          }
        : {}),
    });
    expect(res.status, `register ${label}`).toBeLessThan(300);
  };
  const revokeViaRoute = (signer: K, target: K, revokedAt = new Date().toISOString()) =>
    relay.operatorRequest("POST", `/v1/operator/keys/${target.id}/revoke`, {
      revoked_by_key_id: signer.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, target.id, revokedAt), signer.seed),
    });
  const inboxKeys = async (): Promise<OperatorKeyEntryLike[]> => {
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox?limit=10");
    expect(res.status).toBe(200);
    return res.body.operator_keys as OperatorKeyEntryLike[];
  };
  const inboxRow = async (k: K) => (await inboxKeys()).find((x) => x.key_id === k.id)!;
  /** The whole stored row, every column, for byte-for-byte comparisons. */
  const fullRow = (k: K) =>
    relay.db
      .raw()
      .prepare("SELECT * FROM fleet_operator_keys WHERE fleet_id = ? AND key_id = ?")
      .get(relay.fleetId, k.id) as Record<string, unknown>;
  const columns = () =>
    (relay.db.raw().prepare("PRAGMA table_info(fleet_operator_keys)").all() as { name: string }[]).map((c) => c.name);
  const appliedVersions = () =>
    (relay.db.raw().prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
      (r) => r.version
    );
  /** An identity shaped like a long-enrolled agent that pinned the root and the old browser. */
  const longEnrolled = (): EkhoIdentity => ({
    seedHex: "00".repeat(32),
    pinnedOperatorKeys: { [root.id]: root.pubB64, [old.id]: old.pubB64 },
    tofuAt: "2026-05-01T00:00:00.000Z",
  });

  beforeEach(async () => {
    resetAdvisoryRevocationWarningStateForTests();
    relay = await createTestRelay();
    root = makeKey();
    old = makeKey();
    ctl = makeKey();
    await registerKey(root, "phone");
    await registerKey(old, "old-browser", root);
    await registerKey(ctl, "laptop", root);
    agent = await relay.enrollAgent("Jarvis");
    // Endorse the agent under root so the relay's authority rule is engaged (a
    // fleet with an endorsed agent, not the fresh-fleet exemption).
    const ak = makeKey();
    const akId = relay.db.setAgentIdentityKey(agent.agent_id, relay.fleetId, ak.pubB64).keyId;
    relay.db.endorseAgentKey(relay.fleetId, agent.agent_id, akId, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agent.agent_id, akId, ak.pubB64), root.seed),
    });

    // --- 1. Put the database back into its pre-024 shape, with the legacy row.
    const raw = relay.db.raw();
    raw.exec("ALTER TABLE fleet_operator_keys DROP COLUMN revocation_sig");
    raw.exec("ALTER TABLE fleet_operator_keys DROP COLUMN revoked_by_key_id");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 24").run();
    // Exactly the UPDATE the pre-024 DELETE route ran.
    raw
      .prepare("UPDATE fleet_operator_keys SET revoked_at = ? WHERE fleet_id = ? AND key_id = ?")
      .run(LEGACY_AT, relay.fleetId, old.id);
    expect(columns()).not.toContain("revocation_sig");
    expect(columns()).not.toContain("revoked_by_key_id");
    expect(appliedVersions()).not.toContain(24);
    expect(fullRow(old)).toMatchObject({ revoked_at: LEGACY_AT });

    // --- 2. The upgrade: the relay's migration runner over the real migrations
    // directory, which is what EkhoDb's constructor calls at boot.
    const { runMigrationsOn } = await import("../../relay/src/db");
    runMigrationsOn(raw, MIGRATIONS_DIR);
    expect(appliedVersions()).toContain(24);
    expect(columns()).toEqual(expect.arrayContaining(["revoked_by_key_id", "revocation_sig"]));
    expect(fullRow(old)).toMatchObject({ revoked_at: LEGACY_AT, revoked_by_key_id: null, revocation_sig: null });
  });
  afterEach(() => relay.cleanup());

  it("migrates the row unsigned, keeps it pinned on the agent, signs it through the route with an ephemeral trusted signer, and the real inbox row then tombstones + unpins it; a signed tombstone is never overwritten", async () => {
    // --- 3. The migrated legacy row, as the inbox serves it, is advisory to the agent.
    expect(await inboxRow(old)).toMatchObject({ revoked: true, revoked_at: LEGACY_AT, revocation_sig: null });
    const identity = longEnrolled();
    const poll1: string[] = [];
    // This poll also adopts `ctl` (endorsed by the pinned root) — a long-enrolled
    // agent would have done that long ago; it is what makes the control real.
    expect(syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, collecting(poll1))).toBe(true);
    expect(identity.pinnedOperatorKeys[old.id]).toBe(old.pubB64); // still trusted — the pre-fix defect
    expect(identity.pinnedOperatorKeys[ctl.id]).toBe(ctl.pubB64);
    expect(identity.revokedOperatorKeys ?? {}).toEqual({});
    expect(poll1.join("\n")).toMatch(/REVOKED without a valid revocation signature/);

    // --- 4. An EPHEMERAL signer: registered after the upgrade, endorsed by the
    // root, never pinned by the agent until the next poll adopts it over that
    // endorsement. The relay trusts it because it chains to the pinned root.
    const signer = makeKey();
    await registerKey(signer, "ephemeral-signer", root);
    expect(syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, QUIET)).toBe(true);
    expect(identity.pinnedOperatorKeys[signer.id]).toBe(signer.pubB64);
    expect(identity.pinnedOperatorKeys[old.id]).toBe(old.pubB64); // and old is STILL pinned

    // Control, part 1: a tombstone that carries a signature from the start.
    const ctlAt = new Date().toISOString();
    expect((await revokeViaRoute(root, ctl, ctlAt)).status).toBe(200);
    const ctlRowSigned = fullRow(ctl);
    expect(ctlRowSigned).toMatchObject({ revoked_at: ctlAt, revoked_by_key_id: root.id });
    expect(ctlRowSigned.revocation_sig).toBeTruthy();

    // The supported operator route signs the legacy tombstone.
    const revokedAt = new Date().toISOString();
    const signed = await revokeViaRoute(signer, old, revokedAt);
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ revoked: true, key_id: old.id, revoked_at: revokedAt, revoked_by_key_id: signer.id });
    const oldRowSigned = fullRow(old);
    expect(oldRowSigned).toMatchObject({ revoked_at: revokedAt, revoked_by_key_id: signer.id });
    expect(oldRowSigned.revocation_sig).toBeTruthy();
    // The audit trail says which kind of revocation this was, and what it replaced.
    const resign = relay.db
      .getActivity(relay.fleetId, { limit: 50, type: "operator_key" })
      .find((e) => e.event_type === "operator_key.revoked" && e.resource_id === old.id)!;
    expect(resign).toBeTruthy();
    expect(resign.payload).toMatchObject({
      revoked_by_key_id: signer.id,
      legacy_resign: true,
      prior_unsigned_revoked_at: LEGACY_AT,
    });

    // --- 6. Control, part 2: neither signed tombstone can be overwritten by the
    // same route, by the ephemeral signer or by the root.
    for (const [who, target, before] of [
      [signer, ctl, ctlRowSigned],
      [root, ctl, ctlRowSigned],
      [root, old, oldRowSigned],
      [signer, old, oldRowSigned],
    ] as const) {
      const again = await revokeViaRoute(who, target);
      expect(again.status, `${who.id} re-signing ${target.id}`).toBe(400);
      expect(again.body.error).toMatch(/already revoked/);
      expect(fullRow(target)).toEqual(before);
    }

    // --- 5. The agent's next poll: both real inbox rows carry signatures the
    // agent can verify against keys it pins, so it tombstones and unpins both.
    const keys = await inboxKeys();
    expect(keys.find((k) => k.key_id === old.id)).toMatchObject({
      revoked: true,
      revoked_at: revokedAt,
      revoked_by_key_id: signer.id,
      revocation_sig: oldRowSigned.revocation_sig,
    });
    const poll3: string[] = [];
    expect(syncPinnedOperatorKeys(identity, keys, relay.fleetId, collecting(poll3))).toBe(true);
    expect(identity.pinnedOperatorKeys).toEqual({ [root.id]: root.pubB64, [signer.id]: signer.pubB64 });
    expect(identity.revokedOperatorKeys).toEqual({ [old.id]: revokedAt, [ctl.id]: ctlAt });
    expect(poll3.join("\n")).toMatch(/is revoked \(signed/);
    expect(poll3.join("\n")).not.toMatch(/ADVISORY/);

    // And it sticks on the poll after that.
    expect(syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, QUIET)).toBe(false);
    expect(identity.pinnedOperatorKeys[old.id]).toBeUndefined();
  });

  it("the migrated legacy row is still refused when the signer is not trusted: the row stays unsigned and the agent keeps the key", async () => {
    // An orphan: live, endorsed by nobody, pinned by nobody — the 16 Aug shape.
    const orphan = makeKey();
    await registerKey(orphan, "orphan");
    const before = fullRow(old);
    const res = await revokeViaRoute(orphan, old);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no agent trusts it/);
    expect(fullRow(old)).toEqual(before);

    const identity = longEnrolled();
    syncPinnedOperatorKeys(identity, await inboxKeys(), relay.fleetId, QUIET);
    expect(identity.pinnedOperatorKeys[old.id]).toBe(old.pubB64);
    expect(identity.revokedOperatorKeys ?? {}).toEqual({});
  });
});
