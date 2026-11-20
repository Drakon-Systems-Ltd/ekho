import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// #97: stamp the console bundle with the relay package version and the commit
// it was built from, so the console can show both and warn when the relay is
// running a different commit (a skipped `ui:build`). The SHA is resolved the
// same way as the relay's own (src/version.ts): EKHO_BUILD_SHA if it is a git
// object name, else `git rev-parse HEAD`, else "unknown"; cut to 12.
const SHA_RE = /^[0-9a-f]{7,40}$/;
const sha = (raw) => {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SHA_RE.test(v) ? v.slice(0, 12) : null;
};
function consoleBuildSha() {
  const fromEnv = sha(process.env.EKHO_BUILD_SHA);
  if (fromEnv) return fromEnv;
  try {
    const fromGit = sha(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: new URL(".", import.meta.url),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
    );
    if (fromGit) return fromGit;
  } catch {
    /* no git (e.g. a Docker build context without .git): unknown */
  }
  return "unknown";
}
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** Vite `define` entries read by frontend/src/buildInfo.js. */
export function consoleBuildDefine() {
  return {
    __EKHO_CONSOLE_VERSION__: JSON.stringify(version),
    __EKHO_CONSOLE_SHA__: JSON.stringify(consoleBuildSha()),
  };
}

