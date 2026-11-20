// Version and build UI shared by the Wire, Classic and Command Deck consoles
// (#97). Logic lives in buildInfo.js; class names are styled per skin in
// wire.css, styles.css and deck.css.
import React, { useEffect, useState } from "react";
import { getBuildInfo } from "./api";
import { CONSOLE_BUILD, agentVersionInfo, buildLine, staleBuildMessage, staleDismissKey } from "./buildInfo.js";

const BUILD_REFRESH_MS = 5 * 60_000;

/** The relay's build ({ version, build_sha }), or null until known. Re-read
 *  every few minutes so a relay restarted on a new commit is noticed. */
export function useRelayBuild(token) {
  const [relay, setRelay] = useState(null);
  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    const load = () => getBuildInfo(token)
      .then((info) => { if (live && info?.relay) setRelay(info.relay); })
      .catch(() => { /* an older relay has no build-info route: stay unknown */ });
    load();
    const timer = window.setInterval(load, BUILD_REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [token]);
  return relay;
}

/** "relay v0.9.0 (abc1234) · console v0.9.0 (abc1234)". */
export function BuildLine({ relay, className = "" }) {
  return (
    <div className={`ekho-build-line mono ${className}`.trim()} title="Relay and console builds">
      {buildLine(relay, CONSOLE_BUILD)}
    </div>
  );
}

function readDismissed(key) {
  try { return window.sessionStorage.getItem(key) === "1"; } catch { return false; }
}

/** Shown when the console bundle was built from a different commit than the relay runs. */
export function StaleBuildBanner({ relay }) {
  const message = staleBuildMessage(relay, CONSOLE_BUILD);
  const key = staleDismissKey(relay, CONSOLE_BUILD);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useEffect(() => { setDismissed(readDismissed(key)); }, [key]);
  if (!message || dismissed) return null;
  const dismiss = () => {
    try { window.sessionStorage.setItem(key, "1"); } catch { /* private mode: dismiss for this render only */ }
    setDismissed(true);
  };
  return (
    <div className="ekho-stale-banner" role="alert">
      <span className="ekho-stale-banner__text">{message}</span>
      <button className="ekho-stale-banner__close" onClick={dismiss} aria-label="Dismiss build mismatch warning">✕</button>
    </div>
  );
}

/** The same warning as a compact status flag, for a layout with no room for a
 *  strip (the Command Deck's footer bar). Never covers anything; the full text
 *  is in the tooltip. */
export function StaleBuildFlag({ relay }) {
  const message = staleBuildMessage(relay, CONSOLE_BUILD);
  if (!message) return null;
  return <span className="ekho-stale-flag" role="alert" title={message}>BUILDS DIFFER · REBUILD OR RESTART</span>;
}

/** "plugin 0.8.0 · OpenClaw 2026.9.8" plus an "outdated" chip, for agent cards. */
export function AgentVersion({ identity, className = "" }) {
  const v = agentVersionInfo(identity);
  return (
    <span className={`ekho-ver mono${v.known ? "" : " ekho-ver--unknown"} ${className}`.trim()} title={v.title}>
      {v.label}
      {v.outdated ? <span className="ekho-ver__chip" title={v.latest ? `This relay ships ${v.latest}` : undefined}>outdated</span> : null}
    </span>
  );
}
