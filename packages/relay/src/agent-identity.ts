import { z } from "zod";
import { LATEST_ADAPTER_VERSIONS } from "./version";

/**
 * Self-reported adapter identity carried on heartbeats (#97).
 *
 * Every field is optional and lenient: a value that is not a short string in
 * the allowed character set is dropped (stored as null), never a reason to
 * refuse the heartbeat. Liveness must not depend on a version string. The
 * character sets admit no whitespace, slashes, colons or '@', so a host path,
 * URL, e-mail address or "KEY=value" pair cannot be stored through them.
 *
 * These are claims, not attestation: the console shows them as what the agent
 * says it runs.
 */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const INSTANCE = /^[A-Za-z0-9_-]{8,64}$/;

const lenient = (pattern: RegExp) => z.string().regex(pattern).optional().catch(undefined);

export const heartbeatIdentityFields = {
  adapter: lenient(SLUG),
  adapter_version: lenient(VERSION),
  sdk_version: lenient(VERSION),
  host_runtime: lenient(SLUG),
  host_runtime_version: lenient(VERSION),
  instance_id: lenient(INSTANCE)
};

export const IDENTITY_KEYS = [
  "adapter",
  "adapter_version",
  "sdk_version",
  "host_runtime",
  "host_runtime_version",
  "instance_id"
] as const;

export type IdentityKey = (typeof IDENTITY_KEYS)[number];
export type ReportedIdentity = Record<IdentityKey, string | null>;

/** Pick the identity fields out of a parsed heartbeat; absent → null. */
export function reportedIdentity(input: Partial<Record<IdentityKey, string | undefined>>): ReportedIdentity {
  const out = {} as ReportedIdentity;
  for (const key of IDENTITY_KEYS) out[key] = input[key] ?? null;
  return out;
}

export function hasAnyIdentity(identity: ReportedIdentity): boolean {
  return IDENTITY_KEYS.some((key) => identity[key] !== null);
}

type Semver = { major: number; minor: number; patch: number; pre: Array<string | number> };

// Numeric parts are capped at 9 digits so they stay exact as JS numbers.
const NUM = "(?:0|[1-9]\\d{0,8})";
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

/** Strict semver 2.0.0 (an optional leading "v" allowed). Anything else → null. */
export function parseSemver(raw: unknown): Semver | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const m = raw.trim().match(SEMVER);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/**
 * Semver precedence: -1, 0 or 1, or null when either side is not semver.
 * Build metadata is ignored; a prerelease sorts below its release.
 */
export function compareSemver(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const known = (latest: Readonly<Record<string, string>>, adapter: string) =>
  Object.prototype.hasOwnProperty.call(latest, adapter);

/**
 * Is this adapter older than the newest release the relay knows of for it?
 * true / false, or null when it cannot be said: an unknown adapter, a missing
 * version, or a version that is not semver. Null means "no chip", never a guess.
 */
export function adapterOutdated(
  adapter: string | null | undefined,
  version: string | null | undefined,
  latest: Readonly<Record<string, string>> = LATEST_ADAPTER_VERSIONS
): boolean | null {
  if (!adapter || !version || !known(latest, adapter)) return null;
  const cmp = compareSemver(version, latest[adapter]);
  return cmp === null ? null : cmp < 0;
}

/** The identity block the operator routes return for one agent row. */
export function identityView(row: Record<string, unknown>) {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const adapter = str(row.reported_adapter);
  const adapterVersion = str(row.reported_adapter_version);
  return {
    adapter,
    adapter_version: adapterVersion,
    sdk_version: str(row.reported_sdk_version),
    host_runtime: str(row.reported_host_runtime),
    host_runtime_version: str(row.reported_host_runtime_version),
    instance_id: str(row.reported_instance_id),
    latest_adapter_version: adapter && known(LATEST_ADAPTER_VERSIONS, adapter) ? LATEST_ADAPTER_VERSIONS[adapter] : null,
    outdated: adapterOutdated(adapter, adapterVersion)
  };
}

/** A row with its reported_* columns folded into one `identity` block. */
export function withIdentity(row: Record<string, unknown>): Record<string, unknown> & { identity: ReturnType<typeof identityView> } {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!key.startsWith("reported_")) rest[key] = value;
  return { ...rest, identity: identityView(row) };
}

/** SELECT list fragment for the identity columns. */
export const IDENTITY_COLUMNS_SQL =
  "reported_adapter, reported_adapter_version, reported_sdk_version, reported_host_runtime, reported_host_runtime_version, reported_instance_id";
