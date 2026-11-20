import { describe, it, expect } from "vitest";
import { openclawHostVersion, pluginHeartbeatIdentity } from "../src/heartbeat-identity";
import { resolveBuildIdentity, type BuildIdentity } from "../src/build-info";

// #97: what the plugin reports about itself on each heartbeat.

const stamped = (over: Partial<BuildIdentity> = {}): BuildIdentity => ({
  version: "0.9.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  builtAt: "2026-11-20T00:00:00.000Z",
  builtSha256: "a".repeat(64),
  runningSha256: "a".repeat(64),
  artifact: "intact",
  source: "bundle",
  ...over
});

describe("plugin heartbeat identity (#97)", () => {
  it("reports the stamped bundle version and the host's OpenClaw version", () => {
    expect(pluginHeartbeatIdentity(stamped(), "2026.9.8")).toEqual({
      adapter: "openclaw-plugin",
      adapter_version: "0.9.0",
      host_runtime: "openclaw",
      host_runtime_version: "2026.9.8"
    });
  });

  it("claims no version for an unstamped bundle", () => {
    const unstamped = resolveBuildIdentity(null, () => "");
    expect(pluginHeartbeatIdentity(unstamped)).toEqual({ adapter: "openclaw-plugin", host_runtime: "openclaw" });
  });

  it("marks a bundle edited after its build, so it is not shown as a clean release", () => {
    expect(pluginHeartbeatIdentity(stamped({ artifact: "modified", runningSha256: "b".repeat(64) })).adapter_version).toBe("0.9.0+modified");
    // Unverifiable (could not read itself back) is not evidence of an edit.
    expect(pluginHeartbeatIdentity(stamped({ artifact: "unverifiable" })).adapter_version).toBe("0.9.0");
  });

  it("reads OpenClaw's version defensively and drops anything that is not a short version token", () => {
    expect(openclawHostVersion({ runtime: { version: " 2026.7.1 " } })).toBe("2026.7.1");
    expect(openclawHostVersion({ runtime: { version: "2026.7.1 (/opt/openclaw)" } })).toBeUndefined();
    expect(openclawHostVersion({ runtime: { version: 2026 } })).toBeUndefined();
    expect(openclawHostVersion({ runtime: {} })).toBeUndefined();
    expect(openclawHostVersion(undefined)).toBeUndefined();
    const hostile = { get runtime(): never { throw new Error("host-internal getter"); } };
    expect(openclawHostVersion(hostile)).toBeUndefined();
  });
});
