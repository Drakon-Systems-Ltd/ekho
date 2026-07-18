import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { schemaSql } from "./schema";
import { writeAttachmentBytes } from "./attachments";
import { parseFeed, type FeedItem } from "./feeds";
import { addSeconds, hashPassword, hashSecret, id, nowIso, verifyPassword } from "./utils";
import { deriveAgentHealth, buildAttentionItems } from "./fleet-health";
import {
  keyId as deriveKeyId,
  verifyCanonical,
  fromB64url,
  endorsementPayload,
  agentKeyEndorsementPayload,
} from "./operator-identity";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface OperatorKeyRow {
  fleet_id: string;
  key_id: string;
  public_key: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  endorsed_by_key_id: string | null;
  endorsement_sig: string | null;
}

export interface AgentIdentityKeyRow {
  agent_id: string;
  fleet_id: string;
  key_id: string;
  public_key: string;
  created_at: string;
  revoked_at: string | null;
  endorsed_by_key_id: string | null;
  endorsement_sig: string | null;
  endorsed_at: string | null;
}

const IDEMPOTENT_DDL_ERROR = /duplicate column|already exists/i;

// Per-agent peer turn budget applied to new enrollments and used as the read
// fallback. The rolling per-peer rate gate, the per-conversation latch, and the
// stall escalation keep runaway loops bounded even at this size.
export const DEFAULT_PEER_TURN_BUDGET = 25;

// Per-room budget while project mode is ON — high enough for a real working
// session; the operator toggle (default OFF) is the opt-in.
export const DEFAULT_PROJECT_TURN_BUDGET = 100;

/** Split a migration file into individual statements. A naive ';' split is safe
 *  here: every migration is pure DDL with no ';' inside a string literal
 *  (verified across migrations/001..015). */
function splitStatements(sql: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}

/**
 * Apply one migration file's SQL and record its version ATOMICALLY, inside a
 * single transaction. Each statement runs in a nested transaction (SAVEPOINT);
 * a "duplicate column"/"already exists" error is swallowed per-statement so a
 * fresh DB (whose schema.ts already created the column) or a legacy partially-
 * applied DB does not abort — but the surviving statements AND the version row
 * still commit together. Any OTHER error propagates, rolling the ENTIRE
 * migration (every statement + the version insert) back to nothing. This is the
 * fix: it is impossible to record a version without the DDL committing, or to
 * commit partial DDL without recording the version.
 */
export function applyMigration(rawDb: Database.Database, version: number, sql: string, appliedAt: string): void {
  const apply = rawDb.transaction(() => {
    for (const stmt of splitStatements(sql)) {
      try {
        const savepoint = rawDb.transaction(() => rawDb.exec(stmt));
        savepoint();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!IDEMPOTENT_DDL_ERROR.test(msg)) throw err; // real error → roll the whole migration back
        // else: column/table already exists — savepoint rolled back this one
        // statement only; the outer transaction continues.
      }
    }
    rawDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, appliedAt);
  });
  apply();
}

/** Ensure schema_migrations exists, then apply each unapplied migrations/NNN_*.sql
 *  file transactionally in version order. Idempotent: already-applied versions
 *  are skipped. NOTE: a future migration needing PRAGMA foreign_keys=OFF for a
 *  table rebuild can't run inside a transaction (SQLite forbids it) and would
 *  need bespoke handling — none of 001..015 do this. */
