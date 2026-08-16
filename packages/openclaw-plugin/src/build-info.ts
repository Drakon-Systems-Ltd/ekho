import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which bundle is this process running? (ekho#33)
 *
 * package.json and openclaw.plugin.json both assert a version; dist/index.js —
 * the code that actually runs — asserted nothing. dist is replaced independently
 * of package.json on this fleet (hand-patched bundles sit beside an untouched
 * package.json), so a box could report a release version while running different
 * code, and no local check could contradict it.
 *
 * Two things are needed, and only together:
 *   1. a stamp baked into the bundle at build time (version, commit, builtAt) —
 *      this binds the reported version to the bytes it was built from;
 *   2. a digest of the running bytes, recomputed at startup and compared to the
 *      digest recorded at build time — this is what a hand-patch cannot survive.
 *
 * (1) alone would rebuild the original bug in a new place: a patcher edits the
 * code and the stamp keeps asserting the old release. (2) is what makes the
 * stamp measurable rather than merely declared.
 *
 * Limit, stated plainly: this is tamper-*evidence* against routine hot-patching,
 * not forgery-proofing. Anyone who knows the scheme can re-zero the slot and
 * recompute the digest. Defeating that needs a signature over a key the box
 * doesn't hold, which is a different piece of work.
 */

/** The build injects this via an esbuild banner. Absent when running from
 *  source (vitest, tsx) or from a bundle that predates the stamp. */
declare const __EKHO_BUILD__: unknown;

/** 64 zeros — the slot the build writes the artifact digest into. Constructed
 *  at runtime so this token never appears as a literal inside the bundle, where
 *  the substitution below would hit it. Must match build-stamp.mjs. */
export const ARTIFACT_SLOT = "0".repeat(64);

/** What the banner carries. */
export interface InjectedBuildStamp {
  version: string;
  commit: string;
  builtAt: string;
  artifactSha256: string;
}

/**
 * - `intact`       — the running bytes hash to the digest recorded at build time.
 * - `modified`     — they do not. The bundle was changed after it was built.
 * - `unverifiable` — no stamp, or the bundle file could not be read back.
 */
export type ArtifactVerdict = "intact" | "modified" | "unverifiable";

export interface BuildIdentity {
  version: string;
  commit: string;
  builtAt: string;
  /** Digest recorded when the bundle was built. */
  builtSha256: string;
  /** Digest of the bytes actually loaded now. Differs from builtSha256 iff
   *  someone edited dist after the build — and identifies *which* edit, so two
   *  differently-patched boxes are distinguishable, not just both "modified". */
  runningSha256: string;
  artifact: ArtifactVerdict;
  /** `bundle` = produced by `npm run build`; `unstamped` = it was not. */
  source: "bundle" | "unstamped";
}

const HEX64 = /^[0-9a-f]{64}$/;

/** sha256 of a UTF-8 string, hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A file cannot contain its own digest, so the build hashes the bundle with the
 * digest slot zeroed and then writes the digest into that slot. To re-derive it
 * we put the slot back the way it was hashed. `builtSha256` is the only 64-hex
 * string the build wrote, so this substitution touches exactly the stamp.
 */
export function canonicalizeBundle(text: string, builtSha256: string): string {
  return text.split(builtSha256).join(ARTIFACT_SLOT);
}

/** Recompute the digest of the loaded bytes and compare it to the recorded one. */
export function verifyArtifact(
  text: string,
  builtSha256: string
): { runningSha256: string; artifact: ArtifactVerdict } {
  if (!HEX64.test(builtSha256)) return { runningSha256: "unknown", artifact: "unverifiable" };
  const runningSha256 = sha256(canonicalizeBundle(text, builtSha256));
  return { runningSha256, artifact: runningSha256 === builtSha256 ? "intact" : "modified" };
}

/** Accept the injected value only if it is fully well-formed. A half-populated
 *  stamp is treated as no stamp — a partial answer here reads as a confident one. */
export function readInjectedStamp(raw: unknown): InjectedBuildStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const version = str(o.version);
  const commit = str(o.commit);
  const builtAt = str(o.builtAt);
  const artifactSha256 = str(o.artifactSha256);
  if (!version || !commit || !builtAt || !artifactSha256) return null;
  return { version, commit, builtAt, artifactSha256 };
}

const UNSTAMPED: BuildIdentity = {
  version: "unknown",
  commit: "unknown",
  builtAt: "unknown",
  builtSha256: "unknown",
  runningSha256: "unknown",
  artifact: "unverifiable",
  source: "unstamped"
};

