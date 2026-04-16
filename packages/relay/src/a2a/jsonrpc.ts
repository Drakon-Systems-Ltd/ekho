/**
 * JSON-RPC 2.0 envelope handling for A2A.
 * https://www.jsonrpc.org/specification
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Standard JSON-RPC error codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

// A2A-specific error codes
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;
export const A2A_UNSUPPORTED_OPERATION = -32004;
export const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005;
export const A2A_INVALID_AGENT_RESPONSE = -32006;

export class JsonRpcException extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export function parseRequest(raw: unknown): JsonRpcRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new JsonRpcException(JSONRPC_INVALID_REQUEST, "request must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    throw new JsonRpcException(JSONRPC_INVALID_REQUEST, "jsonrpc must be '2.0'");
  }
  if (typeof obj.method !== "string") {
    throw new JsonRpcException(JSONRPC_INVALID_REQUEST, "method must be a string");
  }
  return obj as unknown as JsonRpcRequest;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function fromException(id: JsonRpcId, err: unknown): JsonRpcError {
  if (err instanceof JsonRpcException) {
    return error(id, err.code, err.message, err.data);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return error(id, JSONRPC_INTERNAL_ERROR, msg);
}
