import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { config } from "../src/config";

/**
 * #155 — query-time `fetch_wait` classification (design §2.3).
 *
 * A delivery that waited a long time before the adapter fetched it looks the
 * same at the relay whether the adapter was busy inside a turn (it does not
 * poll during a turn) or its inbox loop was stalled. The relay tells the two
 * apart from the recipient's own retained turn-attempt intervals:
 *
 *   prompt         fetched within the stale threshold
 *   adapter_busy   the fetch gap is at least 80 % covered by the recipient's
 *                  retained turn intervals
 *   inbox_stalled  any other long gap
 *   null           unknown: not fetched yet, or fetched more than once (the
 *                  gap then includes retry back-off, not a plain fetch wait)
 *
 * Nothing is stored. The label is derived on every read, so a late report
 * reclassifies. It is approximate: turn intervals are adapter-clock.
 */
describe("#155: query-time fetch_wait classification", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => { relay.cleanup(); });

  type Agent = { agent_id: string; secret: string };
  const STALE_S = 120; // config.inboxStaleSeconds default
  const CAP_S = 900; // config.turnIntervalCapSeconds default
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  async function direct(from: Agent, to: Agent) {
    const sent = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: to.agent_id }, message_type: "direct", body: { text: "work" },
      conversation_id: `fw-${Math.random()}`, correlation_id: `fw-${Math.random()}`
    });
    expect(sent.status).toBe(200);
    return sent.body.message_id as string;
  }
  async function fetchWait(sender: Agent, id: string) {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "GET", `/v1/messages/${id}/status`);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toHaveProperty("fetch_wait");
    return res.body.deliveries[0].fetch_wait as string | null;
  }
  /** Place a delivery's fetch gap in the past: queued and fetched `…SecAgo`. */
  function setGap(id: string, recipient: Agent, queuedSecAgo: number, fetchedSecAgo: number, attempts = 1) {
    const now = Date.now(); // one clock read, so the gap length is exact
    const r = relay.db.raw().prepare(`UPDATE message_deliveries
      SET queued_at = ?, delivered_at = ?, status = 'delivered', delivery_attempts = ?
      WHERE message_id = ? AND recipient_agent_id = ?`)
      .run(new Date(now - queuedSecAgo * 1000).toISOString(), new Date(now - fetchedSecAgo * 1000).toISOString(), attempts, id, recipient.agent_id);
    expect(r.changes).toBe(1);
  }
  let turnSeq = 0;
  /** Report one turn of `agent` covering delivery `id`, `[startSecAgo, endSecAgo]`; no end = still open. */
  async function turn(agent: Agent, id: string, startSecAgo: number, endSecAgo?: number, turnId = `turn.fw.${++turnSeq}`) {
    const phases: unknown[] = [{ message_id: id, phase: "turn_started", at: iso(startSecAgo * 1000), turn_id: turnId, attempt: 1 }];
    if (endSecAgo !== undefined) phases.push({ message_id: id, phase: "turn_ended", at: iso(endSecAgo * 1000), turn_id: turnId, attempt: 1, outcome: "completed" });
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/delivery-phases", { phases });
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(phases.length);
    return turnId;
  }

  it("is null until the delivery is fetched, and prompt when fetched inside the threshold", async () => {
    const a = await relay.enrollAgent("fw-prompt-a");
    const b = await relay.enrollAgent("fw-prompt-b");
    const id = await direct(a, b);
    expect(await fetchWait(a, id)).toBeNull(); // queued, never fetched: unknown, not "stalled"

    await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    expect(await fetchWait(a, id)).toBe("prompt");

    // Exactly at the threshold is still prompt; the rule is "longer than".
    setGap(id, b, 1000 + STALE_S, 1000);
    expect(await fetchWait(a, id)).toBe("prompt");
  });

  it("labels a long gap with no retained turn interval inbox_stalled", async () => {
    const a = await relay.enrollAgent("fw-stall-a");
    const b = await relay.enrollAgent("fw-stall-b");
    const id = await direct(a, b);
    setGap(id, b, 1000, 1000 - (STALE_S + 1));
    expect(await fetchWait(a, id)).toBe("inbox_stalled");
  });

  it("labels the gap adapter_busy from a retained interval, even after turn end and an idle heartbeat (design §2.3)", async () => {
    const a = await relay.enrollAgent("fw-busy-a");
    const b = await relay.enrollAgent("fw-busy-b");
    const earlier = await direct(a, b); // the work that kept b busy
    const waiting = await direct(a, b); // arrived mid-turn, fetched only after it

    // waiting: queued 1000 s ago, fetched 400 s ago (600 s gap).
    setGap(waiting, b, 1000, 400);
    // b's turn on `earlier` ran 1100 s → 410 s ago: covers 590 of 600 s.
    await turn(b, earlier, 1100, 410);
    // The sequence that would erase heartbeat-only evidence: the turn ends,
    // an idle heartbeat lands, then the fetch happens.
    const hb = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: { adapter_state: "idle" } });
    expect(hb.status).toBe(200);

    expect(await fetchWait(a, waiting)).toBe("adapter_busy");
    // Derived, never stored: there is no column to go stale.
    const cols = relay.db.raw().prepare("PRAGMA table_info(message_deliveries)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("fetch_wait");
  });

  it("needs at least 80 % coverage, and counts overlapping intervals once", async () => {
    const a = await relay.enrollAgent("fw-cov-a");
    const b = await relay.enrollAgent("fw-cov-b");
    const w1 = await direct(a, b);
    const w2 = await direct(a, b);
    const waiting = await direct(a, b);
    setGap(waiting, b, 2000, 1000); // 1000 s gap: 2000 → 1000 s ago

    // One covering turn reported against two deliveries (the same interval
    // twice): 500 s of 1000 s. Summed naively that is 100 %; as a union, 50 %.
    await turn(b, w1, 2000, 1500);
    await turn(b, w2, 2000, 1500);
    expect(await fetchWait(a, waiting)).toBe("inbox_stalled");

    // A second, disjoint interval takes the union to 790 s: still under 80 %.
    const w3 = await direct(a, b);
    await turn(b, w3, 1400, 1110);
    expect(await fetchWait(a, waiting)).toBe("inbox_stalled");

    // Another 20 s takes it past 80 %.
    const w4 = await direct(a, b);
    await turn(b, w4, 1110, 1090);
    expect(await fetchWait(a, waiting)).toBe("adapter_busy");
  });

  it("caps an open interval at the turn timeout, and a late turn_ended reclassifies", async () => {
    const a = await relay.enrollAgent("fw-late-a");
    const b = await relay.enrollAgent("fw-late-b");
    const earlier = await direct(a, b);
    const waiting = await direct(a, b);
    setGap(waiting, b, 2000, 1400); // 600 s gap

    // Open attempt started with the gap: treated as running up to the cap,
    // which covers the whole 600 s gap.
    const turnId = await turn(b, earlier, 2000);
    expect(await fetchWait(a, waiting)).toBe("adapter_busy");

    // The late report says the turn really ended after 60 s: 10 % coverage.
    const late = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/delivery-phases", {
      phases: [{ message_id: earlier, phase: "turn_ended", at: iso(1940 * 1000), turn_id: turnId, attempt: 1, outcome: "completed" }]
    });
    expect(late.body.recorded).toBe(1);
    expect(await fetchWait(a, waiting)).toBe("inbox_stalled");
  });

  it("never lets one reported interval exceed the turn timeout cap", async () => {
    const a = await relay.enrollAgent("fw-cap-a");
    const b = await relay.enrollAgent("fw-cap-b");
    const earlier = await direct(a, b);
    const waiting = await direct(a, b);
    setGap(waiting, b, 3000, 2000); // 1000 s gap

    // A single "turn" reported as 5 h long would cover any gap. No turn can
    // outlive the timeout, so it counts for CAP_S from its start at most:
    // 6000 → 5100 s ago, which ends before the gap begins.
    await turn(b, earlier, 6000, 100);
    expect(CAP_S).toBeLessThan(3000);
    expect(await fetchWait(a, waiting)).toBe("inbox_stalled");
  });

  it("uses only the recipient's own turn intervals", async () => {
    const a = await relay.enrollAgent("fw-own-a");
    const b = await relay.enrollAgent("fw-own-b");
    const c = await relay.enrollAgent("fw-own-c");
    const toC = await direct(a, c);
    const waiting = await direct(a, b);
    setGap(waiting, b, 1000, 400);
    await turn(c, toC, 1100, 300); // c was busy for the whole gap; b reported nothing
    expect(await fetchWait(a, waiting)).toBe("inbox_stalled");
  });

  it("is unknown (null) for a delivery fetched more than once", async () => {
    const a = await relay.enrollAgent("fw-retry-a");
    const b = await relay.enrollAgent("fw-retry-b");
    const earlier = await direct(a, b);
    const waiting = await direct(a, b);
    // Re-queued after a delivery timeout and fetched again: the gap now spans
    // the first fetch and the retry back-off, so neither label is honest.
    setGap(waiting, b, 1000, 400, 2);
    await turn(b, earlier, 1100, 300);
    expect(await fetchWait(a, waiting)).toBeNull();
  });

  it("classifies each recipient of a broadcast separately", async () => {
    const a = await relay.enrollAgent("fw-bc-a");
    const b = await relay.enrollAgent("fw-bc-b");
    const c = await relay.enrollAgent("fw-bc-c");
    const toB = await direct(a, b);
    const sent = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
      recipient: { kind: "broadcast" }, message_type: "broadcast", body: { text: "all" },
      conversation_id: "fw-bc", correlation_id: "fw-bc"
    });
    expect(sent.status).toBe(200);
    const id = sent.body.message_id as string;
    setGap(id, b, 1000, 400);
    setGap(id, c, 1000, 400);
    await turn(b, toB, 1100, 300);

    const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${id}/status`);
    const by = Object.fromEntries((res.body.deliveries as Array<{ recipient_agent_id: string; fetch_wait: string | null }>)
      .map((d) => [d.recipient_agent_id, d.fetch_wait]));
    expect(by[b.agent_id]).toBe("adapter_busy");
    expect(by[c.agent_id]).toBe("inbox_stalled");
  });
  it("clamps both thresholds to [0, one day] so an extreme finite setting cannot make the read throw", async () => {
    const a = await relay.enrollAgent("fw-ovf-a");
    const b = await relay.enrollAgent("fw-ovf-b");
    const id = await direct(a, b);
    setGap(id, b, 1000, 400);
    const saved = { stale: config.inboxStaleSeconds, cap: config.turnIntervalCapSeconds };
    try {
      for (const extreme of [1e15, Number.MAX_VALUE, -1e15]) {
        config.inboxStaleSeconds = 120;
        config.turnIntervalCapSeconds = extreme; // 1e15 s * 1000 is outside Date's range
        // Before the clamp this status read threw RangeError: Invalid time value.
        expect(await fetchWait(a, id)).toBe("inbox_stalled");
      }
      config.inboxStaleSeconds = 1e15;
      config.turnIntervalCapSeconds = 900;
      expect(await fetchWait(a, id)).toBe("prompt"); // stale clamps to one day; this 600 s gap is within it
    } finally {
      config.inboxStaleSeconds = saved.stale;
      config.turnIntervalCapSeconds = saved.cap;
    }
  });
});
