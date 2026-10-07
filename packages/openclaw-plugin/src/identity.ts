// Re-exported from the SDK since the MCP connector landed: one implementation
// of the canonical form and the Ed25519 primitives for every TypeScript agent.
// The frozen interop vector (packages/relay/tests/fixtures/
// operator-identity-vector.json) still pins the contract from this side.
export {
  canonicalize,
  b64url,
  fromB64url,
  keyId,
  sha256Hex,
  publicKeyB64urlFromSeed,
  signCanonical,
  verifyCanonical,
  endorsementPayload,
  revocationPayload,
  unrevokePayload,
  agentKeyEndorsementPayload
} from "@drakon-systems/ekho-sdk/identity";
