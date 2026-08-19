import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  signCanonical,
  publicKeyB64urlFromSeed,
  keyId,
  endorsementPayload,
  revocationPayload,
  unrevokePayload,
} from "../src/identity";
import {
  loadOrCreateIdentity,
  saveIdentity,
  identityPublicKey,
  type EkhoIdentity,
} from "../src/credentials";
import { registerAndBootstrapIdentity } from "../src/connection";
import {
  syncPinnedOperatorKeys,
  shouldAutowake,
  buildSignedSendFields,
} from "../src/verification";
import { verifyCanonical, fromB64url } from "../src/identity";

const OP1_SEED = new Uint8Array(32).fill(1);
const OP1_PUB = publicKeyB64urlFromSeed(OP1_SEED);
const OP1_KID = keyId(fromB64url(OP1_PUB));
const OP2_SEED = new Uint8Array(32).fill(2);
const OP2_PUB = publicKeyB64urlFromSeed(OP2_SEED);
const OP2_KID = keyId(fromB64url(OP2_PUB));
const FLEET = "flt_v";
const REVOKED_AT = "2026-08-16T00:00:00.000Z";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ekho-oc-"));
}

/** A signed revocation of `kid`, issued by `seed`. */
function revSig(seed: Uint8Array, kid: string, at = REVOKED_AT, fleet = FLEET) {
  return signCanonical(revocationPayload(fleet, kid, at), seed);
}
const UNREV = {
  unrevoke_revoked_at: REVOKED_AT,
  unrevoke_issued_at: "2026-08-16T00:00:01Z",
  unrevoke_nonce: "n1",
};
/** A signed un-revoke of `kid`, issued by `seed`. */
function unrevSig(seed: Uint8Array, kid: string, fleet = FLEET) {
  return signCanonical(
    unrevokePayload(fleet, kid, UNREV.unrevoke_revoked_at, UNREV.unrevoke_issued_at, UNREV.unrevoke_nonce),
    seed
  );
}
/** A signed un-revoke of `kid` BOUND to a specific tombstone timestamp (#52). */
function unrevBoundTo(seed: Uint8Array, kid: string, boundRevokedAt: string, fleet = FLEET) {
  const bind = {
    unrevoke_revoked_at: boundRevokedAt,
    unrevoke_issued_at: "2026-08-16T00:00:01Z",
    unrevoke_nonce: "n1"
  };
  return {
    ...bind,
    unrevoke_sig: signCanonical(
      unrevokePayload(fleet, kid, bind.unrevoke_revoked_at, bind.unrevoke_issued_at, bind.unrevoke_nonce),
      seed
    )
  };
}
/** Capture the structured notes the sync emits (it must never be silent). */
function capture() {
  const notes: string[] = [];
  return { notes, log: { warn: (...a: unknown[]) => notes.push(a.join(" ")), info: () => {} } };
}
const QUIET = { warn: () => {}, info: () => {} };

describe("identity store", () => {
  it("creates and persists a stable identity", () => {
    const dir = tmpdir();
    const a = loadOrCreateIdentity(dir);
    expect(Buffer.from(a.seedHex, "hex").length).toBe(32);
    const b = loadOrCreateIdentity(dir);
    expect(b.seedHex).toBe(a.seedHex);
    expect(identityPublicKey(a)).toBe(identityPublicKey(b));
  });
});

describe("syncPinnedOperatorKeys", () => {
  // #5: a never-pinned identity TOFUs the relay's key set exactly once —
  // "never adopt" left verification dormant on every unconfigured agent.
  it("TOFU-adopts the first key set for a never-pinned identity, and latches", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB }], FLEET)).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
    expect(id.tofuAt).toBeTruthy();

    // Once latched, an emptied pin set can never be re-seeded by the relay.
    id.pinnedOperatorKeys = {};
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP2_KID, public_key: OP2_PUB }], FLEET)).toBe(false);
    expect(id.pinnedOperatorKeys).toEqual({});
  });
  it("TOFU skips revoked keys and doesn't burn the latch on an empty roster", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(syncPinnedOperatorKeys(id, [], FLEET, QUIET)).toBe(false);
    expect(id.tofuAt).toBeUndefined(); // nothing adopted — next contact may still TOFU
    // #27: an unsigned revoked flag is advisory — nothing is written, so this is
    // a no-op poll. It still blocks adoption, so the latch stays unburned.
    expect(
      syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true }], FLEET, QUIET)
    ).toBe(false);
    expect(id.tofuAt).toBeUndefined();
    expect(id.pinnedOperatorKeys).toEqual({});
    expect(id.revokedOperatorKeys ?? {}).toEqual({});
  });
  it("a pre-pinned identity never TOFUs — unendorsed keys are still refused", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP2_KID, public_key: OP2_PUB }], FLEET)).toBe(false);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined();
  });
  it("adds an endorsement-chained key", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    const changed = syncPinnedOperatorKeys(
      id,
      [{ key_id: OP2_KID, public_key: OP2_PUB, endorsed_by_key_id: OP1_KID, endorsement_sig: esig }],
      FLEET
    );
    expect(changed).toBe(true);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB);
  });
  it("a tombstoned key is never re-adopted by TOFU", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: {},
      revokedOperatorKeys: { [OP1_KID]: "2026-08-10T00:00:00.000Z" }
    };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB }], FLEET)).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
    expect(id.tofuAt).toBeUndefined();
  });
  it("a tombstoned key is never re-adopted by endorsement chaining", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB },
      revokedOperatorKeys: { [OP2_KID]: "2026-08-10T00:00:00.000Z" }
    };
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, endorsed_by_key_id: OP1_KID, endorsement_sig: esig }],
        FLEET
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined();
  });
});

