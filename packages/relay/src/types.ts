import { z } from "zod";

export const recipientSchema = z.object({
  kind: z.enum(["agent", "group", "broadcast"]),
  id: z.string().min(1).optional()
}).refine((value) => value.kind === "broadcast" || Boolean(value.id), {
  message: "recipient.id is required unless recipient.kind is broadcast"
});

export const sendMessageSchema = z.object({
  recipient: recipientSchema,
  message_type: z.enum(["direct", "broadcast", "alert", "handoff", "claim", "complete", "heartbeat", "control"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  ttl_seconds: z.number().int().positive().max(86400).default(900),
  requires_approval: z.boolean().optional().default(false),
  body: z.record(z.string(), z.unknown()).or(z.object({ text: z.string() }))
    .refine((b) => JSON.stringify(b).length <= 16384, { message: "message body too large (max 16KB)" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  conversation_id: z.string().min(1),
  correlation_id: z.string().min(1),
  // Verifiable peer identity (optional): the agent signs the canonical payload
  // with its own identity key; relayed verbatim for the recipient to verify.
  agent_sig: z.string().min(1).max(128).optional(),
  key_id: z.string().min(1).max(32).optional(),
  sig_canonical: z.record(z.string(), z.unknown()).optional()
});

export const ackSchema = z.object({
  acks: z.array(z.object({
    message_id: z.string().min(1),
    status: z.enum(["received"]),
    received_at: z.string().datetime()
  })).min(1)
});

// An agent-raised operator-visible notice. Today the only kind is a stalled
// conversation (peer-turn budget exhausted with real work withheld), recorded as
// a `conversation.stalled` event the operator console already surfaces.
export const noticeSchema = z.object({
  conversation_id: z.string().min(1),
  reason: z.string().min(1).max(64).default("peer_turn_budget_exhausted"),
  pending_count: z.number().int().nonnegative().max(10000).default(0),
  budget: z.number().int().positive().max(10000).optional()
});

export const heartbeatSchema = z.object({
  status: z.enum(["healthy", "degraded", "busy", "idle"]),
  active_conversation_ids: z.array(z.string()).optional().default([]),
  metrics: z.record(z.string(), z.unknown()).optional().default({})
});

export const identityKeySchema = z.object({
  public_key: z.string().min(1).max(128)
});

export const enrollSchema = z.object({
  fleet_id: z.string().min(1),
  token: z.string().min(1),
  display_name: z.string().min(1),
  runtime: z.enum(["custom", "openclaw", "langgraph", "autogen"]),
  hostname: z.string().optional(),
  capabilities: z.array(z.string()).optional().default([]),
  // The agent's own Ed25519 identity public key (agent-to-agent trust). Optional
  // for back-compat; agents that omit it simply can't be peer-verified yet.
  identity_public_key: z.string().min(1).max(128).optional()
});

export const proposeActionSchema = z.object({
  conversation_id: z.string().min(1),
  action_type: z.string().min(1),
  summary: z.string().min(1),
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  payload: z.record(z.string(), z.unknown())
});

export const actionResultSchema = z.object({
  approval_id: z.string().min(1),
  result: z.enum(["executed", "cancelled", "failed"]),
  completed_at: z.string().datetime(),
  output: z.record(z.string(), z.unknown()).optional().default({})
});

export const operatorLoginSchema = z.object({
  fleet_name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8)
});

export const operatorMessageSchema = z
  .object({
    // Target either a single agent (or "broadcast") OR a room.
    recipient_agent_id: z.string().min(1).optional(),
    room_id: z.string().min(1).optional(),
    text: z.string().min(1).max(8000),
    conversation_id: z.string().min(1).optional(),
    attachment_ids: z.array(z.string().min(1)).max(50).optional(),
    // @mentions (agent ids the message is addressed to) + reply-to (a prior
    // message id this one answers). Routing/context hints, not part of the signature.
    mentions: z.array(z.string().min(1)).max(20).optional(),
    reply_to: z.string().min(1).max(40).optional(),
    // Verifiable operator identity (optional): the client signs the canonical
    // payload with its operator key; the relay stores/relays all three verbatim.
    operator_sig: z.string().min(1).max(128).optional(),
    key_id: z.string().min(1).max(32).optional(),
    sig_canonical: z.record(z.string(), z.unknown()).optional()
  })
  .refine((d) => Boolean(d.recipient_agent_id) || Boolean(d.room_id), {
    message: "recipient_agent_id or room_id is required"
  });

export const createRoomSchema = z.object({
  name: z.string().min(1).max(120),
  member_agent_ids: z.array(z.string().min(1)).max(50).default([])
});

// Agent-opened topic room. Same shape as the operator schema; the creating
// agent is auto-added as a member by the relay, so member_agent_ids lists the
// OTHER agents to pull in (it may be empty).
export const agentCreateRoomSchema = z.object({
  name: z.string().min(1).max(120),
  member_agent_ids: z.array(z.string().min(1)).max(50).default([])
});

export const createFeedSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().max(2000),
  poll_interval_minutes: z.number().int().min(5).max(1440).default(30),
  subscriber_agent_ids: z.array(z.string().min(1)).max(50).default([])
});

export const feedSubscribersSchema = z.object({
  agent_ids: z.array(z.string().min(1)).max(50).default([])
});

export const operatorControlSchema = z.object({
  reason: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  redirect_agent_id: z.string().optional()
});

export const operatorTrustSchema = z.object({
  trusted: z.boolean()
});

export const operatorKeySchema = z.object({
  public_key: z.string().min(1).max(128),
  label: z.string().min(1).max(80),
  // Present when adding a device key: an existing trusted key vouches for it.
  endorsement: z
    .object({
      endorsed_by_key_id: z.string().min(1).max(32),
      signature: z.string().min(1).max(128)
    })
    .optional()
});

export const endorseAgentKeySchema = z.object({
  key_id: z.string().min(1).max(32),
  endorsed_by_key_id: z.string().min(1).max(32),
  signature: z.string().min(1).max(128)
});

export const peerAutoreplySchema = z.object({
  autoreply: z.boolean(),
  // Optional — when omitted, the existing per-agent budget is left untouched.
  budget: z.number().int().min(1).max(200).optional()
});

// Room project mode: a higher per-room peer budget for designated working rooms.
export const projectModeSchema = z.object({
  enabled: z.boolean(),
  // Optional — when omitted, the room's existing budget is left untouched.
  budget: z.number().int().min(1).max(500).optional()
});

// Operator profile: the team-visible display name (e.g. "Michael"). Trimmed,
// 1–40 chars — a name, not a bio.
export const operatorProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(40)
});

