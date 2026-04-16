import type Database from "better-sqlite3";
import { id, nowIso } from "../utils";
import type { A2AArtifact, A2AMessage, A2ATask, A2ATaskStatus, TaskState } from "./types";
import { TERMINAL_STATES } from "./types";

interface TaskRow {
  id: string;
  fleet_id: string;
  agent_id: string;
  context_id: string;
  state: TaskState;
  history_json: string;
  artifacts_json: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export class A2ATaskStore {
  constructor(private db: Database.Database) {}

  createTask(input: {
    fleetId: string;
    agentId: string;
    contextId?: string;
    initialMessage?: A2AMessage;
    metadata?: Record<string, unknown>;
  }): A2ATask {
    const taskId = id("task");
    const contextId = input.contextId ?? id("ctx");
    const now = nowIso();
    const history = input.initialMessage ? [input.initialMessage] : [];

    this.db.prepare(
      `INSERT INTO a2a_tasks
       (id, fleet_id, agent_id, context_id, state, history_json, artifacts_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      taskId,
      input.fleetId,
      input.agentId,
      contextId,
      "submitted",
      JSON.stringify(history),
      "[]",
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return {
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: now },
      history,
      artifacts: [],
      metadata: input.metadata,
      kind: "task",
    };
  }

  getTask(taskId: string): A2ATask | null {
    const row = this.db.prepare("SELECT * FROM a2a_tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  listTasks(filters: {
    fleetId?: string;
    agentId?: string;
    state?: TaskState;
    limit: number;
    offset: number;
  }): { tasks: A2ATask[]; total: number } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filters.fleetId) {
      conditions.push("fleet_id = ?");
      params.push(filters.fleetId);
    }
    if (filters.agentId) {
      conditions.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.state) {
      conditions.push("state = ?");
      params.push(filters.state);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM a2a_tasks ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM a2a_tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filters.limit, filters.offset) as TaskRow[];

    return {
      tasks: rows.map((r) => this.rowToTask(r)),
      total: totalRow.count,
    };
  }

  updateStatus(taskId: string, state: TaskState, message?: A2AMessage): A2ATaskStatus | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    if (TERMINAL_STATES.includes(task.status.state)) {
      throw new Error(`task ${taskId} is in terminal state ${task.status.state}`);
    }

    const now = nowIso();
    const newHistory = [...(task.history ?? [])];
    if (message) newHistory.push(message);

    this.db
      .prepare("UPDATE a2a_tasks SET state = ?, history_json = ?, updated_at = ? WHERE id = ?")
      .run(state, JSON.stringify(newHistory), now, taskId);

    return { state, timestamp: now, message };
  }

  appendArtifact(taskId: string, artifact: A2AArtifact): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const artifacts = [...(task.artifacts ?? []), artifact];
    this.db
      .prepare("UPDATE a2a_tasks SET artifacts_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(artifacts), nowIso(), taskId);
    return true;
  }

  appendMessage(taskId: string, message: A2AMessage): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    const history = [...(task.history ?? []), message];
    this.db
      .prepare("UPDATE a2a_tasks SET history_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(history), nowIso(), taskId);
    return true;
  }

  linkMessage(taskId: string, messageId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO a2a_task_messages (task_id, message_id) VALUES (?, ?)")
      .run(taskId, messageId);
  }

  cancelTask(taskId: string): A2ATask | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (TERMINAL_STATES.includes(task.status.state)) {
      return task;
    }
    this.updateStatus(taskId, "canceled");
    return this.getTask(taskId);
  }

  private rowToTask(row: TaskRow): A2ATask {
    return {
      id: row.id,
      contextId: row.context_id,
      status: { state: row.state, timestamp: row.updated_at },
      history: JSON.parse(row.history_json) as A2AMessage[],
      artifacts: JSON.parse(row.artifacts_json) as A2AArtifact[],
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
      kind: "task",
    };
  }
}