export function runMigrationsOn(rawDb: Database.Database, migrationsDir: string): void {
  rawDb.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (rawDb.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version)
  );
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = parseInt(file.split("_")[0], 10);
    if (!Number.isFinite(version) || applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    applyMigration(rawDb, version, sql, nowIso());
  }
}

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
    runMigrationsOn(this.db, path.join(__dirname, "..", "migrations"));
  }

  raw() {
    return this.db;
  }

  // ---- Operator signing keys (verifiable operator identity) ----------------

  /**
   * Register an operator public key for a fleet. Returns its derived key_id.
   * If an endorsement is supplied it must be a valid signature by an existing,
   * non-revoked key over endorsementPayload(...) — an early reject so the
   * Security screen surfaces a bad endorsement immediately (agents re-verify).
   */
  registerOperatorKey(
    fleetId: string,
    publicKeyB64url: string,
    label: string,
    endorsement?: { endorsedByKeyId: string; signature: string }
  ): { keyId: string } {
    const kid = deriveKeyId(fromB64url(publicKeyB64url));
    if (endorsement) {
      const endorser = this.db
        .prepare(
          "SELECT public_key FROM fleet_operator_keys WHERE fleet_id = ? AND key_id = ? AND revoked_at IS NULL"
        )
        .get(fleetId, endorsement.endorsedByKeyId) as { public_key: string } | undefined;
      if (!endorser) throw new Error("endorsement references an unknown or revoked key");
      const ok = verifyCanonical(
        endorsementPayload(fleetId, kid, publicKeyB64url),
        endorsement.signature,
        fromB64url(endorser.public_key)
      );
      if (!ok) throw new Error("invalid key endorsement signature");
    }
    const exists = this.db
      .prepare("SELECT 1 FROM fleet_operator_keys WHERE fleet_id = ? AND key_id = ?")
      .get(fleetId, kid);
    if (exists) throw new Error("operator key already registered");
    this.db
      .prepare(
        `INSERT INTO fleet_operator_keys
           (fleet_id, key_id, public_key, label, created_at, endorsed_by_key_id, endorsement_sig)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fleetId,
        kid,
        publicKeyB64url,
        label,
        nowIso(),
        endorsement?.endorsedByKeyId ?? null,
        endorsement?.signature ?? null
      );
    return { keyId: kid };
  }

  listOperatorKeys(fleetId: string): OperatorKeyRow[] {
    return this.db
      .prepare(
        `SELECT fleet_id, key_id, public_key, label, created_at, last_used_at, revoked_at,
                endorsed_by_key_id, endorsement_sig
           FROM fleet_operator_keys WHERE fleet_id = ? ORDER BY created_at ASC`
      )
      .all(fleetId) as OperatorKeyRow[];
  }

  getActiveOperatorKeys(fleetId: string): OperatorKeyRow[] {
    return this.db
      .prepare(
        `SELECT fleet_id, key_id, public_key, label, created_at, last_used_at, revoked_at,
                endorsed_by_key_id, endorsement_sig
           FROM fleet_operator_keys WHERE fleet_id = ? AND revoked_at IS NULL ORDER BY created_at ASC`
      )
      .all(fleetId) as OperatorKeyRow[];
  }

  revokeOperatorKey(fleetId: string, targetKeyId: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE fleet_operator_keys SET revoked_at = ? WHERE fleet_id = ? AND key_id = ? AND revoked_at IS NULL"
      )
      .run(nowIso(), fleetId, targetKeyId);
    return res.changes > 0;
  }

  // ---- Agent identity keys (agent-to-agent trust) --------------------------

  /** Register an agent's own Ed25519 identity public key (unendorsed at first). */
  setAgentIdentityKey(agentId: string, fleetId: string, publicKeyB64url: string): { keyId: string } {
    const kid = deriveKeyId(fromB64url(publicKeyB64url));
    this.db
      .prepare(
        `INSERT INTO agent_identity_keys (agent_id, fleet_id, key_id, public_key, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, key_id) DO NOTHING`
      )
      .run(agentId, fleetId, kid, publicKeyB64url, nowIso());
    return { keyId: kid };
  }

  /**
   * Record the operator's endorsement of an agent's identity key. The endorsement
   * must be a valid signature by an active operator key over
   * agentKeyEndorsementPayload(...) — this is what roots peer trust at the operator.
   */
  endorseAgentKey(
    fleetId: string,
    agentId: string,
    targetKeyId: string,
    endorsement: { endorsedByKeyId: string; signature: string }
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT public_key FROM agent_identity_keys WHERE fleet_id = ? AND agent_id = ? AND key_id = ?"
      )
      .get(fleetId, agentId, targetKeyId) as { public_key: string } | undefined;
    if (!row) throw new Error("agent identity key not found");
    const endorser = this.db
      .prepare(
        "SELECT public_key FROM fleet_operator_keys WHERE fleet_id = ? AND key_id = ? AND revoked_at IS NULL"
      )
      .get(fleetId, endorsement.endorsedByKeyId) as { public_key: string } | undefined;
    if (!endorser) throw new Error("endorsement references an unknown or revoked operator key");
    const ok = verifyCanonical(
      agentKeyEndorsementPayload(fleetId, agentId, targetKeyId, row.public_key),
      endorsement.signature,
      fromB64url(endorser.public_key)
    );
    if (!ok) throw new Error("invalid agent-key endorsement signature");
    const res = this.db
      .prepare(
        `UPDATE agent_identity_keys
           SET endorsed_by_key_id = ?, endorsement_sig = ?, endorsed_at = ?
         WHERE fleet_id = ? AND agent_id = ? AND key_id = ?`
      )
      .run(endorsement.endorsedByKeyId, endorsement.signature, nowIso(), fleetId, agentId, targetKeyId);
    return res.changes > 0;
  }

  getAgentIdentityKeys(fleetId: string): AgentIdentityKeyRow[] {
    return this.db
      .prepare(
        `SELECT agent_id, fleet_id, key_id, public_key, created_at, revoked_at,
                endorsed_by_key_id, endorsement_sig, endorsed_at
           FROM agent_identity_keys WHERE fleet_id = ? AND revoked_at IS NULL`
      )
      .all(fleetId) as AgentIdentityKeyRow[];
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
      ).run(operatorId, fleetId, email, hashPassword(password), "owner", now);
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

    if (!row) return null;
    const { ok, legacy } = verifyPassword(password, String(row.password_hash));
    if (!ok) return null;
    if (legacy) {
      // Transparent rehash-on-login: a row written with the old unsalted SHA-256
      // is upgraded to salted scrypt in place, scoped to this exact operator id.
      // Idempotent — a crash before this commits just upgrades on the next login.
      this.db.prepare("UPDATE operators SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.id);
    }
    return row;
  }

  /** Whether an operator id is a current member of the fleet — authoritative
   *  authorization for operator session tokens (a deleted operator's token must
   *  stop working even though its HMAC still verifies). */
  operatorBelongsToFleet(operatorId: string, fleetId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM operators WHERE id = ? AND fleet_id = ? LIMIT 1").get(operatorId, fleetId)
    );
  }

  issueEnrollmentToken(fleetId: string, operatorId: string) {
    const tokenId = id("ent");
    const token = `${tokenId}.${id("tok")}`;
    this.db.prepare(
      "INSERT INTO enrollment_tokens (id, fleet_id, token_hash, issued_by_operator_id, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run(tokenId, fleetId, hashSecret(token), operatorId, addSeconds(nowIso(), 3600));
    return token;
  }

  /**
   * Atomically claim a single-use enrollment token AND create the agent, in one
   * transaction. The token is CLAIMED FIRST via a guarded conditional UPDATE
   * (used_at IS NULL AND not expired AND right fleet); only if exactly one row is
   * claimed do we create the agent + credential and backfill used_by_agent_id.
   * Returns null when the token can't be claimed (already used / expired / wrong
   * fleet / unknown) — and because the claim is the opening write of the
   * transaction, a rejected reuse leaves NO orphan agent or credential rows.
   * used_by_agent_id is backfilled (not set in the claim) because it has an FK
   * to agents(id), which doesn't exist until the agent is inserted.
   */
  createAgentFromEnrollment(input: {
    fleetId: string;
    token: string;
    displayName: string;
    runtime: string;
    hostname?: string;
  }): { agentId: string; secret: string } | null {
    const agentId = `agent_${id("agt").slice(-12)}`;
    const secret = `${id("secret")}${id("secret")}`;
    const now = nowIso();
    const tokenHash = hashSecret(input.token);

    let claimed = false;
    const tx = this.db.transaction(() => {
      const claim = this.db.prepare(
        "UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND fleet_id = ? AND used_at IS NULL AND expires_at > ?"
      ).run(now, tokenHash, input.fleetId, now);
      if (claim.changes !== 1) return; // not claimable — commit a no-op, create nothing

      const tokenId = (this.db.prepare(
        "SELECT id FROM enrollment_tokens WHERE token_hash = ? AND fleet_id = ?"
      ).get(tokenHash, input.fleetId) as { id: string }).id;

      // peer_autoreply is set explicitly to 1 (ON) rather than relying on the
      // column default: on an EXISTING relay DB the column was created by
      // migration 009 with DEFAULT 0, so an implicit insert would land a fresh
      // agent OFF. Setting it here makes newly enrolled agents land ON on both
      // fresh (schema.ts DEFAULT 1) and migrated databases.
      // peer_turn_budget likewise set explicitly: migrated DBs carry the old
      // column DEFAULT (6), so an implicit insert would under-budget new agents.
      this.db.prepare(
        "INSERT INTO agents (id, fleet_id, display_name, runtime, status, hostname, policy_profile, created_at, peer_autoreply, peer_turn_budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"
      ).run(agentId, input.fleetId, input.displayName, input.runtime, "healthy", input.hostname ?? null, "default", now, DEFAULT_PEER_TURN_BUDGET);

      this.db.prepare(
        "INSERT INTO agent_credentials (id, agent_id, secret_hash, status, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id("cred"), agentId, hashSecret(secret), "active", now);

      this.db.prepare("UPDATE enrollment_tokens SET used_by_agent_id = ? WHERE id = ?").run(agentId, tokenId);
      claimed = true;
    });

    tx();
    return claimed ? { agentId, secret } : null;
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

  /**
   * Atomically claim (agentId, nonce). Returns true if this call recorded the
   * nonce (first use), false if it was already present (a replay). Relies on the
   * UNIQUE(agent_id, nonce) constraint on replay_nonces: INSERT OR IGNORE is a
   * no-op (changes === 0) when the pair already exists, so the claim is a single
   * atomic statement — no check-then-act window between "have I seen this?" and
   * "remember it". Keying is composite, so the same nonce from a different agent
   * is independent.
   */
  claimNonce(agentId: string, nonce: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO replay_nonces (id, agent_id, nonce, created_at) VALUES (?, ?, ?, ?)")
      .run(id("rpl"), agentId, nonce, nowIso());
    return res.changes === 1;
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

  // True if `agentId` is a valid direct-message recipient in this fleet — so a
  // message can't be delivered to a foreign fleet's agent by id. The fleet's
  // synthetic operator recipient (op_<fleetId>, runtime='operator', revoked by
  // design) is always allowed: that's how agents reply TO the operator. The id is
  // fleet-scoped, so this never resolves another fleet's operator.
  private isDeliverableAgent(fleetId: string, agentId: string): boolean {
    if (agentId === `op_${fleetId}`) return true;
    return !!this.db.prepare(
      "SELECT 1 FROM agents WHERE id = ? AND fleet_id = ? AND runtime != 'operator' AND revoked_at IS NULL"
    ).get(agentId, fleetId);
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

    // A "group" recipient targets a room directly: the room id IS both the
    // recipient and the conversation (mirroring the operator->room path), so the
    // message threads under the room regardless of the conversation_id passed.
    const conversationId =
      input.recipientKind === "group" && input.recipientId ? input.recipientId : input.conversationId;

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
      // A "group" recipient names the room explicitly; otherwise a room is
      // inferred from the conversation_id (an agent threading under a room id).
      const roomRecipients = this.roomMemberIds(input.fleetId, conversationId, input.senderAgentId, true);
      if (roomRecipients !== null) {
        for (const rid of roomRecipients) {
          deliveryStmt.run(id("dly"), messageId, rid, createdAt, "queued");
        }
      } else if (input.recipientKind === "group") {
        // A group send that didn't resolve to a room the sender belongs to: the
        // room is unknown or the sender isn't a member. Reject (no silent drop).
        throw new Error("room not found");
      } else if (input.recipientKind === "agent" && input.recipientId) {
        if (!this.isDeliverableAgent(input.fleetId, input.recipientId)) throw new Error("recipient not found");
        deliveryStmt.run(id("dly"), messageId, input.recipientId, createdAt, "queued");
      } else if (input.recipientKind === "broadcast") {
        for (const recipientId of this.broadcastRecipientIds(input.fleetId, input.senderAgentId)) {
          deliveryStmt.run(id("dly"), messageId, recipientId, createdAt, "queued");
        }
      } else {
        // No delivery path matched (e.g. a conversation that isn't a room).
        // Reject loudly instead of inserting a message with zero deliveries that
        // looks sent but reaches no one.
        throw new Error(`unsupported recipient: ${input.recipientKind}`);
      }

      // Surface the message text in the operator-visible event (same as the
      // operator->room path) so the console signal log renders the REAL content
      // of peer + room messages, not a routing stub. It's the same text already
      // stored in body_json — just surfaced for rendering.
      const bodyText = typeof (input.body as Record<string, unknown> | undefined)?.text === "string"
        ? ((input.body as Record<string, unknown>).text as string)
        : undefined;
      this.recordEvent(input.fleetId, "message.queued", "agent", input.senderAgentId, "message", messageId, conversationId, {
        recipient_kind: input.recipientKind,
        recipient_id: input.recipientId ?? null,
        message_type: input.messageType,
        ...(bodyText !== undefined ? { text: bodyText } : {}),
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
    mentions?: string[];
    replyTo?: string;
    // Verifiable operator identity: stored and relayed verbatim (never recomputed).
    signature?: { sig: string; keyId: string; canonical: Record<string, unknown> };
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
        JSON.stringify({
          sender_label: "Operator",
          operator_id: input.operatorId,
          ...(input.mentions && input.mentions.length ? { mentions: input.mentions } : {}),
          ...(input.replyTo ? { reply_to_message_id: input.replyTo } : {}),
          ...(input.signature
            ? {
                operator_sig: input.signature.sig,
                key_id: input.signature.keyId,
                sig_canonical: input.signature.canonical
              }
            : {})
        }),
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
        if (!this.isDeliverableAgent(input.fleetId, recipientId)) throw new Error("recipient not found");
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

  /**
   * Create a named room with a set of member agents. The creator may be the
   * operator OR an agent (agent-opened topic rooms). Returns the room + members.
   *
   * When an AGENT opens the room it is auto-added as a member (in addition to
   * ``memberAgentIds``) so it can immediately post into the thread it created —
   * the operator is never a member (it owns all fleet rooms implicitly). Either
   * way only real, non-revoked agents in THIS fleet can be members, so a
   * malicious agent can't pull in arbitrary/foreign ids.
   */
  createRoom(
    fleetId: string,
    createdBy: { kind: "operator" | "agent"; id: string },
    name: string,
    memberAgentIds: string[]
  ) {
    const roomId = id("room");
    const createdAt = nowIso();
    // Only real, non-revoked agents in this fleet can be members.
    const valid = new Set(
      (this.db.prepare(
        "SELECT id FROM agents WHERE fleet_id = ? AND runtime != 'operator' AND revoked_at IS NULL"
      ).all(fleetId) as Array<{ id: string }>).map((r) => r.id)
    );
    const requested = [...memberAgentIds];
    // An agent creator joins its own room (it must be a member to post into it).
    if (createdBy.kind === "agent") requested.push(createdBy.id);
    const members = [...new Set(requested)].filter((m) => valid.has(m));
    const operatorId = createdBy.kind === "operator" ? createdBy.id : null;
    const agentId = createdBy.kind === "agent" ? createdBy.id : null;
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO rooms (id, fleet_id, name, created_at, created_by_operator_id, created_by_agent_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(roomId, fleetId, name, createdAt, operatorId, agentId);
      const memberStmt = this.db.prepare("INSERT OR IGNORE INTO room_members (room_id, agent_id) VALUES (?, ?)");
      for (const m of members) memberStmt.run(roomId, m);
      // actor = whoever opened it, so the operator console's events feed shows
      // an agent-opened room with the right actor.
      this.recordEvent(fleetId, "room.created", createdBy.kind, createdBy.id, "room", roomId, roomId, { name, members });
    });
    tx();
    return { id: roomId, name, created_at: createdAt, members };
  }

  /** List a fleet's rooms with their members (id + display name). */
  listRooms(fleetId: string) {
    const rooms = this.db.prepare(
      "SELECT id, name, created_at, project_mode, project_turn_budget FROM rooms WHERE fleet_id = ? ORDER BY created_at DESC"
    ).all(fleetId) as Array<{ id: string; name: string; created_at: string; project_mode: number; project_turn_budget: number }>;
    const memberStmt = this.db.prepare(
      `SELECT rm.agent_id, a.display_name, a.status FROM room_members rm
       JOIN agents a ON a.id = rm.agent_id
       WHERE rm.room_id = ? AND a.revoked_at IS NULL
       ORDER BY a.display_name`
    );
    return rooms.map((room) => ({
      ...room,
      project_mode: Boolean(room.project_mode),
      project_turn_budget: Number(room.project_turn_budget) || DEFAULT_PROJECT_TURN_BUDGET,
      members: memberStmt.all(room.id) as Array<{ agent_id: string; display_name: string; status: string }>
    }));
  }

  /** Toggle a room's project mode (higher per-room peer budget). Returns the
   *  new settings, or null if the room doesn't exist in this fleet. */
  setRoomProjectMode(fleetId: string, roomId: string, operatorId: string, enabled: boolean, budget?: number) {
    const room = this.db.prepare("SELECT id FROM rooms WHERE id = ? AND fleet_id = ?").get(roomId, fleetId);
    if (!room) return null;
    if (typeof budget === "number" && budget > 0) {
      this.db.prepare("UPDATE rooms SET project_mode = ?, project_turn_budget = ? WHERE id = ? AND fleet_id = ?")
        .run(enabled ? 1 : 0, budget, roomId, fleetId);
    } else {
      this.db.prepare("UPDATE rooms SET project_mode = ? WHERE id = ? AND fleet_id = ?")
        .run(enabled ? 1 : 0, roomId, fleetId);
    }
    const row = this.db.prepare("SELECT project_mode, project_turn_budget FROM rooms WHERE id = ? AND fleet_id = ?")
      .get(roomId, fleetId) as { project_mode: number; project_turn_budget: number };
    const result = {
      project_mode: Boolean(row.project_mode),
      project_turn_budget: Number(row.project_turn_budget) || DEFAULT_PROJECT_TURN_BUDGET
    };
    this.recordEvent(fleetId, "room.project_mode_changed", "operator", operatorId, "room", roomId, roomId, result);
    return result;
  }

  /** One-click resume for a stalled thread: mint an operator nudge into the
   *  conversation. Operator messages reset every recipient's peer latch and wake
   *  them, and — being operator engagement — re-arm recordConversationStall's
   *  once-per-close boundary. Rooms fan out to members; other conversations fan
   *  out to their historical participants. Returns null when there is nobody to
   *  wake. */
  resumeConversation(fleetId: string, operatorId: string, conversationId: string, text?: string) {
    const nudge = text?.trim() || "▶ Operator resumed this thread — fresh turn budget, continue where you left off.";
    const room = this.db.prepare("SELECT id FROM rooms WHERE id = ? AND fleet_id = ?").get(conversationId, fleetId);
    if (room) {
      const result = this.createOperatorMessage({ fleetId, operatorId, roomId: conversationId, text: nudge });
      this.recordEvent(fleetId, "conversation.resumed", "operator", operatorId, "conversation", conversationId, conversationId, {});
      return result;
    }

    // Participants: every live, non-operator agent that ever sent or received in
    // this conversation (same definition isConversationParticipant uses).
    const participants = (this.db.prepare(
      `SELECT DISTINCT a.id FROM agents a
       WHERE a.fleet_id = ? AND a.runtime != 'operator' AND a.revoked_at IS NULL AND (
         EXISTS (SELECT 1 FROM messages m WHERE m.fleet_id = ? AND m.conversation_id = ? AND m.sender_agent_id = a.id)
         OR EXISTS (
           SELECT 1 FROM messages m JOIN message_deliveries d ON d.message_id = m.id
           WHERE m.fleet_id = ? AND m.conversation_id = ? AND d.recipient_agent_id = a.id
         )
       )`
    ).all(fleetId, fleetId, conversationId, fleetId, conversationId) as Array<{ id: string }>).map((r) => r.id);
    if (participants.length === 0) return null;

    const messageId = id("msg");
    const createdAt = nowIso();
    const ttlSeconds = 900;
    const senderId = this.ensureOperatorAgent(fleetId);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO messages (
          id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
          message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId, fleetId, conversationId, id("cor"), senderId, "broadcast", null,
        "broadcast", "normal", 0,
        JSON.stringify({ text: nudge }),
        JSON.stringify({ sender_label: "Operator", operator_id: operatorId, resumed: true }),
        ttlSeconds, createdAt, addSeconds(createdAt, ttlSeconds), "queued"
      );
      const deliveryStmt = this.db.prepare(
        "INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)"
      );
      for (const rid of participants) deliveryStmt.run(id("dly"), messageId, rid, createdAt, "queued");
      this.recordEvent(fleetId, "message.queued", "operator", senderId, "message", messageId, conversationId, {
        recipient_kind: "broadcast",
        recipient_id: null,
        message_type: "broadcast",
        sender_label: "Operator",
        text: nudge
      });
      this.recordEvent(fleetId, "conversation.resumed", "operator", operatorId, "conversation", conversationId, conversationId, {});
    });
    tx();
    return { messageId, conversationId, createdAt };
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
    const peerTurnBudget = Number(self?.peer_turn_budget) || DEFAULT_PEER_TURN_BUDGET;

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

    // Each teammate's identity key + operator endorsement, so a peer can verify a
    // sender's signature and that its key chains back to the operator. Prefer an
    // endorsed key when an agent has more than one active key.
    const idKeysByAgent = new Map<string, AgentIdentityKeyRow>();
    if (fleetId) {
      for (const k of this.getAgentIdentityKeys(fleetId)) {
        const existing = idKeysByAgent.get(k.agent_id);
        if (!existing || (k.endorsed_by_key_id && !existing.endorsed_by_key_id)) {
          idKeysByAgent.set(k.agent_id, k);
        }
      }
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
        ).all(fleetId, agentId) as Array<Record<string, unknown>>).map((row) => {
          const ik = idKeysByAgent.get(String(row.id));
          return {
            agent_id: row.id,
            display_name: row.display_name,
            runtime: row.runtime,
            status: row.status,
            identity_public_key: ik?.public_key ?? null,
            key_id: ik?.key_id ?? null,
            endorsed_by_key_id: ik?.endorsed_by_key_id ?? null,
            endorsement_sig: ik?.endorsement_sig ?? null
          };
        })
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

    // --- @mentions, reply-to snapshots, and room thread history: the context an
    //     agent needs to know who's addressed and what's being referenced. ---
    const parsedMetas = deliveries.map(
      (row) => (row.metadata_json ? JSON.parse(String(row.metadata_json)) : {}) as Record<string, unknown>
    );
    const replyToIds = Array.from(
      new Set(parsedMetas.map((m) => m.reply_to_message_id).filter(Boolean).map(String))
    );
    const convIds = Array.from(new Set(deliveries.map((row) => String(row.conversation_id))));
    // Only rooms the polling agent is actually a MEMBER of get history — never
    // infer access from a delivery alone (an agent can tag a message with any
    // room's conversation_id, which would otherwise leak that room's thread).
    const roomRows = convIds.length && fleetId
      ? (this.db.prepare(
          `SELECT rooms.id, rooms.name FROM rooms
             JOIN room_members ON room_members.room_id = rooms.id
           WHERE rooms.fleet_id = ? AND room_members.agent_id = ? AND rooms.id IN (${convIds.map(() => "?").join(",")})`
        ).all(fleetId, agentId, ...convIds) as Array<{ id: string; name: string }>)
      : [];
    const roomConvIds = roomRows.map((r) => r.id);

    const HISTORY_LIMIT = 15;
    const contextRows: Array<Record<string, unknown>> = [];
    if (replyToIds.length && fleetId) {
      const ph = replyToIds.map(() => "?").join(",");
      contextRows.push(...(this.db.prepare(
        `SELECT id, conversation_id, sender_agent_id, body_json, metadata_json, created_at FROM messages WHERE fleet_id = ? AND id IN (${ph})`
      ).all(fleetId, ...replyToIds) as Array<Record<string, unknown>>));
    }
    const historyByConv = new Map<string, Array<Record<string, unknown>>>();
    for (const cid of roomConvIds) {
      const rows = (this.db.prepare(
        `SELECT id, sender_agent_id, body_json, metadata_json, created_at FROM messages
         WHERE fleet_id = ? AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(fleetId, cid, HISTORY_LIMIT) as Array<Record<string, unknown>>).reverse(); // chronological
      historyByConv.set(cid, rows);
      contextRows.push(...rows);
    }

    // Resolve runtime + display name for every context sender in one query.
    const ctxSenderIds = Array.from(new Set(contextRows.map((r) => String(r.sender_agent_id))));
    const ctxSenderInfo = new Map<string, { runtime: string; display_name: string }>();
    if (ctxSenderIds.length) {
      const ph = ctxSenderIds.map(() => "?").join(",");
      for (const s of this.db.prepare(
        `SELECT id, runtime, display_name FROM agents WHERE id IN (${ph})`
      ).all(...ctxSenderIds) as Array<Record<string, unknown>>) {
        ctxSenderInfo.set(String(s.id), { runtime: String(s.runtime), display_name: String(s.display_name ?? s.id) });
      }
    }
    const snapshotOf = (row: Record<string, unknown>) => {
      const body = JSON.parse(String(row.body_json)) as Record<string, unknown>;
      const m = (row.metadata_json ? JSON.parse(String(row.metadata_json)) : {}) as Record<string, unknown>;
      const info = ctxSenderInfo.get(String(row.sender_agent_id));
      const sk = info?.runtime === "operator" ? "operator" : "agent";
      return {
        message_id: row.id,
        sender_agent_id: row.sender_agent_id,
        sender_kind: sk,
        sender_label: sk === "operator" ? String(m.sender_label ?? "Operator") : (info?.display_name ?? String(row.sender_agent_id)),
        text: typeof body.text === "string" ? body.text : "",
        created_at: row.created_at
      };
    };
    const replyRowById = new Map<string, Record<string, unknown>>();
    for (const rid of replyToIds) {
      const row = contextRows.find((r) => String(r.id) === rid);
      if (row) replyRowById.set(rid, row);
    }
    const conversation_history: Record<string, Array<ReturnType<typeof snapshotOf>>> = {};
    for (const [cid, rows] of historyByConv) conversation_history[cid] = rows.map(snapshotOf);

    // Per-conversation budget overrides: rooms this agent belongs to that are in
    // project mode. Sent on EVERY poll (not just when a delivery is present) so
    // the plugin's latch always has the live per-room ceiling.
    const conversation_budgets: Record<string, number> = {};
    if (fleetId) {
      const projectRooms = this.db.prepare(
        `SELECT r.id, r.project_turn_budget FROM rooms r
           JOIN room_members rm ON rm.room_id = r.id
         WHERE r.fleet_id = ? AND rm.agent_id = ? AND r.project_mode = 1`
      ).all(fleetId, agentId) as Array<{ id: string; project_turn_budget: number }>;
      for (const r of projectRooms) {
        conversation_budgets[r.id] = Number(r.project_turn_budget) || DEFAULT_PROJECT_TURN_BUDGET;
      }
    }

    return {
      messages: deliveries.map((row, i) => {
        const body = parsedBodies[i];
        const attIds = Array.isArray(body.attachments) ? (body.attachments as unknown[]).map(String) : [];
        const attachments = attIds
          .map((aid) => attachmentMetaById.get(aid))
          .filter((m): m is { id: string; filename: string; mime: string; size_bytes: number } => Boolean(m));
        const meta = row.metadata_json ? JSON.parse(String(row.metadata_json)) : {};
        const senderKind = senderRuntime.get(String(row.sender_agent_id)) === "operator" ? "operator" : "agent";
        return {
          message_id: row.id,
          conversation_id: row.conversation_id,
          correlation_id: row.correlation_id,
          sender_agent_id: row.sender_agent_id,
          sender_kind: senderKind,
          message_type: row.message_type,
          priority: row.priority,
          body,
          attachments,   // [{id, filename, mime, size_bytes}] — NEVER bytes
          metadata: meta,
          // @mentions (who's addressed) + reply-to (a quoted snapshot of the
          // referenced message) — context so agents stop answering for each other.
          mentions: Array.isArray(meta.mentions) ? (meta.mentions as unknown[]).map(String) : [],
          reply_to: (() => {
            const rid = meta.reply_to_message_id ? String(meta.reply_to_message_id) : null;
            const refRow = rid ? replyRowById.get(rid) : undefined;
            // Only a SAME-conversation reference resolves — never surface a body
            // from a thread this recipient isn't part of (cross-conversation leak).
            if (!refRow || String(refRow.conversation_id) !== String(row.conversation_id)) return null;
            return snapshotOf(refRow);
          })(),
          // Verifiable identity, gated on the SERVER-derived sender kind so an agent
          // can't inject a fake operator_sig (nor an operator an agent_sig).
          operator_sig: senderKind === "operator" ? (meta.operator_sig ?? null) : null,
          agent_sig: senderKind === "agent" ? (meta.agent_sig ?? null) : null,
          key_id: meta.key_id ?? null,
          sig_canonical: meta.sig_canonical ?? null,
          created_at: row.created_at,
          deadline_at: row.expires_at
        };
      }),
      controls: controls.map((row) => ({
        control_id: row.id,
        action: row.action,
        reason: row.payload_json ? JSON.parse(String(row.payload_json)).reason ?? "operator control" : "operator control"
      })),
      fleet_id: fleetId,
      operator_trusted: operatorTrusted,
      peer_autoreply: peerAutoreply,
      peer_turn_budget: peerTurnBudget,
      // Project-mode rooms override the per-agent budget for that conversation.
      conversation_budgets,
      roster,
      // Recent thread history per room conversation in this batch (keyed by
      // conversation_id), so an agent always has the room context, not just the
      // single delivered message. Empty for direct (non-room) conversations.
      conversation_history,
      // Rooms (of the ones in this batch) the polling agent is a MEMBER of, so a
      // reply can be framed as going to the named room rather than a 1:1 thread.
      rooms: roomRows.map((r) => ({ id: r.id, name: r.name })),
      // Pinned operator signing keys (incl. revoked, so agents can drop them).
      operator_keys: fleetId
        ? this.listOperatorKeys(fleetId).map((k) => ({
            key_id: k.key_id,
            public_key: k.public_key,
            revoked: Boolean(k.revoked_at),
            endorsed_by_key_id: k.endorsed_by_key_id,
            endorsement_sig: k.endorsement_sig
          }))
        : []
    };
  }

  /**
   * Floor control — at most one agent holds a conversation's floor at a time, so
   * agents take turns instead of all replying at once. Granted if the floor is
   * free, expired, or already held by this agent (idempotent re-acquire). Atomic
   * via a synchronous better-sqlite3 transaction.
   */
  acquireFloor(fleetId: string, conversationId: string, agentId: string, ttlSeconds: number) {
    const now = nowIso();
    const expiresAt = addSeconds(now, Math.max(0, ttlSeconds));
    const tx = this.db.transaction(() => {
      const cur = this.db.prepare(
        "SELECT holder_agent_id, expires_at FROM conversation_floors WHERE conversation_id = ? AND fleet_id = ?"
      ).get(conversationId, fleetId) as { holder_agent_id: string; expires_at: string } | undefined;
      const free = !cur || cur.expires_at <= now || cur.holder_agent_id === agentId;
      if (!free) return { granted: false, holderAgentId: cur!.holder_agent_id, expiresAt: cur!.expires_at };
      this.db.prepare(
        `INSERT INTO conversation_floors (conversation_id, fleet_id, holder_agent_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           fleet_id = excluded.fleet_id, holder_agent_id = excluded.holder_agent_id,
           acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`
      ).run(conversationId, fleetId, agentId, now, expiresAt);
      return { granted: true, holderAgentId: agentId, expiresAt };
    });
    return tx();
  }

  /**
   * Whether an agent is a participant of a conversation — a member of the room,
   * or has sent/received a message in it. Gates the floor + catch-up so an agent
   * can never acquire a floor for, or read the tail of, a thread it isn't in.
   */
  isConversationParticipant(fleetId: string, conversationId: string, agentId: string): boolean {
    const room = this.db.prepare(
      `SELECT 1 FROM room_members rm JOIN rooms r ON r.id = rm.room_id
       WHERE r.fleet_id = ? AND rm.room_id = ? AND rm.agent_id = ? LIMIT 1`
    ).get(fleetId, conversationId, agentId);
    if (room) return true;
    const msg = this.db.prepare(
      `SELECT 1 FROM messages m
       WHERE m.fleet_id = ? AND m.conversation_id = ? AND (
         m.sender_agent_id = ?
         OR EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.recipient_agent_id = ?)
       ) LIMIT 1`
    ).get(fleetId, conversationId, agentId, agentId);
    return Boolean(msg);
  }

  /** Release a conversation floor — only the current holder can. */
  releaseFloor(fleetId: string, conversationId: string, agentId: string): boolean {
    const r = this.db.prepare(
      "DELETE FROM conversation_floors WHERE conversation_id = ? AND fleet_id = ? AND holder_agent_id = ?"
    ).run(conversationId, fleetId, agentId);
    return r.changes > 0;
  }

  /**
   * The recent thread of a conversation (chronological), resolved to
   * {message_id, sender_agent_id, sender_kind, sender_label, text, created_at} —
   * the fresh catch-up handed to a floor holder so it never reasons on stale state.
   */
  getConversationTail(fleetId: string, conversationId: string, limit: number) {
    const rows = (this.db.prepare(
      `SELECT id, sender_agent_id, body_json, metadata_json, created_at FROM messages
       WHERE fleet_id = ? AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(fleetId, conversationId, Math.max(1, limit)) as Array<Record<string, unknown>>).reverse();
    if (rows.length === 0) return [];
    const senderIds = Array.from(new Set(rows.map((r) => String(r.sender_agent_id))));
    const info = new Map<string, { runtime: string; display_name: string }>();
    const ph = senderIds.map(() => "?").join(",");
    for (const s of this.db.prepare(
      `SELECT id, runtime, display_name FROM agents WHERE id IN (${ph})`
    ).all(...senderIds) as Array<Record<string, unknown>>) {
      info.set(String(s.id), { runtime: String(s.runtime), display_name: String(s.display_name ?? s.id) });
    }
    return rows.map((r) => {
      let text = "";
      try { const b = JSON.parse(String(r.body_json) || "{}") as Record<string, unknown>; if (typeof b.text === "string") text = b.text; } catch { /* empty */ }
      const meta = r.metadata_json ? (() => { try { return JSON.parse(String(r.metadata_json)) as Record<string, unknown>; } catch { return {}; } })() : {};
      const inf = info.get(String(r.sender_agent_id));
      const sk = inf?.runtime === "operator" ? "operator" : "agent";
      return {
        message_id: r.id,
        sender_agent_id: r.sender_agent_id,
        sender_kind: sk,
        sender_label: sk === "operator" ? String(meta.sender_label ?? "Operator") : (inf?.display_name ?? String(r.sender_agent_id)),
        text,
        created_at: r.created_at
      };
    });
  }

  ackMessages(agentId: string, ackRows: Array<{ message_id: string; received_at: string }>) {
    let updated = 0;
    const tx = this.db.transaction(() => {
      for (const ack of ackRows) {
        // Only the agent's OWN delivery is touched. If nothing matched (the
        // message wasn't delivered to this agent), the ack is a no-op — never
        // flip a foreign/broadcast message's shared status off an unrelated ack.
        const res = this.db.prepare(
          "UPDATE message_deliveries SET status = 'acked', acked_at = ? WHERE message_id = ? AND recipient_agent_id = ? AND status != 'acked'"
        ).run(ack.received_at, ack.message_id, agentId);
        if (res.changes === 0) continue;
        updated += 1;

        // The message as a whole is 'acked' only once every recipient has acked
        // (a broadcast stays pending until the last recipient does).
        const pending = this.db.prepare(
          "SELECT 1 FROM message_deliveries WHERE message_id = ? AND status != 'acked' LIMIT 1"
        ).get(ack.message_id);
        if (!pending) {
          this.db.prepare("UPDATE messages SET status = 'acked' WHERE id = ?").run(ack.message_id);
        }

        const message = this.db.prepare("SELECT fleet_id, conversation_id FROM messages WHERE id = ?").get(ack.message_id) as Record<string, unknown> | undefined;
        if (message) {
          this.recordEvent(String(message.fleet_id), "message.acked", "agent", agentId, "message", ack.message_id, String(message.conversation_id), {
            received_at: ack.received_at
          });
        }
      }
    });
    tx();
    return updated;
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

  completeActionResult(approvalId: string, fleetId: string, agentId: string, result: string, output: JsonValue) {
    // Scoped to the owning agent + fleet: an agent can only complete its own
    // approval, never another agent's or another fleet's (IDOR).
    const approval = this.db.prepare(
      "SELECT fleet_id, conversation_id, agent_id FROM approvals WHERE id = ? AND fleet_id = ? AND agent_id = ?"
    ).get(approvalId, fleetId, agentId) as Record<string, unknown> | undefined;
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

  getApprovalStatus(approvalId: string, fleetId: string, agentId: string) {
    const approval = this.db.prepare(
      "SELECT id, status, action_type, risk_level, summary, requested_at, resolved_at FROM approvals WHERE id = ? AND fleet_id = ? AND agent_id = ?"
    ).get(approvalId, fleetId, agentId) as Record<string, unknown> | undefined;
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

  controlAgent(fleetId: string, agentId: string, operatorId: string, action: "pause" | "resume" | "quarantine", payload: JsonValue) {
    // Scope to the operator's own fleet (and never the operator pseudo-agent) so a
    // foreign agent id can't be paused/quarantined cross-fleet — matching the
    // fleet-scoped sibling controls (setAgentTrust / setPeerAutoreply).
    const agent = this.db.prepare(
      "SELECT id FROM agents WHERE id = ? AND fleet_id = ? AND runtime != 'operator'"
    ).get(agentId, fleetId) as Record<string, unknown> | undefined;
    if (!agent) {
      return false;
    }

    const nextStatus = action === "pause" ? "paused" : action === "quarantine" ? "quarantined" : "healthy";
    const controlId = id("ctl");
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(controlId, fleetId, "agent", agentId, action, JSON.stringify(payload), operatorId, now);
      this.db.prepare("UPDATE agents SET status = ? WHERE id = ? AND fleet_id = ?").run(nextStatus, agentId, fleetId);
      this.recordEvent(fleetId, `agent.${action}`, "operator", operatorId, "agent", agentId, null, payload);
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
    const result = { peer_autoreply: Boolean(row.peer_autoreply), peer_turn_budget: Number(row.peer_turn_budget) || DEFAULT_PEER_TURN_BUDGET };
    this.recordEvent(fleetId, "agent.peer_autoreply_changed", "operator", operatorId, "agent", agentId, null, result);
    return result;
  }

  /**
   * Per-agent health board: status + heartbeat freshness, the latest
   * agent-reported metrics (model/provider/quota — whatever the heartbeat
   * carries), current activity, the trust/delegation flags, and relay-derived
   * throughput over the last hour. One pane of glass for the fleet.
   */
  // --- Feeds (operator-configured sources delivered non-waking) -------------

  createFeed(fleetId: string, operatorId: string, name: string, url: string, pollIntervalMinutes: number, subscriberAgentIds: string[]) {
    const feedId = id("feed");
    const createdAt = nowIso();
    const valid = new Set(
      (this.db.prepare("SELECT id FROM agents WHERE fleet_id = ? AND runtime != 'operator' AND revoked_at IS NULL").all(fleetId) as Array<{ id: string }>).map((r) => r.id)
    );
    const subs = [...new Set(subscriberAgentIds)].filter((s) => valid.has(s));
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO feeds (id, fleet_id, name, url, poll_interval_minutes, created_at, created_by_operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(feedId, fleetId, name, url, pollIntervalMinutes, createdAt, operatorId);
      const subStmt = this.db.prepare("INSERT OR IGNORE INTO feed_subscribers (feed_id, agent_id) VALUES (?, ?)");
      for (const s of subs) subStmt.run(feedId, s);
      this.recordEvent(fleetId, "feed.created", "operator", operatorId, "feed", feedId, null, { name, url, subscribers: subs });
    });
    tx();
    return { id: feedId, name, url, poll_interval_minutes: pollIntervalMinutes, last_polled_at: null, created_at: createdAt, subscribers: subs };
  }

  listFeeds(fleetId: string) {
    const feeds = this.db.prepare(
      "SELECT id, name, url, poll_interval_minutes, last_polled_at, created_at FROM feeds WHERE fleet_id = ? ORDER BY created_at DESC"
    ).all(fleetId) as Array<Record<string, unknown>>;
    const subStmt = this.db.prepare(
      `SELECT fs.agent_id, a.display_name FROM feed_subscribers fs
       JOIN agents a ON a.id = fs.agent_id WHERE fs.feed_id = ? AND a.revoked_at IS NULL ORDER BY a.display_name`
    );
    const countStmt = this.db.prepare("SELECT COUNT(*) AS c FROM feed_seen WHERE feed_id = ?");
    return feeds.map((f) => ({
      ...f,
      subscribers: subStmt.all(f.id) as Array<{ agent_id: string; display_name: string }>,
      item_count: (countStmt.get(f.id) as { c: number }).c
    }));
  }

  deleteFeed(fleetId: string, feedId: string, operatorId: string): boolean {
    const feed = this.db.prepare("SELECT id FROM feeds WHERE id = ? AND fleet_id = ?").get(feedId, fleetId);
    if (!feed) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM feed_subscribers WHERE feed_id = ?").run(feedId);
      this.db.prepare("DELETE FROM feed_seen WHERE feed_id = ?").run(feedId);
      this.db.prepare("DELETE FROM feeds WHERE id = ? AND fleet_id = ?").run(feedId, fleetId);
      this.recordEvent(fleetId, "feed.deleted", "operator", operatorId, "feed", feedId, null, {});
    });
    tx();
    return true;
  }

  setFeedSubscribers(fleetId: string, feedId: string, operatorId: string, agentIds: string[]): boolean {
    const feed = this.db.prepare("SELECT id FROM feeds WHERE id = ? AND fleet_id = ?").get(feedId, fleetId);
    if (!feed) return false;
    const valid = new Set(
      (this.db.prepare("SELECT id FROM agents WHERE fleet_id = ? AND runtime != 'operator' AND revoked_at IS NULL").all(fleetId) as Array<{ id: string }>).map((r) => r.id)
    );
    const subs = [...new Set(agentIds)].filter((s) => valid.has(s));
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM feed_subscribers WHERE feed_id = ?").run(feedId);
      const stmt = this.db.prepare("INSERT OR IGNORE INTO feed_subscribers (feed_id, agent_id) VALUES (?, ?)");
      for (const s of subs) stmt.run(feedId, s);
      this.recordEvent(fleetId, "feed.subscribers_changed", "operator", operatorId, "feed", feedId, null, { subscribers: subs });
    });
    tx();
    return true;
  }

  getFeedItems(fleetId: string, feedId: string, limit: number) {
    const feed = this.db.prepare("SELECT id FROM feeds WHERE id = ? AND fleet_id = ?").get(feedId, fleetId);
    if (!feed) return null;
    return this.db.prepare(
      "SELECT guid, title, link, delivered_at FROM feed_seen WHERE feed_id = ? ORDER BY delivered_at DESC LIMIT ?"
    ).all(feedId, limit);
  }

  /** Feeds (across all fleets) whose poll interval has elapsed — for the sweep. */
  feedsDueForPoll(nowMs: number): Array<{ id: string }> {
    return (this.db.prepare(
      "SELECT id, last_polled_at, poll_interval_minutes FROM feeds"
    ).all() as Array<{ id: string; last_polled_at: string | null; poll_interval_minutes: number }>)
      .filter((f) => !f.last_polled_at || nowMs - new Date(f.last_polled_at).getTime() >= f.poll_interval_minutes * 60_000)
      .map((f) => ({ id: f.id }));
  }

  private deliverFeedItem(fleetId: string, feedId: string, feedName: string, item: FeedItem, subscriberIds: string[]) {
    const senderId = this.ensureOperatorAgent(fleetId);
    const messageId = id("msg");
    const createdAt = nowIso();
    const ttl = 21_600; // 6h — feeds are context, they can linger
    const text = `📰 [${feedName}] ${item.title}${item.link ? `\n${item.link}` : ""}`;
    this.db.prepare(
      `INSERT INTO messages (id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
        message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      messageId, fleetId, `feed-${feedId}`, id("cor"), senderId, "broadcast", null,
      "feed", "low", 0,
      JSON.stringify({ text, feed: feedName, link: item.link }),
      JSON.stringify({ source: "feed", feed: feedName, link: item.link }),
      ttl, createdAt, addSeconds(createdAt, ttl), "queued"
    );
    const dstmt = this.db.prepare("INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)");
    for (const aid of subscriberIds) dstmt.run(id("dly"), messageId, aid, createdAt, "queued");
  }

  /**
   * Poll a feed: fetch (via the injected fetchFn — real network in prod, a stub
   * in tests), parse, and deliver NEW items to subscribers as non-waking 'feed'
   * messages. The FIRST poll seeds the baseline (marks current items seen,
   * delivers none) so adding a feed doesn't flood subscribers with its backlog.
   */
  async pollFeed(feedId: string, fetchFn: (url: string) => Promise<string | null>): Promise<{ delivered: number; total: number }> {
    const feed = this.db.prepare("SELECT id, fleet_id, name, url FROM feeds WHERE id = ?").get(feedId) as
      | { id: string; fleet_id: string; name: string; url: string }
      | undefined;
    if (!feed) return { delivered: 0, total: 0 };
    const polledAt = nowIso();
    // Mark polled up-front so a flaky source isn't hammered every sweep.
    this.db.prepare("UPDATE feeds SET last_polled_at = ? WHERE id = ?").run(polledAt, feedId);

    let xml: string | null = null;
    try {
      xml = await fetchFn(feed.url);
    } catch {
      return { delivered: 0, total: 0 };
    }
    if (!xml) return { delivered: 0, total: 0 };
    const items = parseFeed(xml);
    if (!items.length) return { delivered: 0, total: 0 };

    const isSeeded = (this.db.prepare("SELECT COUNT(*) AS c FROM feed_seen WHERE feed_id = ?").get(feedId) as { c: number }).c > 0;
    const subscribers = (this.db.prepare(
      `SELECT fs.agent_id FROM feed_subscribers fs JOIN agents a ON a.id = fs.agent_id
       WHERE fs.feed_id = ? AND a.revoked_at IS NULL`
    ).all(feedId) as Array<{ agent_id: string }>).map((r) => r.agent_id);

    const seenStmt = this.db.prepare("SELECT 1 FROM feed_seen WHERE feed_id = ? AND guid = ?");
    const markStmt = this.db.prepare("INSERT OR IGNORE INTO feed_seen (feed_id, guid, title, link, delivered_at) VALUES (?, ?, ?, ?, ?)");
    let delivered = 0;
    const tx = this.db.transaction(() => {
      for (const item of items.slice(0, 25)) {
        if (seenStmt.get(feedId, item.guid)) continue;
        markStmt.run(feedId, item.guid, item.title, item.link, polledAt);
        if (isSeeded && subscribers.length) {
          this.deliverFeedItem(feed.fleet_id, feedId, feed.name, item, subscribers);
          delivered += 1;
        }
      }
      if (delivered > 0) {
        this.recordEvent(feed.fleet_id, "feed.delivered", "system", null, "feed", feedId, `feed-${feedId}`, { feed: feed.name, count: delivered });
      }
    });
    tx();
    return { delivered, total: items.length };
  }

  getFleetHealth(fleetId: string, windowMinutes = 60) {
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
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
      const health = deriveAgentHealth({
        status: String(a.status),
        last_heartbeat_at: hb?.received_at ?? null,
        consecutive_missed_heartbeats: Number(a.consecutive_missed_heartbeats) || 0,
        metrics
      });
      return {
        id,
        display_name: a.display_name,
        runtime: a.runtime,
        status: a.status,
        last_seen_at: a.last_seen_at ?? null,
        consecutive_missed_heartbeats: Number(a.consecutive_missed_heartbeats) || 0,
        operator_trusted: Boolean(a.operator_trusted),
        peer_autoreply: Boolean(a.peer_autoreply),
        peer_turn_budget: Number(a.peer_turn_budget) || DEFAULT_PEER_TURN_BUDGET,
        last_heartbeat_at: hb?.received_at ?? null,
        metrics,
        health,
        active_conversations: activeConversations,
        sent_1h: (sentStmt.get(fleetId, id, since) as { c: number }).c,
        received_1h: (recvStmt.get(fleetId, id, since) as { c: number }).c
      };
    });
  }

  /**
   * The operator "Needs You" queue: the three things that actually need a human
   * — dead/degraded models, stalled hand-offs, and undeliverable messages —
   * folded into one ranked list (assembly is the pure buildAttentionItems).
   * `stalledSinceMs` bounds how far back a stall still counts as open.
   */
  getAttentionItems(fleetId: string, stalledSinceMs = 7 * 86400_000) {
    const agents = this.getFleetHealth(fleetId).map((a) => ({
      id: a.id,
      display_name: a.display_name as string,
      health: a.health,
      last_heartbeat_at: a.last_heartbeat_at
    }));
    const since = new Date(Date.now() - stalledSinceMs).toISOString();
    const stalledRaw = this.db.prepare(
      `SELECT id, actor_id, conversation_id, payload_json, created_at
       FROM events WHERE fleet_id = ? AND event_type = 'conversation.stalled' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 50`
    ).all(fleetId, since) as Array<Record<string, unknown>>;
    const stalled = stalledRaw.map((e) => {
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(String(e.payload_json) || "{}"); } catch { /* malformed */ }
      return { id: String(e.id), actor_id: e.actor_id as string | null, conversation_id: e.conversation_id as string | null, created_at: e.created_at as string | null, payload };
    });
    const deadLetters = this.listDeadLetters(fleetId, { limit: 50, offset: 0 }).items as Array<Record<string, unknown>>;
    const agentNames = Object.fromEntries(
      (this.db.prepare("SELECT id, display_name FROM agents WHERE fleet_id = ?").all(fleetId) as Array<{ id: string; display_name: string }>)
        .map((a) => [a.id, a.display_name])
    );
    const items = buildAttentionItems({
      agents,
      stalled,
      deadLetters: deadLetters.map((d) => ({
        id: String(d.id), recipient_agent_id: d.recipient_agent_id as string, sender_agent_id: d.sender_agent_id as string,
        conversation_id: d.conversation_id as string, failure_reason: d.failure_reason as string, dead_lettered_at: d.dead_lettered_at as string
      })),
      agentNames
    });
    return { items, counts: { critical: items.filter((i) => i.severity === "critical").length, warn: items.filter((i) => i.severity === "warn").length } };
  }

  /**
   * Fleet topology for the command-centre map: every live agent as a node (reusing
   * the health snapshot — sized over the SAME window as the edges — so node state
   * has a single source of truth) plus the undirected agent↔agent collaboration
   * graph: the directed messages sent between two agents in the window, folded into
   * one weighted edge. Edges come from message_deliveries (room fan-out resolves to
   * concrete recipients). Excluded so the map shows pairwise collaboration, not the
   * hub or one-to-many noise: the operator pseudo-agent, feed/control traffic, and
   * broadcast fan-out (recipient_kind='broadcast' — the reliable discriminator,
   * since a broadcast can carry any message_type). Counts attempted sends (a
   * delivery row), matching the health board's recv count.
   */
  getTopology(fleetId: string, options?: { windowMinutes?: number }) {
    const windowMinutes = options?.windowMinutes ?? 60;
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    const nodes = this.getFleetHealth(fleetId, windowMinutes);

    const directed = this.db.prepare(
      `SELECT m.sender_agent_id AS src, d.recipient_agent_id AS dst,
              COUNT(*) AS c, MAX(m.created_at) AS last_at
         FROM messages m
         JOIN message_deliveries d ON d.message_id = m.id
         JOIN agents sa ON sa.id = m.sender_agent_id
         JOIN agents ra ON ra.id = d.recipient_agent_id
        WHERE m.fleet_id = ?
          AND m.created_at >= ?
          AND m.sender_agent_id != d.recipient_agent_id
          AND sa.runtime != 'operator'
          AND ra.runtime != 'operator'
          AND sa.revoked_at IS NULL
          AND ra.revoked_at IS NULL
          AND m.recipient_kind != 'broadcast'
          AND m.message_type NOT IN ('feed', 'control')
        GROUP BY m.sender_agent_id, d.recipient_agent_id`
    ).all(fleetId, since) as Array<{ src: string; dst: string; c: number; last_at: string }>;

    // Fold the two directions of each pair into one weighted, undirected edge.
    const pairs = new Map<string, { source: string; target: string; count: number; last_at: string }>();
    for (const r of directed) {
      const [source, target] = r.src < r.dst ? [r.src, r.dst] : [r.dst, r.src];
      const key = `${source}|${target}`;
      const existing = pairs.get(key);
      if (existing) {
        existing.count += r.c;
        if (r.last_at > existing.last_at) existing.last_at = r.last_at;
      } else {
        pairs.set(key, { source, target, count: r.c, last_at: r.last_at });
      }
    }
    const edges = [...pairs.values()].sort((a, b) => b.count - a.count);

    return { generated_at: nowIso(), window_minutes: windowMinutes, nodes, edges };
  }

  /**
   * Fleet-wide activity stream for the command-centre timeline: recent events
   * (messages, handoffs, trust/room/delegation changes, …) newest-first, with
   * agent ids resolved to display names and the payload parsed for rendering.
   * ``type`` filters by event_type prefix (e.g. "message", "room", "agent").
   */
  getActivity(fleetId: string, options: { limit: number; type?: string }) {
    // Heartbeats (one per agent every ~30s) would drown the stream — exclude them.
    const where = ["fleet_id = ?", "event_type != 'agent.heartbeat'"];
    const params: Array<string | number> = [fleetId];
    if (options.type) {
      where.push("event_type LIKE ? ESCAPE '\\'");
      params.push(`${this.escapeLike(options.type)}%`);
    }
    const rows = this.db.prepare(
      `SELECT id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at
       FROM events WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, options.limit) as Array<Record<string, unknown>>;

    const names = new Map(
      (this.db.prepare("SELECT id, display_name FROM agents WHERE fleet_id = ?").all(fleetId) as Array<{ id: string; display_name: string }>)
        .map((a) => [a.id, a.display_name])
    );
    const nameOf = (raw: unknown): string | null => {
      if (typeof raw !== "string" || !raw) return null;
      return names.get(raw) ?? raw;
    };

    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      if (typeof r.payload_json === "string") {
        try { payload = JSON.parse(r.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
      }
      return {
        id: r.id,
        event_type: r.event_type,
        actor_kind: r.actor_kind,
        actor_id: r.actor_id ?? null,
        actor_name: nameOf(r.actor_id),
        resource_kind: r.resource_kind,
        resource_id: r.resource_id ?? null,
        resource_name: nameOf(r.resource_id),
        conversation_id: r.conversation_id ?? null,
        payload,
        created_at: r.created_at
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
    // Recent conversations sourced from the messages table (the latest message
    // per conversation), NOT the event firehose — so heartbeats from a busy
    // fleet never bury the operator's threads. Powers the console's nav list.
    // Human titles: a room shows its name, a direct conversation the agent's
    // name, a feed a generic label — never a raw conversation id in the UI.
    const opId = `op_${fleetId}`;
    const roomTitles = new Map(
      (this.db.prepare("SELECT id, name FROM rooms WHERE fleet_id = ?").all(fleetId) as Array<{ id: string; name: string }>)
        .map((r) => [r.id, r.name])
    );
    const agentTitles = new Map(
      (this.db.prepare("SELECT id, display_name FROM agents WHERE fleet_id = ? AND runtime != 'operator'").all(fleetId) as Array<{ id: string; display_name: string }>)
        .map((a) => [a.id, a.display_name])
    );
    const recentRows = this.db.prepare(
      `SELECT conversation_id, body_json, created_at, sender_agent_id, recipient_id FROM (
         SELECT conversation_id, body_json, created_at, sender_agent_id, recipient_id,
                ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC, id DESC) AS rn
         FROM messages WHERE fleet_id = ?
       ) WHERE rn = 1 ORDER BY created_at DESC LIMIT 25`
    ).all(fleetId) as Array<Record<string, unknown>>;

    // Distinct AGENT participants per conversation (senders + agent recipients,
    // operator excluded) — the truthful basis for dm-vs-group classification.
    // A last-speaker title alone lets a multi-agent thread masquerade as (and
    // hijack) an agent's 1:1 DM in the console.
    const participantsByConv = new Map<string, Set<string>>();
    if (recentRows.length) {
      const ph = recentRows.map(() => "?").join(",");
      const ids = recentRows.map((r) => String(r.conversation_id));
      const rows = this.db.prepare(
        `SELECT DISTINCT conversation_id, sender_agent_id, recipient_kind, recipient_id
         FROM messages WHERE fleet_id = ? AND conversation_id IN (${ph})`
      ).all(fleetId, ...ids) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const cid = String(row.conversation_id);
        const set = participantsByConv.get(cid) ?? new Set<string>();
        const sender = String(row.sender_agent_id ?? "");
        if (sender && sender !== opId && agentTitles.has(sender)) set.add(sender);
        if (String(row.recipient_kind) === "agent") {
          const rec = String(row.recipient_id ?? "");
          if (rec && rec !== opId && agentTitles.has(rec)) set.add(rec);
        }
        participantsByConv.set(cid, set);
      }
    }

    const recentConversations = recentRows.map((r) => {
      let preview = "";
      try {
        const body = JSON.parse(String(r.body_json) || "{}") as Record<string, unknown>;
        if (typeof body.text === "string") preview = body.text.slice(0, 100);
      } catch { /* malformed body — empty preview */ }
      const cid = String(r.conversation_id);
      const participants = Array.from(participantsByConv.get(cid) ?? []).slice(0, 6);
      let title: string;
      let kind: string;
      if (roomTitles.has(cid)) {
        kind = "room";
        title = "# " + roomTitles.get(cid);
      } else if (cid.startsWith("feed-")) {
        kind = "feed";
        title = "📰 News feed";
      } else if (participants.length === 1) {
        kind = "dm";
        title = agentTitles.get(participants[0]) || "Direct message";
      } else if (participants.length > 1) {
        kind = "group";
        const names = participants.map((p) => agentTitles.get(p) || p);
        title = names.slice(0, 2).join(" + ") + (names.length > 2 ? ` +${names.length - 2}` : "");
      } else {
        // No agent participant found (e.g. operator-only thread) — old fallback.
        kind = "direct";
        const other = String(r.sender_agent_id) === opId ? String(r.recipient_id ?? "") : String(r.sender_agent_id);
        title = agentTitles.get(other) || agentTitles.get(String(r.recipient_id ?? "")) || "Direct message";
      }
      return {
        conversation_id: r.conversation_id,
        last_at: r.created_at,
        sender_agent_id: r.sender_agent_id,
        preview,
        title,
        kind,
        participants
      };
    });
    return {
      agents,
      pendingApprovals: pendingApprovals.count,
      queuedMessages: queuedMessages.count,
      deadLetterCount,
      quarantinedAgentCount,
      rateLimitViolationsLast24h,
      recentEvents,
      recentConversations
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
      peer_turn_budget: Number(row.peer_turn_budget) || DEFAULT_PEER_TURN_BUDGET
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

  /**
   * A feed conversation's items are delivered as messages but never record a
   * message.queued event, so the event timeline would only show "delivered"
   * receipts. Render the actual feed items (headlines) from the messages table
   * instead, shaped as message.queued rows the frontend already draws as bubbles.
   * Returns the NEWEST page (chronological) so a capped limit shows recent items.
   */
  private getFeedConversation(
    fleetId: string,
    conversationId: string,
    options?: { search?: string; limit?: number; offset?: number; beforeAt?: string; beforeId?: string }
  ) {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const search = this.buildLikeSearch(options?.search);
    const beforeAt = options?.beforeAt?.trim();
    const beforeId = options?.beforeId?.trim();
    const where = ["fleet_id = ?", "conversation_id = ?"];
    const params: Array<string | number> = [fleetId, conversationId];
    if (beforeAt && beforeId) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(beforeAt, beforeAt, beforeId);
    }
    if (search) {
      where.push("LOWER(COALESCE(body_json, '')) LIKE ? ESCAPE '\\'");
      params.push(search);
    }
    const whereSql = where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${whereSql}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(
      `SELECT id, sender_agent_id, recipient_kind, recipient_id, body_json, created_at
       FROM messages WHERE ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<Record<string, unknown>>;
    rows.reverse(); // chronological (oldest -> newest) for display
    const items = rows.map((m) => {
      let body: Record<string, unknown> = {};
      try { body = (JSON.parse(String(m.body_json)) as Record<string, unknown>) || {}; } catch { /* non-JSON body */ }
      const feedName = typeof body.feed === "string" && body.feed ? body.feed : "Feed";
      return {
        id: String(m.id),
        event_type: "message.queued",
        actor_kind: "feed",
        actor_id: "feed",
        resource_kind: "message",
        resource_id: String(m.id),
        conversation_id: conversationId,
        payload_json: JSON.stringify({ text: body.text ?? "", feed: feedName, link: body.link, message_type: "feed", sender_label: feedName }),
        created_at: m.created_at,
        message_body_json: m.body_json,
        message_sender_id: m.sender_agent_id,
        message_recipient_kind: m.recipient_kind,
        message_recipient_id: m.recipient_id
      };
    });
    return { items, total };
  }

  getConversation(fleetId: string, conversationId: string, options?: { search?: string; type?: string; dateFrom?: string; dateTo?: string; sortBy?: string; sortOrder?: string; limit?: number; offset?: number; beforeAt?: string; beforeId?: string }) {
    if (conversationId.startsWith("feed-")) {
      return this.getFeedConversation(fleetId, conversationId, options);
    }
    const search = this.buildLikeSearch(options?.search);
    const type = options?.type && options.type !== "all" ? `${options.type}.%` : undefined;
    const dateFrom = this.normalizeDateStart(options?.dateFrom);
    const dateTo = this.normalizeDateEnd(options?.dateTo);
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    // Keyset cursor for infinite scroll-back: everything strictly OLDER than
    // (beforeAt, beforeId). Compound so events sharing a millisecond can never
    // be skipped or duplicated across pages (a plain created_at cursor loses
    // ties at the page boundary).
    const beforeAt = options?.beforeAt?.trim();
    const beforeId = options?.beforeId?.trim();
    const cursor = beforeAt && beforeId;
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
      cursor ? "(created_at < ? OR (created_at = ? AND id < ?))" : "",
      search
        ? "(LOWER(event_type) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(actor_id, '')) LIKE ? ESCAPE '\\' OR LOWER(resource_kind) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(resource_id, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(payload_json, '')) LIKE ? ESCAPE '\\')"
        : ""
    ].filter(Boolean).join(" AND ");

    const params: Array<string | number> = [fleetId, conversationId];
    if (type) params.push(type);
    if (dateFrom) params.push(dateFrom);
    if (dateTo) params.push(dateTo);
    if (cursor) params.push(beforeAt, beforeAt, beforeId);
    if (search) params.push(search, search, search, search, search);

    const rows = this.db.prepare(
      `SELECT id, event_type, actor_kind, actor_id, resource_kind, resource_id, payload_json, created_at
       FROM events
       WHERE ${where}
       ORDER BY ${sortBy} ${sortOrder}, id ${sortOrder}
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

  /**
   * The system operator sentinel for a fleet — a non-loginable operators row
   * that owns control actions the relay issues on its own behalf (auto-quarantine
   * from heartbeat timeout or rate-limit abuse). control_actions.issued_by_operator_id
   * is NOT NULL with a FK to operators(id), so system-issued actions need a real
   * operator row to reference; the literal "system" isn't one, and inserting it
   * throws FOREIGN KEY constraint failed — rolling back the entire sweep. Created
   * once per fleet, reused thereafter. The password hash is a sentinel that can
   * never match any password, so this operator can't be logged into.
   */
  ensureSystemOperator(fleetId: string): string {
    const systemOperatorId = `opr_system_${fleetId}`;
    const existing = this.db.prepare("SELECT id FROM operators WHERE id = ?").get(systemOperatorId);
    if (existing) return systemOperatorId;
    this.db.prepare(
      "INSERT INTO operators (id, fleet_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(systemOperatorId, fleetId, "system@ekho.internal", "!system-no-login", "system", nowIso());
    return systemOperatorId;
  }

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
          const systemOperatorId = this.ensureSystemOperator(String(agent.fleet_id));
          this.db.prepare(
            "UPDATE agents SET status = 'quarantined', auto_quarantined_at = ?, quarantine_reason = 'heartbeat_timeout', consecutive_missed_heartbeats = ? WHERE id = ?"
          ).run(nowIso(), missed, agent.id);

          this.db.prepare(
            "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(id("ctl"), agent.fleet_id, "agent", agent.id, "quarantine", JSON.stringify({ reason: "heartbeat_timeout", missed_count: missed }), systemOperatorId, nowIso());

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
      const systemOperatorId = this.ensureSystemOperator(fleetId);
      this.db.prepare(
        "UPDATE agents SET status = 'quarantined', auto_quarantined_at = ?, quarantine_reason = 'rate_limit_abuse' WHERE id = ? AND status NOT IN ('quarantined', 'paused')"
      ).run(now, agentId);

      this.db.prepare(
        "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id("ctl"), fleetId, "agent", agentId, "quarantine", JSON.stringify({ reason: "rate_limit_abuse", violation_count: row.count }), systemOperatorId, now);

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

  /**
   * Record an agent-raised "conversation stalled" notice as an operator-visible
   * `conversation.stalled` event. Idempotent per (fleet, agent, conversation):
   * at most ONE open stall is recorded until the next operator engagement in that
   * conversation re-opens things — so a repeating poll loop can call this every
   * tick without spamming the events feed. The latest operator event in the
   * conversation marks the re-open boundary; a stall newer than it already exists
   * → skip. Returns whether a new event was written.
   */
  recordConversationStall(
    fleetId: string,
    agentId: string,
    conversationId: string,
    payload: { reason: string; pending_count: number; budget?: number }
  ): { recorded: boolean } {
    const lastOperator = this.db.prepare(
      "SELECT MAX(created_at) AS ts FROM events WHERE fleet_id = ? AND conversation_id = ? AND actor_kind = 'operator'"
    ).get(fleetId, conversationId) as { ts: string | null } | undefined;
    const boundary = lastOperator?.ts ?? null;
    const existing = this.db.prepare(
      `SELECT 1 FROM events
       WHERE fleet_id = ? AND conversation_id = ? AND event_type = 'conversation.stalled' AND actor_id = ?
       ${boundary ? "AND created_at > ?" : ""}
       LIMIT 1`
    ).get(...(boundary ? [fleetId, conversationId, agentId, boundary] : [fleetId, conversationId, agentId]));
    if (existing) return { recorded: false };
    this.recordEvent(fleetId, "conversation.stalled", "agent", agentId, "conversation", conversationId, conversationId, {
      conversation_id: conversationId,
      reason: payload.reason,
      pending_count: payload.pending_count,
      budget: payload.budget ?? null
    });
    return { recorded: true };
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
