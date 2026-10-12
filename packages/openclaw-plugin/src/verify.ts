// Inbound verification lives in the SDK now (shared with the MCP connector);
// this module keeps the plugin's import paths and test surface stable.
export {
  verifyInbound,
  MAX_PAST_SKEW_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  type SignedMessage,
  type RosterEntryLike,
  type VerifyResult,
  type VerifyOpts
} from "@drakon-systems/ekho-sdk/identity";
