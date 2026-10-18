// Keeps the sign-in alive: tokens are stored in localStorage AND IndexedDB, so if the
// browser drops one of them the session can be restored from the other.
const KEY = "hassTokens"; // the key home-assistant-js-websocket uses by default
const DB = "konihaus", STORE = "kv";

const openDb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function idbGet() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const q = db.transaction(STORE).objectStore(STORE).get(KEY);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  } catch { return undefined; }
}
async function idbSet(value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      if (value === undefined) st.delete(KEY); else st.put(value, KEY);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  } catch { /* storage not available: localStorage copy still works */ }
}

export async function loadTokens() {
  let t;
  try { t = JSON.parse(localStorage.getItem(KEY)); } catch { t = null; }
  if (t?.refresh_token) return t;
  t = await idbGet();
  if (t?.refresh_token) {                      // restore the localStorage copy
    try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ }
    return t;
  }
  return undefined;
}

export async function saveTokens(tokens) {
  if (!tokens) return clearTokens();
  try { localStorage.setItem(KEY, JSON.stringify(tokens)); } catch { /* ignore */ }
  await idbSet(tokens);
}

export async function clearTokens() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  await idbSet(undefined);
}

// ask the browser not to evict our storage (helps on iOS / low-storage phones)
export function requestPersistentStorage() {
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }
}
