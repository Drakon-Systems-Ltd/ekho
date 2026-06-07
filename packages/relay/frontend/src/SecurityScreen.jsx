import { useEffect, useState, useCallback } from "react";
import {
  generateSeed,
  publicKeyB64url,
  keyId,
  signCanonical,
  encryptSeed,
  agentKeyEndorsementPayload,
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
} from "./api.js";
import { endorserStatus, dependentsOf, trustHealth } from "./operatorTrust.js";

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

  const onGenerate = async () => {
    if (passphrase.length < 8) return note("warn", "Choose a passphrase of at least 8 characters.");
    setBusy(true);
    try {
      const seed = generateSeed();
      const pub = publicKeyB64url(seed);
      const blob = await encryptSeed(seed, passphrase);
      await saveEncryptedSeed(blob);
      setUnlockedState(setUnlocked(seed));
      setStored(true);
      await registerOperatorKey(token, { publicKey: pub, label: label.trim() || "this device" });
      setPassphrase("");
      note(
        "warn",
        "Identity created and signing. ⚠ Your agents don't trust this key yet — endorse them in ③ (or use the banner) so they can verify your commands. Back it up below."
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
      setUnlockedState(await unlockFromStore(passphrase));
      setPassphrase("");
      note("ok", "Identity unlocked — signing active.");
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
    const deps = dependentsOf(kid, agentKeys);
    if (deps > 0) {
      const ok = window.confirm(
        `⚠ ${deps} agent${deps > 1 ? "s are" : " is"} endorsed by ${kid} — it is their trust root.\n\n` +
          `Revoking it now BREAKS their verification until you re-endorse them under another active key. ` +
          `Re-endorse them first (panel ③), then revoke.\n\nRevoke anyway?`
      );
      if (!ok) return;
    } else if (!window.confirm(`Revoke operator key ${kid}? Agents will stop trusting it on their next poll.`)) {
      return;
    }
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

      {/* Trust-health banner — surfaces a broken chain (e.g. agents left on a revoked key
          after a rotation) and offers the one-click fix, instead of failing silently. */}
      {!health.ok && agentKeys.length > 0 && (
        <div className="sec__alert">
          <div className="sec__alert-h">⚠ Agent trust needs attention</div>
          <div className="sec__alert-b">
            {health.problems.join(" · ")}. Endorsing re-roots each agent's trust at your current device key.
          </div>
          {unlocked ? (
            <button className="sec__btn sec__btn--go" disabled={busy} onClick={onReendorseAll}>
              Re-endorse all under this device · {unlocked.keyId}
            </button>
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
                    <button className="sec__btn" onClick={() => onEndorse(ak)} title="Re-endorse under this device">↻</button>
                  )}
                </>
              )}
              {st.state === "revoked" && (
                <>
                  <span className="sec__tag sec__tag--warn" title={`endorser ${st.endorserId} is revoked/unknown`}>
                    ⚠ trusts a revoked key
                  </span>
                  <button className="sec__btn sec__btn--go" disabled={!unlocked} onClick={() => onEndorse(ak)}>Re-endorse</button>
                </>
              )}
              {st.state === "unendorsed" && (
                <button className="sec__btn sec__btn--go" disabled={!unlocked} onClick={() => onEndorse(ak)}>Endorse</button>
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
      .sec__msg { padding:8px 11px; border-radius:8px; margin-bottom:10px; font-size:12px; }
      .sec__msg--ok { color:var(--ok); background:rgba(52,211,153,.1); }
      .sec__msg--danger { color:var(--danger); background:rgba(248,113,113,.1); }
      .sec__msg--warn { color:var(--warn); background:rgba(251,191,36,.1); }
      .sec__msg--muted { color:var(--muted); background:var(--raised-2); }
    `}</style>
  );
}
