// Local message store: a bounded, durable JSON ring the MCP client reads from.
//
// The relay's inbox is destructive (GET /v1/inbox consumes and the connector
// acks the whole batch), so once the connector has taken a message the ONLY
// copy a slow or disconnected MCP client can still get is here. The ring is
// persisted atomically after every mutation and reloaded on start.
//
// Reads are at-least-once through cursors. `takeUnread` hands out a batch under
// a fresh cursor and keeps a deep copy of that batch. The batch is only
// marked read when the client confirms it by passing the cursor back as
// `after` on its next read; until then every plain read returns those
// messages again (plus anything newer), so a response lost on the wire can
// never lose messages. A message, once read, is never handed out again, even
// if a newer unconfirmed batch also carried it. A retry with the cursor itself
// returns exactly the same batch. A bounded number of cursor copies is kept.
//
// The ring never evicts an unread inbound message: past the bound it drops
// delivered and outbound messages oldest first, and the agent stops polling
// the relay while the unread count is at the bound (backpressure), so an
// acked message always has a local copy until the client has seen it.
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
export const CURSOR_CAP = 16;

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

/** One handed-out batch: an immutable copy, so replay is exact even after eviction. */
export interface CursorRecord {
  cursor: string;
  messages: StoredMessage[];
  created_at: string;
  /** True once the client confirmed the batch with `after`; its messages are then read. */
  confirmed: boolean;
}

interface QueueFile {
  v: 1;
  messages: StoredMessage[];
  cursors: CursorRecord[];
  seenNonces: string[];
  seenMessageIds: string[];
  roster: RosterSnapshot[];
  rooms: Array<{ id: string; name: string }>;
  operatorTrusted: boolean;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private cursors: CursorRecord[] = [];
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
      // Cursor records from before the at-least-once change carried ids, not
      // copies; they cannot be replayed exactly, so they are dropped.
      this.cursors = Array.isArray(data.cursors) ? data.cursors.filter((c) => Array.isArray(c?.messages)) : [];
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

  /**
   * Append messages (inbound or our own outbound). Past the bound, delivered
   * inbound and outbound messages are evicted oldest first; an unread inbound
   * message is never evicted. The ring can therefore exceed `max` by the size
   * of one poll while `hasRoom()` is false, which is what stops the next poll.
   */
  add(messages: StoredMessage[]): void {
    if (messages.length === 0) return;
    for (const m of messages) {
      this.messages.push(m);
      if (m.direction === "in") this.markMessageSeen(m.message_id);
    }
    // What was just added is kept even past the bound (an outbound message
    // sent while the unread queue is full stays in the conversation history);
    // it becomes evictable on the next add.
    const added = new Set(messages);
    let excess = this.messages.length - this.max;
    if (excess > 0) {
      this.messages = this.messages.filter((m) => {
        if (excess <= 0 || this.isUnread(m) || added.has(m)) return true;
        excess--;
        return false;
      });
    }
    this.persist();
  }

  /** False while the unread backlog is at the bound: the agent must not poll the relay. */
  hasRoom(): boolean {
    return this.unreadCount() < this.max;
  }

  private isUnread(m: StoredMessage): boolean {
    return m.direction === "in" && m.delivered_cursor === null;
  }

  /**
   * The next batch for the client, oldest first: every inbound message not yet
   * read, up to `limit`. A message handed out in a batch the client has not
   * confirmed is still unread, so it comes back. Passing `after` (the cursor
   * of the batch the client handled) confirms that batch, marks its messages
   * read and leaves them out of this and every later batch, whatever other
   * cursors also carried them. The returned batch is copied under a new
   * cursor so a retry with it is exact.
   */
  takeUnread(limit: number, after?: string): { cursor: string; messages: StoredMessage[] } {
    if (after) this.confirm(after);
    const batch = structuredClone(this.messages.filter((m) => this.isUnread(m)).slice(0, limit));
    const cursor = this.cursorId();
    this.cursors.push({ cursor, messages: structuredClone(batch), created_at: new Date().toISOString(), confirmed: false });
    while (this.cursors.length > CURSOR_CAP) this.cursors.shift();
    this.persist();
    return { cursor, messages: batch };
  }

  /** Mark the batch under `cursor` read. Unknown cursors are ignored. */
  confirm(cursor: string): void {
    const entry = this.cursors.find((c) => c.cursor === cursor);
    if (!entry) return;
    entry.confirmed = true;
    const ids = new Set(entry.messages.map((m) => m.message_id));
    for (const m of this.messages) if (ids.has(m.message_id) && m.delivered_cursor === null) m.delivered_cursor = cursor;
  }

  /** The exact batch a previous read returned, or null for an unknown/aged-out cursor. */
  replay(cursor: string): StoredMessage[] | null {
    const entry = this.cursors.find((c) => c.cursor === cursor);
    return entry ? structuredClone(entry.messages) : null;
  }

  /** Inbound messages the client has not confirmed as read. */
  unreadCount(): number {
    return this.messages.filter((m) => this.isUnread(m)).length;
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
