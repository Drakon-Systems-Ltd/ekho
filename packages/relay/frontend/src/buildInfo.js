// Build and version helpers for the console (#97). Pure: no React, no fetch,
// so the relay's vitest suite can import them directly.

/* global __EKHO_CONSOLE_VERSION__, __EKHO_CONSOLE_SHA__ */

// Injected by vite.config.mjs at `ui:build`. Absent under vitest or a dev
// server started without the define, which reads as "unknown".
export const CONSOLE_BUILD = Object.freeze({
  version: typeof __EKHO_CONSOLE_VERSION__ === "string" && __EKHO_CONSOLE_VERSION__ ? __EKHO_CONSOLE_VERSION__ : "unknown",
  sha: typeof __EKHO_CONSOLE_SHA__ === "string" && __EKHO_CONSOLE_SHA__ ? __EKHO_CONSOLE_SHA__ : "unknown",
});

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** A git object name, lowercased; null for "unknown", empty or anything else. */
export function knownSha(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return SHA_RE.test(v) ? v : null;
}

/**
 * True only when both builds are known and name different commits. Short SHAs
 * of different lengths are compared on their common prefix, so "abc1234" and
 * "abc1234def56" are the same commit. Either side unknown → false: no banner
 * is better than a banner that cries wolf.
 */
export function buildMismatch(consoleSha, relaySha) {
  const a = knownSha(consoleSha);
  const b = knownSha(relaySha);
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) !== b.slice(0, n);
}

const shortSha = (raw) => knownSha(raw)?.slice(0, 7) ?? "unknown";
const ver = (raw) => (typeof raw === "string" && raw && raw !== "unknown" ? `v${raw}` : "v?");

/** "relay v0.9.0 (abc1234) · console v0.9.0 (abc1234)". */
export function buildLine(relay, consoleBuild = CONSOLE_BUILD) {
  return `relay ${ver(relay?.version)} (${shortSha(relay?.build_sha)}) · console ${ver(consoleBuild?.version)} (${shortSha(consoleBuild?.sha)})`;
}

/** The stale-console banner text, or null when there is nothing to say. */
export function staleBuildMessage(relay, consoleBuild = CONSOLE_BUILD) {
  if (!buildMismatch(consoleBuild?.sha, relay?.build_sha)) return null;
  return (
    `Console build is stale: this console was built from ${shortSha(consoleBuild.sha)}, ` +
    `the relay is running ${shortSha(relay.build_sha)}. Run \`npm run ui:build -w @ekho/relay\` on the relay host, then reload.`
  );
}

/** Session-storage key for "dismissed", per pair of builds: a new mismatch shows again. */
export function staleDismissKey(relay, consoleBuild = CONSOLE_BUILD) {
  return `ekho.staleBuildDismissed.${knownSha(consoleBuild?.sha) ?? "?"}.${knownSha(relay?.build_sha) ?? "?"}`;
}

const ADAPTER_LABEL = {
  "openclaw-plugin": "plugin",
  "hermes-plugin": "plugin",
  "mcp-connector": "mcp",
  sdk: "sdk",
  "python-sdk": "py-sdk",
};
const HOST_LABEL = { openclaw: "OpenClaw", hermes: "Hermes", node: "Node", python: "Python" };

/**
 * What an agent card says about the agent's software, from the relay's
 * `identity` block: "plugin 0.8.0 · OpenClaw 2026.9.8", or "version unknown"
 * when the agent reports nothing (a plugin older than #97). `outdated` is the
 * relay's verdict, true only when it said so.
 */
export function agentVersionInfo(identity) {
  const id = identity && typeof identity === "object" ? identity : {};
  const parts = [];
  if (id.adapter_version) parts.push(`${ADAPTER_LABEL[id.adapter] ?? id.adapter ?? "adapter"} ${id.adapter_version}`);
  else if (id.adapter) parts.push(`${ADAPTER_LABEL[id.adapter] ?? id.adapter} version unknown`);
  if (id.host_runtime) {
    const host = HOST_LABEL[id.host_runtime] ?? id.host_runtime;
    parts.push(id.host_runtime_version ? `${host} ${id.host_runtime_version}` : host);
  }
  const label = parts.length ? parts.join(" · ") : "version unknown";
  const details = [
    id.adapter ? `adapter ${id.adapter}${id.adapter_version ? ` ${id.adapter_version}` : ""}` : null,
    id.sdk_version ? `sdk ${id.sdk_version}` : null,
    id.host_runtime ? `host ${id.host_runtime}${id.host_runtime_version ? ` ${id.host_runtime_version}` : ""}` : null,
    id.instance_id ? `instance ${id.instance_id}` : null,
    id.outdated === true && id.latest_adapter_version ? `latest release known to this relay: ${id.latest_adapter_version}` : null,
  ].filter(Boolean);
  return {
    label,
    known: parts.length > 0,
    outdated: id.outdated === true,
    latest: id.latest_adapter_version ?? null,
    title: details.length ? `Reported by the agent: ${details.join(", ")}` : "This agent does not report its version (adapter predates version reporting)",
  };
}
