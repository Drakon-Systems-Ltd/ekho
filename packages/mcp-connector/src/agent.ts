// The Ekho side of the connector: one enrolled fleet agent whose inbox, trust
// root and outbound signing follow the OpenClaw plugin's rules exactly (the
// code is the SDK's identity layer, shared with the plugin), and whose local
// store is what the MCP tools read and write.

import crypto from "node:crypto";
import { EkhoAgentClient, type InboxMessage, type InboxResponse } from "@drakon-systems/ekho-sdk";
import {
  IdentityUnavailableError,
  buildSignedSendFields,
  identityPublicKey,
  loadOrCreateIdentity,
  saveIdentity,
  syncPinnedOperatorKeys,
  verifyBatch,
  type EkhoIdentity,
  type OperatorKeyEntryLike,
  type RequireSignedMode,
  type RosterEntryLike,
  type VerifyResult
} from "@drakon-systems/ekho-sdk/identity";
import { credentialsState, enroll, saveCredentials, CredentialsUnavailableError, type StoredCredentials } from "./credentials.js";
import { appendDeadLetters, type DeadLetterRecord } from "./dead-letter.js";
import { MessageStore, type RosterSnapshot, type StoredMessage, type VerificationStatus } from "./store.js";

/** Every send from this connector carries this stamp (the plugin's is
 *  "openclaw-agent", Hermes' its own): peers' loops can tell a machine reply
 *  from an operator one. No origin_session_id: the connector has no host
 *  session to report, and the plugin's rule is honesty over completeness. */
export const EKHO_ORIGIN_STAMP = "ekho-mcp";
export const MAX_SEND_TEXT = 8000;

export interface AgentLogger {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
}

export interface AgentOptions {
  relayBaseUrl: string;
  fleetId?: string;
  enrollmentToken?: string;
  displayName: string;
  stateDir: string;
  requireSigned: RequireSignedMode;
  queueMax: number;
  pollIntervalSeconds?: number;
  heartbeatIntervalSeconds?: number;
  log?: AgentLogger;
  /** Called with the messages newly stored by a poll (the wake-webhook seam). */
  onNewMessages?: (messages: StoredMessage[]) => void;
  fetchImpl?: typeof fetch;
}

export interface SendRequest {
  recipientAgentId?: string;
  roomId?: string;
  broadcast?: boolean;
  text: string;
  replyTo?: string;
  mentions?: string[];
}

export type AgentStatus = "starting" | "connected" | "paused" | "identity_unavailable" | "error" | "stopped";

/** Inbox batch fields the SDK type does not (yet) declare but the relay sends. */
interface InboxBatch extends InboxResponse {
  fleet_id?: string | null;
  operator_keys?: OperatorKeyEntryLike[];
  roster?: Array<InboxResponse["roster"] extends Array<infer R> | undefined ? R & RosterEntryLike : never>;
}

type SignedInboxMessage = InboxMessage & {
  agent_sig?: string | null;
  operator_sig?: string | null;
  key_id?: string | null;
  sig_canonical?: Record<string, unknown> | null;
};

export class EkhoConnectorAgent {
  readonly store: MessageStore;
  private client: EkhoAgentClient | null = null;
  private credentials: StoredCredentials | null = null;
  private identity: EkhoIdentity | null = null;
  private status: AgentStatus = "starting";
  private lastError: string | null = null;
  private paused = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private readonly log: AgentLogger;

  constructor(private readonly opts: AgentOptions) {
    this.log = opts.log ?? console;
    this.store = new MessageStore(opts.stateDir, opts.queueMax);
  }

  get agentId(): string | null {
    return this.credentials?.agentId ?? null;
  }

  get fleetId(): string | null {
    return this.credentials?.fleetId ?? this.opts.fleetId ?? null;
  }

  /** Public key of this connector's identity, for the operator to endorse. */
  get identityPublicKeyB64url(): string | null {
    return this.identity ? identityPublicKey(this.identity) : null;
  }