/**
 * Pure resolver — everything it depends on is passed in, so the dirty-tree,
 * unstamped and hand-patched cases are all reachable from a test.
 * `readSelf` returns the text of the bundle that is executing.
 */
export function resolveBuildIdentity(raw: unknown, readSelf: () => string): BuildIdentity {
  const stamp = readInjectedStamp(raw);
  if (!stamp) return { ...UNSTAMPED };

  let verdict: { runningSha256: string; artifact: ArtifactVerdict };
  try {
    verdict = verifyArtifact(readSelf(), stamp.artifactSha256);
  } catch {
    // Can't read our own file back (packed, permissions, exotic loader). Say so
    // rather than assuming intact.
    verdict = { runningSha256: "unknown", artifact: "unverifiable" };
  }

  return {
    version: stamp.version,
    commit: stamp.commit,
    builtAt: stamp.builtAt,
    builtSha256: HEX64.test(stamp.artifactSha256) ? stamp.artifactSha256 : "unknown",
    runningSha256: verdict.runningSha256,
    artifact: verdict.artifact,
    source: "bundle"
  };
}

/** Abbreviate a hex ref, keeping any suffix. `-dirty` is the part that says
 *  "not a release build", so it must survive the shortening, and a value that
 *  isn't a hex ref at all ("unknown") is passed through untouched. */
const short = (v: string, n = 12) => {
  const m = /^([0-9a-f]{40}|[0-9a-f]{64})(-.*)?$/.exec(v);
  return m ? `${m[1].slice(0, n)}${m[2] ?? ""}` : v;
};

/** The full startup line. Greppable, and self-describing when it has nothing. */
export function formatBuildIdentity(id: BuildIdentity): string {
  if (id.source === "unstamped") {
    return (
      "[ekho-build] version=unknown commit=unknown built=unknown artifact=unverifiable " +
      "— this bundle carries no build stamp (not produced by `npm run build`), so its version cannot be established"
    );
  }
  const head =
    `[ekho-build] version=${id.version} commit=${id.commit} built=${id.builtAt} ` +
    `artifact=sha256:${short(id.runningSha256, 16)}`;
  if (id.artifact === "intact") return `${head} (intact)`;
  if (id.artifact === "modified") {
    return `${head} (MODIFIED — dist was edited after build; built as sha256:${short(id.builtSha256, 16)})`;
  }
  return `${head} (unverifiable — could not read the running bundle back)`;
}

/** Compact form for the tail of the autoreply listening line, so one grep gets
 *  both the poll interval and the build. */
export function formatBuildIdentityShort(id: BuildIdentity): string {
  if (id.source === "unstamped") return "unstamped";
  const suffix =
    id.artifact === "modified" ? "!MODIFIED" : id.artifact === "unverifiable" ? "?unverified" : "";
  return `${id.version}+${short(id.commit)}/${short(id.runningSha256)}${suffix}`;
}

let cached: BuildIdentity | null = null;

/** The identity of the bundle this process loaded. Computed once. */
export function buildIdentity(): BuildIdentity {
  if (cached) return cached;
  cached = resolveBuildIdentity(typeof __EKHO_BUILD__ === "undefined" ? null : __EKHO_BUILD__, () =>
    readFileSync(fileURLToPath(import.meta.url), "utf8")
  );
  return cached;
}

let logged = false;

/** Emit the build line once per process, whichever startup path gets there first. */
export function logBuildIdentity(log?: { info?: (...a: unknown[]) => void }): void {
  if (logged) return;
  logged = true;
  try {
    log?.info?.(formatBuildIdentity(buildIdentity()));
  } catch {
    // Identity reporting must never be the reason startup fails.
  }
}

/** Test seam: reset the once-only latches. */
export function resetBuildIdentityCacheForTests(): void {
  cached = null;
  logged = false;
}

/**
 * The same identity as a tool-result field, so an agent can answer "which bundle
 * am I running" without shell access to the journal. `running_sha256` is derived
 * from the bytes serving the call, not from the stamp — it is the field that
 * survives a hand-patch, and it is why `version` here can be trusted when
 * `artifact` is "intact".
 */
export function buildStatusField(id: BuildIdentity = buildIdentity()): Record<string, unknown> {
  return {
    version: id.version,
    commit: id.commit,
    built_at: id.builtAt,
    built_sha256: id.builtSha256,
    running_sha256: id.runningSha256,
    artifact: id.artifact,
    source: id.source
  };
}
