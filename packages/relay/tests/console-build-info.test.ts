import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// #97: console build identity, the stale-console banner and the agent card's
// version line. buildInfo.js is pure; versionUi.jsx is rendered to markup.
import {
  CONSOLE_BUILD,
  agentVersionInfo,
  buildLine,
  buildMismatch,
  knownSha,
  staleBuildMessage,
  staleDismissKey
} from "../frontend/src/buildInfo.js";
import { AgentVersion, BuildLine } from "../frontend/src/versionUi.jsx";

const A = "0123456789ab";
const B = "fedcba987654";

describe("stale console banner (#97)", () => {
  it("shows only when both builds are known and name different commits", () => {
    expect(buildMismatch(A, B)).toBe(true);
    expect(buildMismatch(A, A)).toBe(false);
    // Different short lengths of the same commit are the same build.
    expect(buildMismatch("0123456", A)).toBe(false);
    expect(buildMismatch(A.toUpperCase(), A)).toBe(false);
    // Either side unknown: no banner rather than a false alarm.
    for (const unknown of ["unknown", "", null, undefined, "abc12", "not-a-sha"]) {
      expect(buildMismatch(unknown, B), String(unknown)).toBe(false);
      expect(buildMismatch(A, unknown), String(unknown)).toBe(false);
    }
  });

  it("tells the operator what to run, naming both commits", () => {
    const msg = staleBuildMessage({ version: "0.9.0", build_sha: B }, { version: "0.9.0", sha: A });
    expect(msg).toContain("Console build is stale");
    expect(msg).toContain("0123456");
    expect(msg).toContain("fedcba9");
    expect(msg).toContain("npm run ui:build -w @ekho/relay");
    expect(staleBuildMessage({ version: "0.9.0", build_sha: A }, { version: "0.9.0", sha: A })).toBeNull();
    expect(staleBuildMessage(null, { version: "0.9.0", sha: A })).toBeNull(); // relay not known yet (or too old to say)
  });

  it("dismissal is per pair of builds, so a new mismatch shows again", () => {
    const k1 = staleDismissKey({ build_sha: B }, { sha: A });
    expect(k1).toBe(staleDismissKey({ build_sha: B }, { sha: A }));
    expect(k1).not.toBe(staleDismissKey({ build_sha: "aaaaaaaaaaaa" }, { sha: A }));
  });

  it("reads 'unknown' for the console build when the bundle carries no stamp (vitest, dev server)", () => {
    expect(CONSOLE_BUILD).toEqual({ version: "unknown", sha: "unknown" });
    expect(knownSha(CONSOLE_BUILD.sha)).toBeNull();
  });
});

describe("footer build line (#97)", () => {
  it("names the relay and console versions and short SHAs", () => {
    expect(buildLine({ version: "0.9.0", build_sha: A }, { version: "0.9.0", sha: B }))
      .toBe("relay v0.9.0 (0123456) · console v0.9.0 (fedcba9)");
    expect(buildLine(null, { version: "unknown", sha: "unknown" })).toBe("relay v? (unknown) · console v? (unknown)");
    expect(renderToStaticMarkup(React.createElement(BuildLine, { relay: { version: "0.9.0", build_sha: "unknown" } })))
      .toContain("relay v0.9.0 (unknown) · console v? (unknown)");
  });
});

describe("agent card version (#97)", () => {
  const card = (identity: unknown) => renderToStaticMarkup(React.createElement(AgentVersion, { identity }));

  it("shows the plugin and host versions, with an outdated chip when the relay says so", () => {
    const identity = {
      adapter: "openclaw-plugin", adapter_version: "0.8.0", sdk_version: "0.8.0",
      host_runtime: "openclaw", host_runtime_version: "2026.9.8", instance_id: "abc-12345678",
      latest_adapter_version: "0.9.0", outdated: true
    };
    expect(agentVersionInfo(identity)).toMatchObject({ label: "plugin 0.8.0 · OpenClaw 2026.9.8", known: true, outdated: true, latest: "0.9.0" });
    const html = card(identity);
    expect(html).toContain("plugin 0.8.0 · OpenClaw 2026.9.8");
    expect(html).toContain(">outdated<");
  });

  it("an up-to-date or unjudgeable adapter gets no chip", () => {
    expect(card({ adapter: "hermes-plugin", adapter_version: "0.9.0", host_runtime: "hermes", outdated: false })).not.toContain("outdated");
    expect(card({ adapter: "openclaw-plugin", adapter_version: "garbage", outdated: null })).not.toContain("outdated");
    expect(agentVersionInfo({ adapter: "hermes-plugin", adapter_version: "0.9.0", host_runtime: "hermes" }).label).toBe("plugin 0.9.0 · Hermes");
  });

  it("a plugin that reports nothing (0.5.4) reads 'version unknown', not an error", () => {
    const blank = {
      adapter: null, adapter_version: null, sdk_version: null, host_runtime: null,
      host_runtime_version: null, instance_id: null, latest_adapter_version: null, outdated: null
    };
    for (const identity of [blank, undefined, null, "garbage"]) {
      expect(agentVersionInfo(identity)).toMatchObject({ label: "version unknown", known: false, outdated: false });
      expect(card(identity)).toContain("version unknown");
    }
  });

  it("an unstamped plugin build still names itself and its host", () => {
    expect(agentVersionInfo({ adapter: "openclaw-plugin", host_runtime: "openclaw", host_runtime_version: "2026.7.1" }).label)
      .toBe("plugin version unknown · OpenClaw 2026.7.1");
    expect(agentVersionInfo({ adapter: "sdk", adapter_version: "0.9.0", host_runtime: "node", host_runtime_version: "22.23.5" }).label)
      .toBe("sdk 0.9.0 · Node 22.23.5");
  });
});
