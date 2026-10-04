import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import {
  b64url,
  keyId,
  signCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
} from "../src/operator-identity";
import { applyMigration } from "../src/db";
import { run as runCli } from "../src/recovery-grant-cli";
import { endorseAuthority, rescueGuard } from "../frontend/src/operatorTrust.js";

/**
 * #93 — one-off, operator-armed recovery of the fleet trust root.
 *
 * 4 Oct 2026: the operator lost the passphrase for the browser holding root
 * _sthCgMINcL9GAXO. Every agent key is endorsed by _sthCg; _sthCg was endorsed
 * by X6NvGXWiMP32k0J6, which is unlocked elsewhere but is neither a trust root
 * nor chained to a live key, so the relay refuses it. A standing "the key that
 * endorsed a live root may endorse" rule was rejected in review. What replaces
 * it: a grant armed ON THE RELAY HOST that lets ONE named key endorse ONE named
 * successor operator key, ONCE, inside a short window, consumed in the same
 * transaction. Never agent keys.
 *
 * Every scenario here is built in the live shape: origin (X6Nv) bootstraps the
 * agents, endorses root (_sthCg), the agents are re-rooted onto root, and the
 * operator then generates a fresh, unendorsed successor in a new browser.
 */

let fill = 10;
function makeKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}
type K = ReturnType<typeof makeKey>;

const UNTRUSTED = /no agent trusts it/i;
const MIN = 60_000;

