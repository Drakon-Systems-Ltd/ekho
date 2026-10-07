// Test fixtures: a REAL relay (the relay's own createTestRelay harness, then
// listened on a loopback port so the connector's SDK client can reach it over
// HTTP), operator keys, an endorsed peer agent that signs like the plugin, and
// a connector agent in a temp state dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createTestRelay, type TestRelay } from "../../relay/tests/setup";
import {
  agentKeyEndorsementPayload,
  buildSignedSendFields,
  fromB64url,
  keyId,
  publicKeyB64urlFromSeed,
  signCanonical
} from "@drakon-systems/ekho-sdk/identity";
import { EkhoConnectorAgent, type AgentOptions } from "../src/agent";

export const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

export function tmpDir(prefix = "ekho-mcp-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let fill = 10;
export function makeOperatorKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pubB64 = publicKeyB64urlFromSeed(seed);
  return { seed, pubB64, id: keyId(fromB64url(pubB64)) };
}
export type OperatorKey = ReturnType<typeof makeOperatorKey>;

export interface LiveRelay extends TestRelay {
  baseUrl: string;
  /** First operator key, registered as the fleet's trust root. */
  root: OperatorKey;
  /** Enrol a peer whose identity key the root operator key endorses. */
  enrollEndorsedPeer(displayName: string): Promise<Peer>;
  /** One-time enrolment token for a NEW agent (the connector). */
  issueToken(): string;
  close(): Promise<void>;
}

export interface Peer {
  agent_id: string;
  secret: string;
  seedHex: string;
  pubB64: string;
  keyId: string;
  /** Send a v2-signed direct/room message exactly as the OpenClaw plugin does. */
  sendSigned(opts: { to?: string; roomId?: string; text: string; conversationId?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  sendUnsigned(opts: { to: string; text: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  inbox(): Promise<Record<string, unknown>>;
}

export async function startRelay(): Promise<LiveRelay> {
  const relay = await createTestRelay();
  await relay.app.listen({ host: "127.0.0.1", port: 0 });
  const address = relay.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const root = makeOperatorKey();
  const reg = await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: root.pubB64, label: "root" });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`operator key registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);

  const peerSeeds = new Map<string, Uint8Array>();
  let peerFill = 100;
  async function enrollEndorsedPeer(displayName: string): Promise<Peer> {
    const enrolled = await relay.enrollAgent(displayName);
    const seed = new Uint8Array(32).fill(peerFill++);
    peerSeeds.set(enrolled.agent_id, seed);
    const pubB64 = publicKeyB64urlFromSeed(seed);
    const kid = relay.db.setAgentIdentityKey(enrolled.agent_id, relay.fleetId, pubB64).keyId;
    relay.db.endorseAgentKey(relay.fleetId, enrolled.agent_id, kid, {
      endorsedByKeyId: root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, enrolled.agent_id, kid, pubB64), root.seed)
    });
    const seedHex = Buffer.from(seed).toString("hex");
    const peer: Peer = {
      agent_id: enrolled.agent_id,
      secret: enrolled.secret,
      seedHex,
      pubB64,
      keyId: kid,
      async sendSigned({ to, roomId, text, conversationId }) {
        const recipient = roomId ? { kind: "group", id: roomId } : { kind: "agent", id: to };
        const conv = roomId ?? conversationId ?? `conv-${crypto.randomUUID()}`;
        const signed = buildSignedSendFields({
          identity: { seedHex, pinnedOperatorKeys: {} },
          fleetId: relay.fleetId,
          selfAgentId: enrolled.agent_id,
          recipient,
          conversationId: conv,
          bodyText: text,
          nonce: crypto.randomBytes(16).toString("base64url"),
          sentAt: new Date().toISOString(),
          messageType: "direct",
          priority: "normal",
          attachments: []
        });
        return relay.agentRequest(enrolled.agent_id, enrolled.secret, "POST", "/v1/messages", {
          recipient,
          message_type: "direct",
          priority: "normal",
          body: { text },
          metadata: { ekho_origin: "openclaw-agent" },
          conversation_id: conv,
          correlation_id: `corr-${crypto.randomUUID()}`,
          ...signed
        });
      },
      async sendUnsigned({ to, text }) {
        return relay.agentRequest(enrolled.agent_id, enrolled.secret, "POST", "/v1/messages", {
          recipient: { kind: "agent", id: to },
          message_type: "direct",
          body: { text },
          conversation_id: `conv-${crypto.randomUUID()}`,
          correlation_id: `corr-${crypto.randomUUID()}`
        });
      },
      async inbox() {
        return (await relay.agentRequest(enrolled.agent_id, enrolled.secret, "GET", "/v1/inbox?limit=25")).body;
      }
    };
    return peer;
  }

  return {
    ...relay,
    baseUrl,
    root,
    enrollEndorsedPeer,
    issueToken: () => relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId),
    close: async () => {
      await relay.app.close();
    }
  };
}

export function connectorOptions(relay: LiveRelay, stateDir: string, overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    relayBaseUrl: relay.baseUrl,
    fleetId: relay.fleetId,
    enrollmentToken: relay.issueToken(),
    displayName: "Grok",
    stateDir,
    requireSigned: "warn",
    queueMax: 100,
    pollIntervalSeconds: 3600,
    heartbeatIntervalSeconds: 3600,
    log: QUIET,
    ...overrides
  };
}

/** A connected (enrolled, identity bootstrapped) connector agent. Not started:
 *  tests drive pollOnce() themselves so nothing races. */
export async function connectAgent(relay: LiveRelay, stateDir = tmpDir(), overrides: Partial<AgentOptions> = {}) {
  const agent = new EkhoConnectorAgent(connectorOptions(relay, stateDir, overrides));
  await agent.connect();
  return agent;
}
