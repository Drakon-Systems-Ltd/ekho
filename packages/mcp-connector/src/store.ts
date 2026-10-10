// Local message store: a bounded, durable JSON ring the MCP client reads from.
//
// The relay's inbox is destructive (GET /v1/inbox consumes and the connector
// acks the whole batch), so once the connector has taken a message the ONLY
// copy a slow or disconnected MCP client can still get is here. The ring is
// persisted atomically after every mutation and reloaded on start.
//
// Reads are idempotent through cursors: `takeUnread` marks the batch delivered
// under a fresh cursor and remembers exactly which ids it returned, so a client
// that retries the same call with that cursor gets the same batch back instead
// of an empty one (or, worse, the batch being lost). A bounded number of
// cursors is kept.
//
// Replay guards persist too: the nonces of signatures this connector accepted
// (the OpenClaw plugin keeps the same 500-entry FIFO in memory) and the relay
// message ids already stored, so a relay redelivery after a restart cannot
// double-insert.

import path from "node:path";
import { readJsonIfPresent, writeJsonAtomic } from "./files.js";

export const QUEUE_FILE = "queue.json";
/** Same bound the OpenClaw plugin uses for its seen-nonce FIFO. */
export const SEEN_CAP = 500;
export const CURSOR_CAP = 32;

export type VerificationStatus =
  /** Signed and verified against this connector's pinned trust root. */
  | "verified"
  /** Unsigned operator message the relay attests as the fleet operator. */
  | "relay_attested"
  /** No signature at all. */
  | "unsigned"
  /** Signed, but the signature or a binding failed (reason says which). */
  | "failed"
  /** Signed, but this connector holds no pinned operator keys yet. */
  | "unverifiable"
  /** Our own outbound message: signed with this connector's key, but whether
   *  that key is endorsed by the fleet is not checked here. */
  | "self_signed";

export interface StoredAttachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
}

export interface StoredMessage {
  message_id: string;
  conversation_id: string;
  direction: "in" | "out";
  sender_agent_id: string;
  sender_label: string;
  sender_kind: "operator" | "agent";
  message_type: string;
  priority: string;
  text: string;
  attachments: StoredAttachment[];
  mentions: string[];
  reply_to: { message_id: string; sender_label: string; text: string } | null;
  room: { id: string; name: string } | null;
  verification: { status: VerificationStatus; reason: string | null; key_id: string | null };
  sent_at: string;
  stored_at: string;
  /** Cursor of the ekho_inbox read that delivered it; null = unread. */
  delivered_cursor: string | null;
}

export interface RosterSnapshot {
  agent_id: string;
  display_name: string;
  runtime: string;
  status: string;
  /** Whether the relay carries an operator-endorsed identity key for it. */
  endorsed: boolean;
}

interface QueueFile {
  v: 1;
  messages: StoredMessage[];
  cursors: Array<{ cursor: string; ids: string[]; created_at: string }>;
  seenNonces: string[];
  seenMessageIds: string[];
  roster: RosterSnapshot[];
  rooms: Array<{ id: string; name: string }>;
  operatorTrusted: boolean;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private cursors: Array<{ cursor: string; ids: string[]; created_at: string }> = [];
  private seenNonces: string[] = [];
  private seenMessageIds: string[] = [];
  private roster: RosterSnapshot[] = [];
  private rooms: Array<{ id: string; name: string }> = [];
  private operatorTrusted = false;
  private readonly filePath: string;