  /**
   * Load or enrol, then bootstrap identity. Order matters: the identity key is
   * minted BEFORE enrolment so it rides in the enrol request, and an
   * already-enrolled connector (credentials on disk) must never mint a new key
   * because its file went missing — that is a lost file, not a new agent.
   */
  async connect(): Promise<void> {
    const stored = credentialsState(this.opts.stateDir);
    if (stored.state === "unusable") {
      throw new CredentialsUnavailableError(
        `saved credentials in ${this.opts.stateDir} are present but unusable; refusing to enrol a new agent over them` +
          (stored.preservedAt ? ` (bytes preserved at ${stored.preservedAt})` : "") +
          `. Restore the file from a backup, or remove it to enrol again on purpose.`
      );
    }
    const enrolled = stored.state === "ok";
    try {
      this.identity = loadOrCreateIdentity(this.opts.stateDir, { allowCreate: !enrolled });
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        this.status = "identity_unavailable";
        this.lastError = err.message;
      }
      throw err;
    }
    let enrolKeys: OperatorKeyEntryLike[] = [];
    if (enrolled) {
      this.credentials = stored.credentials;
    } else {
      if (!this.opts.fleetId || !this.opts.enrollmentToken) {
        throw new Error("not enrolled: set EKHO_FLEET_ID and EKHO_ENROLLMENT_TOKEN for the first start");
      }
      const result = await enroll({
        relayBaseUrl: this.opts.relayBaseUrl,
        fleetId: this.opts.fleetId,
        enrollmentToken: this.opts.enrollmentToken,
        displayName: this.opts.displayName,
        identityPublicKey: identityPublicKey(this.identity),
        fetchImpl: this.opts.fetchImpl
      });
      saveCredentials(this.opts.stateDir, result.credentials);
      this.credentials = result.credentials;
      enrolKeys = result.operatorKeys;
      this.log.info?.(`[ekho-mcp] enrolled as ${result.credentials.agentId}`);
    }
    this.client = new EkhoAgentClient({
      agentId: this.credentials.agentId,
      secret: this.credentials.secret,
      relayBaseUrl: this.credentials.relayBaseUrl,
      pollIntervalSeconds: this.opts.pollIntervalSeconds,
      heartbeatIntervalSeconds: this.opts.heartbeatIntervalSeconds
    });
    // Idempotent on the relay; covers a relay that ignored the enrol-time key.
    try {
      await this.client.registerIdentityKey(identityPublicKey(this.identity));
    } catch (err) {
      this.log.warn?.(`[ekho-mcp] identity-key registration failed: ${String(err)}`);
    }
    // TOFU from the enrol response — fires only for a never-pinned identity.
    if (enrolKeys.length > 0 && syncPinnedOperatorKeys(this.identity, enrolKeys, this.credentials.fleetId, this.log)) {
      saveIdentity(this.opts.stateDir, this.identity);
      this.log.info?.(`[ekho-mcp] pinned ${Object.keys(this.identity.pinnedOperatorKeys).length} operator key(s) from enrolment (TOFU)`);
    }
    this.status = this.paused ? "paused" : "connected";
    this.lastError = null;
  }

  /** Start the background heartbeat + poll loops (after connect()). */
  start(): void {
    if (!this.client) throw new Error("connect() first");
    const client = this.client;
    const beat = async () => {
      try {
        await client.heartbeat({
          status: this.paused ? "degraded" : "healthy",
          metrics: { paused: this.paused, queued: this.store.unreadCount(), runtime: "ekho-mcp" }
        });
        this.lastHeartbeatAt = new Date().toISOString();
      } catch (err) {
        this.log.warn?.(`[ekho-mcp] heartbeat failed: ${String(err)}`);
      }
    };
    void beat();
    this.heartbeatTimer = setInterval(() => void beat(), client.heartbeatIntervalSeconds * 1000);
    this.pollTimer = setInterval(() => void this.pollOnce(), client.pollIntervalSeconds * 1000);
    void this.pollOnce();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = this.heartbeatTimer = null;
    this.status = "stopped";
  }

  health(): { status: AgentStatus; unread: number; stored: number; last_poll_at: string | null; last_heartbeat_at: string | null; pinned_operator_keys: number; error: string | null } {
    return {
      status: this.status,
      unread: this.store.unreadCount(),
      stored: this.store.size(),
      last_poll_at: this.lastPollAt,
      last_heartbeat_at: this.lastHeartbeatAt,
      pinned_operator_keys: Object.keys(this.identity?.pinnedOperatorKeys ?? {}).length,
      error: this.lastError
    };
  }

  /**
   * One inbox poll: sync the trust root, verify every message, store what the
   * mode allows, dead-letter the rest, burn accepted nonces, ack the WHOLE
   * batch (the relay must not redeliver what we have already judged).
   */
  async pollOnce(): Promise<StoredMessage[]> {
    if (!this.client || !this.credentials || this.polling) return [];
    this.polling = true;
    try {
      const batch = (await this.client.getInbox(25)) as InboxBatch;
      this.lastPollAt = new Date().toISOString();
      for (const control of batch.controls ?? []) {
        if (control.action === "pause" || control.action === "quarantine") this.paused = true;
        if (control.action === "resume") this.paused = false;
        this.log.warn?.(`[ekho-mcp] operator control: ${control.action} (${control.reason})`);
      }
      this.status = this.paused ? "paused" : "connected";
      const fleetId = batch.fleet_id ?? this.credentials.fleetId ?? null;
      const stored = this.ingest(batch, fleetId);
      if (batch.messages.length > 0) {
        try {
          await this.client.ackMessages(
            batch.messages.map((m) => ({ message_id: m.message_id, status: "received" as const, received_at: new Date().toISOString() }))
          );
        } catch (err) {
          this.log.warn?.(`[ekho-mcp] ack failed: ${String(err)}`);
        }
      }
      if (stored.length > 0) this.opts.onNewMessages?.(stored);
      return stored;
    } catch (err) {
      this.lastError = String(err);
      this.log.warn?.(`[ekho-mcp] poll failed: ${String(err)}`);
      return [];
    } finally {
      this.polling = false;
    }
  }

  /** Pure part of a poll (no network): trust-root sync, verdicts, store, dead-letter. */
  ingest(batch: InboxBatch, fleetId: string | null): StoredMessage[] {
    const selfId = this.credentials?.agentId ?? "";
    let verdicts: Record<string, VerifyResult | null> = {};
    if (this.identity) {
      try {
        const keys = Array.isArray(batch.operator_keys) ? batch.operator_keys : [];
        if (syncPinnedOperatorKeys(this.identity, keys, fleetId, this.log)) saveIdentity(this.opts.stateDir, this.identity);
      } catch (err) {
        this.log.warn?.(`[ekho-mcp] operator-key sync failed: ${String(err)}`);
      }
      verdicts = verifyBatch(batch.messages as SignedInboxMessage[], {
        identity: this.identity,
        selfAgentId: selfId,
        fleetId,
        roster: (batch.roster ?? []) as RosterEntryLike[],
        seenNonces: this.store.seenNonceSet(),
        now: new Date()
      });
    }
    const operatorTrusted = Boolean(batch.operator_trusted);
    const roomName = new Map((batch.rooms ?? []).map((r) => [r.id, r.name] as const));
    const labelOf = new Map((batch.roster ?? []).map((r) => [r.agent_id, r.display_name] as const));

    const accepted: StoredMessage[] = [];
    const rejects: DeadLetterRecord[] = [];
    for (const raw of batch.messages as SignedInboxMessage[]) {
      if (!raw || typeof raw.message_id !== "string") continue;
      if (raw.sender_agent_id === selfId) continue; // our own echo
      if (raw.message_type === "heartbeat") continue;
      if (this.store.messageSeen(raw.message_id)) continue; // relay redelivery
      const verdict = verdicts[raw.message_id] ?? null;
      const v = classify(raw, verdict, operatorTrusted);
      const admit =
        this.opts.requireSigned === "require"
          ? v.status === "verified" || v.status === "relay_attested"
          : v.status !== "failed";
      if (!admit) {
        rejects.push({
          rejected_at: new Date().toISOString(),
          reason: v.reason ?? (v.status === "unsigned" ? "unsigned" : v.status),
          kind: raw.sender_kind === "operator" ? "operator" : "peer",
          key_id: v.key_id,
          message: raw
        });
        continue;
      }
      if (verdict?.verified) {
        const nonce = raw.sig_canonical?.nonce;
        if (typeof nonce === "string" && nonce) this.store.markNonceSeen(nonce);
      }
      const text = typeof raw.body?.text === "string" ? raw.body.text : "";
      const sentAt = typeof raw.sig_canonical?.sent_at === "string" ? raw.sig_canonical.sent_at : raw.created_at;
      accepted.push({
        message_id: raw.message_id,
        conversation_id: raw.conversation_id,
        direction: "in",
        sender_agent_id: raw.sender_agent_id,
        sender_label:
          raw.sender_kind === "operator"
            ? String((raw.metadata as Record<string, unknown> | undefined)?.sender_label ?? "Operator")
            : (labelOf.get(raw.sender_agent_id) ?? raw.sender_agent_id),
        sender_kind: raw.sender_kind === "operator" ? "operator" : "agent",
        message_type: raw.message_type,
        priority: raw.priority,
        text,
        attachments: (raw.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size_bytes: a.size_bytes })),
        mentions: Array.isArray(raw.mentions) ? raw.mentions.map(String) : [],
        reply_to: raw.reply_to
          ? { message_id: raw.reply_to.message_id, sender_label: raw.reply_to.sender_label, text: raw.reply_to.text }
          : null,
        room: roomName.has(raw.conversation_id) ? { id: raw.conversation_id, name: roomName.get(raw.conversation_id)! } : null,
        verification: v,
        sent_at: sentAt,
        stored_at: new Date().toISOString(),
        delivered_cursor: null
      });
    }
    if (rejects.length > 0) {
      for (const r of rejects) {
        const m = r.message as SignedInboxMessage;
        this.log.warn?.(
          `[ekho-mcp] verification ${r.reason} for message ${m.message_id} from ${r.kind}/${m.sender_agent_id} key=${r.key_id ?? "?"} — dead-lettered, not shown to the client`
        );
      }
      appendDeadLetters(this.opts.stateDir, rejects);
    }
    this.store.add(accepted);
    this.store.setFleetView({
      roster: (batch.roster ?? []).map(
        (r): RosterSnapshot => ({
          agent_id: r.agent_id,
          display_name: r.display_name,
          runtime: r.runtime,
          status: r.status,
          endorsed: Boolean((r as RosterEntryLike).endorsed_by_key_id && (r as RosterEntryLike).endorsement_sig)
        })
      ),
      rooms: batch.rooms,
      operatorTrusted
    });
    return accepted;
  }

  /** Sign and send; refuses while paused/quarantined by the operator. */
  async send(req: SendRequest): Promise<{ message_id: string; conversation_id: string }> {
    if (!this.client || !this.credentials || !this.identity) throw new Error("not connected");
    if (this.paused) throw new Error("this agent is paused or quarantined by the operator; sends are refused");
    const text = typeof req.text === "string" ? req.text : "";
    if (!text.trim()) throw new Error("text must not be empty");
    if (text.length > MAX_SEND_TEXT) throw new Error(`text exceeds ${MAX_SEND_TEXT} characters`);
    const targets = [req.roomId, req.recipientAgentId, req.broadcast ? "broadcast" : undefined].filter(Boolean).length;
    if (targets !== 1) throw new Error("choose exactly one of recipient_agent_id, room_id or broadcast");

    const recipient: Record<string, unknown> = req.roomId
      ? { kind: "group", id: req.roomId }
      : req.broadcast
        ? { kind: "broadcast" }
        : { kind: "agent", id: req.recipientAgentId };
    const conversationId = req.roomId || `mcp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const metadata: Record<string, unknown> = { ekho_origin: EKHO_ORIGIN_STAMP };
    if (req.mentions && req.mentions.length) metadata.mentions = req.mentions;
    if (req.replyTo) metadata.reply_to_message_id = req.replyTo;
    const sentAt = new Date().toISOString();
    const signed = buildSignedSendFields({
      identity: this.identity,
      fleetId: this.credentials.fleetId,
      selfAgentId: this.credentials.agentId,
      recipient,
      conversationId,
      bodyText: text,
      nonce: crypto.randomBytes(16).toString("base64url"),
      sentAt,
      messageType: "direct",
      priority: "normal",
      attachments: []
    });
    const payload = {
      recipient,
      message_type: "direct" as const,
      priority: "normal" as const,
      body: { text },
      metadata,
      conversation_id: conversationId,
      correlation_id: `mcp-${Date.now().toString(36)}`,
      ...signed
    };
    const result = await this.client.sendMessage(payload as unknown as Parameters<EkhoAgentClient["sendMessage"]>[0]);
    this.store.add([
      {
        message_id: result.message_id,
        conversation_id: conversationId,
        direction: "out",
        sender_agent_id: this.credentials.agentId,
        sender_label: this.opts.displayName,
        sender_kind: "agent",
        message_type: "direct",
        priority: "normal",
        text,
        attachments: [],
        mentions: req.mentions ?? [],
        reply_to: req.replyTo ? { message_id: req.replyTo, sender_label: "", text: "" } : null,
        room: req.roomId ? { id: req.roomId, name: this.store.getRooms().find((r) => r.id === req.roomId)?.name ?? req.roomId } : null,
        verification: { status: "self_signed", reason: null, key_id: signed.key_id },
        sent_at: sentAt,
        stored_at: new Date().toISOString(),
        delivered_cursor: "self"
      }
    ]);
    return { message_id: result.message_id, conversation_id: conversationId };
  }

  async openRoom(name: string, members: string[]): Promise<{ id: string; name: string; members: string[] }> {
    if (!this.client) throw new Error("not connected");
    if (this.paused) throw new Error("this agent is paused or quarantined by the operator");
    const roster = this.store.getRoster();
    const ids = members.map((m) => {
      const byId = roster.find((r) => r.agent_id === m);
      if (byId) return byId.agent_id;
      const byName = roster.filter((r) => r.display_name.toLowerCase() === m.toLowerCase());
      if (byName.length === 1) return byName[0].agent_id;
      if (byName.length > 1) throw new Error(`"${m}" matches ${byName.length} agents; use an agent id`);
      throw new Error(`"${m}" is not an agent id or display name in the roster`);
    });
    const room = await this.client.createRoom({ name, member_agent_ids: ids });
    this.store.setFleetView({ rooms: [{ id: room.id, name: room.name }] });
    return { id: room.id, name: room.name, members: room.members };
  }
}

/** Map a verdict onto the status the client sees. Mirrors the plugin's gate
 *  (shouldAutowake): operator unsigned falls back to the relay-attested
 *  operator_trusted flag, which is operator-set, not relay-implied. */
export function classify(
  msg: SignedInboxMessage,
  verdict: VerifyResult | null,
  operatorTrusted: boolean
): { status: VerificationStatus; reason: string | null; key_id: string | null } {
  const isOperator = msg.sender_kind === "operator";
  const signed = Boolean(isOperator ? msg.operator_sig : msg.agent_sig);
  const keyId = msg.key_id ?? null;
  if (!signed) {
    return isOperator && operatorTrusted
      ? { status: "relay_attested", reason: null, key_id: null }
      : { status: "unsigned", reason: null, key_id: null };
  }
  if (!verdict) return { status: "unverifiable", reason: "no-pinned-operator-keys", key_id: keyId };
  if (verdict.verified) return { status: "verified", reason: null, key_id: verdict.keyId };
  return { status: "failed", reason: verdict.reason, key_id: keyId };
}
