// Keeps the sign-in alive: tokens are stored in localStorage AND IndexedDB, so if the
// browser drops one of them the session can be restored from the other.
const KEY = "hassTokens"; // the key home-assistant-js-websocket uses by default
const DB = "konihaus", STORE = "kv";

// no storage backend may ever block the start of the app: give up on it after a moment
const within = (promise, ms = 2500, fallback = undefined) =>
  Promise.race([Promise.resolve(promise), new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

// In the iPhone app a third copy lives in native storage (@capacitor/preferences / UserDefaults),
// which the system does not clear when it cleans up web storage. (Only loaded inside the app.)
const prefs = () => (__MULTI__ && window.Capacitor?.isNativePlatform?.())
  ? import("@capacitor/preferences").then(m => m.Preferences).catch(() => null)
  : Promise.resolve(null);
async function nativeGet(key) {
  try { const P = await within(prefs(), 600, null); const r = P && await within(P.get({ key }), 600); return r?.value ? JSON.parse(r.value) : undefined; } catch { return undefined; }
}
// writing the backup never makes anyone wait (the other two copies are already saved); a removal waits a moment so it is not lost on reload
async function nativeSet(value, key, wait = false) {
  const job = (async () => {
    try {
      const P = await within(prefs(), 2500, null); if (!P) return;
      if (value === undefined) await within(P.remove({ key })); else await within(P.set({ key, value: JSON.stringify(value) }));
    } catch { /* ignore */ }
  })();
  if (wait) await within(job, 800);
}

const openDb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function idbGet(key = KEY) {
  try {
    const db = await within(openDb(), 2500, null);
    if (!db) return undefined;
    return await new Promise((resolve, reject) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  } catch { return undefined; }
}
async function idbSet(value, key = KEY) {
  try {
    const db = await within(openDb(), 2500, null);
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      if (value === undefined) st.delete(key); else st.put(value, key);
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
  t = await nativeGet(KEY);
  if (t?.refresh_token) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ } await idbSet(t); return t; }
  return undefined;
}

export async function saveTokens(tokens) {
  if (!tokens) return clearTokens();
  try { localStorage.setItem(KEY, JSON.stringify(tokens)); } catch { /* ignore */ }
  await idbSet(tokens);
  nativeSet(tokens, KEY);
}

export async function clearTokens() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  await idbSet(undefined);
  await nativeSet(undefined, KEY, true);
}

// ask the browser not to evict our storage (helps on iOS / low-storage phones)
export function requestPersistentStorage() {
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }
}

// ---- the chosen home (multi-home app): which Home Assistant this phone belongs to ----
const HOME_KEY = "konihaus.home";
export async function loadHomeRec() {
  let r;
  try { r = JSON.parse(localStorage.getItem(HOME_KEY)); } catch { r = null; }
  if (r?.hassUrl) return r;
  r = await idbGet(HOME_KEY);
  if (!r?.hassUrl) r = await nativeGet(HOME_KEY);
  if (r?.hassUrl) { try { localStorage.setItem(HOME_KEY, JSON.stringify(r)); } catch { /* ignore */ } return r; }
  return undefined;
}
export async function saveHomeRec(rec) {
  try { localStorage.setItem(HOME_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
  await idbSet(rec, HOME_KEY);
  nativeSet(rec, HOME_KEY);
}
export async function clearHomeRec() {
  try { localStorage.removeItem(HOME_KEY); } catch { /* ignore */ }
  await idbSet(undefined, HOME_KEY);
  await nativeSet(undefined, HOME_KEY, true);
}

// ---- small generic records (e.g. the push registration), kept in the same three places ----
export async function kvLoad(key) {
  let r;
  try { r = JSON.parse(localStorage.getItem(key)); } catch { r = null; }
  if (r) return r;
  r = (await idbGet(key)) ?? (await nativeGet(key));
  if (r) { try { localStorage.setItem(key, JSON.stringify(r)); } catch { /* ignore */ } return r; }
  return undefined;
}
export async function kvSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  await idbSet(value, key);
  nativeSet(value, key);
}