  constructor(
    stateDir: string,
    private readonly max: number,
    private readonly cursorId: () => string = () => `cur_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  ) {
    this.filePath = path.join(stateDir, QUEUE_FILE);
    const data = readJsonIfPresent<QueueFile>(this.filePath);
    if (data && data.v === 1) {
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.cursors = Array.isArray(data.cursors) ? data.cursors : [];
      this.seenNonces = Array.isArray(data.seenNonces) ? data.seenNonces : [];
      this.seenMessageIds = Array.isArray(data.seenMessageIds) ? data.seenMessageIds : [];
      this.roster = Array.isArray(data.roster) ? data.roster : [];
      this.rooms = Array.isArray(data.rooms) ? data.rooms : [];
      this.operatorTrusted = Boolean(data.operatorTrusted);
    }
  }

  private persist(): void {
    const file: QueueFile = {
      v: 1,
      messages: this.messages,
      cursors: this.cursors,
      seenNonces: this.seenNonces,
      seenMessageIds: this.seenMessageIds,
      roster: this.roster,
      rooms: this.rooms,
      operatorTrusted: this.operatorTrusted
    };
    writeJsonAtomic(this.filePath, file);
  }

  /** Append messages (inbound or our own outbound), evicting the oldest past the bound. */
  add(messages: StoredMessage[]): void {
    if (messages.length === 0) return;
    for (const m of messages) {
      this.messages.push(m);
      if (m.direction === "in") this.markMessageSeen(m.message_id);
    }
    while (this.messages.length > this.max) this.messages.shift();
    this.persist();
  }

  /** Unread inbound messages, oldest first, marked delivered under a new cursor. */
  takeUnread(limit: number): { cursor: string; messages: StoredMessage[] } {
    const batch = this.messages.filter((m) => m.direction === "in" && m.delivered_cursor === null).slice(0, limit);
    const cursor = this.cursorId();
    for (const m of batch) m.delivered_cursor = cursor;
    this.cursors.push({ cursor, ids: batch.map((m) => m.message_id), created_at: new Date().toISOString() });
    while (this.cursors.length > CURSOR_CAP) this.cursors.shift();
    this.persist();
    return { cursor, messages: batch };
  }

  /** The exact batch a previous read returned, or null for an unknown/aged-out cursor. */
  replay(cursor: string): StoredMessage[] | null {
    const entry = this.cursors.find((c) => c.cursor === cursor);
    if (!entry) return null;
    const byId = new Map(this.messages.map((m) => [m.message_id, m] as const));
    return entry.ids.map((id) => byId.get(id)).filter((m): m is StoredMessage => Boolean(m));
  }

  unreadCount(): number {
    return this.messages.filter((m) => m.direction === "in" && m.delivered_cursor === null).length;
  }

  /** Last `limit` messages of one conversation, oldest first, both directions. */
  conversation(conversationId: string, limit: number): StoredMessage[] {
    return this.messages.filter((m) => m.conversation_id === conversationId).slice(-limit);
  }

  size(): number {
    return this.messages.length;
  }

  nonceSeen(nonce: string): boolean {
    return this.seenNonces.includes(nonce);
  }

  markNonceSeen(nonce: string): void {
    if (this.seenNonces.includes(nonce)) return;
    this.seenNonces.push(nonce);
    while (this.seenNonces.length > SEEN_CAP) this.seenNonces.shift();
  }

  /** A live Set view for the SDK verifier (which only reads it). */
  seenNonceSet(): Set<string> {
    return new Set(this.seenNonces);
  }

  messageSeen(messageId: string): boolean {
    return this.seenMessageIds.includes(messageId);
  }

  private markMessageSeen(messageId: string): void {
    if (this.seenMessageIds.includes(messageId)) return;
    this.seenMessageIds.push(messageId);
    while (this.seenMessageIds.length > SEEN_CAP) this.seenMessageIds.shift();
  }

  setFleetView(view: { roster?: RosterSnapshot[]; rooms?: Array<{ id: string; name: string }>; operatorTrusted?: boolean }): void {
    if (view.roster) this.roster = view.roster;
    if (view.rooms) {
      // Rooms only arrive with the batches that mention them; merge, never replace.
      const byId = new Map(this.rooms.map((r) => [r.id, r] as const));
      for (const r of view.rooms) byId.set(r.id, r);
      this.rooms = [...byId.values()];
    }
    if (view.operatorTrusted !== undefined) this.operatorTrusted = view.operatorTrusted;
    this.persist();
  }

  getRoster(): RosterSnapshot[] {
    return [...this.roster];
  }

  getRooms(): Array<{ id: string; name: string }> {
    return [...this.rooms];
  }

  isOperatorTrusted(): boolean {
    return this.operatorTrusted;
  }

  /** Persist the replay guards (called after a poll burned nonces). */
  flush(): void {
    this.persist();
  }
}
