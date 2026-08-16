import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildStampBanner, makeBuildStamp, resolveBuildCommit, stampArtifactDigest } from "./build-stamp.mjs";

// Start from a clean dist so stale per-module output from earlier builds can't
// linger alongside the bundle.
rmSync("dist", { recursive: true, force: true });

// Bind the reported version to the bytes that get shipped (ekho#33). The stamp
// is injected here rather than committed as a generated source file, so it can
// never be stale, and it degrades to "unknown"/"-dirty" instead of guessing.
const git = (args) =>
  execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const stamp = makeBuildStamp({
  version: pkg.version,
  commit: resolveBuildCommit(git),
  builtAt: new Date().toISOString()
});

// Bundle the plugin into a single self-contained ESM file so it can be dropped
// onto any host without a follow-up `npm install`. Runtime deps (typebox, the
// Ekho SDK) are inlined; `openclaw` stays external — the host gateway provides
// it at load time (it's an optional peer dependency).
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["openclaw", "openclaw/*"],
  banner: {
    js: buildStampBanner(stamp)
  }
});

// The bundle can't contain its own digest, so it was just written with the digest
// slot zeroed: hash it in that form, then write the hash into the slot. The
// runtime re-zeros the slot and re-hashes, so any later edit to dist stops
// matching and says so at startup.
const outfile = "dist/index.js";
const { text, sha256 } = stampArtifactDigest(readFileSync(outfile, "utf8"));
writeFileSync(outfile, text);

console.log(
  `[build] ${pkg.name}@${stamp.version} commit=${stamp.commit} built=${stamp.builtAt} artifact=sha256:${sha256}`
);