// #27: the relay is the transport, not the trust root. Before this, a relay that
// said revoked:true got a permanent tombstone AND the pin deleted, with no proof
// asked for — one poll from a compromised relay wiped a fleet's trust root.
describe("syncPinnedOperatorKeys — unsigned revoked is ADVISORY (#27)", () => {
  const unsigned = { key_id: OP1_KID, public_key: OP1_PUB, revoked: true };

  it("does NOT unpin a pinned key", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    expect(syncPinnedOperatorKeys(id, [unsigned], FLEET, QUIET)).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
  });

  it("does NOT write a tombstone", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP2_KID]: OP2_PUB } };
    expect(syncPinnedOperatorKeys(id, [unsigned], FLEET, QUIET)).toBe(false);
    expect(id.revokedOperatorKeys ?? {}).toEqual({});
    // and it is still a no-op on the next poll — nothing accumulates
    expect(syncPinnedOperatorKeys(id, [unsigned], FLEET, QUIET)).toBe(false);
  });

  it("still blocks NEW adoption by TOFU", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(
      syncPinnedOperatorKeys(id, [unsigned, { key_id: OP2_KID, public_key: OP2_PUB }], FLEET, QUIET)
    ).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined(); // flagged → not freshly pinned
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB);
  });

  it("still blocks NEW adoption by endorsement chaining", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, revoked: true, endorsed_by_key_id: OP1_KID, endorsement_sig: esig }],
        FLEET,
        QUIET
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined();
  });

  it("blocks adoption even when the relay ALSO serves the same key id unflagged", () => {
    // Split the claim across two entries and a naive per-entry check adopts it.
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(
      syncPinnedOperatorKeys(id, [unsigned, { key_id: OP1_KID, public_key: OP1_PUB }], FLEET, QUIET)
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
  });

  it("is never silent — it names the key and says the claim was unsigned", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const { notes, log } = capture();
    syncPinnedOperatorKeys(id, [unsigned], FLEET, log);
    expect(notes.join("\n")).toContain(OP1_KID);
    expect(notes.join("\n").toLowerCase()).toContain("without a valid revocation signature");
  });

  it("treats a revocation signature that does not verify as unsigned", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const { notes, log } = capture();
    // Signed by a key nobody pinned — the classic rogue-relay forgery.
    const rogue = new Uint8Array(32).fill(9);
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ ...unsigned, revoked_at: REVOKED_AT, revocation_sig: revSig(rogue, OP1_KID) }],
        FLEET,
        log
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
    expect(id.revokedOperatorKeys ?? {}).toEqual({});
    expect(notes.join("\n")).toContain(OP1_KID);
  });

  it("treats a revocation signature for a DIFFERENT fleet or time as unsigned", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB }
    };
    // Right key, wrong fleet.
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ ...unsigned, revoked_at: REVOKED_AT, revocation_sig: revSig(OP2_SEED, OP1_KID, REVOKED_AT, "flt_other") }],
        FLEET,
        QUIET
      )
    ).toBe(false);
    // Right key and fleet, but the relay restated WHEN it happened.
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ ...unsigned, revoked_at: "2020-01-01T00:00:00Z", revocation_sig: revSig(OP2_SEED, OP1_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
  });
});

