import { execFileSync } from "node:child_process";

/**
 * The relay's release version, and the single place it is written (#97).
 * GET /, /metrics and the A2A agent card all read it from here.
 * release-version-lockstep.test.ts keeps it equal to every package.json.
 */
export const RELAY_VERSION = "0.9.0";

/**
 * Newest release this relay knows of for each adapter, used for the console's
 * "outdated" chip. Every adapter listed here ships from this monorepo and is
 * released in lockstep with the relay, so the newest version the relay knows
 * of is its own. No registry is ever queried. An adapter that is not listed
 * (a third-party client, or the Python SDK, which is versioned separately)
 * never gets an outdated verdict.
 */
export const LATEST_ADAPTER_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  "openclaw-plugin": RELAY_VERSION,
  "hermes-plugin": RELAY_VERSION,
  "mcp-connector": RELAY_VERSION,
  sdk: RELAY_VERSION
});

/** Short SHAs are compared at this length on both sides (relay and console). */
export const BUILD_SHA_LENGTH = 12;

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A git object name, lowercased and cut to BUILD_SHA_LENGTH; null if it is not one. */
export function normalizeBuildSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return SHA_RE.test(value) ? value.slice(0, BUILD_SHA_LENGTH) : null;
}

/**
 * Which commit is this relay running? In order:
 *   1. EKHO_BUILD_SHA, when it is a git object name (set by an image build or a
 *      deploy script that knows the commit);
 *   2. `git rev-parse HEAD` in the relay's own source directory (a source
 *      checkout, which is how the relay is normally run);
 *   3. "unknown" (no git, not a work tree, or anything else going wrong).
 * Pure: every source is passed in, so each branch is reachable from a test.
 */
export function resolveRelayBuildSha(sources: { env?: string; git?: () => string }): string {
  const fromEnv = normalizeBuildSha(sources.env);
  if (fromEnv) return fromEnv;
  if (sources.git) {
    try {
      const fromGit = normalizeBuildSha(sources.git());
      if (fromGit) return fromGit;
    } catch {
      /* no git binary, not a work tree, timed out: the commit is unknown */
    }
  }
  return "unknown";
}

let cachedSha: string | null = null;

/**
 * The relay's build SHA, resolved once per process and cached. server.ts calls
 * this at boot so the one possible `git` spawn happens before the relay listens,
 * never on a request. execFile, not a shell; fixed arguments; 2 s timeout.
 */
export function relayBuildSha(): string {
  if (cachedSha === null) {
    cachedSha = resolveRelayBuildSha({
      env: process.env.EKHO_BUILD_SHA,
      git: () =>
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: __dirname,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000
        })
    });
  }
  return cachedSha;
}
