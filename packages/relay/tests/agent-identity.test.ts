import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { adapterOutdated, compareSemver, parseSemver } from "../src/agent-identity";
import { LATEST_ADAPTER_VERSIONS, RELAY_VERSION, normalizeBuildSha, resolveRelayBuildSha } from "../src/version";

// #97: adapters report who they are on the heartbeat; the relay keeps the
// latest claim per agent and the console shows it. Migration 028 on a real
// pre-upgrade database is covered in schema-upgrade-path.test.ts.

const FULL = {
  adapter: "openclaw-plugin",
  adapter_version: "0.8.0",
  sdk_version: "0.8.0",
  host_runtime: "openclaw",
  host_runtime_version: "2026.9.8",
  instance_id: "3f2b8c1e-5d4a-4e7b-9c1a-2b3c4d5e6f70"
};

describe("semver comparison (#97)", () => {
  it("orders releases, prereleases and build metadata by semver precedence", () => {
    expect(compareSemver("0.8.0", "0.9.0")).toBe(-1);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1); // numeric, not lexical
    expect(compareSemver("v0.9.0", "0.9.0")).toBe(0);
    expect(compareSemver("0.9.0+build.7", "0.9.0")).toBe(0);
    expect(compareSemver("0.9.0-rc.1", "0.9.0")).toBe(-1);
    expect(compareSemver("0.9.0-rc.2", "0.9.0-rc.10")).toBe(-1);
    expect(compareSemver("0.9.0-alpha", "0.9.0-alpha.1")).toBe(-1);
    expect(compareSemver("0.9.0-1", "0.9.0-alpha")).toBe(-1); // numeric ids sort first
    expect(compareSemver("0.9.0-beta", "0.9.0-alpha")).toBe(1);
  });

  it("treats anything that is not semver as unknown", () => {
    for (const bad of ["", "unknown", "0.9", "0.9.0.1", "01.2.3", "1.2.3-", "latest", "9999999999.0.0", null, 7, {}]) {
      expect(parseSemver(bad), String(bad)).toBeNull();
      expect(compareSemver(bad, "0.9.0"), String(bad)).toBeNull();
    }
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
  });

  it("flags outdated only for a known adapter with a parseable older version", () => {
    const latest = { "openclaw-plugin": "0.9.0" };
    expect(adapterOutdated("openclaw-plugin", "0.8.0", latest)).toBe(true);
    expect(adapterOutdated("openclaw-plugin", "0.9.0-rc.1", latest)).toBe(true);
    expect(adapterOutdated("openclaw-plugin", "0.9.0", latest)).toBe(false);
    expect(adapterOutdated("openclaw-plugin", "0.10.0", latest)).toBe(false); // newer than the relay
    expect(adapterOutdated("openclaw-plugin", "garbage", latest)).toBeNull();
    expect(adapterOutdated("openclaw-plugin", null, latest)).toBeNull();
    expect(adapterOutdated("someone-elses-client", "0.0.1", latest)).toBeNull();
    expect(adapterOutdated("constructor", "0.0.1", latest)).toBeNull(); // no prototype lookups
    expect(adapterOutdated(null, "0.0.1", latest)).toBeNull();
  });

  it("compares every in-repo adapter against the relay's own release", () => {
    expect(Object.keys(LATEST_ADAPTER_VERSIONS).sort()).toEqual(["hermes-plugin", "mcp-connector", "openclaw-plugin", "sdk"]);
    for (const v of Object.values(LATEST_ADAPTER_VERSIONS)) expect(v).toBe(RELAY_VERSION);
  });
});

describe("relay build SHA (#97)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("prefers a valid EKHO_BUILD_SHA, then git, then unknown", () => {
    let gitCalls = 0;
    const git = () => { gitCalls++; return `${SHA}\n`; };
    expect(resolveRelayBuildSha({ env: "ABCDEF1", git })).toBe("abcdef1");
    expect(gitCalls).toBe(0);
    expect(resolveRelayBuildSha({ env: "not-a-sha", git })).toBe(SHA.slice(0, 12));
    expect(resolveRelayBuildSha({ env: undefined, git })).toBe(SHA.slice(0, 12));
    expect(resolveRelayBuildSha({ git: () => { throw new Error("not a git repository"); } })).toBe("unknown");
    expect(resolveRelayBuildSha({ git: () => "fatal: no HEAD" })).toBe("unknown");
    expect(resolveRelayBuildSha({})).toBe("unknown");
  });

  it("only accepts hex object names, cut to 12 characters", () => {
    expect(normalizeBuildSha(SHA)).toBe("0123456789ab");
    expect(normalizeBuildSha("abc12")).toBeNull(); // too short to identify a commit
    expect(normalizeBuildSha("$(rm -rf /)")).toBeNull();
    expect(normalizeBuildSha(undefined)).toBeNull();
  });
});

