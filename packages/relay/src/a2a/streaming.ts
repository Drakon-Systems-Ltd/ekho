/**
 * Server-Sent Events (SSE) streaming for A2A task updates.
 *
 * A2A streaming is a lightweight fan-out: subscribers receive status & artifact
 * updates as the underlying task progresses. For Ekho v1 we emit events when
 * task state changes or artifacts are appended. Internal helpers rely on an
 * in-process EventEmitter — multi-process replication would move to Redis pub/sub.
 */
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { A2AStreamEvent, A2ATask, A2ATaskStatusUpdateEvent, A2ATaskArtifactUpdateEvent, A2AArtifact, A2ATaskStatus } from "./types";
import { success } from "./jsonrpc";
import type { JsonRpcId } from "./jsonrpc";

class TaskEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Tasks can have many listeners — lift the default warning limit.
    this.emitter.setMaxListeners(0);
  }

  emitStatus(taskId: string, update: A2ATaskStatusUpdateEvent) {
    this.emitter.emit(taskId, update);
  }

  emitArtifact(taskId: string, update: A2ATaskArtifactUpdateEvent) {
    this.emitter.emit(taskId, update);
  }

  subscribe(taskId: string, listener: (event: A2AStreamEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }
}

export const taskEventBus = new TaskEventBus();

export function publishStatus(task: A2ATask, status: A2ATaskStatus, final: boolean) {
  taskEventBus.emitStatus(task.id, {
    taskId: task.id,
    contextId: task.contextId,
    status,
    final,
    kind: "status-update",
  });
}

export function publishArtifact(task: A2ATask, artifact: A2AArtifact, lastChunk = false) {
  taskEventBus.emitArtifact(task.id, {
    taskId: task.id,
    contextId: task.contextId,
    artifact,
    append: false,
    lastChunk,
    kind: "artifact-update",
  });
}

/**
 * Opens an SSE response stream, writes the initial snapshot, then forwards
 * events from the bus until the client disconnects or the task finalises.
 */
export function openSseStream(opts: {
  request: FastifyRequest;
  reply: FastifyReply;
  task: A2ATask;
  rpcId: JsonRpcId;
  initialEvent?: A2AStreamEvent;
}): void {
  const { reply, request, task, rpcId, initialEvent } = opts;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeEvent = (event: A2AStreamEvent) => {
    const envelope = success(rpcId, event);
    reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
  };

  // Send initial snapshot — current task or caller-supplied event
  writeEvent(initialEvent ?? task);

  const unsubscribe = taskEventBus.subscribe(task.id, (event) => {
    writeEvent(event);
    if (event.kind === "status-update" && event.final) {
      close();
    }
  });

  // Keep-alive comment every 20s
  const keepAlive = setInterval(() => {
    reply.raw.write(":\n\n");
  }, 20_000);

  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
    reply.raw.end();
  };

  request.raw.on("close", close);
  request.raw.on("error", close);
}
