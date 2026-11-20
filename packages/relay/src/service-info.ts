import { RELAY_VERSION } from "./version";

/**
 * The body of the unauthenticated `GET /`. It names the release but never the
 * build SHA: the exact commit would fingerprint the deployment for anyone who
 * can reach the port. The SHA is served to authenticated operators only, on
 * `GET /v1/operator/build-info` (#97).
 */
export function serviceInfo(input: { tier: string; setupRequired: boolean }) {
  return {
    service: "ekho-relay",
    version: RELAY_VERSION,
    tier: input.tier,
    setup_required: input.setupRequired,
    docs: {
      architecture: "/ARCHITECTURE.md",
      ui: "/ui/",
      a2a_agent_card: "/.well-known/agent-card.json",
      metrics: "/metrics"
    }
  };
}
