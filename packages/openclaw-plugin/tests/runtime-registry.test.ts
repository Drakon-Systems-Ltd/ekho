// The process-wide producer registry on its own: claim, release, standby and
// resume (#160), including synchronous re-entrancy from a holder's stop() or
// resume(), which the plugin-level reload tests cannot drive deliberately.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeGeneration,
  agentRuntimeStandbyGenerations,
  claimAgentRuntime,
  releaseAgentRuntime,
  withdrawAgentRuntimeStandby,
  type AgentRuntimeHolder
} from "../src/runtime-registry";

const AGENT = "agent_registry";

function holder(generation: number, extra: Partial<AgentRuntimeHolder> = {}): AgentRuntimeHolder & { stop: ReturnType<typeof vi.fn> } {
  return { generation, stop: vi.fn(), ...extra } as AgentRuntimeHolder & { stop: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekho-adapter.runtime")];
});

describe("runtime registry: claim and release", () => {
  it("a newer generation stops the older one and takes the slot; the older one goes on standby only if it can resume", () => {
    const g1 = holder(1);
    expect(claimAgentRuntime(AGENT, g1)).toBe(true);
    const g2 = holder(2);
    expect(claimAgentRuntime(AGENT, g2)).toBe(true);
    expect(g1.stop).toHaveBeenCalledWith("superseded by generation 2");
    expect(agentRuntimeGeneration(AGENT)).toBe(2);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]); // g1 has no resume

    const g3 = holder(3, { resume: () => true });
    expect(claimAgentRuntime(AGENT, g3)).toBe(true);
    const g4 = holder(4);
    expect(claimAgentRuntime(AGENT, g4)).toBe(true);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([3]);
  });

  it("an older generation claiming after a newer one is refused and nothing changes", () => {
    const g2 = holder(2);
    claimAgentRuntime(AGENT, g2);
    const g1 = holder(1);
    expect(claimAgentRuntime(AGENT, g1)).toBe(false);
    expect(agentRuntimeGeneration(AGENT)).toBe(2);
    expect(g2.stop).not.toHaveBeenCalled();
  });

  it("the superseded holder's own release (from inside its stop) is a no-op: the successor keeps the slot and nothing resumes", () => {
    const g1 = holder(1, { resume: vi.fn(() => true) });
    g1.stop.mockImplementation(() => releaseAgentRuntime(AGENT, 1)); // what shutdown() does
    claimAgentRuntime(AGENT, g1);
    const g2 = holder(2);
    expect(claimAgentRuntime(AGENT, g2)).toBe(true);
    expect(agentRuntimeGeneration(AGENT)).toBe(2);
    expect(g1.resume).not.toHaveBeenCalled();
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1]);
  });
});

describe("runtime registry: standby resume (#160)", () => {
  it("releasing the holder with no successor resumes the most recently superseded generation, which re-claims", () => {
    const g1 = holder(1, { resume: vi.fn(() => claimAgentRuntime(AGENT, g1)) });
    claimAgentRuntime(AGENT, g1);
    const g2 = holder(2);
    claimAgentRuntime(AGENT, g2);
    releaseAgentRuntime(AGENT, 2);
    expect(g1.resume).toHaveBeenCalledTimes(1);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]);
  });

  it("a standby that declines is discarded and the next older one is tried; none left leaves the slot empty", () => {
    const g1 = holder(1, { resume: vi.fn(() => claimAgentRuntime(AGENT, g1)) });
    const g2 = holder(2, { resume: vi.fn(() => false) }); // its host unloaded it too
    const g3 = holder(3, { resume: vi.fn(() => { throw new Error("broken standby"); }) });
    claimAgentRuntime(AGENT, g1);
    claimAgentRuntime(AGENT, g2);
    claimAgentRuntime(AGENT, g3);
    const g4 = holder(4);
    claimAgentRuntime(AGENT, g4);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1, 2, 3]);
    releaseAgentRuntime(AGENT, 4);
    expect(g3.resume).toHaveBeenCalledTimes(1);
    expect(g2.resume).toHaveBeenCalledTimes(1);
    expect(g1.resume).toHaveBeenCalledTimes(1);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]);

    releaseAgentRuntime(AGENT, 1);
    expect(agentRuntimeGeneration(AGENT)).toBeUndefined();
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]);
  });

  it("a release by a generation that does not hold the slot changes nothing and resumes no one", () => {
    const g1 = holder(1, { resume: vi.fn(() => true) });
    claimAgentRuntime(AGENT, g1);
    const g2 = holder(2);
    claimAgentRuntime(AGENT, g2);
    releaseAgentRuntime(AGENT, 7);
    releaseAgentRuntime(AGENT, 1);
    expect(agentRuntimeGeneration(AGENT)).toBe(2);
    expect(g1.resume).not.toHaveBeenCalled();
  });

  it("a resumed generation superseded again goes back on standby and can resume again", () => {
    const g1 = holder(1, { resume: vi.fn(() => claimAgentRuntime(AGENT, g1)) });
    claimAgentRuntime(AGENT, g1);
    claimAgentRuntime(AGENT, holder(2));
    releaseAgentRuntime(AGENT, 2);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    claimAgentRuntime(AGENT, holder(3));
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1]);
    releaseAgentRuntime(AGENT, 3);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    expect(g1.resume).toHaveBeenCalledTimes(2);
    expect(g1.stop).toHaveBeenCalledTimes(2);
  });
});

