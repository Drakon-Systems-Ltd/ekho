import type { BuildIdentity } from "./build-info.js";

/**
 * What this plugin says about itself on each heartbeat (#97), for the operator
 * console's per-agent version line. The SDK client adds `sdk_version` (the SDK
 * inlined into this bundle) and the per-load `instance_id`.
 *
 * - `adapter_version` comes from the build stamp baked into dist/index.js
 *   (ekho#33), never from a package.json read at run time. An unstamped bundle
 *   omits it, so the console says "version unknown" rather than guessing. A
 *   bundle whose bytes no longer match its stamp reports `<version>+modified`.
 * - `host_runtime_version` is OpenClaw's own `api.runtime.version`, when the
 *   host exposes it as a short version token.
 */
export type PluginHeartbeatIdentity = {
  adapter: "openclaw-plugin";
  adapter_version?: string;
  host_runtime: "openclaw";
  host_runtime_version?: string;
};

const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

function versionToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return VERSION_TOKEN.test(value) ? value : undefined;
}

/** OpenClaw's version from the host api, or undefined. Never throws. */
export function openclawHostVersion(api: unknown): string | undefined {
  try {
    const runtime = (api as { runtime?: { version?: unknown } } | null | undefined)?.runtime;
    return versionToken(runtime?.version);
  } catch {
    return undefined; // a throwing getter on a host-internal object is not our failure
  }
}

export function pluginHeartbeatIdentity(build: BuildIdentity, hostVersion?: string): PluginHeartbeatIdentity {
  const identity: PluginHeartbeatIdentity = { adapter: "openclaw-plugin", host_runtime: "openclaw" };
  const stamped = build.source === "bundle" ? versionToken(build.version) : undefined;
  if (stamped && stamped !== "unknown") {
    identity.adapter_version = build.artifact === "modified" && !stamped.includes("+") ? `${stamped}+modified` : stamped;
  }
  const host = versionToken(hostVersion);
  if (host) identity.host_runtime_version = host;
  return identity;
}
