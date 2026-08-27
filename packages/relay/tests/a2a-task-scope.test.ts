import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

/**
 * #58 — A2A tasks/list, tasks/get and tasks/cancel must be scoped to the
 * authenticated caller and its fleet.
 *
 * Before the fix: POST /a2a passed targetAgentId undefined, so tasks/list
 * returned every a2a_tasks row in the fleet; tasks/get and tasks/cancel looked
 * the task up by id alone. Any enrolled agent could read any other agent's task
 * history and cancel its work.
 *
 * Each test below fails if the scoping is removed.
 */

const A2A_TASK_NOT_FOUND = -32001;
const JSONRPC_INVALID_PARAMS = -32602;

function sendParams(text: string, extra: Record<string, unknown> = {}) {
  return {
    message: {
      messageId: `msg_${text.replace(/\W+/g, "_")}`,
      role: "user",
      parts: [{ kind: "text", text }],
      kind: "message",
      ...extra,
    },
  };
}

describe("A2A task scoping (#58)", () => {
  let relay: TestRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  type Agent = { agent_id: string; secret: string };

  /** Create a task from `from` to `to` and return its id. */
  async function createTask(from: Agent, to: Agent, text: string): Promise<string> {
    const res = await relay.agentRequest(from.agent_id, from.secret, "POST", `/agents/${to.agent_id}/a2a`, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: sendParams(text),
    });
    expect(res.body.error).toBeUndefined();
    return res.body.result.id as string;
  }

  function rpc(caller: Agent, url: string, method: string, params: unknown, id: number | string = 7) {
    return relay.agentRequest(caller.agent_id, caller.secret, "POST", url, {
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
  }

  /**
   * A second fleet on the same relay, with one enrolled agent. Synthetic — the
   * fleet name and operator email exist only inside this test database.
   */
  async function enrollInOtherFleet(label: string): Promise<Agent> {
    const suffix = `${label}-${Math.random().toString(36).slice(2, 10)}`;
    const other = relay.db.createBootstrap(`other-fleet-${suffix}`, `admin-${suffix}@example.invalid`, "testpassword1");
    const token = relay.db.issueEnrollmentToken(other.fleetId, other.operatorId);
    const res = await relay.app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { fleet_id: other.fleetId, token, display_name: `foreign-${suffix}`, runtime: "custom" },
    });
    return JSON.parse(res.body) as Agent;
  }

  describe("two-agent isolation", () => {
    it("tasks/get on another agents task reports not-found, not the task", async () => {
      const alice = await relay.enrollAgent("scope-alice");
      const bob = await relay.enrollAgent("scope-bob");
      const eve = await relay.enrollAgent("scope-eve");

      const taskId = await createTask(alice, bob, "private plan for bob");

      // Eve knows the id (it leaks through logs, an operator console, anywhere)
      // and asks on both endpoints. Both must refuse — and must NOT confirm the
      // task exists, so the code is TaskNotFound rather than a forbidden.
      for (const url of ["/a2a", `/agents/${bob.agent_id}/a2a`, `/agents/${alice.agent_id}/a2a`]) {
        const res = await rpc(eve, url, "tasks/get", { id: taskId });
        expect(res.body.result).toBeUndefined();
        expect(res.body.error.code).toBe(A2A_TASK_NOT_FOUND);
      }
    });

    it("keeps history out of a non-participants reach entirely", async () => {
      const alice = await relay.enrollAgent("hist-alice");
      const bob = await relay.enrollAgent("hist-bob");
      const eve = await relay.enrollAgent("hist-eve");

      const taskId = await createTask(alice, bob, "confidential-marker-9f2c");

      const res = await rpc(eve, "/a2a", "tasks/get", { id: taskId });
      expect(JSON.stringify(res.body)).not.toContain("confidential-marker-9f2c");
    });

    it("tasks/list on the fleet hub returns only the callers own tasks", async () => {
      const alice = await relay.enrollAgent("list-alice");
      const bob = await relay.enrollAgent("list-bob");
      const carol = await relay.enrollAgent("list-carol");
      const dave = await relay.enrollAgent("list-dave");

      const aliceTask = await createTask(alice, bob, "alice to bob");
      const carolTask = await createTask(carol, dave, "carol to dave");

      const aliceList = await rpc(alice, "/a2a", "tasks/list", { limit: 50 });
      const ids = (aliceList.body.result.tasks as Array<{ id: string }>).map((t) => t.id);
      expect(ids).toContain(aliceTask);
      expect(ids).not.toContain(carolTask);
      // `total` must be scoped too — a truthful count is part of the leak.
      expect(aliceList.body.result.total).toBe(1);
    });

    it("tasks/list gives an uninvolved agent nothing at all", async () => {
      const alice = await relay.enrollAgent("empty-alice");
      const bob = await relay.enrollAgent("empty-bob");
      const eve = await relay.enrollAgent("empty-eve");
      await createTask(alice, bob, "not eves business");

      const onHub = await rpc(eve, "/a2a", "tasks/list", { limit: 50 });
      expect(onHub.body.result).toEqual({ tasks: [], total: 0 });

      // …including via the per-agent endpoint of a participant, which used to be
      // the only filter applied and let anyone enumerate a target's tasks.
      const onBob = await rpc(eve, `/agents/${bob.agent_id}/a2a`, "tasks/list", { limit: 50 });
      expect(onBob.body.result).toEqual({ tasks: [], total: 0 });
    });

    it("tasks/cancel by a non-participant is refused and leaves the task running", async () => {
      const alice = await relay.enrollAgent("cancel-alice");
      const bob = await relay.enrollAgent("cancel-bob");
      const eve = await relay.enrollAgent("cancel-eve");

      const taskId = await createTask(alice, bob, "work in progress");

      const res = await rpc(eve, "/a2a", "tasks/cancel", { id: taskId });
      expect(res.body.error.code).toBe(A2A_TASK_NOT_FOUND);

      const state = relay.db.raw().prepare("SELECT state FROM a2a_tasks WHERE id = ?").get(taskId) as { state: string };
      expect(state.state).toBe("submitted");
    });

    it("message/send cannot append to (or read back) a stranger's task", async () => {
      const alice = await relay.enrollAgent("append-alice");
      const bob = await relay.enrollAgent("append-bob");
      const eve = await relay.enrollAgent("append-eve");

      const taskId = await createTask(alice, bob, "alice history");

      const res = await rpc(
        eve,
        `/agents/${bob.agent_id}/a2a`,
        "message/send",
        sendParams("injected by eve", { taskId })
      );
      expect(res.body.result).toBeUndefined();
      expect(res.body.error.code).toBe(A2A_TASK_NOT_FOUND);

      const row = relay.db.raw().prepare("SELECT history_json FROM a2a_tasks WHERE id = ?").get(taskId) as {
        history_json: string;
      };
      expect(row.history_json).not.toContain("injected by eve");
    });

    it("refuses to re-address an existing task at a third agent", async () => {
      const alice = await relay.enrollAgent("readdress-alice");
      const bob = await relay.enrollAgent("readdress-bob");
      const carol = await relay.enrollAgent("readdress-carol");

      const taskId = await createTask(alice, bob, "for bob only");

      const res = await rpc(
        alice,
        `/agents/${carol.agent_id}/a2a`,
        "message/send",
        sendParams("now for carol", { taskId })
      );
      expect(res.body.error.code).toBe(JSONRPC_INVALID_PARAMS);
    });
  });

  describe("the legitimate owner workflow still works", () => {
    it("lets the creating agent get, list and cancel its own task", async () => {
      const alice = await relay.enrollAgent("owner-alice");
      const bob = await relay.enrollAgent("owner-bob");

      const taskId = await createTask(alice, bob, "alices own task");

      const got = await rpc(alice, "/a2a", "tasks/get", { id: taskId });
      expect(got.body.result.id).toBe(taskId);
      expect(got.body.result.history[0].parts[0].text).toBe("alices own task");

      const listed = await rpc(alice, `/agents/${bob.agent_id}/a2a`, "tasks/list", { limit: 10 });
      expect((listed.body.result.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(taskId);

      const canceled = await rpc(alice, "/a2a", "tasks/cancel", { id: taskId });
      expect(canceled.body.result.status.state).toBe("canceled");
    });

    it("lets the RECIPIENT agent get and cancel the task addressed to it", async () => {
      const alice = await relay.enrollAgent("recipient-alice");
      const bob = await relay.enrollAgent("recipient-bob");

      const taskId = await createTask(alice, bob, "bob please handle");

      const got = await rpc(bob, "/a2a", "tasks/get", { id: taskId });
      expect(got.body.result.id).toBe(taskId);

      const listed = await rpc(bob, "/a2a", "tasks/list", { limit: 10 });
      expect((listed.body.result.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(taskId);

      const canceled = await rpc(bob, "/a2a", "tasks/cancel", { id: taskId });
      expect(canceled.body.result.status.state).toBe("canceled");
    });

    it("lets the recipient reply on the same task", async () => {
      const alice = await relay.enrollAgent("reply-alice");
      const bob = await relay.enrollAgent("reply-bob");

      const taskId = await createTask(alice, bob, "question for bob");

      const reply = await rpc(
        bob,
        `/agents/${alice.agent_id}/a2a`,
        "message/send",
        sendParams("bobs answer", { taskId })
      );
      expect(reply.body.error).toBeUndefined();
      expect(reply.body.result.id).toBe(taskId);
      expect(reply.body.result.history).toHaveLength(2);
    });
  });

  describe("cross-fleet", () => {
    it("cannot open an A2A endpoint for an agent in another fleet", async () => {
      const local = await relay.enrollAgent("xfleet-local");
      const foreign = await enrollInOtherFleet("target");

      const res = await rpc(local, `/agents/${foreign.agent_id}/a2a`, "message/send", sendParams("hello stranger"));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("agent not found");
    });

    it("cannot name a foreign agent as recipient on the fleet hub", async () => {
      const local = await relay.enrollAgent("xfleet-hub");
      const foreign = await enrollInOtherFleet("hubtarget");

      const res = await relay.agentRequest(local.agent_id, local.secret, "POST", "/a2a", {
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        params: { ...sendParams("hello stranger"), recipientAgentId: foreign.agent_id },
      });
      expect(res.body.result).toBeUndefined();
      expect(res.body.error.code).toBe(JSONRPC_INVALID_PARAMS);

      // Nothing was minted before the refusal.
      const count = relay.db
        .raw()
        .prepare("SELECT COUNT(*) AS c FROM a2a_tasks WHERE sender_agent_id = ?")
        .get(local.agent_id) as { c: number };
      expect(count.c).toBe(0);
    });

    it("cannot read or cancel a task belonging to another fleet", async () => {
      const alice = await relay.enrollAgent("xfleet-alice");
      const bob = await relay.enrollAgent("xfleet-bob");
      const foreign = await enrollInOtherFleet("snooper");

      const taskId = await createTask(alice, bob, "in-fleet only");

      const got = await rpc(foreign, "/a2a", "tasks/get", { id: taskId });
      expect(got.body.error.code).toBe(A2A_TASK_NOT_FOUND);

      const canceled = await rpc(foreign, "/a2a", "tasks/cancel", { id: taskId });
      expect(canceled.body.error.code).toBe(A2A_TASK_NOT_FOUND);

      const listed = await rpc(foreign, "/a2a", "tasks/list", { limit: 50 });
      expect(listed.body.result).toEqual({ tasks: [], total: 0 });

      const state = relay.db.raw().prepare("SELECT state FROM a2a_tasks WHERE id = ?").get(taskId) as { state: string };
      expect(state.state).toBe("submitted");
    });
  });

  describe("recipient resolution", () => {
    it("refuses a revoked recipient instead of minting an orphan task", async () => {
      const sender = await relay.enrollAgent("revoked-sender");
      const gone = await relay.enrollAgent("revoked-target");
      relay.db.raw().prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), gone.agent_id);

      const res = await rpc(sender, "/a2a", "message/send", {
        ...sendParams("to a revoked agent"),
        recipientAgentId: gone.agent_id,
      });
      expect(res.body.result).toBeUndefined();
      expect(res.body.error.code).toBe(JSONRPC_INVALID_PARAMS);

      const count = relay.db
        .raw()
        .prepare("SELECT COUNT(*) AS c FROM a2a_tasks WHERE sender_agent_id = ?")
        .get(sender.agent_id) as { c: number };
      expect(count.c).toBe(0);
    });

    it("still lets an agent address the fleet operator over A2A", async () => {
      const sender = await relay.enrollAgent("op-recipient-sender");
      const operatorAgentId = relay.db.ensureOperatorAgent(relay.fleetId);

      const res = await rpc(sender, "/a2a", "message/send", {
        ...sendParams("message for the operator"),
        recipientAgentId: operatorAgentId,
      });
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.status.state).toBe("submitted");
    });
  });

  describe("streaming methods are scoped too", () => {
    it("tasks/resubscribe on a stranger's task errors instead of opening a stream", async () => {
      const alice = await relay.enrollAgent("stream-alice");
      const bob = await relay.enrollAgent("stream-bob");
      const eve = await relay.enrollAgent("stream-eve");

      const taskId = await createTask(alice, bob, "streamed work");

      const res = await relay.app.inject({
        method: "POST",
        url: "/a2a",
        headers: signed(eve, "POST", "/a2a", {
          jsonrpc: "2.0",
          id: 11,
          method: "tasks/resubscribe",
          params: { id: taskId },
        }),
        payload: { jsonrpc: "2.0", id: 11, method: "tasks/resubscribe", params: { id: taskId } },
      });

      // A JSON-RPC error body, NOT an SSE stream carrying the task snapshot.
      expect(res.headers["content-type"]).not.toContain("text/event-stream");
      expect(JSON.parse(res.body).error.code).toBe(A2A_TASK_NOT_FOUND);
      expect(res.body).not.toContain("streamed work");
    });
  });

  /**
   * Sign a request the same way TestRelay.agentRequest does, for the few cases
   * that need the raw reply (headers, non-JSON bodies) instead of parsed JSON.
   */
  function signed(agent: Agent, method: string, urlPath: string, payload: unknown): Record<string, string> {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
    const signature = crypto
      .createHmac("sha256", agent.secret)
      .update(`${method}\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`)
      .digest("hex");
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": agent.agent_id,
      "x-ekho-agent-secret": agent.secret,
      "x-ekho-timestamp": timestamp,
      "x-ekho-nonce": nonce,
      "x-ekho-signature": signature,
    };
  }
});
