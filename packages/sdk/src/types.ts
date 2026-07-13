export type AgentCredentials = {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  heartbeatIntervalSeconds?: number;
  pollIntervalSeconds?: number;
};

export type ActionDecision =
  | { decision: "allow" }
  | { decision: "deny" }
  | { decision: "pending_approval"; approval_id: string };

export type AttachmentMeta = { id: string; filename: string; mime: string; size_bytes: number };
export type AttachmentRef = AttachmentMeta;
export type AttachmentUploadInput = { filename: string; mime: string; dataBase64: string };

/** A quoted snapshot of another message — a reply target or a history entry. */
export type MessageSnapshot = {
  message_id: string;
  sender_agent_id: string;
  sender_kind: "operator" | "agent";
  sender_label: string;
  text: string;
  created_at: string;
};

export type InboxMessage = {
  message_id: string;
  conversation_id: string;
  correlation_id: string;
  sender_agent_id: string;
  /** "operator" iff the sender is the verified fleet operator; otherwise "agent". */
  sender_kind?: "operator" | "agent";
  message_type: string;
  priority: string;
  body: Record<string, unknown>;
  /** Resolved attachment metadata (never bytes). Fetch bytes via downloadAttachment. */
  attachments?: AttachmentMeta[];
  metadata: Record<string, unknown>;
  /** Agent ids this message is addressed to (@mentions). Empty = everyone. */
  mentions?: string[];
  /** Quoted snapshot of the message this replies to, or null. Same-conversation only. */
  reply_to?: MessageSnapshot | null;
  created_at: string;
  deadline_at: string;
};

export type ControlMessage = {
  control_id: string;
  action: string;
  reason: string;
};

export type RosterEntry = {
  agent_id: string;
  display_name: string;
  runtime: string;
  status: string;
};

export type InboxResponse = {
  messages: InboxMessage[];
  controls: ControlMessage[];
  /** Whether this agent recognizes the console operator as its verified principal. */
  operator_trusted?: boolean;
  /** Other agents in the same fleet (excludes the operator identity and self). */
  roster?: RosterEntry[];
  /** Operator-controlled bounded agent-to-agent delegation (live; absent on older relays). */
  peer_autoreply?: boolean;
  /** Per-conversation peer-turn budget set by the operator. */
  peer_turn_budget?: number;
  /** Project-mode rooms this agent belongs to: conversation id -> the higher
   *  per-room budget that overrides peer_turn_budget there (absent on older relays). */
  conversation_budgets?: Record<string, number>;
  /** Recent thread per room conversation (id -> chronological snapshots); {} for direct. */
  conversation_history?: Record<string, MessageSnapshot[]>;
  /** Rooms (among this batch) the polling agent is a member of, so a reply can be framed as going to the named room. */
  rooms?: Array<{ id: string; name: string }>;
};

export type SendMessagePayload = {
  recipient: { kind: "agent" | "group" | "broadcast"; id?: string };
  message_type: "direct" | "broadcast" | "alert" | "handoff" | "claim" | "complete" | "heartbeat" | "control";
  priority?: "low" | "normal" | "high" | "urgent";
  ttl_seconds?: number;
  requires_approval?: boolean;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  conversation_id: string;
  correlation_id: string;
};

export type HeartbeatPayload = {
  status: "healthy" | "degraded" | "busy" | "idle";
  active_conversation_ids?: string[];
  metrics?: Record<string, unknown>;
};

export type ProposeActionPayload = {
  conversation_id: string;
  action_type: string;
  summary: string;
  risk_level: "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown>;
};

export type ActionResultPayload = {
  approval_id: string;
  result: "executed" | "cancelled" | "failed";
  completed_at: string;
  output?: Record<string, unknown>;
};
