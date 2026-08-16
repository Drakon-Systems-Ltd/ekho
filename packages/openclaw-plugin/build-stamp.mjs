// Build-identity helpers, shared by build.mjs and its tests.
//
// The plugin's version lives in package.json; the code that actually runs lives
// in dist/index.js. Nothing bound the two, so a box could report a release
// version while running hand-patched bytes (ekho#33). These helpers produce the
// binding: a stamp baked into the bundle at build time, plus a digest of the
// bundle itself so the running bytes can be checked against the stamp.
//
// Everything here degrades to a truthful "unknown" rather than a confident
// guess. A build stamp that lies is worse than no build stamp.

import { createHash } from "node:crypto";

/** The 64-character slot the artifact digest is written into. The bundle is
 *  hashed with the slot zeroed, which is the only way a file can carry a digest
 *  of itself; the runtime re-zeros it before re-hashing. Built with repeat() so
 *  the token never appears as a source literal that the substitution could hit. */
export const ARTIFACT_SLOT = "0".repeat(64);

/** sha256 of a UTF-8 string, hex. */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The commit the bundle is being built from.
 *
 * `git` is an injected runner: `(args: string[]) => string` returning trimmed
 * stdout and throwing on non-zero exit. Every failure path resolves to a
 * truthful answer, never an optimistic one:
 *   - not a git work tree (tarball, npm install, docker COPY) -> "unknown"
 *   - no HEAD yet (fresh repo)                                -> "unknown"
 *   - work tree has any modification                          -> "<sha>-dirty"
 *   - cleanliness cannot be established                       -> "<sha>-dirty"
 * The last one matters: an unprovable clean tree is reported dirty, because the
 * cost of a false "dirty" is a second look and the cost of a false "clean" is
 * this whole bug again.
 */
export function resolveBuildCommit(git) {
  let inTree;
  try {
    inTree = git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return "unknown";
  }
  if (inTree !== "true") return "unknown";

  let sha;
  try {
    sha = git(["rev-parse", "HEAD"]);
  } catch {
    return "unknown";
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) return "unknown";

  let porcelain;
  try {
    porcelain = git(["status", "--porcelain"]);
  } catch {
    return `${sha}-dirty`;
  }
  return porcelain.trim() === "" ? sha : `${sha}-dirty`;
}

/**
 * The stamp object the banner injects. `artifactSha256` starts as the zero slot
 * and is filled in by stampArtifactDigest() once the bundle exists.
 */
export function makeBuildStamp({ version, commit, builtAt }) {
  return {
    version: typeof version === "string" && version ? version : "unknown",
    commit: typeof commit === "string" && commit ? commit : "unknown",
    builtAt: typeof builtAt === "string" && builtAt ? builtAt : "unknown",
    artifactSha256: ARTIFACT_SLOT
  };
}

/** The banner esbuild prepends. A module-scope const (not a global) so two
 *  plugin copies loaded in one process can't overwrite each other's identity. */
export function buildStampBanner(stamp) {
  return (
    "// @drakon-systems/ekho-openclaw-plugin — bundled. Edit src/, run `npm run build`.\n" +
    `const __EKHO_BUILD__ = ${JSON.stringify(stamp)};`
  );
}

/**
 * Fill the zero slot in a freshly built bundle with the digest of that same
 * bundle. Returns { text, sha256 }. Idempotent only against slot-bearing text —
 * calling it twice is a build bug, so it throws rather than silently no-op.
 */
export function stampArtifactDigest(text) {
  if (!text.includes(ARTIFACT_SLOT)) {
    throw new Error("build stamp slot missing from bundle — banner injection did not land");
  }
  const digest = sha256(text);
  return { text: text.split(ARTIFACT_SLOT).join(digest), sha256: digest };
}
