import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { EkhoAgentClient } from "../../sdk/src/client";
import { createDeadLetterReporter } from "../src/delivery-phase-reporter";

type Phases = Array<Record<string, unknown>>;

function setup(postImpl?: (phases: Phases) => unknown) {
  const calls: Phases[] = [];
  const logs: string[] = [];
  let clock = Date.parse("2026-11-23T10:00:00.000Z");
  const post = vi.fn(async (phases: Phases) => {
    calls.push(phases);
    return postImpl ? postImpl(phases) : { recorded: phases.length, refused: 0 };
  });
  const reporter = createDeadLetterReporter({
    post: post as never,
    now: () => clock,
    log: (line: string) => { logs.push(line); }
  });
  return { reporter, post, calls, logs, tick: (ms: number) => { clock += ms; } };
}

const httpError = (status: number) =>
  new Error(`Ekho request failed for /v1/delivery-phases: ${status} nope`);

describe("createDeadLetterReporter", () => {
  it("T1: sends one entry with the decision-time clock value", async () => {
    const { reporter, calls, tick } = setup();
    reporter.enqueue("m1", "deadline_passed");
    tick(60_000);
    await reporter.flush();
    expect(calls).toEqual([[
      { message_id: "m1", phase: "dead_lettered", at: "2026-11-23T10:00:00.000Z", reason: "deadline_passed" }
    ]]);
  });

  it("T2: three entries make three separate calls in enqueue order", async () => {
    const { reporter, calls } = setup();
    reporter.enqueue("a", "deadline_passed");
    reporter.enqueue("b", "withheld_by_recipient");
    reporter.enqueue("c", "handoff_unclaimed");
    await reporter.flush();
    expect(calls.map((c) => c.length)).toEqual([1, 1, 1]);
    expect(calls.map((c) => [c[0]!.message_id, c[0]!.reason])).toEqual([
      ["a", "deadline_passed"], ["b", "withheld_by_recipient"], ["c", "handoff_unclaimed"]
    ]);
  });

  it("T3: a reason outside the closed set never reaches post and is logged once, generically", async () => {
    const { reporter, calls, logs } = setup();
    for (let i = 0; i < 3; i++) {
      reporter.enqueue(`m${i}`, "reload_withheld:peer_latch_closed");
      reporter.enqueue(`n${i}`, "unverifiable-require-signed");
    }
    await reporter.flush();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain("peer_latch_closed");
    expect(reporter.pending()).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("peer_latch_closed");
    expect(logs.join("\n")).not.toContain("unverifiable");
  });

  it("T3b: many distinct invalid reasons stay bounded and are never copied into diagnostics", async () => {
    const { reporter, calls, logs } = setup();
    for (let i = 0; i < 50; i++) reporter.enqueue(`m${i}`, `secret-detail-${i}\u001b[31m\nforged`);
    await reporter.flush();
    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/secret-detail|forged|\u001b|\n/);
  });

  it("T4: the same id is reported once, before and after a successful flush", async () => {
    const { reporter, calls } = setup();
    reporter.enqueue("m1", "deadline_passed");
    reporter.enqueue("m1", "handoff_unclaimed");
    await reporter.flush();
    reporter.enqueue("m1", "deadline_passed");
    await reporter.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.reason).toBe("deadline_passed");
  });

  it("T4b: a message id that is empty, not a string or over 200 characters is dropped", async () => {
    const { reporter, calls } = setup();
    reporter.enqueue("", "deadline_passed");
    reporter.enqueue(undefined as never, "deadline_passed");
    reporter.enqueue("x".repeat(201), "deadline_passed");
    reporter.enqueue("x".repeat(200), "deadline_passed");
    await reporter.flush();
    expect(calls).toHaveLength(1);
  });

  it("T5: a 404 turns reporting off for the life of the instance", async () => {
    const { reporter, calls, logs } = setup((p) => {
      if (p[0]!.message_id === "a") throw httpError(404);
      return { recorded: 1, refused: 0 };
    });
    reporter.enqueue("a", "deadline_passed");
    reporter.enqueue("b", "deadline_passed");
    await reporter.flush();
    expect(calls).toHaveLength(1);
    expect(reporter.pending()).toBe(0);
    expect(reporter.disabled()).toBe(true);
    reporter.enqueue("c", "deadline_passed");
    await reporter.flush();
    expect(calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("T6: a 400 drops only that entry and keeps reporting on", async () => {
    const { reporter, calls, logs } = setup((p) => {
      if (p[0]!.message_id === "b") throw httpError(400);
      return { recorded: 1, refused: 0 };
    });
    reporter.enqueue("a", "deadline_passed");
    reporter.enqueue("b", "withheld_by_recipient");
    reporter.enqueue("c", "handoff_unclaimed");
    await reporter.flush();
    expect(calls.map((c) => c[0]!.message_id)).toEqual(["a", "b", "c"]);
    expect(reporter.pending()).toBe(0);
    expect(reporter.disabled()).toBe(false);
    reporter.enqueue("d", "withheld_by_recipient");
    await reporter.flush();
    expect(calls.map((c) => c[0]!.message_id)).toEqual(["a", "b", "c", "d"]);
    expect(logs.filter((l) => l.includes("withheld_by_recipient"))).toHaveLength(1);
  });

  it("T7: a network failure keeps the entry, stops the flush, and gives up after three attempts", async () => {
    const { reporter, calls } = setup((p) => {
      if (p[0]!.message_id === "a") throw new Error("fetch failed");
      return { recorded: 1, refused: 0 };
    });
    reporter.enqueue("a", "deadline_passed");
    reporter.enqueue("b", "deadline_passed");
    await reporter.flush();
    expect(calls.map((c) => c[0]!.message_id)).toEqual(["a"]);
    expect(reporter.pending()).toBe(2);
    await reporter.flush();
    await reporter.flush();
    expect(calls.map((c) => c[0]!.message_id)).toEqual(["a", "a", "a"]);
    expect(reporter.pending()).toBe(1);
    await reporter.flush();
    expect(calls.map((c) => c[0]!.message_id)).toEqual(["a", "a", "a", "b"]);
  });

  it("T7b: 401, 403, 429 and 5xx are retryable", async () => {
    for (const status of [401, 403, 429, 503]) {
      const { reporter, calls } = setup(() => { throw httpError(status); });
      reporter.enqueue("a", "deadline_passed");
      await reporter.flush();
      expect(reporter.pending()).toBe(1);
      expect(reporter.disabled()).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("T8: no input makes enqueue throw or flush reject", async () => {
    const sync = setup();
    sync.post.mockImplementation((() => { throw new Error("boom"); }) as never);
    sync.reporter.enqueue("a", "deadline_passed");
    await expect(sync.reporter.flush()).resolves.toBeUndefined();

    const badLog = createDeadLetterReporter({
      post: (async () => ({ recorded: 1, refused: 0 })) as never,
      now: () => 0,
      log: () => { throw new Error("log boom"); }
    });
    expect(() => badLog.enqueue("a", "not-a-reason")).not.toThrow();
    badLog.enqueue("b", "deadline_passed");
    await expect(badLog.flush()).resolves.toBeUndefined();

    const garbage = setup(() => "garbage");
    garbage.reporter.enqueue("a", "deadline_passed");
    await expect(garbage.reporter.flush()).resolves.toBeUndefined();

    const badClock = createDeadLetterReporter({
      post: (async () => ({ recorded: 1, refused: 0 })) as never,
      now: () => { throw new Error("clock"); },
      log: () => {}
    });
    expect(() => badClock.enqueue("a", "deadline_passed")).not.toThrow();
    await expect(badClock.flush()).resolves.toBeUndefined();
  });

  it("T9: the ring keeps 500 and drops the oldest; a flush makes at most 20 calls", async () => {
    const full = setup();
    for (let i = 0; i < 501; i++) full.reporter.enqueue(`m${i}`, "deadline_passed");
    expect(full.reporter.pending()).toBe(500);
    expect(full.logs).toHaveLength(0);
    await full.reporter.flush();
    expect(full.calls[0]![0]!.message_id).toBe("m1");
    expect(full.logs).toHaveLength(1);

    const batch = setup();
    for (let i = 0; i < 25; i++) batch.reporter.enqueue(`m${i}`, "deadline_passed");
    await batch.reporter.flush();
    expect(batch.calls).toHaveLength(20);
    await batch.reporter.flush();
    expect(batch.calls).toHaveLength(25);
    expect(batch.reporter.pending()).toBe(0);
  });

  it("T9b: overflow during a pending POST keeps the in-flight id reserved, so a same-id enqueue is not re-sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const { reporter, calls } = setup(async () => {
      if (first) { first = false; await gate; }
      return { recorded: 1, refused: 0 };
    });
    reporter.enqueue("m0", "deadline_passed");
    const running = reporter.flush();
    await Promise.resolve();
    for (let i = 1; i <= 500; i++) reporter.enqueue(`m${i}`, "deadline_passed");
    expect(reporter.pending()).toBe(500);
    reporter.enqueue("m0", "handoff_unclaimed");
    expect(reporter.pending()).toBe(500);
    release();
    await running;
    for (let i = 0; i < 30; i++) await reporter.flush();
    expect(reporter.pending()).toBe(0);
    const ids = calls.map((c) => c[0]!.message_id as string);
    expect(ids.filter((id) => id === "m0")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("m1");
  });

  it("T10: overlapping flush calls share one run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { reporter, calls } = setup(async () => { await gate; return { recorded: 1, refused: 0 }; });
    reporter.enqueue("a", "deadline_passed");
    const first = reporter.flush();
    const second = reporter.flush();
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
  });

  it("T11: a refused result is final", async () => {
    const { reporter, calls } = setup(() => ({ recorded: 0, refused: 1 }));
    reporter.enqueue("a", "deadline_passed");
    await reporter.flush();
    await reporter.flush();
    expect(calls).toHaveLength(1);
    expect(reporter.pending()).toBe(0);
  });

  it("T13: log lines carry the id and coarse reason only", async () => {
    const { reporter, logs } = setup(() => { throw httpError(400); });
    reporter.enqueue("msg-secret-id", "deadline_passed");
    await reporter.flush();
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("T12: pins the real SDK error text for 404 and 400", async () => {
    const statuses = [404, 400];
    const server = http.createServer((req, res) => {
      req.resume();
      res.statusCode = statuses.shift() ?? 200;
      res.end(res.statusCode === 200 ? JSON.stringify({ recorded: 1, refused: 0 }) : "no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new EkhoAgentClient({ agentId: "a1", secret: "s", relayBaseUrl: `http://127.0.0.1:${port}` });
      const post = (phases: never) => client.reportDeliveryPhases(phases);

      const off = createDeadLetterReporter({ post, now: () => 0, log: () => {} });
      off.enqueue("a", "deadline_passed");
      await off.flush();
      expect(off.disabled()).toBe(true);
      expect(off.pending()).toBe(0);

      statuses.splice(0, statuses.length, 400, 200);
      const on = createDeadLetterReporter({ post, now: () => 0, log: () => {} });
      on.enqueue("a", "deadline_passed");
      on.enqueue("b", "deadline_passed");
      await on.flush();
      expect(on.disabled()).toBe(false);
      expect(on.pending()).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
