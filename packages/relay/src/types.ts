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
  body: z.record(z.string(), z.unknown()).or(z.object({ text: z.string() })),
  metadata: z.record(z.string(), z.unknown()).optional(),
  conversation_id: z.string().min(1),
  correlation_id: z.string().min(1)
});

export const ackSchema = z.object({
  acks: z.array(z.object({
    message_id: z.string().min(1),
    status: z.enum(["received"]),
    received_at: z.string().datetime()
  })).min(1)
});

export const heartbeatSchema = z.object({
  status: z.enum(["healthy", "degraded", "busy", "idle"]),
  active_conversation_ids: z.array(z.string()).optional().default([]),
  metrics: z.record(z.string(), z.unknown()).optional().default({})
});

export const enrollSchema = z.object({
  fleet_id: z.string().min(1),
  token: z.string().min(1),
  display_name: z.string().min(1),
  runtime: z.enum(["custom", "openclaw", "langgraph", "autogen"]),
  hostname: z.string().optional(),
  capabilities: z.array(z.string()).optional().default([])
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

export const operatorMessageSchema = z.object({
  recipient_agent_id: z.string().min(1),
  text: z.string().min(1).max(8000),
  conversation_id: z.string().min(1).optional(),
  attachment_ids: z.array(z.string().min(1)).max(50).optional()
});

export const operatorControlSchema = z.object({
  reason: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  redirect_agent_id: z.string().optional()
});

export const operatorTrustSchema = z.object({
  trusted: z.boolean()
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
