// In-memory unlocked operator key + passphrase-encrypted persistence (IndexedDB).
// The decrypted seed lives only in memory (this module); only the ENCRYPTED blob
// is persisted, so a page reload requires the passphrase again. The seed never
// touches the network.

import { decryptSeed, publicKeyB64url, keyId } from "./operatorKey.js";

const DB_NAME = "ekho-operator";
const STORE = "identity";
const REC = "encrypted-seed";

let unlocked = null; // { seed: Uint8Array, publicKey: string, keyId: string }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbOp(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const getStoredBlob = () => idbOp("readonly", (s) => s.get(REC));
export const hasStoredKey = async () => Boolean(await getStoredBlob());
export const saveEncryptedSeed = (blob) => idbOp("readwrite", (s) => s.put(blob, REC));
export const clearStoredKey = async () => {
  await idbOp("readwrite", (s) => s.delete(REC));
  unlocked = null;
};

export function setUnlocked(seed) {
  const pub = publicKeyB64url(seed);
  unlocked = { seed, publicKey: pub, keyId: keyId(pub) };
  return unlocked;
}

export async function unlockFromStore(passphrase) {
  const blob = await getStoredBlob();
  if (!blob) throw new Error("no stored operator key");
  return setUnlocked(await decryptSeed(blob, passphrase));
}

export const getUnlocked = () => unlocked;
export const lock = () => {
  unlocked = null;
};
