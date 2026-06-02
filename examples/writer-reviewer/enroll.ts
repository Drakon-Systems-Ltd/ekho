/**
 * One-shot enrollment helper.
 *
 * The Ekho SDK deliberately does not expose enrollment — it's a one-time
 * bootstrap step where an operator-issued token is exchanged for a signed
 * agent_id + secret. After that the SDK takes over for every other call.
 *
 * This helper hits POST /v1/enroll directly so the example can be run
 * end-to-end with just an enrollment token. Every subsequent operation
 * (send, poll, ack, heartbeat) goes through @drakon-systems/ekho-sdk.
 */

import type { AgentCredentials } from "@drakon-systems/ekho-sdk";

export type EnrollParams = {
  relayBaseUrl: string;
  fleetId: string;
  token: string;
  displayName: string;
};

type EnrollResponse = {
  agent_id: string;
  secret: string;
  relay_base_url: string;
  heartbeat_interval_seconds: number;
  poll_interval_seconds: number;
};

export async function enrollAgent(params: EnrollParams): Promise<AgentCredentials> {
  const response = await fetch(`${params.relayBaseUrl}/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fleet_id: params.fleetId,
      token: params.token,
      display_name: params.displayName,
      runtime: "custom"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`enrollment failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as EnrollResponse;
  return {
    agentId: data.agent_id,
    secret: data.secret,
    relayBaseUrl: params.relayBaseUrl,
    heartbeatIntervalSeconds: data.heartbeat_interval_seconds,
    pollIntervalSeconds: 1 // tight poll for demo snappiness
  };
}