// #27: signed revocation is the ONLY thing that mutates the trust root.
describe("syncPinnedOperatorKeys — signed revocation (#27)", () => {
  it("tombstones and unpins a key revoked by a pinned key", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB }
    };
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP2_SEED, OP1_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB);
    expect(id.revokedOperatorKeys?.[OP1_KID]).toBe(REVOKED_AT); // the SIGNED time
  });

  it("accepts a key that revokes itself", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB }
    };
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP1_SEED, OP1_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
  });

  it("tombstones a key that was never pinned here, so it can never be adopted", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP1_SEED, OP2_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(true);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(REVOKED_AT);
    // Idempotent: the same signed claim again is not a change.
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP1_SEED, OP2_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(false);
  });

  it("REFUSES a revocation that would leave zero pinned keys, and says so", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const { notes, log } = capture();
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP1_SEED, OP1_KID) }],
        FLEET,
        log
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB); // still the trust root
    expect(id.revokedOperatorKeys ?? {}).toEqual({}); // and NOT tombstoned, or it would be pinned-but-dead
    expect(notes.join("\n")).toContain(OP1_KID);
  });

  it("revoking both pinned keys in one poll still leaves one — the last root holds", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB }
    };
    syncPinnedOperatorKeys(
      id,
      [
        { key_id: OP1_KID, public_key: OP1_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP2_SEED, OP1_KID) },
        { key_id: OP2_KID, public_key: OP2_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: revSig(OP1_SEED, OP2_KID) }
      ],
      FLEET,
      QUIET
    );
    expect(Object.keys(id.pinnedOperatorKeys).length).toBe(1);
  });

  it("a signed revocation cannot be replayed against another fleet's key id", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB }
    };
    // A genuine revocation of OP2, re-labelled by the relay as revoking OP1.
    const sigForOp2 = revSig(OP1_SEED, OP2_KID);
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true, revoked_at: REVOKED_AT, revocation_sig: sigForOp2 }],
        FLEET,
        QUIET
      )
    ).toBe(false);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
  });
});

// #27: the escape hatch for a revocation issued in error.
describe("syncPinnedOperatorKeys — signed un-revoke (#27)", () => {
  const tombstoned = (): EkhoIdentity => ({
    seedHex: "00".repeat(32),
    pinnedOperatorKeys: { [OP1_KID]: OP1_PUB },
    revokedOperatorKeys: { [OP2_KID]: REVOKED_AT }
  });

  it("clears the tombstone but does NOT re-pin", () => {
    const id = tombstoned();
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, unrevoke_sig: unrevSig(OP1_SEED, OP2_KID), ...UNREV }],
        FLEET,
        QUIET
      )
    ).toBe(true);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBeUndefined();
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined(); // re-admission still costs an endorsement
  });

  it("lets the endorsement chain re-admit the key afterwards", () => {
    const id = tombstoned();
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    syncPinnedOperatorKeys(
      id,
      [
        {
          key_id: OP2_KID,
          public_key: OP2_PUB,
          unrevoke_sig: unrevSig(OP1_SEED, OP2_KID),
          ...UNREV,
          endorsed_by_key_id: OP1_KID,
          endorsement_sig: esig
        }
      ],
      FLEET,
      QUIET
    );
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB);
  });

  it("an un-revoke with a signature but no bind fields is refused", () => {
    const id = tombstoned();
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, unrevoke_sig: unrevSig(OP1_SEED, OP2_KID) }],
        FLEET,
        QUIET
      )
    ).toBe(false);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(REVOKED_AT);
  });

  // #52: the payload binds the tombstone it undoes, but apply-time never
  // compared that bound value to the LIVE one — so a captured un-revoke for an
  // old revocation cleared whatever newer tombstone happened to be standing.
  it("an un-revoke bound to an OLDER tombstone never clears a NEWER one", () => {
    const NEWER_AT = "2026-08-17T00:00:00.000Z";
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB },
      revokedOperatorKeys: { [OP2_KID]: NEWER_AT }
    };
    const { notes, log } = capture();
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, ...unrevBoundTo(OP1_SEED, OP2_KID, REVOKED_AT) }],
        FLEET,
        log
      )
    ).toBe(false);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(NEWER_AT);
    expect(notes.join("\n")).toContain(OP2_KID);
  });

  it("an un-revoke bound to the CURRENT live tombstone clears it", () => {
    const NEWER_AT = "2026-08-17T00:00:00.000Z";
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB },
      revokedOperatorKeys: { [OP2_KID]: NEWER_AT }
    };
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, ...unrevBoundTo(OP1_SEED, OP2_KID, NEWER_AT) }],
        FLEET,
        QUIET
      )
    ).toBe(true);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBeUndefined();
  });

  it("UNSIGNED absence of `revoked` never clears a tombstone (the #14 hole)", () => {
    const id = tombstoned();
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP2_KID, public_key: OP2_PUB }], FLEET, QUIET)).toBe(false);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(REVOKED_AT);
  });

  it("an un-revoke signed by a key we do NOT pin is refused", () => {
    const id = tombstoned();
    const rogue = new Uint8Array(32).fill(9);
    const { notes, log } = capture();
    expect(
      syncPinnedOperatorKeys(
        id,
        [{ key_id: OP2_KID, public_key: OP2_PUB, unrevoke_sig: unrevSig(rogue, OP2_KID), ...UNREV }],
        FLEET,
        log
      )
    ).toBe(false);
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(REVOKED_AT);
    expect(notes.join("\n")).toContain(OP2_KID);
  });

  it("a revocation in the same poll beats an un-revoke — fail closed", () => {
    const id: EkhoIdentity = {
      seedHex: "00".repeat(32),
      pinnedOperatorKeys: { [OP1_KID]: OP1_PUB, [OP2_KID]: OP2_PUB },
      revokedOperatorKeys: {}
    };
    syncPinnedOperatorKeys(
      id,
      [
        {
          key_id: OP2_KID,
          public_key: OP2_PUB,
          revoked: true,
          revoked_at: REVOKED_AT,
          revocation_sig: revSig(OP1_SEED, OP2_KID),
          unrevoke_sig: unrevSig(OP1_SEED, OP2_KID),
          ...UNREV
        }
      ],
      FLEET,
      QUIET
    );
    expect(id.revokedOperatorKeys?.[OP2_KID]).toBe(REVOKED_AT);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined();
  });
});

