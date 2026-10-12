// Pin sync, per-message verdicts, the autowake gate and outbound signing live
// in the SDK now (shared with the MCP connector); this module keeps the
// plugin's import paths and test surface stable. The advisory-warning throttle
// is a module-level Map in the SDK module, so the plugin and its tests share
// one instance exactly as they did when it lived here.
export {
  syncPinnedOperatorKeys,
  verifyBatch,
  shouldAutowake,
  parseRequireSignedMode,
  buildSignedSendFields,
  makeSnapshotVerifier,
  NO_SNAPSHOT_VERIFICATION,
  resetAdvisoryRevocationWarningStateForTests,
  ADVISORY_REVOCATION_WARNING_SUMMARY_EVERY,
  ADVISORY_REVOCATION_WARNING_MAX_SCOPES,
  type OperatorKeyEntryLike,
  type SyncLog,
  type RequireSignedMode,
  type MsgSnapshotLike,
  type SnapshotVerifier
} from "@drakon-systems/ekho-sdk/identity";
