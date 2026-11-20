/**
 * This SDK's release version, sent as `sdk_version` on every heartbeat (#97).
 * A constant rather than a read of package.json at run time: the SDK is also
 * inlined into the OpenClaw plugin bundle, where no package.json sits beside
 * it. release-version-lockstep.test.ts keeps it equal to package.json.
 */
export const SDK_VERSION = "0.9.0";