// #26: persist the endorsement the gate already verified, so a box can answer
// "why is this key trusted here?" offline, with no relay round trip.
describe("operatorKeyAdmissions (#26)", () => {
  it("records the endorser and the signature on chain admission", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    syncPinnedOperatorKeys(
      id,
      [{ key_id: OP2_KID, public_key: OP2_PUB, endorsed_by_key_id: OP1_KID, endorsement_sig: esig }],
      FLEET,
      QUIET
    );
    const rec = id.operatorKeyAdmissions?.[OP2_KID];
    expect(rec?.admitted_by).toBe("chain");
    expect(rec?.endorsed_by_key_id).toBe(OP1_KID);
    expect(rec?.endorsement_sig).toBe(esig);
    expect(Date.parse(String(rec?.admitted_at))).not.toBeNaN();
    // The stored evidence is enough to re-verify offline, relay or no relay.
    expect(
      verifyCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), rec!.endorsement_sig!, fromB64url(OP1_PUB))
    ).toBe(true);
  });

  it("records tofu with no endorser on TOFU admission", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB }], FLEET, QUIET);
    const rec = id.operatorKeyAdmissions?.[OP1_KID];
    expect(rec?.admitted_by).toBe("tofu");
    expect(rec?.endorsed_by_key_id).toBeUndefined();
    expect(rec?.endorsement_sig).toBeUndefined();
  });

  it("survives a save/load round trip, and unknown fields are not dropped", () => {
    const dir = tmpdir();
    const id = loadOrCreateIdentity(dir);
    id.operatorKeyAdmissions = {
      [OP1_KID]: { admitted_by: "tofu", admitted_at: "2026-08-16T00:00:00.000Z" }
    };
    (id as Record<string, unknown>).somethingNewerWrote = { keep: "me" };
    saveIdentity(dir, id);
    const back = loadOrCreateIdentity(dir);
    expect(back.operatorKeyAdmissions?.[OP1_KID].admitted_by).toBe("tofu");
    expect((back as Record<string, unknown>).somethingNewerWrote).toEqual({ keep: "me" });
    // and a rewrite must not silently drop it either
    saveIdentity(dir, back);
    expect(
      (JSON.parse(fs.readFileSync(path.join(dir, ".ekho-identity.json"), "utf-8")) as Record<string, unknown>)
        .somethingNewerWrote
    ).toEqual({ keep: "me" });
  });
});

