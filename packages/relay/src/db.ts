import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { schemaSql } from "./schema";
import { writeAttachmentBytes } from "./attachments";
import { addSeconds, hashSecret, id, nowIso } from "./utils";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class EkhoDb {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(schemaSql);
    this.runMigrations();
  }

  private runMigrations() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version)
    );
    const migrationsDir = path.join(__dirname, "..", "migrations");
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const version = parseInt(file.split("_")[0], 10);
      if (!Number.isFinite(version) || applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      try {
        this.db.exec(sql);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("duplicate column")) {
          // For ALTER TABLE migrations on existing DBs, run statements individually
          const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
          for (const stmt of statements) {
            try { this.db.exec(stmt); } catch (e: unknown) {
              const m = e instanceof Error ? e.message : String(e);
              if (!m.includes("duplicate column") && !m.includes("already exists")) throw e;
            }
          }
        } else {
          throw err;
        }
      }
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, nowIso());
    }
  }

  raw() {
    return this.db;
  }

  private escapeLike(value: string) {
    return value.replace(/[%_\\]/g, "\\$&");
  }

  private buildLikeSearch(value?: string) {
    if (!value?.trim()) {
      return undefined;
    }
    return `%${this.escapeLike(value.trim().toLowerCase())}%`;
  }

  private normalizeDateStart(value?: string) {
    if (!value?.trim()) {
      return undefined;
    }
    return `${value.trim()}T00:00:00.000Z`;
  }

  private normalizeDateEnd(value?: string) {
    if (!value?.trim()) {
      return undefined;
    }
    return `${value.trim()}T23:59:59.999Z`;
  }

  createBootstrap(fleetName: string, email: string, password: string) {
    const fleetId = id("flt");
    const operatorId = id("opr");
    const now = nowIso();

    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO fleets (id, name, created_at) VALUES (?, ?, ?)").run(fleetId, fleetName, now);
      this.db.prepare(
        "INSERT INTO operators (id, fleet_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(operatorId, fleetId, email, hashSecret(password), "owner", now);
    });

    tx();
    return { fleetId, operatorId };
  }

  findFleetByName(name: string) {
    return this.db.prepare("SELECT * FROM fleets WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  }

  authenticateOperator(fleetName: string, email: string, password: string) {
    const row = this.db.prepare(
      `SELECT operators.*, fleets.name AS fleet_name
       FROM operators
       JOIN fleets ON fleets.id = operators.fleet_id
       WHERE fleets.name = ? AND operators.email = ?`
    ).get(fleetName, email) as Record<string, unknown> | undefined;

    if (!row || row.password_hash !== hashSecret(password)) {
      return null;
    }

    return row;
  }

  issueEnrollmentToken(fleetId: string, operatorId: string) {
    const tokenId = id("ent");
    const token = `${tokenId}.${id("tok")}`;
    this.db.prepare(
      "INSERT INTO enrollment_tokens (id, fleet_id, token_hash, issued_by_operator_id, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run(tokenId, fleetId, hashSecret(token), operatorId, addSeconds(nowIso(), 3600));
    return token;
  }

  consumeEnrollmentToken(token: string, fleetId: string) {
    const row = this.db.prepare(
      "SELECT * FROM enrollment_tokens WHERE token_hash = ? AND fleet_id = ? AND used_at IS NULL AND expires_at > ?"
    ).get(hashSecret(token), fleetId, nowIso()) as Record<string, unknown> | undefined;
    return row;
  }

  createAgentFromEnrollment(input: {
    fleetId: string;
    tokenId: string;
    displayName: string;
    runtime: string;
    hostname?: string;
  }) {
    const agentId = `agent_${id("agt").slice(-12)}`;
    const secret = `${id("secret")}${id("secret")}`;
    const now = nowIso();

    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO agents (id, fleet_id, display_name, runtime, status, hostname, policy_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(agentId, input.fleetId, input.displayName, input.runtime, "healthy", input.hostname ?? null, "default", now);

      this.db.prepare(
        "INSERT INTO agent_credentials (id, agent_id, secret_hash, status, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id("cred"), agentId, hashSecret(secret), "active", now);

      this.db.prepare("UPDATE enrollment_tokens SET used_at = ?, used_by_agent_id = ? WHERE id = ?").run(now, agentId, input.tokenId);
    });

    tx();
    return { agentId, secret };
  }

  authenticateAgent(agentId: string, secret: string) {
    return this.db.prepare(
      `SELECT agents.*, agent_credentials.secret_hash
       FROM agents
       JOIN agent_credentials ON agent_credentials.agent_id = agents.id
       WHERE agents.id = ?
         AND agent_credentials.status = 'active'
         AND agents.revoked_at IS NULL
       ORDER BY agent_credentials.created_at DESC
       LIMIT 1`
    ).get(agentId) as Record<string, unknown> | undefined;
  }

  rememberNonce(agentId: string, nonce: string) {
    this.db.prepare("INSERT INTO replay_nonces (id, agent_id, nonce, created_at) VALUES (?, ?, ?, ?)").run(id("rpl"), agentId, nonce, nowIso());
  }

  findNonce(agentId: string, nonce: string) {
    return this.db.prepare("SELECT id FROM replay_nonces WHERE agent_id = ? AND nonce = ?").get(agentId, nonce);
  }

  /**
   * Prune replay nonces older than twice the timestamp-skew window. A request
   * whose timestamp is outside the skew window is rejected before its nonce is
   * ever checked, so older nonces can never enable a replay — keeping them only
   * grows the table unbounded. Returns the number of rows deleted.
   */
  sweepStaleNonces(): number {
    const cutoff = new Date(Date.now() - config.timestampSkewSeconds * 2 * 1000).toISOString();
    return this.db.prepare("DELETE FROM replay_nonces WHERE created_at < ?").run(cutoff).changes;
  }

  /**
   * Active recipients for a broadcast: every non-revoked agent in the fleet
   * except the sender and the synthetic operator identity (runtime='operator',
   * which can send but never receives). Returns agent ids only.
   */
  private broadcastRecipientIds(fleetId: string, senderAgentId: string): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM agents
       WHERE fleet_id = ?
         AND runtime != 'operator'
         AND revoked_at IS NULL
         AND id != ?`
    ).all(fleetId, senderAgentId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * If conversationId is a room in this fleet, return its member agent ids
   * (minus the sender, excluding the synthetic operator + revoked agents).
   * Otherwise null. This is what makes a room a shared space: any message
   * whose conversation_id is the room fans out to every member.
   *
   * ``requireSenderMembership`` (true for agent sends) prevents an IDOR: a
   * non-member agent that learns/guesses a room id can NOT fan a message into
   * that room — it falls through to normal delivery. The operator is the rooms'
   * owner, so its sends pass false.
   */
  private roomMemberIds(
    fleetId: string,
    conversationId: string,
    senderAgentId: string,
    requireSenderMembership: boolean
  ): string[] | null {
    const room = this.db.prepare("SELECT id FROM rooms WHERE id = ? AND fleet_id = ?").get(conversationId, fleetId);
    if (!room) return null;
    if (requireSenderMembership) {
      const isMember = this.db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ?").get(conversationId, senderAgentId);
      if (!isMember) return null; // not a member -> not a room fan-out
    }
    const rows = this.db.prepare(
      `SELECT rm.agent_id AS id FROM room_members rm
       JOIN agents a ON a.id = rm.agent_id
       WHERE rm.room_id = ?
         AND a.runtime != 'operator'
         AND a.revoked_at IS NULL
         AND rm.agent_id != ?`
    ).all(conversationId, senderAgentId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  createMessage(input: {
    fleetId: string;
    senderAgentId: string;
    recipientKind: string;
    recipientId?: string;
    messageType: string;
    priority: string;
    ttlSeconds: number;
    requiresApproval: boolean;
    body: JsonValue;
    metadata?: JsonValue;
    conversationId: string;
    correlationId: string;
  }) {
    const messageId = id("msg");
    const createdAt = nowIso();
    const expiresAt = addSeconds(createdAt, input.ttlSeconds);

    // Attachment binding rides inside the (HMAC-signed) body as body.attachments.
    // Validate the count cap and that every id belongs to the sender's fleet AND
    // was uploaded by this sender — the authoritative anti-smuggling check.
    const attachmentIds = Array.isArray((input.body as Record<string, unknown> | undefined)?.attachments)
      ? ((input.body as Record<string, unknown>).attachments as unknown[]).map(String)
      : [];
    if (attachmentIds.length > config.attachmentMaxPerMessage) {
      throw new Error(`too many attachments (max ${config.attachmentMaxPerMessage})`);
    }
    if (!this.validateAttachmentOwnership(input.fleetId, input.senderAgentId, attachmentIds)) {
      throw new Error("attachment not found in fleet or not owned by sender");
    }

    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO messages (
          id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
          message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        input.fleetId,
        input.conversationId,
        input.correlationId,
        input.senderAgentId,
        input.recipientKind,
        input.recipientId ?? null,
        input.messageType,
        input.priority,
        input.requiresApproval ? 1 : 0,
        JSON.stringify(input.body),
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.ttlSeconds,
        createdAt,
        expiresAt,
        "queued"
      );

      const deliveryStmt = this.db.prepare(
        "INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)"
      );
      // A message into a room fans out to its members (minus sender), whatever
      // recipient the sender stated — that's what makes the room shared. The
      // sender must be a member (else a non-member could inject into the room).
      const roomRecipients = this.roomMemberIds(input.fleetId, input.conversationId, input.senderAgentId, true);
      if (roomRecipients !== null) {
        for (const rid of roomRecipients) {
          deliveryStmt.run(id("dly"), messageId, rid, createdAt, "queued");
        }
      } else if (input.recipientKind === "agent" && input.recipientId) {
        deliveryStmt.run(id("dly"), messageId, input.recipientId, createdAt, "queued");
      } else if (input.recipientKind === "broadcast") {
        for (const recipientId of this.broadcastRecipientIds(input.fleetId, input.senderAgentId)) {
          deliveryStmt.run(id("dly"), messageId, recipientId, createdAt, "queued");
        }
      }

      this.recordEvent(input.fleetId, "message.queued", "agent", input.senderAgentId, "message", messageId, input.conversationId, {
        recipient_kind: input.recipientKind,
        recipient_id: input.recipientId ?? null,
        message_type: input.messageType,
        attachments: attachmentIds
      });
    });

    tx();
    return { messageId, createdAt };
  }

  /**
   * Synthetic per-fleet "operator" agent used as the sender identity for
   * operator-originated messages. better-sqlite3 enables foreign_keys by
   * default, so messages.sender_agent_id must reference a real agents row.
   * This agent is marked with runtime='operator' and a revoked credential so
   * it can never authenticate as an agent, and is filtered out of the operator
   * UI (listAgents / getFleetOverview). Idempotent.
   */
  ensureOperatorAgent(fleetId: string): string {
    const operatorAgentId = `op_${fleetId}`;
    const existing = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(operatorAgentId);
    if (existing) return operatorAgentId;
    const now = nowIso();
    this.db.prepare(
      "INSERT INTO agents (id, fleet_id, display_name, runtime, status, policy_profile, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(operatorAgentId, fleetId, "Operator", "operator", "healthy", "default", now, now);
    return operatorAgentId;
  }

  /**
   * Operator-originated send. Mirrors createMessage exactly (same messages +
   * message_deliveries inserts) but stamps the sender as the synthetic operator
   * agent and embeds the message text + a "Operator" sender label in the
   * message.queued event payload, so the conversation timeline can render it as
   * a chat bubble and the recipient agent receives it in its inbox.
   */
  createOperatorMessage(input: {
    fleetId: string;
    operatorId: string;
    recipientId?: string; // "broadcast" allowed; optional when roomId is set
    roomId?: string;
    text: string;
    conversationId?: string;
    attachmentIds?: string[];
  }) {
    const messageId = id("msg");
    const createdAt = nowIso();
    const ttlSeconds = 900;
    const expiresAt = addSeconds(createdAt, ttlSeconds);
    const senderId = this.ensureOperatorAgent(input.fleetId);
    const correlationId = id("cor");

    let conversationId: string;
    let recipientKind: string;
    let recipientId: string | null;
    let messageType: string;
    const roomId = input.roomId?.trim();
    if (roomId) {
      const room = this.db.prepare("SELECT id FROM rooms WHERE id = ? AND fleet_id = ?").get(roomId, input.fleetId);
      if (!room) throw new Error("room not found");
      // The room IS the conversation; delivery fans out to its members below.
      conversationId = roomId;
      recipientKind = "room";
      recipientId = roomId;
      messageType = "direct";
    } else {
      conversationId = input.conversationId?.trim() || `op-${Date.now()}-${id("conv").slice(-8)}`;
      const isBroadcast = input.recipientId === "broadcast";
      recipientKind = isBroadcast ? "broadcast" : "agent";
      recipientId = isBroadcast ? null : input.recipientId ?? null;
      messageType = isBroadcast ? "broadcast" : "direct";
    }

    // Validate operator-owned attachments before binding them into the body.
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > config.attachmentMaxPerMessage) {
      throw new Error(`too many attachments (max ${config.attachmentMaxPerMessage})`);
    }
    if (!this.validateAttachmentOwnership(input.fleetId, input.operatorId, attachmentIds)) {
      throw new Error("attachment not found in fleet or not owned by operator");
    }
    const body: Record<string, unknown> = { text: input.text };
    if (attachmentIds.length) body.attachments = attachmentIds;

    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO messages (
          id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
          message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        input.fleetId,
        conversationId,
        correlationId,
        senderId,
        recipientKind,
        recipientId,
        messageType,
        "normal",
        0,
        JSON.stringify(body),
        JSON.stringify({ sender_label: "Operator", operator_id: input.operatorId }),
        ttlSeconds,
        createdAt,
        expiresAt,
        "queued"
      );

      const deliveryStmt = this.db.prepare(
        "INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)"
      );
      // The operator owns the fleet's rooms, so it may post into any of them
      // (it is never a "member"); membership is not required for this path.
      const roomRecipients = this.roomMemberIds(input.fleetId, conversationId, senderId, false);
      if (roomRecipients !== null) {
        for (const rid of roomRecipients) {
          deliveryStmt.run(id("dly"), messageId, rid, createdAt, "queued");
        }
      } else if (recipientKind === "agent" && recipientId) {
        deliveryStmt.run(id("dly"), messageId, recipientId, createdAt, "queued");
      } else if (recipientKind === "broadcast") {
        for (const rid of this.broadcastRecipientIds(input.fleetId, senderId)) {
          deliveryStmt.run(id("dly"), messageId, rid, createdAt, "queued");
        }
      }

      this.recordEvent(input.fleetId, "message.queued", "operator", senderId, "message", messageId, conversationId, {
        recipient_kind: recipientKind,
        recipient_id: recipientId,
        message_type: messageType,
        sender_label: "Operator",
        text: input.text,
        attachments: attachmentIds
      });
    });

    tx();
    return { messageId, conversationId, createdAt };
  }

  /** Create a named room with a set of member agents. Returns the room + members. */
  createRoom(fleetId: string, operatorId: string, name: string, memberAgentIds: string[]) {
    const roomId = id("room");
    const createdAt = nowIso();
    // Only real, non-revoked agents in this fleet can be members.
    const valid = new Set(
      (this.db.prepare(
        "SELECT id FROM agents WHERE fleet_id = ? AND runtime != 'operator' AND revoked_at IS NULL"
      ).all(fleetId) as Array<{ id: string }>).map((r) => r.id)
    );
    const members = [...new Set(memberAgentIds)].filter((m) => valid.has(m));
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO rooms (id, fleet_id, name, created_at, created_by_operator_id) VALUES (?, ?, ?, ?, ?)"
      ).run(roomId, fleetId, name, createdAt, operatorId);
      const memberStmt = this.db.prepare("INSERT OR IGNORE INTO room_members (room_id, agent_id) VALUES (?, ?)");
      for (const m of members) memberStmt.run(roomId, m);
      this.recordEvent(fleetId, "room.created", "operator", operatorId, "room", roomId, roomId, { name, members });
    });
    tx();
    return { id: roomId, name, created_at: createdAt, members };
  }

  /** List a fleet's rooms with their members (id + display name). */
  listRooms(fleetId: string) {
    const rooms = this.db.prepare(
      "SELECT id, name, created_at FROM rooms WHERE fleet_id = ? ORDER BY created_at DESC"
    ).all(fleetId) as Array<{ id: string; name: string; created_at: string }>;
    const memberStmt = this.db.prepare(
      `SELECT rm.agent_id, a.display_name, a.status FROM room_members rm
       JOIN agents a ON a.id = rm.agent_id
       WHERE rm.room_id = ? AND a.revoked_at IS NULL
       ORDER BY a.display_name`
    );
    return rooms.map((room) => ({
      ...room,
      members: memberStmt.all(room.id) as Array<{ agent_id: string; display_name: string; status: string }>
    }));
  }

  /** Delete a room (and its membership). Returns false if it doesn't exist. */
  deleteRoom(fleetId: string, roomId: string, operatorId: string): boolean {
    const room = this.db.prepare("SELECT id FROM rooms WHERE id = ? AND fleet_id = ?").get(roomId, fleetId);
    if (!room) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM room_members WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM rooms WHERE id = ? AND fleet_id = ?").run(roomId, fleetId);
      this.recordEvent(fleetId, "room.deleted", "operator", operatorId, "room", roomId, roomId, {});
    });
    tx();
    return true;
  }

  getInbox(agentId: string, limit: number) {
    const now = nowIso();
    const deliveries = this.db.prepare(
      `SELECT messages.*, message_deliveries.id AS delivery_id, message_deliveries.queued_at
       FROM message_deliveries
       JOIN messages ON messages.id = message_deliveries.message_id
       WHERE message_deliveries.recipient_agent_id = ?
         AND message_deliveries.status = 'queued'
         AND messages.expires_at > ?
         AND (message_deliveries.next_retry_at IS NULL OR message_deliveries.next_retry_at <= ?)
       ORDER BY message_deliveries.queued_at ASC
       LIMIT ?`
    ).all(agentId, now, now, limit) as Array<Record<string, unknown>>;

    const update = this.db.prepare("UPDATE message_deliveries SET status = 'delivered', delivered_at = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ?");
    const eventStmt = this.db.prepare(
      "INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const deliveredAt = nowIso();
    const tx = this.db.transaction(() => {
      for (const row of deliveries) {
        update.run(deliveredAt, row.delivery_id);
        eventStmt.run(
          id("evt"),
          row.fleet_id,
          "message.delivered",
          "agent",
          agentId,
          "message",
          row.id,
          row.conversation_id,
          JSON.stringify({ delivery_id: row.delivery_id }),
          deliveredAt
        );
      }
    });
    tx();

    const controls = this.db.prepare(
      "SELECT * FROM control_actions WHERE target_kind = 'agent' AND target_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC"
    ).all(agentId, nowIso()) as Array<Record<string, unknown>>;

    // The polling agent's own trust flag + fleet — drives operator_trusted and
    // scopes the teammate roster. An unknown agent id yields untrusted + empty.
    const self = this.db.prepare(
      "SELECT fleet_id, operator_trusted, peer_autoreply, peer_turn_budget FROM agents WHERE id = ?"
    ).get(agentId) as Record<string, unknown> | undefined;
    const fleetId = self ? String(self.fleet_id) : null;
    const operatorTrusted = Boolean(self?.operator_trusted);
    const peerAutoreply = Boolean(self?.peer_autoreply);
    const peerTurnBudget = Number(self?.peer_turn_budget) || 6;

    // Resolve each distinct sender's runtime so messages can be tagged
    // operator vs agent. The synthetic op_<fleetId> sender has runtime
    // 'operator'; everything else is a peer agent.
    const senderIds = Array.from(new Set(deliveries.map((row) => String(row.sender_agent_id))));
    const senderRuntime = new Map<string, string>();
    if (senderIds.length > 0) {
      const placeholders = senderIds.map(() => "?").join(",");
      const senders = this.db.prepare(
        `SELECT id, runtime FROM agents WHERE id IN (${placeholders})`
      ).all(...senderIds) as Array<Record<string, unknown>>;
      for (const s of senders) senderRuntime.set(String(s.id), String(s.runtime));
    }

    // Lightweight teammate roster: other agents in the same fleet, excluding
    // the synthetic operator identity and self, capped so the inbox stays small.
    const roster = fleetId
      ? (this.db.prepare(
          `SELECT id, display_name, runtime, status
           FROM agents
           WHERE fleet_id = ? AND runtime != 'operator' AND id != ?
           ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
           LIMIT 50`
        ).all(fleetId, agentId) as Array<Record<string, unknown>>).map((row) => ({
          agent_id: row.id,
          display_name: row.display_name,
          runtime: row.runtime,
          status: row.status
        }))
      : [];

    // Parse bodies once, collect every attachment id across the batch, and
    // resolve their metadata in a single fleet-scoped query (O(1) queries like
    // the sender-runtime resolution above). Metadata only — never bytes.
    const parsedBodies = deliveries.map((row) => JSON.parse(String(row.body_json)) as Record<string, unknown>);
    const allAttachmentIds = Array.from(new Set(
      parsedBodies.flatMap((body) => Array.isArray(body.attachments) ? (body.attachments as unknown[]).map(String) : [])
    ));
    const attachmentMetaById = new Map<string, { id: string; filename: string; mime: string; size_bytes: number }>();
    if (allAttachmentIds.length > 0 && fleetId) {
      for (const meta of this.getAttachmentsMeta(fleetId, allAttachmentIds)) {
        attachmentMetaById.set(meta.id, meta);
      }
    }

    return {
      messages: deliveries.map((row, i) => {
        const body = parsedBodies[i];
        const attIds = Array.isArray(body.attachments) ? (body.attachments as unknown[]).map(String) : [];
        const attachments = attIds
          .map((aid) => attachmentMetaById.get(aid))
          .filter((m): m is { id: string; filename: string; mime: string; size_bytes: number } => Boolean(m));
        return {
          message_id: row.id,
          conversation_id: row.conversation_id,
          correlation_id: row.correlation_id,
          sender_agent_id: row.sender_agent_id,
          sender_kind: senderRuntime.get(String(row.sender_agent_id)) === "operator" ? "operator" : "agent",
          message_type: row.message_type,
          priority: row.priority,
          body,
          attachments,   // [{id, filename, mime, size_bytes}] — NEVER bytes
          metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : {},
          created_at: row.created_at,
          deadline_at: row.expires_at
        };
      }),
      controls: controls.map((row) => ({
        control_id: row.id,
        action: row.action,
        reason: row.payload_json ? JSON.parse(String(row.payload_json)).reason ?? "operator control" : "operator control"
      })),
      operator_trusted: operatorTrusted,
      peer_autoreply: peerAutoreply,
      peer_turn_budget: peerTurnBudget,
      roster
    };
  }

  ackMessages(agentId: string, ackRows: Array<{ message_id: string; received_at: string }>) {
    const tx = this.db.transaction(() => {
      for (const ack of ackRows) {
        this.db.prepare(
          "UPDATE message_deliveries SET status = 'acked', acked_at = ? WHERE message_id = ? AND recipient_agent_id = ?"
        ).run(ack.received_at, ack.message_id, agentId);

        this.db.prepare("UPDATE messages SET status = 'acked' WHERE id = ?").run(ack.message_id);

        const message = this.db.prepare("SELECT fleet_id, conversation_id FROM messages WHERE id = ?").get(ack.message_id) as Record<string, unknown> | undefined;
        if (message) {
          this.recordEvent(String(message.fleet_id), "message.acked", "agent", agentId, "message", ack.message_id, String(message.conversation_id), {
            received_at: ack.received_at
          });
        }
      }
    });
    tx();
    return ackRows.length;
  }

  insertHeartbeat(agentId: string, status: string, metrics: JsonValue) {
    const agent = this.db.prepare("SELECT fleet_id, status AS agent_status, quarantine_reason FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      return;
    }
    const receivedAt = nowIso();
    const newStatus = status === "healthy" ? "healthy" : "degraded";
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO heartbeats (id, agent_id, status, metrics_json, received_at) VALUES (?, ?, ?, ?, ?)").run(
        id("hbt"),
        agentId,
        status,
        JSON.stringify(metrics),
        receivedAt
      );

      // Auto-restore from heartbeat-timeout quarantine
      if (agent.agent_status === "quarantined" && agent.quarantine_reason === "heartbeat_timeout") {
        this.db.prepare(
          "UPDATE agents SET status = ?, last_seen_at = ?, consecutive_missed_heartbeats = 0, auto_quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?"
        ).run(newStatus, receivedAt, agentId);
        this.recordEvent(String(agent.fleet_id), "agent.auto_unquarantined", "system", null, "agent", agentId, null, { reason: "heartbeat_resumed" });
      } else {
        this.db.prepare(
          "UPDATE agents SET status = ?, last_seen_at = ?, consecutive_missed_heartbeats = 0 WHERE id = ? AND status NOT IN ('quarantined', 'paused')"
        ).run(newStatus, receivedAt, agentId);
      }

      this.recordEvent(String(agent.fleet_id), "agent.heartbeat", "agent", agentId, "agent", agentId, null, { status, metrics });
    });
    tx();
  }

  proposeAction(input: {
    agentId: string;
    conversationId: string;
    actionType: string;
    summary: string;
    riskLevel: string;
    payload: JsonValue;
  }) {
    const agent = this.db.prepare("SELECT fleet_id, status FROM agents WHERE id = ?").get(input.agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      return { decision: "deny" as const };
    }

    if (agent.status === "paused" || agent.status === "quarantined") {
      return { decision: "deny" as const };
    }

    if (input.riskLevel === "high" || input.riskLevel === "critical") {
      const approvalId = id("apr");
      const requestedAt = nowIso();
      this.db.prepare(
        "INSERT INTO approvals (id, fleet_id, agent_id, conversation_id, action_type, risk_level, summary, payload_json, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(approvalId, agent.fleet_id, input.agentId, input.conversationId, input.actionType, input.riskLevel, input.summary, JSON.stringify(input.payload), "pending", requestedAt);
      this.recordEvent(String(agent.fleet_id), "approval.requested", "agent", input.agentId, "approval", approvalId, input.conversationId, {
        action_type: input.actionType,
        risk_level: input.riskLevel
      });
      return { decision: "pending_approval" as const, approvalId };
    }

    return { decision: "allow" as const };
  }

  completeActionResult(approvalId: string, result: string, output: JsonValue) {
    const approval = this.db.prepare("SELECT fleet_id, conversation_id, agent_id FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown> | undefined;
    if (!approval) {
      return false;
    }

    const resolvedAt = nowIso();
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(result === "executed" ? "executed" : result, resolvedAt, approvalId);
    this.recordEvent(String(approval.fleet_id), "approval.result", "agent", String(approval.agent_id), "approval", approvalId, String(approval.conversation_id ?? ""), {
      result,
      output
    });
    return true;
  }

  getApprovalStatus(approvalId: string) {
    const approval = this.db.prepare(
      "SELECT id, status, action_type, risk_level, summary, requested_at, resolved_at FROM approvals WHERE id = ?"
    ).get(approvalId) as Record<string, unknown> | undefined;
    return approval ?? null;
  }

  approveOrReject(approvalId: string, operatorId: string, status: "approved" | "rejected") {
    const approval = this.db.prepare("SELECT fleet_id, conversation_id FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown> | undefined;
    if (!approval) {
      return false;
    }

    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by_operator_id = ? WHERE id = ?").run(status, nowIso(), operatorId, approvalId);
    this.recordEvent(String(approval.fleet_id), `approval.${status}`, "operator", operatorId, "approval", approvalId, String(approval.conversation_id ?? ""), {});
    return true;
  }

  controlAgent(agentId: string, operatorId: string, action: "pause" | "resume" | "quarantine", payload: JsonValue) {
    const agent = this.db.prepare("SELECT fleet_id FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      return false;
    }

    const nextStatus = action === "pause" ? "paused" : action === "quarantine" ? "quarantined" : "healthy";
    const controlId = id("ctl");
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(controlId, agent.fleet_id, "agent", agentId, action, JSON.stringify(payload), operatorId, now);
      this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(nextStatus, agentId);
      this.recordEvent(String(agent.fleet_id), `agent.${action}`, "operator", operatorId, "agent", agentId, null, payload);
    });
    tx();
    return true;
  }

  /**
   * Toggle the per-agent "operator-trusted channel" flag. When on, the relay
   * tells the agent (via its inbox) that the console operator is its verified
   * principal — a dynamic, centrally-controlled trust signal rather than a
   * static per-machine config change. Returns the new value, or null if the
   * agent is not in this fleet (so the route can 404). Records an audit event.
   */
  setAgentTrust(fleetId: string, agentId: string, operatorId: string, trusted: boolean): boolean | null {
    const agent = this.db.prepare("SELECT id FROM agents WHERE id = ? AND fleet_id = ? AND runtime != 'operator'").get(agentId, fleetId) as Record<string, unknown> | undefined;
    if (!agent) {
      return null;
    }
    this.db.prepare("UPDATE agents SET operator_trusted = ? WHERE id = ? AND fleet_id = ?").run(trusted ? 1 : 0, agentId, fleetId);
    this.recordEvent(fleetId, "agent.trust_changed", "operator", operatorId, "agent", agentId, null, { operator_trusted: trusted });
    return trusted;
  }

  /**
   * Enable/disable bounded agent-to-agent delegation for an agent, optionally
   * setting its per-conversation turn budget. The agent reads both live on its
   * next inbox poll (no restart). Returns the resulting state, or null if the
   * agent is unknown. Mirrors setAgentTrust.
   */
  setPeerAutoreply(
    fleetId: string,
    agentId: string,
    operatorId: string,
    autoreply: boolean,
    budget?: number
  ): { peer_autoreply: boolean; peer_turn_budget: number } | null {
    const agent = this.db.prepare("SELECT id FROM agents WHERE id = ? AND fleet_id = ? AND runtime != 'operator'").get(agentId, fleetId) as Record<string, unknown> | undefined;
    if (!agent) {
      return null;
    }
    if (typeof budget === "number") {
      this.db.prepare("UPDATE agents SET peer_autoreply = ?, peer_turn_budget = ? WHERE id = ? AND fleet_id = ?").run(autoreply ? 1 : 0, budget, agentId, fleetId);
    } else {
      this.db.prepare("UPDATE agents SET peer_autoreply = ? WHERE id = ? AND fleet_id = ?").run(autoreply ? 1 : 0, agentId, fleetId);
    }
    const row = this.db.prepare("SELECT peer_autoreply, peer_turn_budget FROM agents WHERE id = ? AND fleet_id = ?").get(agentId, fleetId) as Record<string, unknown>;
    const result = { peer_autoreply: Boolean(row.peer_autoreply), peer_turn_budget: Number(row.peer_turn_budget) || 6 };
    this.recordEvent(fleetId, "agent.peer_autoreply_changed", "operator", operatorId, "agent", agentId, null, result);
    return result;
  }

  /**
   * Per-agent health board: status + heartbeat freshness, the latest
   * agent-reported metrics (model/provider/quota — whatever the heartbeat
   * carries), current activity, the trust/delegation flags, and relay-derived
   * throughput over the last hour. One pane of glass for the fleet.
   */
  getFleetHealth(fleetId: string) {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const agents = this.db.prepare(
      `SELECT id, display_name, runtime, status, last_seen_at, consecutive_missed_heartbeats,
              operator_trusted, peer_autoreply, peer_turn_budget
       FROM agents WHERE fleet_id = ? AND runtime != 'operator'
       ORDER BY display_name`
    ).all(fleetId) as Array<Record<string, unknown>>;

    const latestHb = this.db.prepare(
      "SELECT metrics_json, received_at FROM heartbeats WHERE agent_id = ? ORDER BY received_at DESC LIMIT 1"
    );
    const sentStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE fleet_id = ? AND sender_agent_id = ? AND created_at >= ?"
    );
    const recvStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM message_deliveries d JOIN messages m ON m.id = d.message_id
       WHERE m.fleet_id = ? AND d.recipient_agent_id = ? AND d.queued_at >= ?`
    );

    return agents.map((a) => {
      const id = String(a.id);
      const hb = latestHb.get(id) as { metrics_json?: string; received_at?: string } | undefined;
      let metrics: Record<string, unknown> = {};
      let activeConversations: string[] = [];
      if (hb?.metrics_json) {
        try {
          const parsed = JSON.parse(hb.metrics_json) as Record<string, unknown>;
          metrics = (parsed.metrics as Record<string, unknown>) ?? {};
          activeConversations = Array.isArray(parsed.active_conversation_ids)
            ? (parsed.active_conversation_ids as string[])
            : [];
        } catch {
          /* malformed heartbeat metrics — show none */
        }
      }
      return {
        id,
        display_name: a.display_name,
        runtime: a.runtime,
        status: a.status,
        last_seen_at: a.last_seen_at ?? null,
        consecutive_missed_heartbeats: Number(a.consecutive_missed_heartbeats) || 0,
        operator_trusted: Boolean(a.operator_trusted),
        peer_autoreply: Boolean(a.peer_autoreply),
        peer_turn_budget: Number(a.peer_turn_budget) || 6,
        last_heartbeat_at: hb?.received_at ?? null,
        metrics,
        active_conversations: activeConversations,
        sent_1h: (sentStmt.get(fleetId, id, since) as { c: number }).c,
        received_1h: (recvStmt.get(fleetId, id, since) as { c: number }).c
      };
    });
  }

  getFleetOverview(fleetId: string) {
    const agents = this.db.prepare(
      "SELECT id, display_name, runtime, status, last_seen_at FROM agents WHERE fleet_id = ? AND runtime != 'operator' ORDER BY created_at DESC LIMIT 10"
    ).all(fleetId) as Array<Record<string, unknown>>;
    const pendingApprovals = this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE fleet_id = ? AND status = 'pending'").get(fleetId) as { count: number };
    const queuedMessages = this.db.prepare(
      "SELECT COUNT(*) AS count FROM message_deliveries JOIN messages ON messages.id = message_deliveries.message_id WHERE message_deliveries.status = 'queued' AND messages.fleet_id = ?"
    ).get(fleetId) as { count: number };
    const deadLetterCount = (this.db.prepare("SELECT COUNT(*) AS count FROM dead_letters WHERE fleet_id = ?").get(fleetId) as { count: number }).count;
    const quarantinedAgentCount = (this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE fleet_id = ? AND status = 'quarantined'").get(fleetId) as { count: number }).count;
    const rateLimitCutoff = new Date(Date.now() - 86400 * 1000).toISOString();
    const rateLimitViolationsLast24h = (this.db.prepare("SELECT COUNT(*) AS count FROM rate_limit_violations WHERE fleet_id = ? AND created_at > ?").get(fleetId, rateLimitCutoff) as { count: number }).count;
    const recentEvents = this.db.prepare(
      "SELECT event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, created_at FROM events WHERE fleet_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(fleetId);
    return {
      agents,
      pendingApprovals: pendingApprovals.count,
      queuedMessages: queuedMessages.count,
      deadLetterCount,
      quarantinedAgentCount,
      rateLimitViolationsLast24h,
      recentEvents
    };
  }

  listDeadLetters(fleetId: string, options: { limit: number; offset: number }) {
    const rows = this.db.prepare(
      `SELECT id, original_message_id, recipient_agent_id, sender_agent_id, conversation_id, message_type, retry_count, failure_reason, dead_lettered_at
       FROM dead_letters WHERE fleet_id = ? ORDER BY dead_lettered_at DESC LIMIT ? OFFSET ?`
    ).all(fleetId, options.limit, options.offset);
    const totalRow = this.db.prepare("SELECT COUNT(*) AS count FROM dead_letters WHERE fleet_id = ?").get(fleetId) as { count: number };
    return { items: rows, total: totalRow.count };
  }

  getDeadLetterDetail(fleetId: string, deadLetterId: string) {
    return this.db.prepare(
      "SELECT * FROM dead_letters WHERE id = ? AND fleet_id = ?"
    ).get(deadLetterId, fleetId) as Record<string, unknown> | undefined ?? null;
  }

  getAgentRateLimitHistory(fleetId: string, agentId: string) {
    return this.db.prepare(
      "SELECT id, window_start, message_count, limit_value, created_at FROM rate_limit_violations WHERE fleet_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(fleetId, agentId);
  }

  listAgents(fleetId: string, options: { search?: string; status?: string; sortBy?: string; sortOrder?: string; limit: number; offset: number }) {
    const search = this.buildLikeSearch(options.search);
    const status = options.status && options.status !== "all" ? options.status : undefined;
    const sortable: Record<string, string> = {
      display_name: "display_name",
      status: "status",
      last_seen_at: "last_seen_at",
      created_at: "created_at"
    };
    const sortBy = sortable[options.sortBy ?? "created_at"] ?? "created_at";
    const sortOrder = options.sortOrder === "asc" ? "ASC" : "DESC";

    const where = [
      "fleet_id = ?",
      "runtime != 'operator'",
      status ? "status = ?" : "",
      search ? "(LOWER(display_name) LIKE ? ESCAPE '\\' OR LOWER(id) LIKE ? ESCAPE '\\' OR LOWER(runtime) LIKE ? ESCAPE '\\')" : ""
    ].filter(Boolean).join(" AND ");

    const params: Array<string | number> = [fleetId];
    if (status) params.push(status);
    if (search) params.push(search, search, search);

    const rows = (this.db.prepare(
      `SELECT id, display_name, runtime, status, last_seen_at, operator_trusted, peer_autoreply, peer_turn_budget
       FROM agents
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`
    ).all(...params, options.limit, options.offset) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      operator_trusted: Boolean(row.operator_trusted),
      peer_autoreply: Boolean(row.peer_autoreply),
      peer_turn_budget: Number(row.peer_turn_budget) || 6
    }));

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM agents
       WHERE ${where}`
    ).get(...params) as { count: number };

    return { items: rows, total: totalRow.count };
  }

  listPendingApprovals(fleetId: string, options: { search?: string; risk?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortOrder?: string; limit: number; offset: number }) {
    const search = this.buildLikeSearch(options.search);
    const risk = options.risk && options.risk !== "all" ? options.risk : undefined;
    const dateFrom = this.normalizeDateStart(options.dateFrom);
    const dateTo = this.normalizeDateEnd(options.dateTo);
    const sortable: Record<string, string> = {
      requested_at: "approvals.requested_at",
      risk_level: "approvals.risk_level",
      summary: "approvals.summary"
    };
    const sortBy = sortable[options.sortBy ?? "requested_at"] ?? "approvals.requested_at";
    const sortOrder = options.sortOrder === "asc" ? "ASC" : "DESC";
    const where = [
      "approvals.fleet_id = ?",
      "approvals.status = 'pending'",
      risk ? "approvals.risk_level = ?" : "",
      dateFrom ? "approvals.requested_at >= ?" : "",
      dateTo ? "approvals.requested_at <= ?" : "",
      search
        ? "(LOWER(approvals.summary) LIKE ? ESCAPE '\\' OR LOWER(agents.display_name) LIKE ? ESCAPE '\\' OR LOWER(approvals.agent_id) LIKE ? ESCAPE '\\' OR LOWER(approvals.action_type) LIKE ? ESCAPE '\\')"
        : ""
    ].filter(Boolean).join(" AND ");

    const params: Array<string | number> = [fleetId];
    if (risk) params.push(risk);
    if (dateFrom) params.push(dateFrom);
    if (dateTo) params.push(dateTo);
    if (search) params.push(search, search, search, search);

    const rows = this.db.prepare(
      `SELECT approvals.id, approvals.agent_id, approvals.conversation_id, approvals.action_type, approvals.risk_level,
              approvals.summary, approvals.status, approvals.requested_at, agents.display_name
       FROM approvals
       JOIN agents ON agents.id = approvals.agent_id
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`
    ).all(...params, options.limit, options.offset);

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM approvals
       JOIN agents ON agents.id = approvals.agent_id
       WHERE ${where}`
    ).get(...params) as { count: number };

    return { items: rows, total: totalRow.count };
  }

  listEvents(fleetId: string, options: { search?: string; type?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortOrder?: string; limit: number; offset: number }) {
    const search = this.buildLikeSearch(options.search);
    const type = options.type && options.type !== "all" ? `${options.type}.%` : undefined;
    const dateFrom = this.normalizeDateStart(options.dateFrom);
    const dateTo = this.normalizeDateEnd(options.dateTo);
    const sortable: Record<string, string> = {
      created_at: "created_at",
      event_type: "event_type",
      actor_id: "actor_id",
      resource_kind: "resource_kind"
    };
    const sortBy = sortable[options.sortBy ?? "created_at"] ?? "created_at";
    const sortOrder = options.sortOrder === "asc" ? "ASC" : "DESC";
    const where = [
      "fleet_id = ?",
      type ? "event_type LIKE ?" : "",
      dateFrom ? "created_at >= ?" : "",
      dateTo ? "created_at <= ?" : "",
      search
        ? "(LOWER(event_type) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(actor_id, '')) LIKE ? ESCAPE '\\' OR LOWER(resource_kind) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(resource_id, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(conversation_id, '')) LIKE ? ESCAPE '\\')"
        : ""
    ].filter(Boolean).join(" AND ");

    const params: Array<string | number> = [fleetId];
    if (type) params.push(type);
    if (dateFrom) params.push(dateFrom);
    if (dateTo) params.push(dateTo);
    if (search) params.push(search, search, search, search, search);

    const rows = this.db.prepare(
      `SELECT event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, created_at
       FROM events
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`
    ).all(...params, options.limit, options.offset);

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM events
       WHERE ${where}`
    ).get(...params) as { count: number };

    return { items: rows, total: totalRow.count };
  }

  getAgentDetail(fleetId: string, agentId: string) {
    const agent = this.db.prepare(
      "SELECT id, display_name, runtime, status, hostname, policy_profile, created_at, last_seen_at FROM agents WHERE fleet_id = ? AND id = ?"
    ).get(fleetId, agentId) as Record<string, unknown> | undefined;

    if (!agent) {
      return null;
    }

    const recentEvents = this.db.prepare(
      `SELECT event_type, resource_kind, resource_id, conversation_id, payload_json, created_at
       FROM events
       WHERE fleet_id = ? AND (
         (resource_kind = 'agent' AND resource_id = ?)
         OR actor_id = ?
       )
       ORDER BY created_at DESC
       LIMIT 20`
    ).all(fleetId, agentId, agentId);

    const controls = this.db.prepare(
      `SELECT id, action, payload_json, created_at, expires_at
       FROM control_actions
       WHERE fleet_id = ? AND target_kind = 'agent' AND target_id = ?
       ORDER BY created_at DESC
       LIMIT 10`
    ).all(fleetId, agentId);

    const recentMessages = this.db.prepare(
      `SELECT id, conversation_id, correlation_id, message_type, priority, sender_agent_id, recipient_id, created_at, status
       FROM messages
       WHERE fleet_id = ? AND (sender_agent_id = ? OR recipient_id = ?)
       ORDER BY created_at DESC
       LIMIT 20`
    ).all(fleetId, agentId, agentId);

    return { agent, recentEvents, controls, recentMessages };
  }

  getConversation(fleetId: string, conversationId: string, options?: { search?: string; type?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortOrder?: string; limit?: number; offset?: number }) {
    const search = this.buildLikeSearch(options?.search);
    const type = options?.type && options.type !== "all" ? `${options.type}.%` : undefined;
    const dateFrom = this.normalizeDateStart(options?.dateFrom);
    const dateTo = this.normalizeDateEnd(options?.dateTo);
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const sortable: Record<string, string> = {
      created_at: "created_at",
      event_type: "event_type",
      actor_id: "actor_id",
      resource_kind: "resource_kind"
    };
    const sortBy = sortable[options?.sortBy ?? "created_at"] ?? "created_at";
    const sortOrder = options?.sortOrder === "desc" ? "DESC" : "ASC";
    const where = [
      "fleet_id = ?",
      "conversation_id = ?",
      type ? "event_type LIKE ?" : "",
      dateFrom ? "created_at >= ?" : "",
      dateTo ? "created_at <= ?" : "",
      search
        ? "(LOWER(event_type) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(actor_id, '')) LIKE ? ESCAPE '\\' OR LOWER(resource_kind) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(resource_id, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(payload_json, '')) LIKE ? ESCAPE '\\')"
        : ""
    ].filter(Boolean).join(" AND ");

    const params: Array<string | number> = [fleetId, conversationId];
    if (type) params.push(type);
    if (dateFrom) params.push(dateFrom);
    if (dateTo) params.push(dateTo);
    if (search) params.push(search, search, search, search, search);

    const rows = this.db.prepare(
      `SELECT event_type, actor_kind, actor_id, resource_kind, resource_id, payload_json, created_at
       FROM events
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;

    // Attach the actual message body to message events so the conversation
    // timeline can render agent-sent messages as real chat bubbles (the event
    // payload alone doesn't carry the text for agent sends).
    const messageIds = Array.from(
      new Set(
        rows
          .filter((row) => row.resource_kind === "message" && row.resource_id)
          .map((row) => String(row.resource_id))
      )
    );
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => "?").join(",");
      const bodies = this.db.prepare(
        `SELECT id, body_json, sender_agent_id, recipient_kind, recipient_id FROM messages WHERE id IN (${placeholders})`
      ).all(...messageIds) as Array<Record<string, unknown>>;
      const byId = new Map(bodies.map((row) => [String(row.id), row]));

      // Collect every attachment id referenced by the page's message bodies and
      // resolve their metadata in one fleet-scoped query (one batched call).
      const allAttachmentIds = Array.from(new Set(
        bodies.flatMap((row) => {
          try {
            const body = JSON.parse(String(row.body_json)) as Record<string, unknown>;
            return Array.isArray(body.attachments) ? (body.attachments as unknown[]).map(String) : [];
          } catch {
            return [];
          }
        })
      ));
      const attachmentMetaById = new Map<string, { id: string; filename: string; mime: string; size_bytes: number }>();
      if (allAttachmentIds.length > 0) {
        for (const meta of this.getAttachmentsMeta(fleetId, allAttachmentIds)) {
          attachmentMetaById.set(meta.id, meta);
        }
      }

      for (const row of rows) {
        if (row.resource_kind === "message" && row.resource_id) {
          const message = byId.get(String(row.resource_id));
          if (message) {
            row.message_body_json = message.body_json ?? null;
            row.message_sender_id = message.sender_agent_id ?? null;
            row.message_recipient_kind = message.recipient_kind ?? null;
            row.message_recipient_id = message.recipient_id ?? null;
            // Resolve attachment metadata (never bytes) so App.jsx can render
            // them on the chat bubble.
            try {
              const body = JSON.parse(String(message.body_json)) as Record<string, unknown>;
              const attIds = Array.isArray(body.attachments) ? (body.attachments as unknown[]).map(String) : [];
              const metas = attIds
                .map((aid) => attachmentMetaById.get(aid))
                .filter((m): m is { id: string; filename: string; mime: string; size_bytes: number } => Boolean(m));
              if (metas.length) row.message_attachments = metas;
            } catch {
              // non-JSON body — no attachments to surface
            }
          }
        }
      }
    }

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM events
       WHERE ${where}`
    ).get(...params) as { count: number };

    return { items: rows, total: totalRow.count };
  }

  // --- Policy engine ---

  evaluateMessagePolicies(
    fleetId: string,
    senderAgentId: string,
    recipientId: string | null,
    messageType: string,
    priority: string
  ): { allowed: boolean; deniedByPolicy?: string } {
    const policies = this.db.prepare(
      `SELECT id, name, scope_kind, scope_id, rule_json
       FROM policies
       WHERE fleet_id = ? AND enabled = 1
         AND (scope_kind = 'fleet' OR (scope_kind = 'agent' AND scope_id IN (?, ?)))
       ORDER BY CASE WHEN json_extract(rule_json, '$.action') = 'deny' THEN 0 ELSE 1 END`
    ).all(fleetId, senderAgentId, recipientId ?? "") as Array<Record<string, unknown>>;

    for (const policy of policies) {
      const rule = JSON.parse(String(policy.rule_json)) as {
        action: "allow" | "deny";
        conditions: Record<string, string | string[] | undefined>;
      };

      if (this.matchesPolicyConditions(rule.conditions, senderAgentId, recipientId, messageType, priority)) {
        if (rule.action === "deny") {
          this.recordEvent(fleetId, "message.policy_denied", "system", null, "policy", String(policy.id), null, {
            policy_name: policy.name, sender: senderAgentId, recipient: recipientId, message_type: messageType
          });
          return { allowed: false, deniedByPolicy: String(policy.name) };
        }
        return { allowed: true };
      }
    }

    return { allowed: true };
  }

  private matchesPolicyConditions(
    conditions: Record<string, string | string[] | undefined>,
    senderAgentId: string,
    recipientId: string | null,
    messageType: string,
    priority: string
  ): boolean {
    const checks: Array<[string | undefined | string[], string | null]> = [
      [conditions.sender_agent_id, senderAgentId],
      [conditions.recipient_agent_id, recipientId],
      [conditions.message_type, messageType],
      [conditions.priority, priority]
    ];

    for (const [condition, value] of checks) {
      if (condition === undefined) continue;
      if (value === null) return false;
      const allowed = Array.isArray(condition) ? condition : [condition];
      if (!allowed.includes(value)) return false;
    }

    return true;
  }

  createPolicy(fleetId: string, input: { name: string; scopeKind: string; scopeId?: string; rule: unknown; enabled: boolean }) {
    const policyId = id("pol");
    const now = nowIso();
    this.db.prepare(
      "INSERT INTO policies (id, fleet_id, name, scope_kind, scope_id, rule_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(policyId, fleetId, input.name, input.scopeKind, input.scopeId ?? null, JSON.stringify(input.rule), input.enabled ? 1 : 0, now);
    this.recordEvent(fleetId, "policy.created", "operator", null, "policy", policyId, null, { name: input.name });
    return { policyId };
  }

  listPolicies(fleetId: string) {
    return this.db.prepare(
      "SELECT id, name, scope_kind, scope_id, rule_json, enabled, created_at FROM policies WHERE fleet_id = ? ORDER BY created_at DESC"
    ).all(fleetId) as Array<Record<string, unknown>>;
  }

  updatePolicy(policyId: string, fleetId: string, updates: { name?: string; scopeKind?: string; scopeId?: string | null; rule?: unknown; enabled?: boolean }) {
    const existing = this.db.prepare("SELECT * FROM policies WHERE id = ? AND fleet_id = ?").get(policyId, fleetId);
    if (!existing) return false;

    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.scopeKind !== undefined) { sets.push("scope_kind = ?"); params.push(updates.scopeKind); }
    if (updates.scopeId !== undefined) { sets.push("scope_id = ?"); params.push(updates.scopeId); }
    if (updates.rule !== undefined) { sets.push("rule_json = ?"); params.push(JSON.stringify(updates.rule)); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return true;
    params.push(policyId, fleetId);
    this.db.prepare(`UPDATE policies SET ${sets.join(", ")} WHERE id = ? AND fleet_id = ?`).run(...params);
    this.recordEvent(fleetId, "policy.updated", "operator", null, "policy", policyId, null, { updates: Object.keys(updates) });
    return true;
  }

  deletePolicy(policyId: string, fleetId: string) {
    const result = this.db.prepare("DELETE FROM policies WHERE id = ? AND fleet_id = ?").run(policyId, fleetId);
    if (result.changes > 0) {
      this.recordEvent(fleetId, "policy.deleted", "operator", null, "policy", policyId, null, {});
    }
    return result.changes > 0;
  }

  // --- Sweep: retry, dead-letter, expiry ---

  sweepRetryDeliveries() {
    const now = nowIso();
    const timeoutThreshold = addSeconds(now, -config.deliveryTimeoutSeconds);

    const timedOut = this.db.prepare(
      `SELECT message_deliveries.id AS delivery_id, message_deliveries.retry_count,
              messages.id AS message_id, messages.fleet_id, messages.conversation_id,
              messages.sender_agent_id, messages.message_type, messages.body_json,
              messages.metadata_json, message_deliveries.recipient_agent_id
       FROM message_deliveries
       JOIN messages ON messages.id = message_deliveries.message_id
       WHERE message_deliveries.status = 'delivered'
         AND message_deliveries.delivered_at < ?
         AND messages.expires_at > ?`
    ).all(timeoutThreshold, now) as Array<Record<string, unknown>>;

    if (timedOut.length === 0) return { retried: 0, deadLettered: 0 };

    let retried = 0;
    let deadLettered = 0;

    const tx = this.db.transaction(() => {
      for (const row of timedOut) {
        const retryCount = (row.retry_count as number) + 1;
        if (retryCount > config.maxRetries) {
          this.moveToDeadLetter(row);
          deadLettered++;
        } else {
          const backoffIndex = Math.min(retryCount - 1, config.retryBackoffSeconds.length - 1);
          const nextRetryAt = addSeconds(now, config.retryBackoffSeconds[backoffIndex]);
          this.db.prepare(
            `UPDATE message_deliveries
             SET status = 'queued', delivered_at = NULL, retry_count = ?, next_retry_at = ?, last_failure_reason = 'timeout'
             WHERE id = ? AND status = 'delivered'`
          ).run(retryCount, nextRetryAt, row.delivery_id);

          this.recordEvent(
            String(row.fleet_id), "message.retry_requeued", "system", null,
            "message", String(row.message_id), String(row.conversation_id),
            { delivery_id: row.delivery_id, retry_count: retryCount, next_retry_at: nextRetryAt }
          );
          retried++;
        }
      }
    });
    tx();
    return { retried, deadLettered };
  }

  private moveToDeadLetter(row: Record<string, unknown>) {
    const now = nowIso();
    const dlId = id("dl");

    const result = this.db.prepare(
      "UPDATE message_deliveries SET status = 'dead_lettered' WHERE id = ? AND status = 'delivered'"
    ).run(row.delivery_id);

    if (result.changes === 0) return;

    this.db.prepare(
      `INSERT INTO dead_letters (id, fleet_id, original_message_id, original_delivery_id, recipient_agent_id, sender_agent_id, conversation_id, message_type, body_json, metadata_json, retry_count, failure_reason, dead_lettered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      dlId, row.fleet_id, row.message_id, row.delivery_id,
      row.recipient_agent_id, row.sender_agent_id, row.conversation_id,
      row.message_type, row.body_json, row.metadata_json ?? null,
      row.retry_count, "max_retries_exceeded", now
    );

    this.db.prepare("UPDATE messages SET status = 'dead_lettered' WHERE id = ? AND status NOT IN ('acked')").run(row.message_id);

    this.recordEvent(
      String(row.fleet_id), "message.dead_lettered", "system", null,
      "message", String(row.message_id), String(row.conversation_id),
      { delivery_id: row.delivery_id, retry_count: row.retry_count, dead_letter_id: dlId }
    );
  }

  // --- Rate limiting ---

  checkAndIncrementRateLimit(agentId: string, fleetId: string): { allowed: boolean; current: number; limit: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = new Date(Math.floor(nowSec / config.rateLimitWindowSeconds) * config.rateLimitWindowSeconds * 1000).toISOString();
    const limit = config.rateLimitMaxMessages;

    let current = 0;
    let allowed = true;

    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT OR IGNORE INTO rate_limit_counters (agent_id, window_start, message_count) VALUES (?, ?, 0)"
      ).run(agentId, windowStart);

      const row = this.db.prepare(
        "SELECT message_count FROM rate_limit_counters WHERE agent_id = ? AND window_start = ?"
      ).get(agentId, windowStart) as { message_count: number };

      if (row.message_count >= limit) {
        current = row.message_count;
        allowed = false;
        this.db.prepare(
          "INSERT INTO rate_limit_violations (id, fleet_id, agent_id, window_start, message_count, limit_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(id("rlv"), fleetId, agentId, windowStart, current, limit, nowIso());

        this.recordEvent(fleetId, "agent.rate_limit_exceeded", "agent", agentId, "agent", agentId, null, {
          window_start: windowStart, message_count: current, limit
        });
      } else {
        this.db.prepare(
          "UPDATE rate_limit_counters SET message_count = message_count + 1 WHERE agent_id = ? AND window_start = ?"
        ).run(agentId, windowStart);
        current = row.message_count + 1;
      }
    });
    tx();

    if (!allowed) {
      this.checkRateLimitQuarantine(agentId, fleetId);
    }

    return { allowed, current, limit };
  }

  sweepStaleRateLimitCounters() {
    const cutoff = new Date(Date.now() - config.rateLimitWindowSeconds * 2 * 1000).toISOString();
    this.db.prepare("DELETE FROM rate_limit_counters WHERE window_start < ?").run(cutoff);
  }

  // --- Quarantine automation ---

  sweepHeartbeatLiveness(): number {
    const now = Date.now();
    const agents = this.db.prepare(
      "SELECT id, fleet_id, last_seen_at FROM agents WHERE status IN ('healthy', 'degraded') AND last_seen_at IS NOT NULL"
    ).all() as Array<Record<string, unknown>>;

    let quarantined = 0;
    const tx = this.db.transaction(() => {
      for (const agent of agents) {
        const lastSeen = new Date(String(agent.last_seen_at)).getTime();
        const missed = Math.floor((now - lastSeen) / (config.heartbeatTimeoutSeconds * 1000));

        this.db.prepare("UPDATE agents SET consecutive_missed_heartbeats = ? WHERE id = ?").run(missed, agent.id);

        if (missed >= config.heartbeatLivenessThreshold) {
          this.db.prepare(
            "UPDATE agents SET status = 'quarantined', auto_quarantined_at = ?, quarantine_reason = 'heartbeat_timeout', consecutive_missed_heartbeats = ? WHERE id = ?"
          ).run(nowIso(), missed, agent.id);

          this.db.prepare(
            "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(id("ctl"), agent.fleet_id, "agent", agent.id, "quarantine", JSON.stringify({ reason: "heartbeat_timeout", missed_count: missed }), "system", nowIso());

          this.recordEvent(
            String(agent.fleet_id), "agent.auto_quarantined", "system", null,
            "agent", String(agent.id), null,
            { reason: "heartbeat_timeout", missed_count: missed }
          );
          quarantined++;
        }
      }
    });
    tx();
    return quarantined;
  }

  checkRateLimitQuarantine(agentId: string, fleetId: string) {
    const cutoff = new Date(Date.now() - config.rateLimitViolationWindowSeconds * 1000).toISOString();
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_violations WHERE agent_id = ? AND created_at > ?"
    ).get(agentId, cutoff) as { count: number };

    if (row.count >= config.rateLimitViolationThreshold) {
      const now = nowIso();
      this.db.prepare(
        "UPDATE agents SET status = 'quarantined', auto_quarantined_at = ?, quarantine_reason = 'rate_limit_abuse' WHERE id = ? AND status NOT IN ('quarantined', 'paused')"
      ).run(now, agentId);

      this.db.prepare(
        "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id("ctl"), fleetId, "agent", agentId, "quarantine", JSON.stringify({ reason: "rate_limit_abuse", violation_count: row.count }), "system", now);

      this.recordEvent(fleetId, "agent.auto_quarantined", "system", null, "agent", agentId, null, {
        reason: "rate_limit_abuse", violation_count: row.count
      });
    }
  }

  sweepExpiredMessages() {
    const now = nowIso();

    const expired = this.db.prepare(
      `SELECT message_deliveries.id AS delivery_id, messages.id AS message_id,
              messages.fleet_id, messages.conversation_id
       FROM message_deliveries
       JOIN messages ON messages.id = message_deliveries.message_id
       WHERE message_deliveries.status IN ('queued', 'delivered')
         AND messages.expires_at <= ?`
    ).all(now) as Array<Record<string, unknown>>;

    if (expired.length === 0) return 0;

    const tx = this.db.transaction(() => {
      for (const row of expired) {
        this.db.prepare("UPDATE message_deliveries SET status = 'expired' WHERE id = ?").run(row.delivery_id);
        this.db.prepare("UPDATE messages SET status = 'expired' WHERE id = ? AND status NOT IN ('acked', 'dead_lettered')").run(row.message_id);
        this.recordEvent(
          String(row.fleet_id), "message.expired", "system", null,
          "message", String(row.message_id), String(row.conversation_id), {}
        );
      }
    });
    tx();
    return expired.length;
  }

  // --- Attachments ---

  createAttachment(input: {
    fleetId: string;
    uploaderKind: "operator" | "agent";
    uploaderId: string;
    filename: string;     // already sanitized by the route
    mime: string;         // already allowlist-checked by the route
    bytes: Buffer;        // already decoded + size/sniff-validated by the route
  }): { id: string; filename: string; mime: string; size_bytes: number; created_at: string } {
    const attachmentId = id("att");
    const createdAt = nowIso();
    const storagePath = writeAttachmentBytes(input.fleetId, attachmentId, input.bytes);
    this.db.prepare(
      `INSERT INTO attachments (id, fleet_id, uploader_kind, uploader_id, filename, mime, size_bytes, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(attachmentId, input.fleetId, input.uploaderKind, input.uploaderId, input.filename, input.mime, input.bytes.length, storagePath, createdAt);
    this.recordEvent(input.fleetId, "attachment.uploaded", input.uploaderKind, input.uploaderId, "attachment", attachmentId, null, {
      filename: input.filename, mime: input.mime, size_bytes: input.bytes.length
    });
    return { id: attachmentId, filename: input.filename, mime: input.mime, size_bytes: input.bytes.length, created_at: createdAt };
  }

  // Returns the row ONLY if it belongs to fleetId. A mismatch returns undefined,
  // which the route maps to 404 (never 403) so cross-fleet existence never leaks.
  getAttachment(fleetId: string, attachmentId: string): {
    id: string; fleet_id: string; filename: string; mime: string;
    size_bytes: number; storage_path: string;
  } | undefined {
    return this.db.prepare(
      "SELECT id, fleet_id, filename, mime, size_bytes, storage_path FROM attachments WHERE id = ? AND fleet_id = ?"
    ).get(attachmentId, fleetId) as {
      id: string; fleet_id: string; filename: string; mime: string;
      size_bytes: number; storage_path: string;
    } | undefined;
  }

  // Metadata for a set of ids, fleet-scoped. Used to surface inbox/conversation
  // attachment metadata. Silently drops ids not in the fleet.
  getAttachmentsMeta(fleetId: string, ids: string[]): Array<{ id: string; filename: string; mime: string; size_bytes: number }> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT id, filename, mime, size_bytes FROM attachments WHERE fleet_id = ? AND id IN (${placeholders})`
    ).all(fleetId, ...ids) as Array<{ id: string; filename: string; mime: string; size_bytes: number }>;
  }

  // Validate that every id belongs to fleetId AND was uploaded by this sender.
  // Returns true only if all ids resolve. Used to bind attachments to a message.
  validateAttachmentOwnership(fleetId: string, uploaderId: string, ids: string[]): boolean {
    if (ids.length === 0) return true;
    const placeholders = ids.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT id) AS count FROM attachments WHERE fleet_id = ? AND uploader_id = ? AND id IN (${placeholders})`
    ).get(fleetId, uploaderId, ...ids) as { count: number };
    return row.count === new Set(ids).size;
  }

  recordEvent(
    fleetId: string,
    eventType: string,
    actorKind: string,
    actorId: string | null,
    resourceKind: string,
    resourceId: string | null,
    conversationId: string | null,
    payload: JsonValue
  ) {
    this.db.prepare(
      "INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id("evt"), fleetId, eventType, actorKind, actorId, resourceKind, resourceId, conversationId, JSON.stringify(payload), nowIso());
  }
}

export const db = new EkhoDb();