// Operator resume of a stalled thread: optional custom nudge text.
export const resumeConversationSchema = z.object({
  text: z.string().min(1).max(2000).optional()
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type AckInput = z.infer<typeof ackSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type EnrollInput = z.infer<typeof enrollSchema>;
export type ProposeActionInput = z.infer<typeof proposeActionSchema>;

// Policy engine schemas
export const policyRuleSchema = z.object({
  action: z.enum(["allow", "deny"]),
  conditions: z.object({
    sender_agent_id: z.union([z.string(), z.array(z.string())]).optional(),
    recipient_agent_id: z.union([z.string(), z.array(z.string())]).optional(),
    message_type: z.union([z.string(), z.array(z.string())]).optional(),
    priority: z.union([z.string(), z.array(z.string())]).optional()
  })
});

export const createPolicySchema = z.object({
  name: z.string().min(1),
  scope_kind: z.enum(["fleet", "agent"]),
  scope_id: z.string().optional(),
  rule: policyRuleSchema,
  enabled: z.boolean().default(true)
});

export const updatePolicySchema = z.object({
  name: z.string().min(1).optional(),
  scope_kind: z.enum(["fleet", "agent"]).optional(),
  scope_id: z.string().nullable().optional(),
  rule: policyRuleSchema.optional(),
  enabled: z.boolean().optional()
});

export type PolicyRule = z.infer<typeof policyRuleSchema>;

// --- Attachments ---
export const attachmentUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(127),
  // Declared decoded size in bytes; cross-checked against actual decoded length.
  size_bytes: z.number().int().nonnegative(),
  data_base64: z.string().min(1)
});

// Extend the message body to optionally carry attachment ids. The existing
// sendMessageSchema.body accepts `z.record(...)`, so attachments already pass
// through untyped; this dedicated schema is used to VALIDATE the array shape
// (count cap + id format) inside createMessage, not at the route boundary.
export const attachmentIdsSchema = z.array(z.string().min(1)).max(50); // hard ceiling; per-message cap enforced via config

export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;
