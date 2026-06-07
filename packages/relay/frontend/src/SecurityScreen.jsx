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
      note("ok", "Operator identity created. Console sends are now signed. Download a backup below.");
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
    if (!window.confirm(`Revoke operator key ${kid}? Agents will stop trusting it on their next poll.`)) return;
    try {
      await revokeOperatorKey(token, kid);
      note("muted", `Revoked ${kid}.`);
      await refresh();
    } catch (e) {
      note("danger", `Revoke failed: ${e.message || e}`);
    }
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
        {keys.map((k) => (
          <div key={k.key_id} className="sec__item">
            <code className="sec__kid">{k.key_id}</code>
            <span className="sec__lbl">{k.label}</span>
            {k.revoked_at ? (
              <span className="sec__tag sec__tag--off">revoked</span>
            ) : (
              <>
                <span className="sec__tag sec__tag--live">active</span>
                <button className="sec__btn sec__btn--danger" onClick={() => onRevoke(k.key_id)}>Revoke</button>
              </>
            )}
          </div>
        ))}
      </section>

      {/* ③ Endorse agents */}
      <section className="sec__panel">
        <h4>③ Agent identities <span className="sec__count">{agentKeys.length}</span></h4>
        <p className="sec__hint">Endorse an agent's key so peers can verify it chains back to you. Requires an unlocked identity.</p>
        {agentKeys.length === 0 && <p className="sec__hint">No agent identity keys registered yet.</p>}
        {agentKeys.map((ak) => (
          <div key={`${ak.agent_id}:${ak.key_id}`} className="sec__item">
            <span className="sec__lbl">{nameFor(ak.agent_id)}</span>
            <code className="sec__kid">{ak.key_id}</code>
            {ak.endorsed_by_key_id ? (
              <span className="sec__tag sec__tag--live" title={`by ${ak.endorsed_by_key_id}`}>✓ endorsed</span>
            ) : (
              <button className="sec__btn sec__btn--go" disabled={!unlocked} onClick={() => onEndorse(ak)}>Endorse</button>
            )}
          </div>
        ))}
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
      .sec__item { display:flex; gap:10px; align-items:center; padding:7px 0; border-top:1px solid var(--hair); }
      .sec__item:first-of-type { border-top:none; }
      .sec__kid { font-family:"Share Tech Mono",monospace; font-size:11px; color:var(--cr); background:var(--cr-soft); padding:2px 6px; border-radius:5px; }
      .sec__lbl { flex:1; color:var(--text); }
      .sec__tag { font-size:10px; letter-spacing:.05em; text-transform:uppercase; padding:2px 7px; border-radius:6px; }
      .sec__tag--live { color:var(--ok); border:1px solid rgba(52,211,153,.3); }
      .sec__tag--off { color:var(--faint); border:1px solid var(--hair-strong); }
      .sec__msg { padding:8px 11px; border-radius:8px; margin-bottom:10px; font-size:12px; }
      .sec__msg--ok { color:var(--ok); background:rgba(52,211,153,.1); }
      .sec__msg--danger { color:var(--danger); background:rgba(248,113,113,.1); }
      .sec__msg--warn { color:var(--warn); background:rgba(251,191,36,.1); }
      .sec__msg--muted { color:var(--muted); background:var(--raised-2); }
    `}</style>
  );
}