describe("runtime registry: synchronous re-entrancy", () => {
  it("a claim whose stop() re-enters and installs a newer generation returns false: the caller must start nothing", () => {
    const g3 = holder(3);
    const g1 = holder(1);
    g1.stop.mockImplementation(() => {
      claimAgentRuntime(AGENT, g3); // re-entrant: a newer generation wins mid-hand-off
    });
    claimAgentRuntime(AGENT, g1);
    const g2 = holder(2);
    expect(claimAgentRuntime(AGENT, g2)).toBe(false);
    expect(agentRuntimeGeneration(AGENT)).toBe(3);
    expect(g2.stop).toHaveBeenCalledWith("superseded by generation 3");
  });

  it("a release whose standby resume re-enters with a claim leaves exactly one holder and an empty standby", () => {
    const g1 = holder(1, {
      resume: vi.fn(() => {
        const ok = claimAgentRuntime(AGENT, g1);
        // While resuming, the slot is briefly empty for anyone else: a stray
        // release from the generation just stopped must not resume g1 twice.
        releaseAgentRuntime(AGENT, 2);
        return ok;
      })
    });
    claimAgentRuntime(AGENT, g1);
    claimAgentRuntime(AGENT, holder(2));
    releaseAgentRuntime(AGENT, 2);
    expect(g1.resume).toHaveBeenCalledTimes(1);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]);
  });

  it("a resume that is itself superseded before it returns keeps the resumed generation on the NEW standby list", () => {
    // Release g2 → g1 resumes and re-claims (the old list is now empty) → a
    // newer g3 claims before resume() returns, putting g1 on a fresh list.
    // The outer release must not throw that fresh list away (it is not the
    // list it emptied), or disposing g3 could never bring g1 back.
    const g3 = holder(3);
    let resumes = 0;
    const g1 = holder(1, {
      resume: vi.fn(() => {
        const ok = claimAgentRuntime(AGENT, g1);
        if (++resumes === 1) claimAgentRuntime(AGENT, g3); // only the first resume is interrupted
        return ok;
      })
    });
    claimAgentRuntime(AGENT, g1);
    claimAgentRuntime(AGENT, holder(2));
    releaseAgentRuntime(AGENT, 2);
    expect(agentRuntimeGeneration(AGENT)).toBe(3);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1]);
    releaseAgentRuntime(AGENT, 3);
    expect(g1.resume).toHaveBeenCalledTimes(2);
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
  });
});

describe("runtime registry: standby withdrawal", () => {
  it("a host-stopped standby is withdrawn by generation and never tried; the list is forgotten once empty", () => {
    const g1 = holder(1, { resume: vi.fn(() => claimAgentRuntime(AGENT, g1)) });
    const g2 = holder(2, { resume: vi.fn(() => claimAgentRuntime(AGENT, g2)) });
    claimAgentRuntime(AGENT, g1);
    claimAgentRuntime(AGENT, g2);
    claimAgentRuntime(AGENT, holder(3));
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1, 2]);
    withdrawAgentRuntimeStandby(AGENT, 2); // g2's host unloaded it (ordinary reload)
    withdrawAgentRuntimeStandby(AGENT, 9); // unknown generation: no-op
    withdrawAgentRuntimeStandby("agent_other", 1); // unknown agent: no-op
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([1]);
    releaseAgentRuntime(AGENT, 3);
    expect(g2.resume).not.toHaveBeenCalled();
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    withdrawAgentRuntimeStandby(AGENT, 1); // not on standby (it holds the slot): no-op
    expect(agentRuntimeGeneration(AGENT)).toBe(1);
    expect(agentRuntimeStandbyGenerations(AGENT)).toEqual([]);
  });
});
