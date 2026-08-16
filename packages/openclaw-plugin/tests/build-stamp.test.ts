import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS build helper shared with build.mjs; no type decls.
import { ARTIFACT_SLOT, resolveBuildCommit, makeBuildStamp, buildStampBanner, stampArtifactDigest, sha256 } from "../build-stamp.mjs";
import {
  canonicalizeBundle,
  formatBuildIdentity,
  formatBuildIdentityShort,
  readInjectedStamp,
  resolveBuildIdentity,
  verifyArtifact
} from "../src/build-info";

const SHA = "a".repeat(40);

/** A fake `git` runner: joined-args -> stdout, or an Error to throw. */
function fakeGit(table: Record<string, string | Error>) {
  return (args: string[]) => {
    const hit = table[args.join(" ")];
    if (hit === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
}

// ekho#33: the stamp exists so a box can be asked which bundle it runs. Every
// answer it can give has to be true — an over-confident stamp just reproduces
// the original defect one layer further in.
describe("build commit resolution degrades honestly", () => {
  it("reports the sha when the tree is clean", () => {
    expect(
      resolveBuildCommit(
        fakeGit({ "rev-parse --is-inside-work-tree": "true", "rev-parse HEAD": SHA, "status --porcelain": "" })
      )
    ).toBe(SHA);
  });

  it("suffixes -dirty when the worktree has uncommitted changes", () => {
    expect(
      resolveBuildCommit(
        fakeGit({
          "rev-parse --is-inside-work-tree": "true",
          "rev-parse HEAD": SHA,
          "status --porcelain": " M src/autoreply.ts"
        })
      )
    ).toBe(`${SHA}-dirty`);
  });

  it("suffixes -dirty when cleanliness cannot be established", () => {
    // A false "clean" is the failure that matters; a false "dirty" only costs a
    // second look. So an unprovable tree is reported dirty, not clean.
    expect(
      resolveBuildCommit(
        fakeGit({
          "rev-parse --is-inside-work-tree": "true",
          "rev-parse HEAD": SHA,
          "status --porcelain": new Error("could not read the index")
        })
      )
    ).toBe(`${SHA}-dirty`);
  });

  it("reports unknown outside a git work tree", () => {
    // Building from an npm tarball or a docker COPY: no repo, so no commit.
    expect(resolveBuildCommit(fakeGit({ "rev-parse --is-inside-work-tree": new Error("not a git repo") }))).toBe(
      "unknown"
    );
    expect(resolveBuildCommit(fakeGit({ "rev-parse --is-inside-work-tree": "false" }))).toBe("unknown");
  });

  it("reports unknown when HEAD does not resolve to a sha", () => {
    expect(
      resolveBuildCommit(
        fakeGit({ "rev-parse --is-inside-work-tree": "true", "rev-parse HEAD": new Error("no HEAD yet") })
      )
    ).toBe("unknown");
    expect(
      resolveBuildCommit(fakeGit({ "rev-parse --is-inside-work-tree": "true", "rev-parse HEAD": "HEAD" }))
    ).toBe("unknown");
  });

  it("never claims a version it was not given", () => {
    expect(makeBuildStamp({})).toEqual({
      version: "unknown",
      commit: "unknown",
      builtAt: "unknown",
      artifactSha256: ARTIFACT_SLOT
    });
  });
});

describe("artifact digest binds the stamp to the bytes", () => {
  const bundleOf = (body: string, commit = SHA, version = "9.9.9") =>
    `${buildStampBanner(makeBuildStamp({ version, commit, builtAt: "2026-08-16T00:00:00.000Z" }))}\n${body}`;

  it("fills the zero slot with the digest of the slot-bearing bundle", () => {
    const { text, sha256: digest } = stampArtifactDigest(bundleOf("export const x = 1;\n"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain(ARTIFACT_SLOT);
    expect(text).toContain(digest);
    // The recorded digest is the digest of the bytes with the slot re-zeroed,
    // which is exactly what the runtime recomputes.
    expect(sha256(canonicalizeBundle(text, digest))).toBe(digest);
  });

  it("refuses to seal a bundle the banner never reached", () => {
    expect(() => stampArtifactDigest("export const x = 1;\n")).toThrow(/slot missing/);
  });

  it("verifies an untouched bundle as intact", () => {
    const { text, sha256: digest } = stampArtifactDigest(bundleOf("export const x = 1;\n"));
    expect(verifyArtifact(text, digest)).toEqual({ runningSha256: digest, artifact: "intact" });
  });

  it("detects a hand-patched bundle, down to a one-character edit", () => {
    const { text, sha256: digest } = stampArtifactDigest(bundleOf("export const pollMs = 5000;\n"));
    const verdict = verifyArtifact(text.replace("5000", "5001"), digest);
    expect(verdict.artifact).toBe("modified");
    expect(verdict.runningSha256).not.toBe(digest);
  });

  it("detects a relabelled stamp — editing the version inside dist does not make it true", () => {
    // The exact move this issue is about, applied to the stamp itself.
    const { text, sha256: digest } = stampArtifactDigest(bundleOf("export const x = 1;\n"));
    expect(text).toContain('"version":"9.9.9"');
    expect(verifyArtifact(text.replace('"version":"9.9.9"', '"version":"0.4.1"'), digest).artifact).toBe("modified");
  });

  it("tells two differently-patched boxes apart instead of lumping them together", () => {
    const { text, sha256: digest } = stampArtifactDigest(bundleOf("export const x = 1;\n"));
    const a = verifyArtifact(`${text}\n// patch A`, digest);
    const b = verifyArtifact(`${text}\n// patch B`, digest);
    expect(a.artifact).toBe("modified");
    expect(b.artifact).toBe("modified");
    expect(a.runningSha256).not.toBe(b.runningSha256);
  });

  it("cannot be verified against a malformed recorded digest", () => {
    expect(verifyArtifact("anything", "not-a-digest")).toEqual({
      runningSha256: "unknown",
      artifact: "unverifiable"
    });
  });
});

describe("injected stamp is accepted only when whole", () => {
  const whole = { version: "0.4.1", commit: SHA, builtAt: "2026-08-16T00:00:00.000Z", artifactSha256: "b".repeat(64) };

  it("accepts a complete stamp", () => {
    expect(readInjectedStamp(whole)).toEqual(whole);
  });

  it("rejects absent, non-object, or partial stamps", () => {
    expect(readInjectedStamp(undefined)).toBeNull();
    expect(readInjectedStamp(null)).toBeNull();
    expect(readInjectedStamp("0.4.1")).toBeNull();
    for (const key of Object.keys(whole)) {
      expect(readInjectedStamp({ ...whole, [key]: "" })).toBeNull();
      const missing: Record<string, unknown> = { ...whole };
      delete missing[key];
      expect(readInjectedStamp(missing)).toBeNull();
    }
  });
});

describe("resolved identity and the lines it prints", () => {
  /** Build a stamped bundle and the injected object that matches it. */
  const stamped = (body: string, commit = SHA) => {
    const builtAt = "2026-08-16T00:00:00.000Z";
    const banner = buildStampBanner(makeBuildStamp({ version: "0.4.1", commit, builtAt }));
    const { text, sha256: digest } = stampArtifactDigest(`${banner}\n${body}`);
    return { raw: { version: "0.4.1", commit, builtAt, artifactSha256: digest }, text };
  };

  it("reports an intact bundle with its version and commit", () => {
    const { raw, text } = stamped("export const x = 1;\n");
    const id = resolveBuildIdentity(raw, () => text);
    expect(id).toMatchObject({ source: "bundle", artifact: "intact", version: "0.4.1", commit: SHA });
    expect(id.runningSha256).toBe(id.builtSha256);
    expect(formatBuildIdentity(id)).toContain("(intact)");
    expect(formatBuildIdentityShort(id)).toBe(`0.4.1+${SHA.slice(0, 12)}/${id.runningSha256.slice(0, 12)}`);
  });

  it("says MODIFIED, loudly, when the running bytes are not the built bytes", () => {
    const { raw, text } = stamped("export const x = 1;\n");
    const id = resolveBuildIdentity(raw, () => `${text}\n// hot patch applied by hand\n`);
    expect(id.artifact).toBe("modified");
    // The version is still reported — but no longer as a claim about the code.
    expect(id.version).toBe("0.4.1");
    expect(id.runningSha256).not.toBe(id.builtSha256);
    expect(formatBuildIdentity(id)).toMatch(/MODIFIED — dist was edited after build/);
    expect(formatBuildIdentityShort(id)).toMatch(/!MODIFIED$/);
  });

  it("says unstamped when the bundle carries no build identity at all", () => {
    // A pre-#33 bundle, or a hand-assembled one: it cannot be identified, and
    // the line says so instead of falling back to package.json.
    const id = resolveBuildIdentity(undefined, () => "");
    expect(id).toMatchObject({ source: "unstamped", artifact: "unverifiable", version: "unknown" });
    expect(formatBuildIdentity(id)).toContain("carries no build stamp");
    expect(formatBuildIdentityShort(id)).toBe("unstamped");
  });

  it("says unverifiable — not intact — when it cannot read its own bytes back", () => {
    const { raw } = stamped("export const x = 1;\n");
    const id = resolveBuildIdentity(raw, () => {
      throw new Error("EACCES");
    });
    expect(id.artifact).toBe("unverifiable");
    expect(id.runningSha256).toBe("unknown");
    expect(formatBuildIdentity(id)).toContain("could not read the running bundle back");
    expect(formatBuildIdentityShort(id)).toMatch(/\?unverified$/);
  });

  it("carries the dirty marker through to both lines", () => {
    const { raw, text } = stamped("export const x = 1;\n", `${SHA}-dirty`);
    const id = resolveBuildIdentity(raw, () => text);
    expect(id.artifact).toBe("intact");
    expect(formatBuildIdentity(id)).toContain(`commit=${SHA}-dirty`);
    // -dirty must survive shortening: it is the part that says "not a release".
    expect(formatBuildIdentityShort(id)).toContain(`${SHA.slice(0, 12)}-dirty`);
  });
});