// #14: the seed is a bootstrap hint, not an override. A key the relay has told
// us is revoked must not come back from config on the next agent wake.
describe("registerAndBootstrapIdentity (config seed)", () => {
  const client = { registerIdentityKey: async () => {} } as any;

  it("pins a seeded key that has never been revoked", async () => {
    const dir = tmpdir();
    const id = await registerAndBootstrapIdentity(client, { operatorPubkey: OP1_PUB, configDir: dir });
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
  });

  it("refuses to re-pin a key recorded as revoked, and warns naming the key id", async () => {
    const dir = tmpdir();
    const seeded = loadOrCreateIdentity(dir);
    seeded.revokedOperatorKeys = { [OP1_KID]: "2026-08-10T00:00:00.000Z" };
    saveIdentity(dir, seeded);

    const warnings: string[] = [];
    const id = await registerAndBootstrapIdentity(client, {
      operatorPubkey: `${OP1_PUB},${OP2_PUB}`,
      configDir: dir,
      log: { warn: (...a: unknown[]) => warnings.push(a.join(" ")) }
    });

    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB); // the live one still seeds
    expect(warnings.join("\n")).toContain(OP1_KID);
    // and it must survive the reload — otherwise the next wake re-pins it
    expect(loadOrCreateIdentity(dir).pinnedOperatorKeys[OP1_KID]).toBeUndefined();
  });

  it("persists the revocation ledger across a reload", () => {
    const dir = tmpdir();
    const id = loadOrCreateIdentity(dir);
    id.revokedOperatorKeys = { [OP1_KID]: "2026-08-10T00:00:00.000Z" };
    saveIdentity(dir, id);
    expect(loadOrCreateIdentity(dir).revokedOperatorKeys?.[OP1_KID]).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("shouldAutowake (graceful gate)", () => {
  const op = (verified?: boolean, signed = true) => ({
    sender_kind: "operator",
    operator_sig: signed ? "S" : null,
    agent_sig: null,
  });
  it("verified operator acts even with relay flag false", () => {
    expect(shouldAutowake(op(true) as any, { verified: true } as any, false, false)).toBe(true);
  });
  it("signed-invalid operator blocked even with relay flag true", () => {
    expect(shouldAutowake(op(false) as any, { verified: false } as any, true, false)).toBe(false);
  });
  it("unsigned operator falls back to relay trust", () => {
    expect(shouldAutowake(op(undefined, false) as any, null, true, false)).toBe(true);
    expect(shouldAutowake(op(undefined, false) as any, null, false, false)).toBe(false);
  });

  // #5: "require" closes the fail-open peer paths.
  const peer = (signed: boolean) => ({ sender_kind: "agent", agent_sig: signed ? "S" : null, operator_sig: null });
  it("require mode: unsigned peer does NOT wake (was the fail-open default)", () => {
    expect(shouldAutowake(peer(false) as any, null, false, true)).toBe(true); // warn: legacy fail-open
    expect(shouldAutowake(peer(false) as any, null, false, true, "require")).toBe(false);
  });
  it("require mode: signed-but-unverifiable (no pinned keys) does NOT wake", () => {
    expect(shouldAutowake(peer(true) as any, null, false, true)).toBe(true); // warn: dormant crypto waves it through
    expect(shouldAutowake(peer(true) as any, null, false, true, "require")).toBe(false);
  });
  it("require mode: signed and verified peer wakes", () => {
    expect(shouldAutowake(peer(true) as any, { verified: true } as any, false, true, "require")).toBe(true);
  });
  it("require mode: operator relay-trust fallback is preserved", () => {
    expect(shouldAutowake(op(undefined, false) as any, null, true, false, "require")).toBe(true);
  });
});

describe("buildSignedSendFields", () => {
  it("round-trips: a recipient can verify it", () => {
    const id: EkhoIdentity = { seedHex: "0a".repeat(32), pinnedOperatorKeys: {} };
    const fields = buildSignedSendFields({
      identity: id, fleetId: "flt", selfAgentId: "me",
      recipient: { kind: "agent", id: "peer" }, conversationId: "c",
      bodyText: "hello", nonce: "n1", sentAt: "2026-06-07T00:00:00Z",
      messageType: "direct", priority: "normal",
    });
    expect(verifyCanonical(fields.sig_canonical, fields.agent_sig, fromB64url(identityPublicKey(id)))).toBe(true);
    expect(fields.sig_canonical.sender_agent_id).toBe("me");
  });
  it("v2 envelope (#9) binds type, priority and sorted attachment ids", () => {
    const id: EkhoIdentity = { seedHex: "0a".repeat(32), pinnedOperatorKeys: {} };
    const fields = buildSignedSendFields({
      identity: id, fleetId: "flt", selfAgentId: "me",
      recipient: { kind: "agent", id: "peer" }, conversationId: "c",
      bodyText: "hello", nonce: "n2", sentAt: "2026-06-07T00:00:00Z",
      messageType: "direct", priority: "high", attachments: ["att_b", "att_a"],
    });
    expect(fields.sig_canonical.v).toBe(2);
    expect(fields.sig_canonical.message_type).toBe("direct");
    expect(fields.sig_canonical.priority).toBe("high");
    expect(fields.sig_canonical.attachments).toEqual(["att_a", "att_b"]);
  });
});