describe("heartbeat identity round trip (#97)", () => {
  let relay: TestRelay;
  beforeAll(async () => { relay = await createTestRelay(); });
  afterAll(() => relay.cleanup());

  const beat = (agent: { agent_id: string; secret: string }, extra: Record<string, unknown> = {}) =>
    relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: {}, ...extra });
  const health = async (agentId: string) =>
    ((await relay.operatorRequest("GET", "/v1/operator/fleet-health")).body.agents as Array<Record<string, any>>).find((a) => a.id === agentId)!;

  it("stores the reported identity and shows it on fleet health, the agent list, the agent detail and the topology", async () => {
    const agent = await relay.enrollAgent("identity-full");
    expect((await beat(agent, FULL)).status).toBe(200);

    const expected = { ...FULL, latest_adapter_version: RELAY_VERSION, outdated: true };
    expect((await health(agent.agent_id)).identity).toEqual(expected);

    const list = await relay.operatorRequest("GET", "/v1/operator/agents?search=identity-full");
    const row = list.body.agents.find((a: { id: string }) => a.id === agent.agent_id);
    expect(row.identity).toEqual(expected);
    expect(Object.keys(row).some((k) => k.startsWith("reported_"))).toBe(false);

    const detail = await relay.operatorRequest("GET", `/v1/operator/agents/${agent.agent_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.identity).toEqual(expected);
    expect(Object.keys(detail.body.agent).some((k) => k.startsWith("reported_"))).toBe(false);

    // The Command Deck draws its unit cards from the topology nodes.
    const topo = await relay.operatorRequest("GET", "/v1/operator/topology");
    const node = topo.body.nodes.find((n: { id: string }) => n.id === agent.agent_id);
    expect(node.identity.adapter_version).toBe("0.8.0");
  });

  it("an up-to-date adapter is not outdated", async () => {
    const agent = await relay.enrollAgent("identity-current");
    await beat(agent, { ...FULL, adapter_version: RELAY_VERSION });
    expect((await health(agent.agent_id)).identity).toMatchObject({ adapter_version: RELAY_VERSION, outdated: false });
  });

  it("a heartbeat without identity (a 0.5.4 plugin) still works and reads as unknown", async () => {
    const agent = await relay.enrollAgent("identity-legacy");
    const res = await beat(agent, { active_conversation_ids: [], metrics: { model: "m" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const h = await health(agent.agent_id);
    expect(h.metrics).toEqual({ model: "m" });
    expect(h.identity).toEqual({
      adapter: null, adapter_version: null, sdk_version: null, host_runtime: null,
      host_runtime_version: null, instance_id: null, latest_adapter_version: null, outdated: null
    });
  });

  it("drops invalid or oversized fields without refusing the heartbeat, keeping the valid ones", async () => {
    const agent = await relay.enrollAgent("identity-hostile");
    const res = await beat(agent, {
      adapter: "openclaw-plugin",
      adapter_version: "9".repeat(65), // too long
      sdk_version: "0.9.0 /home/alice/.openclaw", // whitespace + a path
      host_runtime: "x".repeat(33),
      host_runtime_version: { major: 1 }, // not a string
      instance_id: "short" // under 8 characters
    });
    expect(res.status).toBe(200);
    expect((await health(agent.agent_id)).identity).toMatchObject({
      adapter: "openclaw-plugin", adapter_version: null, sdk_version: null,
      host_runtime: null, host_runtime_version: null, instance_id: null, outdated: null
    });

    for (const bad of ["EKHO_AGENT_SECRET=abc", "https://relay.example", "a@b.c", "../../etc/passwd", "C:\\Users\\x", "x\ny", ""]) {
      expect((await beat(agent, { adapter: "sdk", adapter_version: bad })).status, bad).toBe(200);
      expect((await health(agent.agent_id)).identity.adapter_version, bad).toBeNull();
    }
    // A malformed heartbeat is still refused for the reasons it always was.
    expect((await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/heartbeats", { status: "on-fire", ...FULL })).status).toBe(400);
  });

  it("the latest heartbeat wins: a downgrade to a plugin that sends nothing clears the claim", async () => {
    const agent = await relay.enrollAgent("identity-downgrade");
    await beat(agent, FULL);
    expect((await health(agent.agent_id)).identity.adapter_version).toBe("0.8.0");
    await beat(agent, { ...FULL, instance_id: "second-process-0001" });
    expect((await health(agent.agent_id)).identity.instance_id).toBe("second-process-0001");
    await beat(agent);
    expect((await health(agent.agent_id)).identity.adapter_version).toBeNull();
  });

  it("keeps a copy on the heartbeat row so a rollout is checkable from the database", async () => {
    const agent = await relay.enrollAgent("identity-rows");
    await beat(agent, { ...FULL, instance_id: "process-a-0001" });
    await beat(agent, { ...FULL, instance_id: "process-b-0002" });
    await beat(agent);
    const rows = relay.db.raw().prepare(
      "SELECT json_extract(metrics_json, '$.identity.instance_id') AS iid FROM heartbeats WHERE agent_id = ? ORDER BY rowid"
    ).all(agent.agent_id) as Array<{ iid: string | null }>;
    expect(rows.map((r) => r.iid)).toEqual(["process-a-0001", "process-b-0002", null]);
  });

  it("serves the relay's build identity to an authenticated operator only", async () => {
    const res = await relay.operatorRequest("GET", "/v1/operator/build-info");
    expect(res.status).toBe(200);
    expect(res.body.relay.version).toBe(RELAY_VERSION);
    expect(res.body.relay.build_sha).toMatch(/^(?:[0-9a-f]{7,12}|unknown)$/);
    expect(res.body.latest_adapter_versions).toEqual(LATEST_ADAPTER_VERSIONS);

    const anon = await relay.app.inject({ method: "GET", url: "/v1/operator/build-info" });
    expect(anon.statusCode).toBe(401);
  });
});
