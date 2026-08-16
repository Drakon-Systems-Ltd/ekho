import { useEffect, useState, useCallback } from "react";
import {
  generateSeed,
  publicKeyB64url,
  keyId,
  signCanonical,
  encryptSeed,
  agentKeyEndorsementPayload,
  endorsementPayload,
} from "./operatorKey.js";
import {
  getUnlocked,
  setUnlocked,
  unlockFromStore,
  saveEncryptedSeed,
  hasStoredKey,
  lock as lockStore,
  clearStoredKey,
  getStoredBlob,
} from "./operatorKeyStore.js";
import {
  listOperatorKeys,
  registerOperatorKey,
  getAgentKeys,
  endorseAgentKey,
  revokeOperatorKey,
  endorseOperatorKey,
} from "./api.js";
import {
  endorserStatus,
  dependentsOf,
  trustHealth,
  deviceKeySigningState,
  liveOperatorKeys,
  revokeGuard,
  pickEndorser,
  rescueGuard,
} from "./operatorTrust.js";

const SHORT = (s) => (s ? `${String(s).slice(0, 10)}…` : "—");

export default function SecurityScreen({ session, agents = [] }) {
  const token = session?.token || "";
  const fleetId = session?.fleetId || "";
  const [unlocked, setUnlockedState] = useState(getUnlocked());
  const [stored, setStored] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [label, setLabel] = useState("this device");
  const [keys, setKeys] = useState([]);
  const [agentKeys, setAgentKeys] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { tone, text }

  const note = (tone, text) => setMsg({ tone, text });

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [k, ak] = await Promise.all([listOperatorKeys(token), getAgentKeys(token)]);
      setKeys(k.keys || []);
      setAgentKeys(ak.keys || []);
    } catch (e) {
      note("danger", `Load failed: ${e.message || e}`);
    }
  }, [token]);

  useEffect(() => {
    hasStoredKey().then(setStored).catch(() => {});
    refresh();
  }, [refresh]);

  // #19: endorse an already-registered key with the live key in THIS browser.
  // The rescue for a device that cannot sign for itself — without this, a key
  // minted on a stranded device is permanently invisible to every agent.
  const onEndorseKey = async (targetKeyId) => {
    const guard = rescueGuard(targetKeyId, keys, unlocked?.keyId);
    if (!guard.allowed) return note("danger", guard.reason);
    const target = keys.find((k) => k.key_id === targetKeyId);
    setBusy(true);
    try {
      await endorseOperatorKey(token, targetKeyId, {
        endorsedByKeyId: unlocked.keyId,
        signature: signCanonical(
          endorsementPayload(fleetId, targetKeyId, target.public_key),
          unlocked.seed
        ),
      });
      note(
        "ok",
        `${targetKeyId} endorsed by ${unlocked.keyId}. Agents that trust ${unlocked.keyId} adopt it on their next poll — that device can send again without re-enrolling.`
      );
      await refresh();
    } catch (e) {
      note("danger", `Endorse failed: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = async () => {
    if (passphrase.length < 8) return note("warn", "Choose a passphrase of at least 8 characters.");
    // #19: refuse rather than mint an orphan. Without a live key in this browser
    // the new key cannot be endorsed — not now, and not later, because the relay
    // rejects a re-registration of the same key id. On 16 Aug this path burnt a
    // key and left the operator exactly as locked out as before, with the console
    // still reporting success. A warning in small print was not enough.
    if (keys.length > 0 && !pickEndorser(getUnlocked(), keys)) {
      return note(
        "danger",
        "This device holds no live key, so a new identity here could never be endorsed — agents would discard everything it signs, permanently. " +
          "Open the console on a device that still holds a live key and use ‘Endorse’ on this device's key in panel ②."
      );
    }
    setBusy(true);
    try {
      const seed = generateSeed();
      const pub = publicKeyB64url(seed);
      const kid = keyId(pub);
      // #13: chain the new key to the one we are replacing, while we still hold
      // its seed. The relay has always accepted and verified this endorsement,
      // and agents adopt an endorsed key automatically on their next poll — but
      // the console never sent one, so `endorsed_by_key_id` was null on EVERY
      // key of every fleet and the chaining branch in syncPinnedOperatorKeys had
      // literally never fired. Without it a new operator key reaches agents only
      // by trust-on-first-use (empty pin set) or by hand-editing trust files.
      // Signed BEFORE the new seed replaces the old one in the store; a live
      // endorser is required, since the relay rejects a revoked one.
      const endorser = pickEndorser(unlocked, keys);
      const endorsement = endorser
        ? {
            endorsedByKeyId: endorser.keyId,
            signature: signCanonical(endorsementPayload(fleetId, kid, pub), endorser.seed),
          }
        : undefined;

      // Register FIRST: if the relay rejects the key or its endorsement, the old
      // identity is still intact in the browser rather than half-replaced.
      await registerOperatorKey(token, { publicKey: pub, label: label.trim() || "this device", endorsement });
      const blob = await encryptSeed(seed, passphrase);
      await saveEncryptedSeed(blob);
      setUnlockedState(setUnlocked(seed));
      setStored(true);
      setPassphrase("");
      note(
        endorsement ? "ok" : "warn",
        endorsement
          ? `Identity created, signing, and endorsed by your previous key ${endorser.keyId} — agents that trust that key will adopt this one automatically on their next poll.`
          : "Identity created and signing. ⚠ Your agents don't trust this key yet, and no live key was available to endorse it — endorse them in ③ (or use the banner) so they can verify your commands. Back it up below."
      );
      await refresh();
    } catch (e) {
      note("danger", `Generate failed: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const onUnlock = async () => {
    setBusy(true);
    try {
      const u = await unlockFromStore(passphrase);
      setUnlockedState(u);
      setPassphrase("");
      // #19: do not report "signing active" for a key the relay has revoked or
      // never saw. The console said exactly that for six days while every agent
      // discarded the operator's messages unread.
      const state = deviceKeySigningState(keys, u?.keyId);
      if (state.canSign) note("ok", "Identity unlocked — signing active.");
      else note("danger", `${state.reason}${state.recovery ? ` ${state.recovery}` : ""}`);
    } catch (e) {
      note("danger", "Wrong passphrase, or no stored key.");
    } finally {
      setBusy(false);
    }
  };

  const onLock = () => {
    lockStore();
    setUnlockedState(null);
    note("muted", "Identity locked. Console sends will be unsigned until you unlock.");
  };

  const onForget = async () => {
    if (!window.confirm("Remove the encrypted key from THIS browser? You'll need a backup to sign again here.")) return;
    await clearStoredKey();
    setUnlockedState(null);
    setStored(false);
    note("muted", "Encrypted key removed from this device.");
  };

  const onDownloadBackup = async () => {
    const blob = await getStoredBlob();
    if (!blob) return note("warn", "Nothing stored to back up.");
    const data = new Blob([JSON.stringify({ ekho_operator_key: blob }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ekho-operator-key.json";
    a.click();
    URL.revokeObjectURL(url);
    note("ok", "Encrypted backup downloaded. AirDrop it to your phone — it's useless without the passphrase.");
  };

  const onRevoke = async (kid) => {
    // #15: revoking the console's OWN device key, or the last live key, is what
    // took the fleet's trust chain down — and the UI treated both like any other
    // row. The guard blocks the unrecoverable case and words the self-revoke
    // confirmation for what it actually costs.
    const guard = revokeGuard(kid, keys, unlocked?.keyId, dependentsOf(kid, agentKeys));
    if (guard.blocked) {
      note("danger", guard.message);
      return;
    }
    if (!window.confirm(guard.message)) return;
    try {
      await revokeOperatorKey(token, kid);
      note("muted", `Revoked ${kid}.${deps > 0 ? ` Re-endorse the ${deps} affected agent(s) now.` : ""}`);
      await refresh();
    } catch (e) {
      note("danger", `Revoke failed: ${e.message || e}`);
    }
  };

  // Re-endorse every agent whose endorser is missing/revoked under the unlocked device key.
  // This is the one-click recovery after a key rotation: it re-roots peer trust at a live key.
  const onReendorseAll = async () => {
    if (!unlocked) return note("warn", "Unlock your operator identity first.");
    // #15: never sign with a key the relay has revoked — every endorsement it
    // produces is dropped by the agents on their next poll, and the old failure
    // toast blamed the agents for it.
    if (!signing.canSign) return note("danger", `${signing.reason} ${signing.recovery ?? ""}`.trim());
    const targets = agentKeys.filter((ak) => endorserStatus(ak, keys, unlocked.keyId).needsAction);
    if (!targets.length) return note("ok", "Every agent already trusts this device.");
    setBusy(true);
    let done = 0;
    const failed = [];
    for (const ak of targets) {
      try {
        const payload = agentKeyEndorsementPayload(fleetId, ak.agent_id, ak.key_id, ak.public_key);
        const signature = signCanonical(payload, unlocked.seed);
        await endorseAgentKey(token, ak.agent_id, { keyId: ak.key_id, endorsedByKeyId: unlocked.keyId, signature });
        done += 1;
      } catch {
        failed.push(nameFor(ak.agent_id));
      }
    }
    note(
      failed.length ? "warn" : "ok",
      `Re-endorsed ${done} agent${done !== 1 ? "s" : ""} under ${unlocked.keyId}` +
        (failed.length ? ` · failed: ${failed.join(", ")}` : ".")
    );
    await refresh();
    setBusy(false);
  };

  const onEndorse = async (ak) => {
    if (!unlocked) return note("warn", "Unlock your operator identity first.");
    if (!signing.canSign) return note("danger", `${signing.reason} ${signing.recovery ?? ""}`.trim()); // #15
    try {
      const payload = agentKeyEndorsementPayload(fleetId, ak.agent_id, ak.key_id, ak.public_key);
      const signature = signCanonical(payload, unlocked.seed);
      await endorseAgentKey(token, ak.agent_id, {
        keyId: ak.key_id,
        endorsedByKeyId: unlocked.keyId,
        signature,
      });
      note("ok", `Endorsed ${nameFor(ak.agent_id)} — peers can now verify it.`);
      await refresh();
    } catch (e) {
      note("danger", `Endorse failed: ${e.message || e}`);
    }
  };

  const nameFor = (id) => agents.find((a) => a.id === id)?.display_name || id;
  const health = trustHealth(keys, agentKeys, unlocked?.keyId);
  const signing = deviceKeySigningState(keys, unlocked?.keyId);
  const live = liveOperatorKeys(keys);

  return (
    <div className="sec">
      <SecStyle />
      <div className="sec__head">
        <span className="sec__title">⛨ OPERATOR SECURITY</span>
        <span className={`sec__status sec__status--${unlocked ? "live" : "off"}`}>
          {unlocked ? `● SIGNING · ${unlocked.keyId}` : "○ NOT SIGNING"}
        </span>
      </div>

      {msg && <div className={`sec__msg sec__msg--${msg.tone}`}>{msg.text}</div>}

      {/* #15: zero live operator keys is the loudest state on this page. With no
          live key every agent's trust map empties, verification returns a null
          verdict rather than a rejection, and on the default requireSigned:"warn"
          the fleet keeps working — unauthenticated. Silent by construction. */}
      {keys.length > 0 && live.length === 0 && (
        <div className="sec__alert sec__alert--danger">
          <div className="sec__alert-h">🔴 NO LIVE OPERATOR KEY — your agents are accepting unverified messages</div>
          <div className="sec__alert-b">
            Every registered key is revoked, so nothing can be endorsed and no agent can verify anything you send.
            Recover: <b>Forget device</b> (panel ①) → <b>Generate identity</b> to enrol a fresh key → then re-endorse
            every agent under it.
          </div>
        </div>
      )}

      {/* #15: the console signs in the browser and will happily sign with a key
          the relay has revoked. Say so, and point at the recovery, instead of
          offering a Re-endorse button whose every press fails. */}
      {unlocked && !signing.canSign && (
        <div className="sec__alert sec__alert--danger">
          <div className="sec__alert-h">⚠ This device cannot sign endorsements</div>
          <div className="sec__alert-b">
            {signing.reason} {signing.recovery}
          </div>
          <button className="sec__btn sec__btn--danger" onClick={onForget}>Forget device</button>
        </div>
      )}

      {/* Trust-health banner — surfaces a broken chain (e.g. agents left on a revoked key
          after a rotation) and offers the one-click fix, instead of failing silently. */}
      {!health.ok && agentKeys.length > 0 && (
        <div className="sec__alert">
          <div className="sec__alert-h">⚠ Agent trust needs attention</div>
          <div className="sec__alert-b">
            {health.problems.join(" · ")}. Endorsing re-roots each agent's trust at your current device key.
          </div>
          {unlocked && signing.canSign ? (
            <button className="sec__btn sec__btn--go" disabled={busy} onClick={onReendorseAll}>
              Re-endorse all under this device · {unlocked.keyId}
            </button>
          ) : unlocked ? (
            <div className="sec__hint">{signing.reason} {signing.recovery}</div>
          ) : (
            <div className="sec__hint">Unlock your operator identity above, then re-endorse the affected agents.</div>
          )}
        </div>
      )}

      {/* ① Identity */}
      <section className="sec__panel">
        <h4>① Operator identity</h4>
        <p className="sec__hint">
          Your Ed25519 key is generated and held in <b>this browser</b> and never sent to the relay —
          that's what lets agents trust you even if the relay is compromised.
        </p>
        {unlocked ? (
          <div className="sec__row">
            <code className="sec__kid">key {unlocked.keyId}</code>
            <button className="sec__btn" onClick={onDownloadBackup}>⤓ Backup</button>
            <button className="sec__btn" onClick={onLock}>Lock</button>
            <button className="sec__btn sec__btn--danger" onClick={onForget}>Forget device</button>
          </div>
        ) : stored ? (
          <div className="sec__row">
            <input
              className="sec__in"
              type="password"
              placeholder="passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onUnlock()}
            />
            <button className="sec__btn sec__btn--go" disabled={busy} onClick={onUnlock}>Unlock</button>
          </div>
        ) : (
          <div className="sec__col">
            <input className="sec__in" placeholder="device label (e.g. macbook)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input
              className="sec__in"
              type="password"
              placeholder="passphrase (≥ 8 chars, encrypts the key at rest)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <button className="sec__btn sec__btn--go" disabled={busy} onClick={onGenerate}>Generate identity</button>
          </div>
        )}
      </section>

      {/* ② Registered keys */}
      <section className="sec__panel">
        <h4>② Registered keys <span className="sec__count">{keys.length}</span></h4>
        {keys.length === 0 && <p className="sec__hint">No operator keys registered yet.</p>}
        {keys.map((k) => {
          const deps = dependentsOf(k.key_id, agentKeys);
          return (
            <div key={k.key_id} className="sec__item">
              <code className="sec__kid">{k.key_id}</code>
              <span className="sec__lbl">{k.label}</span>
              {deps > 0 && !k.revoked_at && (
                <span className="sec__dep" title={`${deps} agent(s) verify against this key`}>
                  trust root · {deps}
                </span>
              )}
              {k.revoked_at ? (
                <span className="sec__tag sec__tag--off">revoked</span>
              ) : (
                <>
                  <span className="sec__tag sec__tag--live">active</span>
                  {/* #19: "active" is not the same as usable. A key with no
                      endorsement is discarded by every agent, and the row gave
                      no hint of it — the operator read "active" and reasonably
                      assumed his agents were ignoring him. */}
                  {!k.endorsed_by_key_id && deps === 0 && k.key_id !== unlocked?.keyId && (
                    <>
                      <span className="sec__tag sec__tag--off" title="No endorsement — agents reject anything this key signs">
                        unendorsed
                      </span>
                      <button
                        className="sec__btn sec__btn--go"
                        disabled={busy || !rescueGuard(k.key_id, keys, unlocked?.keyId).allowed}
                        title={rescueGuard(k.key_id, keys, unlocked?.keyId).reason || `Endorse ${k.key_id} with this device's key`}
                        onClick={() => onEndorseKey(k.key_id)}
                      >
                        Endorse
                      </button>
                    </>
                  )}
                  <button className="sec__btn sec__btn--danger" onClick={() => onRevoke(k.key_id)}>Revoke</button>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* ③ Endorse agents */}
      <section className="sec__panel">
        <h4>③ Agent identities <span className="sec__count">{agentKeys.length}</span></h4>
        <p className="sec__hint">
          Endorsing an agent's key roots peer (agent↔agent) trust at your device. For agents to
          verify <b>your</b> commands too, each agent host also pins your key (<code>EKHO_OPERATOR_PUBKEY</code>)
          at enrollment.
        </p>
        {agentKeys.length === 0 && <p className="sec__hint">No agent identity keys registered yet.</p>}
        {agentKeys.map((ak) => {
          const st = endorserStatus(ak, keys, unlocked?.keyId);
          return (
            <div key={`${ak.agent_id}:${ak.key_id}`} className="sec__item">
              <span className="sec__lbl">{nameFor(ak.agent_id)}</span>
              <code className="sec__kid">{ak.key_id}</code>
              {st.state === "current" && <span className="sec__tag sec__tag--live">✓ this device</span>}
              {st.state === "foreign" && (
                <>
                  <span className="sec__tag sec__tag--live" title={`endorsed by ${st.endorserId}`}>
                    ✓ {st.endorserLabel || st.endorserId}
                  </span>
                  {unlocked && (
                    <button className="sec__btn" disabled={!signing.canSign} onClick={() => onEndorse(ak)} title="Re-endorse under this device">↻</button>
                  )}
                </>
              )}
              {st.state === "revoked" && (
                <>
                  <span className="sec__tag sec__tag--warn" title={`endorser ${st.endorserId} is revoked/unknown`}>
                    ⚠ trusts a revoked key
                  </span>
                  <button className="sec__btn sec__btn--go" disabled={!signing.canSign} onClick={() => onEndorse(ak)}>Re-endorse</button>
                </>
              )}
              {st.state === "unendorsed" && (
                <button className="sec__btn sec__btn--go" disabled={!signing.canSign} onClick={() => onEndorse(ak)}>Endorse</button>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function SecStyle() {
  return (
    <style>{`
      .sec { --cr: #e23b4e; --cr-soft: rgba(226,59,78,.13); color: var(--text); font-size: 13px; }
      .sec__head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
      .sec__title { font-family: "Chakra Petch","Share Tech Mono",monospace; letter-spacing:.14em; font-size:12px; color:var(--cr); }
      .sec__status { font-family:"Share Tech Mono",monospace; font-size:11px; padding:3px 8px; border-radius:6px; }
      .sec__status--live { color:#fff; background:var(--cr); }
      .sec__status--off { color:var(--faint); border:1px solid var(--hair-strong); }
      .sec__panel { background:var(--raised); border:1px solid var(--hair); border-left:2px solid var(--cr); border-radius:var(--radius-sm); padding:12px 14px; margin-bottom:10px; }
      .sec__panel h4 { margin:0 0 6px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
      .sec__count { display:inline-block; min-width:18px; text-align:center; margin-left:6px; padding:0 5px; border-radius:9px; background:var(--cr-soft); color:var(--cr); font-size:11px; }
      .sec__hint { margin:2px 0 10px; color:var(--faint); font-size:12px; line-height:1.45; }
      .sec__row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .sec__col { display:flex; flex-direction:column; gap:8px; }
      .sec__in { flex:1; min-width:140px; background:var(--bg); border:1px solid var(--hair-strong); color:var(--text); border-radius:8px; padding:8px 10px; font-family:"Share Tech Mono",monospace; font-size:12px; }
      .sec__in:focus { outline:none; border-color:var(--cr); }
      .sec__btn { background:var(--raised-2); border:1px solid var(--hair-strong); color:var(--text); border-radius:8px; padding:7px 12px; font-size:12px; cursor:pointer; transition:var(--t); }
      .sec__btn:hover { border-color:var(--cr); }
      .sec__btn:disabled { opacity:.45; cursor:not-allowed; }
      .sec__btn--go { background:var(--cr); border-color:var(--cr); color:#fff; font-weight:600; }
      .sec__btn--danger:hover { border-color:var(--danger); color:var(--danger); }
      .sec__item { display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; padding:8px 0; border-top:1px solid var(--hair); }
      .sec__item:first-of-type { border-top:none; }
      .sec__kid { flex:0 0 auto; max-width:100%; font-family:"Share Tech Mono",monospace; font-size:11px; color:var(--cr); background:var(--cr-soft); padding:2px 6px; border-radius:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sec__lbl { flex:1 1 110px; min-width:80px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sec__tag { flex:0 0 auto; font-size:10px; letter-spacing:.05em; text-transform:uppercase; padding:2px 7px; border-radius:6px; }
      .sec__item .sec__btn { flex:0 0 auto; padding:5px 10px; }
      .sec__tag--live { color:var(--ok); border:1px solid rgba(52,211,153,.3); }
      .sec__tag--off { color:var(--faint); border:1px solid var(--hair-strong); }
      .sec__tag--warn { color:var(--warn); border:1px solid rgba(251,191,36,.4); background:rgba(251,191,36,.08); }
      .sec__dep { flex:0 0 auto; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); border:1px solid var(--hair-strong); border-radius:6px; padding:2px 7px; }
      .sec__alert { border:1px solid rgba(251,191,36,.4); background:rgba(251,191,36,.08); border-left:3px solid var(--warn); border-radius:var(--radius-sm); padding:11px 13px; margin-bottom:10px; }
      .sec__alert-h { color:var(--warn); font-weight:600; font-size:12px; letter-spacing:.04em; margin-bottom:3px; }
      .sec__alert-b { color:var(--text); font-size:12px; line-height:1.45; margin-bottom:9px; }
      .sec__alert .sec__btn--go { background:var(--warn); border-color:var(--warn); color:#1a1206; }
      /* #15: a dead device key / zero live keys is a red state, not an amber one —
         the fleet is silently unauthenticated, which reads as "fine" everywhere else. */
      .sec__alert--danger { border-color:rgba(239,68,68,.45); background:rgba(239,68,68,.09); border-left-color:var(--danger, #ef4444); }
      .sec__alert--danger .sec__alert-h { color:var(--danger, #ef4444); }
      .sec__msg { padding:8px 11px; border-radius:8px; margin-bottom:10px; font-size:12px; }
      .sec__msg--ok { color:var(--ok); background:rgba(52,211,153,.1); }
      .sec__msg--danger { color:var(--danger); background:rgba(248,113,113,.1); }
      .sec__msg--warn { color:var(--warn); background:rgba(251,191,36,.1); }
      .sec__msg--muted { color:var(--muted); background:var(--raised-2); }
    `}</style>
  );
}
