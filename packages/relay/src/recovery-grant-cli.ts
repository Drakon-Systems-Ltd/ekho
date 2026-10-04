/**
 * Host-only admin for one-off operator-key recovery grants (#93).
 *
 * Entry point: src/recovery-grant.ts (`npm run recovery-grant -- <command>`),
 * run ON THE RELAY HOST, against the relay's own database (same working
 * directory / .env / EKHO_DB_PATH as the relay service). There is no HTTP route
 * that arms a grant: holding an operator session is not enough, by design.
 *
 * Arm a grant only after the operator has confirmed to you DIRECTLY, out of
 * band, the exact recovering key and the exact successor key id he generated in
 * his new browser. Before arming, check that the agents really pin the
 * recovering key (their identity files list it as a trusted operator key): the
 * relay does not, and cannot, prove that for you.
 *
 * This module has no side effects on import; the entry file calls run().
 */
import type { EkhoDb } from "./db";
import { RECOVERY_GRANT_DEFAULT_TTL_MINUTES, RECOVERY_GRANT_MAX_TTL_MINUTES } from "./db";

const USAGE = `Usage (on the relay host, from packages/relay):
  npm run recovery-grant -- status --fleet <fleet id or name>
  npm run recovery-grant -- arm --fleet <fleet id or name> --endorser <key id> --successor <key id> \\
      --confirmed-by "<who confirmed, how, when>" [--ttl-minutes ${RECOVERY_GRANT_DEFAULT_TTL_MINUTES}]
  npm run recovery-grant -- cancel --fleet <fleet id or name> --grant <grant id>

A grant lets <endorser> endorse <successor> (an operator key, never an agent key)
exactly once, within --ttl-minutes (default ${RECOVERY_GRANT_DEFAULT_TTL_MINUTES}, max ${RECOVERY_GRANT_MAX_TTL_MINUTES}).`;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    i++;
  }
  return flags;
}

function resolveFleetId(db: EkhoDb, ref: string | undefined): string {
  if (!ref) throw new Error("--fleet is required");
  const row = db
    .raw()
    .prepare("SELECT id FROM fleets WHERE id = ? OR name = ?")
    .all(ref, ref) as { id: string }[];
  if (row.length === 0) throw new Error(`no fleet with id or name "${ref}"`);
  if (row.length > 1) throw new Error(`"${ref}" matches more than one fleet; pass the fleet id`);
  return row[0].id;
}

function printStatus(db: EkhoDb, fleetId: string, out: (s: string) => void) {
  const agentKeys = db.getAgentIdentityKeys(fleetId);
  const deps = (kid: string) => agentKeys.filter((a) => a.endorsed_by_key_id === kid).length;
  out(`fleet ${fleetId}`);
  out("operator keys (key id | label | endorsed by | agents endorsed by it | state):");
  for (const k of db.listOperatorKeys(fleetId)) {
    out(
      `  ${k.key_id} | ${k.label} | ${k.endorsed_by_key_id ?? "-"} | ${deps(k.key_id)} | ${k.revoked_at ? `revoked ${k.revoked_at}` : "live"}`
    );
  }
  const unendorsedAgents = agentKeys.filter((a) => !a.endorsed_by_key_id).length;
  if (unendorsedAgents) out(`  (${unendorsedAgents} live agent key(s) not endorsed by any operator key)`);
  const grants = db.listOperatorRecoveryGrants(fleetId);
  out(grants.length ? "recovery grants:" : "recovery grants: none");
  for (const g of grants) {
    const state = g.consumed_at
      ? `used ${g.consumed_at}`
      : g.cancelled_at
        ? `cancelled ${g.cancelled_at}`
        : g.expires_at <= new Date().toISOString()
          ? `expired ${g.expires_at}`
          : `ARMED until ${g.expires_at}`;
    out(`  ${g.id} | ${g.endorser_key_id} -> ${g.target_key_id} | ${state} | confirmed by: ${g.confirmed_by}`);
  }
}

/** Returns a process exit code. */
export function run(argv: string[], db: EkhoDb, out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help") {
      out(USAGE);
      return command ? 0 : 2;
    }
    const flags = parseFlags(rest);
    const fleetId = resolveFleetId(db, flags.fleet);
    if (command === "status") {
      printStatus(db, fleetId, out);
      return 0;
    }
    if (command === "arm") {
      if (!flags.endorser) throw new Error("--endorser is required");
      if (!flags.successor) throw new Error("--successor is required");
      if (!flags["confirmed-by"]) throw new Error('--confirmed-by is required (e.g. "Michael, direct TG to Tars, 2026-10-04 11:05Z")');
      let ttlMinutes: number | undefined;
      if (flags["ttl-minutes"] !== undefined) {
        ttlMinutes = Number(flags["ttl-minutes"]);
        if (!/^\d+$/.test(flags["ttl-minutes"])) throw new Error("--ttl-minutes must be a whole number");
      }
      const g = db.createOperatorRecoveryGrant(fleetId, {
        endorserKeyId: flags.endorser,
        targetKeyId: flags.successor,
        confirmedBy: flags["confirmed-by"],
        ttlMinutes
      });
      out(`ARMED one-time recovery grant ${g.id}`);
      out(`  ${g.endorser_key_id} may endorse ONLY operator key ${g.target_key_id}, ONCE, until ${g.expires_at}.`);
      out("  It cannot endorse agent keys. It is consumed by the endorsement. Cancel with:");
      out(`  npm run recovery-grant -- cancel --fleet ${fleetId} --grant ${g.id}`);
      out("Next (operator, in the console): from the browser holding the recovering key, press Endorse on the");
      out("successor in panel 2. Then, from the successor's browser, re-endorse every agent. Revoke the lost");
      out("root LAST, only once no agent is still endorsed by it.");
      return 0;
    }
    if (command === "cancel") {
      if (!flags.grant) throw new Error("--grant is required");
      const ok = db.cancelOperatorRecoveryGrant(fleetId, flags.grant);
      if (!ok) throw new Error(`grant ${flags.grant} not found in this fleet, or already used or cancelled`);
      out(`cancelled recovery grant ${flags.grant}`);
      return 0;
    }
    throw new Error(`unknown command "${command}"`);
  } catch (e) {
    err(`recovery-grant: ${e instanceof Error ? e.message : String(e)}`);
    err(USAGE);
    return 1;
  }
}
