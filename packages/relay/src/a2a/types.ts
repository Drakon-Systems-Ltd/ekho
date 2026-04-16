/**
 * A2A v1.0 protocol types.
 * Spec: https://a2a-protocol.org/latest/specification/
 */

export type TaskState =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export const TERMINAL_STATES: TaskState[] = ["completed", "failed", "canceled", "rejected"];

export interface A2APart {
  kind: "text" | "data" | "file";
  text?: string;
  data?: Record<string, unknown>;
  file?: { name?: string; mimeType?: string; bytes?: string; uri?: string };
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  kind: "message";
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: TaskState;
  timestamp: string;
  message?: A2AMessage;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
  kind: "task";
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  final: boolean;
  kind: "status-update";
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  kind: "artifact-update";
}

export type A2AStreamEvent =
  | A2ATask
  | A2AMessage
  | A2ATaskStatusUpdateEvent
  | A2ATaskArtifactUpdateEvent;

export interface A2AAgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCardCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2AAgentCardProvider {
  organization: string;
  url: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  provider?: A2AAgentCardProvider;
  iconUrl?: string;
  protocolVersion: string;
  preferredTransport: "JSONRPC" | "HTTP+JSON" | "GRPC";
  capabilities: A2AAgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentCardSkill[];
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  supportsAuthenticatedExtendedCard?: boolean;
}
