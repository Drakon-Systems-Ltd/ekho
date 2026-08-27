import type Database from "better-sqlite3";
import { id, nowIso } from "../utils";
import type { A2AArtifact, A2AMessage, A2ATask, A2ATaskStatus, TaskState } from "./types";
import { TERMINAL_STATES } from "./types";

interface TaskRow {
  id: string;
  fleet_id: string;
  agent_id: string;
  sender_agent_id: string | null;
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
    /** The agent that created the task (#58) — half of the participant pair. */
    senderAgentId: string;
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
       (id, fleet_id, agent_id, sender_agent_id, context_id, state, history_json, artifacts_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      taskId,
      input.fleetId,
      input.agentId,
      input.senderAgentId,
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

  /**
   * Unscoped read. Internal callers only (status updates, cancel bookkeeping) —
   * anything reachable from an A2A request MUST go through getTaskForParticipant.
   */
  getTask(taskId: string): A2ATask | null {
    const row = this.db.prepare("SELECT * FROM a2a_tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * #58: the only task read an A2A caller gets. A task is visible to exactly the
   * two agents on it — the sender that created it and the recipient it was
   * addressed to — and only within their own fleet. Everyone else gets null,
   * which the method layer renders as TaskNotFound so the endpoint never
   * discloses that another agent's task exists.
   *
   * Rows migrated from before sender_agent_id existed and whose sender could not
   * be recovered hold NULL, which matches no caller: fail closed.
   */
  getTaskForParticipant(taskId: string, scope: { fleetId: string; agentId: string }): A2ATask | null {
    const row = this.db
      .prepare(
        "SELECT * FROM a2a_tasks WHERE id = ? AND fleet_id = ? AND (agent_id = ? OR sender_agent_id = ?)"
      )
      .get(taskId, scope.fleetId, scope.agentId, scope.agentId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /** Participants of a task, for callers that must check membership themselves. */
  taskParticipants(taskId: string): { fleetId: string; recipientAgentId: string; senderAgentId: string | null } | null {
    const row = this.db
      .prepare("SELECT fleet_id, agent_id, sender_agent_id FROM a2a_tasks WHERE id = ?")
      .get(taskId) as { fleet_id: string; agent_id: string; sender_agent_id: string | null } | undefined;
    if (!row) return null;
    return { fleetId: row.fleet_id, recipientAgentId: row.agent_id, senderAgentId: row.sender_agent_id };
  }

  /**
   * #58: listing is participant-scoped by construction — fleetId and
   * participantAgentId are REQUIRED, so there is no call shape that produces a
   * fleet-wide scan. `counterpartyAgentId` narrows further to the tasks shared
   * with one other agent (what /agents/{id}/a2a asks for); it never widens.
   */
  listTasks(filters: {
    fleetId: string;
    participantAgentId: string;
    counterpartyAgentId?: string;
    state?: TaskState;
    limit: number;
    offset: number;
  }): { tasks: A2ATask[]; total: number } {
    const conditions: string[] = ["fleet_id = ?", "(agent_id = ? OR sender_agent_id = ?)"];
    const params: Array<string | number> = [
      filters.fleetId,
      filters.participantAgentId,
      filters.participantAgentId,
    ];

    if (filters.counterpartyAgentId) {
      conditions.push("(agent_id = ? OR sender_agent_id = ?)");
      params.push(filters.counterpartyAgentId, filters.counterpartyAgentId);
    }
    if (filters.state) {
      conditions.push("state = ?");
      params.push(filters.state);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
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
