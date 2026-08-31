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
//
// Every inlined dependency has to resolve to ESM. esbuild will happily inline a
// CommonJS one, but it lowers that dependency's `require()` calls to a shim that
// throws under any loader leaving no ambient `require` in scope — which is every
// real ESM loader, OpenClaw 2.x's included. See the check below; the SDK's
// `exports` map is what keeps its side of this true.
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

const outfile = "dist/index.js";
const built = readFileSync(outfile, "utf8");

// Refuse to ship a bundle that cannot be imported. 0.4.5 and 0.4.6 both went out
// with esbuild's dynamic-require shim in them, from a dependency that resolved
// to CommonJS, and both died at `import` on every 2.x box with
// `Dynamic require of "node:crypto" is not supported` (ekho#68). The shim runs
// at the top of the module, so nothing downstream of it gets a chance. Failing
// the build is the only place this costs one person a minute instead of costing
// the fleet a release.
if (built.includes("Dynamic require of")) {
  const cjs = [...new Set([...built.matchAll(/^\s*"([^"]+)"\((?:exports|module)[,)]/gm)].map((m) => m[1]))];
  throw new Error(
    "bundle carries esbuild's dynamic-require shim, which throws under a real ESM loader.\n" +
      `CommonJS inlined from: ${cjs.join(", ") || "(could not identify the module)"}\n` +
      "Fix it where it resolves — publish/point at an ESM build of that dependency, as packages/sdk's " +
      "`exports` map does — rather than shipping a bundle the gateway cannot load."
  );
}

// The bundle can't contain its own digest, so it was just written with the digest
// slot zeroed: hash it in that form, then write the hash into the slot. The
// runtime re-zeros the slot and re-hashes, so any later edit to dist stops
// matching and says so at startup.
const { text, sha256 } = stampArtifactDigest(built);
writeFileSync(outfile, text);

console.log(
  `[build] ${pkg.name}@${stamp.version} commit=${stamp.commit} built=${stamp.builtAt} artifact=sha256:${sha256}`
);