describe("#93 one-off operator recovery grant (relay)", () => {
  let relay: TestRelay;
  let origin: K; // X6Nv: endorsed the root, pinned by agents, refused by the ordinary rule
  let root: K; // _sthCg: the lost root every agent is endorsed by
  let successor: K; // the new browser's key
  let agents: { agentId: string; keyId: string; pubB64: string }[];

  const register = (k: K, label: string) => relay.db.registerOperatorKey(relay.fleetId, k.pubB64, label);
  const endorseOperator = (endorser: K, target: K, now?: Date) =>
    relay.db.endorseOperatorKey(
      relay.fleetId,
      target.id,
      {
        endorsedByKeyId: endorser.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, target.id, target.pubB64), endorser.seed),
      },
      undefined,
      now
    );
  const endorseAgent = (endorser: K, a: { agentId: string; keyId: string; pubB64: string }) =>
    relay.db.endorseAgentKey(relay.fleetId, a.agentId, a.keyId, {
      endorsedByKeyId: endorser.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, a.agentId, a.keyId, a.pubB64), endorser.seed),
    });
  const addAgent = async (name: string) => {
    const agentId = (await relay.enrollAgent(name)).agent_id;
    const k = makeKey();
    const keyIdA = relay.db.setAgentIdentityKey(agentId, relay.fleetId, k.pubB64).keyId;
    return { agentId, keyId: keyIdA, pubB64: k.pubB64 };
  };
  const arm = (opts: Partial<{ endorser: K; target: K; ttlMinutes: number }> = {}, now?: Date) =>
    relay.db.createOperatorRecoveryGrant(
      relay.fleetId,
      {
        endorserKeyId: (opts.endorser ?? origin).id,
        targetKeyId: (opts.target ?? successor).id,
        confirmedBy: "Michael, direct to Tars (test)",
        ttlMinutes: opts.ttlMinutes,
      },
      now
    );
  const opKey = (k: K) => relay.db.listOperatorKeys(relay.fleetId).find((r) => r.key_id === k.id)!;
  const grantRow = (gid: string) => relay.db.listOperatorRecoveryGrants(relay.fleetId).find((g) => g.id === gid)!;

  beforeEach(async () => {
    relay = await createTestRelay();
    origin = makeKey();
    root = makeKey();
    successor = makeKey();
    register(origin, "old browser (X6Nv)");
    register(root, "lost browser (_sthCg)");
    agents = [await addAgent("Jarvis"), await addAgent("Edith")];
    for (const a of agents) endorseAgent(origin, a); // bootstrap onto origin
    endorseOperator(origin, root); // origin vouches for root
    for (const a of agents) endorseAgent(root, a); // fleet re-rooted onto root
    register(successor, "new browser"); // generated after the passphrase was lost
  });
  afterEach(() => relay.cleanup());

  it("without a grant the recovering key is still refused on BOTH paths (the 16 Aug rule stands)", () => {
    expect(() => endorseOperator(origin, successor)).toThrow(UNTRUSTED);
    expect(() => endorseAgent(origin, agents[0])).toThrow(UNTRUSTED);
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
  });

  it("ALLOWS exactly one endorsement of the named successor and consumes the grant in the same write", () => {
    const g = arm();
    endorseOperator(origin, successor);

    expect(opKey(successor).endorsed_by_key_id).toBe(origin.id);
    const used = grantRow(g.id);
    expect(used.consumed_at).not.toBeNull();
    expect(relay.db.getActiveOperatorRecoveryGrant(relay.fleetId)).toBeNull();

    const events = relay.db
      .raw()
      .prepare("SELECT event_type, payload_json FROM events WHERE fleet_id = ? AND event_type LIKE 'operator_key.%'")
      .all(relay.fleetId) as { event_type: string; payload_json: string }[];
    const types = events.map((e) => e.event_type);
    expect(types).toContain("operator_key.recovery_grant_armed");
    expect(types).toContain("operator_key.recovery_grant_consumed");
    const endorsed = events.filter((e) => e.event_type === "operator_key.endorsed").map((e) => JSON.parse(e.payload_json));
    expect(endorsed).toContainEqual({ endorsed_by_key_id: origin.id, recovery_grant_id: g.id });
  });

  it("after recovery the successor re-endorses agents by the EXISTING #13 chain rule; the recovering key gains nothing", () => {
    arm();
    endorseOperator(origin, successor);
    for (const a of agents) expect(endorseAgent(successor, a)).toBe(true);
    // The grant conferred no standing authority on the recovering key.
    expect(() => endorseAgent(origin, agents[0])).toThrow(UNTRUSTED);
    // And the lost root is untouched: revocation is the operator's later, separate step.
    expect(opKey(root).revoked_at).toBeNull();
  });

  it("REFUSES a second use — another successor, or the same one again", () => {
    const g = arm();
    endorseOperator(origin, successor);
    const another = makeKey();
    register(another, "a second browser");
    expect(() => endorseOperator(origin, another)).toThrow(/already used.*single-use/i);
    expect(() => endorseOperator(origin, successor)).toThrow(/already used/i);
    expect(opKey(another).endorsed_by_key_id).toBeNull();
    expect(grantRow(g.id).consumed_at).not.toBeNull();
  });

  it("REFUSES an expired grant and leaves the successor unendorsed", () => {
    arm({ ttlMinutes: 30 }, new Date(Date.now() - 31 * MIN));
    expect(() => endorseOperator(origin, successor)).toThrow(/expired at .*arm a new one/i);
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
  });

  it("REFUSES a grant that expires between arming and use (relay clock decides)", () => {
    const armedAt = new Date();
    arm({ ttlMinutes: 30 }, armedAt);
    expect(() => endorseOperator(origin, successor, new Date(armedAt.getTime() + 30 * MIN))).toThrow(/expired at /i);
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
  });

  it("REFUSES the wrong target and does not spend the grant", () => {
    const g = arm();
    const other = makeKey();
    register(other, "not the named successor");
    expect(() => endorseOperator(origin, other)).toThrow(new RegExp(`names successor ${successor.id} only`));
    expect(opKey(other).endorsed_by_key_id).toBeNull();
    expect(grantRow(g.id).consumed_at).toBeNull();
  });

  it("REFUSES the wrong endorser, even for the named target, and does not spend the grant", () => {
    const g = arm();
    const stranger = makeKey();
    register(stranger, "some other live key");
    expect(() => endorseOperator(stranger, successor)).toThrow(UNTRUSTED);
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
    expect(grantRow(g.id).consumed_at).toBeNull();
  });

  it("can NEVER be used for endorseAgentKey, and an agent attempt does not spend it", () => {
    const g = arm();
    for (const a of agents) expect(() => endorseAgent(origin, a)).toThrow(UNTRUSTED);
    const rows = relay.db.getAgentIdentityKeys(relay.fleetId);
    for (const r of rows) expect(r.endorsed_by_key_id).toBe(root.id);
    expect(grantRow(g.id).consumed_at).toBeNull();
  });

  it("a bad signature does not spend the grant", () => {
    const g = arm();
    expect(() =>
      relay.db.endorseOperatorKey(relay.fleetId, successor.id, {
        endorsedByKeyId: origin.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, successor.id, successor.pubB64), successor.seed),
      })
    ).toThrow(/invalid key endorsement signature/);
    expect(grantRow(g.id).consumed_at).toBeNull();
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
  });

  it("is atomic: if the endorsement write fails, the grant is NOT consumed (and vice versa)", () => {
    const g = arm();
    const spy = vi.spyOn(relay.db, "recordEvent").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => endorseOperator(origin, successor)).toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }
    expect(grantRow(g.id).consumed_at).toBeNull();
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
    // and it still works once, afterwards
    endorseOperator(origin, successor);
    expect(grantRow(g.id).consumed_at).not.toBeNull();
  });

  it("fails closed if the grant is spent between the check and the write (another process cancels/uses it)", () => {
    const g = arm();
    const dbAny = relay.db as unknown as { requireRecoveryGrant: (...a: unknown[]) => unknown };
    const original = dbAny.requireRecoveryGrant.bind(relay.db);
    const spy = vi.spyOn(dbAny, "requireRecoveryGrant").mockImplementation((...a: unknown[]) => {
      const found = original(...a);
      // e.g. Tars cancels from the host CLI while the console request is in flight
      relay.db.raw().prepare("UPDATE operator_recovery_grants SET cancelled_at = ? WHERE id = ?").run(new Date().toISOString(), g.id);
      return found;
    });
    try {
      expect(() => endorseOperator(origin, successor)).toThrow(/no longer usable/);
    } finally {
      spy.mockRestore();
    }
    expect(opKey(successor).endorsed_by_key_id).toBeNull();
    expect(grantRow(g.id).consumed_at).toBeNull();
  });

  it("a cancelled grant is refused", () => {
    const g = arm();
    expect(relay.db.cancelOperatorRecoveryGrant(relay.fleetId, g.id)).toBe(true);
    expect(() => endorseOperator(origin, successor)).toThrow(/was cancelled at /);
  });

  it("an already-endorsed successor cannot be re-parented by the grant", () => {
    const g = arm();
    // Someone with real authority endorses the successor first (in a test we
    // can do it directly; on the live relay nothing holding root can).
    endorseOperator(root, successor);
    expect(() => endorseOperator(origin, successor)).toThrow(/already endorsed/i);
    expect(opKey(successor).endorsed_by_key_id).toBe(root.id);
    expect(grantRow(g.id).consumed_at).toBeNull();
  });

  describe("arming is narrow and fails closed", () => {
    it("names an already-registered, live, UNENDORSED successor only", () => {
      expect(() => arm({ target: root })).toThrow(/already endorsed/i);
      const ghost = makeKey();
      expect(() => arm({ target: ghost })).toThrow(/not registered/i);
      expect(() => arm({ target: origin })).toThrow(/itself/i);
    });

    it("refuses a revoked recovering key", () => {
      relay.db.revokeOperatorKey(relay.fleetId, origin.id);
      expect(() => arm()).toThrow(/revoked/i);
    });

    it("needs a confirmation record and a short TTL (default 30, max 120)", () => {
      expect(() =>
        relay.db.createOperatorRecoveryGrant(relay.fleetId, {
          endorserKeyId: origin.id,
          targetKeyId: successor.id,
          confirmedBy: "  ",
        })
      ).toThrow(/confirmed-by/);
      expect(() => arm({ ttlMinutes: 121 })).toThrow(/between 1 and 120/);
      expect(() => arm({ ttlMinutes: 0 })).toThrow(/between 1 and 120/);
      const now = new Date();
      const g = arm({}, now);
      expect(Date.parse(g.expires_at) - now.getTime()).toBe(30 * MIN);
    });

    it("allows one armed grant per fleet at a time", () => {
      arm();
      const other = makeKey();
      register(other, "other");
      expect(() => arm({ target: other })).toThrow(/already armed/i);
    });

    it("has no HTTP route that arms or cancels a grant — host only", () => {
      const routesDir = fileURLToPath(new URL("../src", import.meta.url));
      for (const f of fs.readdirSync(routesDir, { recursive: true }) as string[]) {
        if (!f.endsWith(".ts") || f.startsWith("recovery-grant")) continue;
        const src = fs.readFileSync(path.join(routesDir, f), "utf-8");
        if (f === "db.ts") continue;
        expect(src, f).not.toMatch(/createOperatorRecoveryGrant|cancelOperatorRecoveryGrant/);
      }
    });
  });

  describe("Case's negative cases: the standing path must not reappear", () => {
    it("a LATER agent pinned only to root: no grant, no authority for the recovering key", async () => {
      // Enrolled after the re-rooting, endorsed by root directly: it has never
      // pinned origin, so a rule inferring 'agents pin origin' from the
      // origin->root edge would be wrong about it.
      const late = await addAgent("Zeus");
      endorseAgent(root, late);
      expect(() => endorseOperator(origin, successor)).toThrow(UNTRUSTED);
      expect(() => endorseAgent(origin, late)).toThrow(UNTRUSTED);
      // Console mirrors the relay: refused with no grant.
      const keys = relay.db.listOperatorKeys(relay.fleetId);
      const agentKeys = relay.db.getAgentIdentityKeys(relay.fleetId);
      expect(endorseAuthority(origin.id, keys, agentKeys).allowed).toBe(false);
      expect(rescueGuard(successor.id, keys, origin.id, agentKeys).allowed).toBe(false);
    });

    it("partial divergence (agents split across two roots): still refused without a grant", () => {
      const q = makeKey();
      register(q, "a second root");
      endorseOperator(root, q);
      endorseAgent(q, agents[1]); // half the fleet now on q, half on root
      expect(() => endorseOperator(origin, successor)).toThrow(UNTRUSTED);
      for (const a of agents) expect(() => endorseAgent(origin, a)).toThrow(UNTRUSTED);
      const keys = relay.db.listOperatorKeys(relay.fleetId);
      const agentKeys = relay.db.getAgentIdentityKeys(relay.fleetId);
      expect(endorseAuthority(origin.id, keys, agentKeys).allowed).toBe(false);
    });

    it("with a grant armed, a later agent and a divergent fleet still cannot be endorsed by the recovering key", async () => {
      const late = await addAgent("Zeus");
      endorseAgent(root, late);
      const q = makeKey();
      register(q, "a second root");
      endorseOperator(root, q);
      endorseAgent(q, agents[1]);
      const g = arm();
      expect(() => endorseAgent(origin, late)).toThrow(UNTRUSTED);
      expect(() => endorseAgent(origin, agents[1])).toThrow(UNTRUSTED);
      expect(grantRow(g.id).consumed_at).toBeNull();
    });
  });

  describe("HTTP surface", () => {
    it("GET /v1/operator/keys reports the armed grant; POST endorse consumes it; GET then reports none", async () => {
      const g = arm();
      const before = await relay.operatorRequest("GET", "/v1/operator/keys");
      expect(before.body.recovery_grant).toEqual({
        grant_id: g.id,
        endorser_key_id: origin.id,
        target_key_id: successor.id,
        expires_at: g.expires_at,
      });
      expect(JSON.stringify(before.body.recovery_grant)).not.toMatch(/confirmed/);

      const sig = signCanonical(endorsementPayload(relay.fleetId, successor.id, successor.pubB64), origin.seed);
      const ok = await relay.operatorRequest("POST", `/v1/operator/keys/${successor.id}/endorse`, {
        endorsed_by_key_id: origin.id,
        signature: sig,
      });
      expect(ok.status).toBe(200);

      const again = await relay.operatorRequest("POST", `/v1/operator/keys/${successor.id}/endorse`, {
        endorsed_by_key_id: origin.id,
        signature: sig,
      });
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/already used/i);

      const after = await relay.operatorRequest("GET", "/v1/operator/keys");
      expect(after.body.recovery_grant).toBeNull();
    });
  });

  describe("host CLI (npm run recovery-grant)", () => {
    const capture = () => {
      const lines: string[] = [];
      return { lines, out: (s: string) => lines.push(s) };
    };

    it("arms, reports status, and the armed grant works exactly once", () => {
      const o = capture();
      const e = capture();
      const code = runCli(
        ["arm", "--fleet", relay.fleetId, "--endorser", origin.id, "--successor", successor.id, "--confirmed-by", "Michael to Tars, TG"],
        relay.db,
        o.out,
        e.out
      );
      expect(e.lines).toEqual([]);
      expect(code).toBe(0);
      expect(o.lines.join("\n")).toMatch(/ARMED one-time recovery grant/);
      const s = capture();
      expect(runCli(["status", "--fleet", relay.fleetName], relay.db, s.out, s.out)).toBe(0);
      expect(s.lines.join("\n")).toMatch(new RegExp(`${origin.id} -> ${successor.id} \\| ARMED`));
      endorseOperator(origin, successor);
      expect(() => endorseOperator(origin, successor)).toThrow(/already used/);
    });

    it("refuses to arm without --confirmed-by, and cancels", () => {
      const o = capture();
      expect(
        runCli(["arm", "--fleet", relay.fleetId, "--endorser", origin.id, "--successor", successor.id], relay.db, o.out, o.out)
      ).toBe(1);
      expect(relay.db.getActiveOperatorRecoveryGrant(relay.fleetId)).toBeNull();
      const g = arm();
      expect(runCli(["cancel", "--fleet", relay.fleetId, "--grant", g.id], relay.db, o.out, o.out)).toBe(0);
      expect(() => endorseOperator(origin, successor)).toThrow(/was cancelled at /);
    });
  });
});

describe("#93 migration 023", () => {
  it("adds operator_recovery_grants to an existing database exactly once", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE fleets (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const sql = fs.readFileSync(
      fileURLToPath(new URL("../migrations/023_operator_recovery_grants.sql", import.meta.url)),
      "utf-8"
    );
    applyMigration(db, 23, sql, new Date().toISOString());
    const cols = (db.prepare("PRAGMA table_info(operator_recovery_grants)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["id", "fleet_id", "endorser_key_id", "target_key_id", "confirmed_by", "expires_at", "consumed_at", "cancelled_at"])
    );
    // Idempotent against a fresh DB that already has it from schema.ts.
    expect(() => applyMigration(db, 24, sql, new Date().toISOString())).not.toThrow();
  });
});
