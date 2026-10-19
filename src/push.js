// Push notifications (iPhone app only).
// The app registers this phone with the home's Home Assistant ("mobile_app" integration) and gives it OUR relay
// as push_url (relay/server.mjs). Home Assistant then sends notifications through notify.mobile_app_<device>
// to the relay, which delivers them through Apple's APNs. No other app is involved.
import { MULTI } from "./home.js";
import { APP_VERSION } from "./version.js";
import { kvLoad, kvSave } from "./session.js";

const PUSH_URL = __PUSH_URL__;                 // build setting: PUSH_URL=https://relay.example.com/push/<secret>
const APP_ID = "ch.konihaus.app";
const KEY = "konihaus.push";                   // { [hassUrl]: { device_id, device_name, webhook_id } }

export const pushSupported = () => !!PUSH_URL && MULTI && !!window.Capacitor?.isNativePlatform?.();
// window.__pushTest is only set by the automated tests
const plugin = () => window.__pushTest ?? import("@capacitor/push-notifications").then(m => m.PushNotifications);

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const iosVersion = () => { const m = /OS (\d+)[_.](\d+)/.exec(navigator.userAgent); return m ? `${m[1]}.${m[2]}` : "unknown"; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
const json = { "Content-Type": "application/json" };
// The phone is known to Home Assistant under the home's main address, even when the home network address is
// the one in use right now (hassUrl below = the address in use).
let identity = "";
export const setPushIdentity = url => { identity = url; };
const keyOf = hassUrl => identity || hassUrl;

async function records() { return (await kvLoad(KEY)) ?? {}; }

// what the Settings page shows
export async function pushState(hassUrl) {
  const P = await plugin();
  const { receive } = await P.checkPermissions();
  const rec = (await records())[keyOf(hassUrl)];
  return {
    permission: receive === "granted" ? "granted" : receive === "denied" ? "denied" : "prompt",
    registered: !!rec?.webhook_id,
    service: rec?.device_name ? "notify.mobile_app_" + slug(rec.device_name) : "",
  };
}

// asks iOS for permission (first time) and registers the phone
export async function enablePush(auth, hassUrl) {
  const P = await plugin();
  let { receive } = await P.checkPermissions();
  if (receive !== "granted" && receive !== "denied") ({ receive } = await P.requestPermissions());
  if (receive !== "granted") return "denied";
  await registerPhone(P, auth, hassUrl);
  return "granted";
}

// at every start: if notifications are already allowed, make sure Home Assistant has the current token
export async function syncPush(auth, hassUrl) {
  if (!pushSupported()) return;
  try {
    const P = await plugin();
    if ((await P.checkPermissions()).receive === "granted") await registerPhone(P, auth, hassUrl);
  } catch (e) { console.warn("push sync failed", e); }
}

// sign out / leave home: Home Assistant stops sending to this phone
export async function disablePush(hassUrl) {
  if (!pushSupported()) return;
  try {
    const rec = (await records())[keyOf(hassUrl)];
    if (!rec?.webhook_id) return;
    await Promise.race([
      fetch(`${hassUrl}/api/webhook/${rec.webhook_id}`, { method: "POST", headers: json,
        body: JSON.stringify({ type: "update_registration", data: { app_data: { push_token: "", push_url: "" } } }) }),
      new Promise(r => setTimeout(r, 4000)),
    ]);
  } catch { /* best effort */ }
}

async function registerPhone(P, auth, hassUrl) {
  const token = await new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No push token from iOS (is the Push Notifications capability on?)")), 15000);
    try {
      await P.removeAllListeners();
      await P.addListener("registration", t => { clearTimeout(timer); resolve(t.value); });
      await P.addListener("registrationError", e => { clearTimeout(timer); reject(new Error(e?.error ?? "registration error")); });
      await P.register();
    } catch (e) { clearTimeout(timer); reject(e); }
  });
  await sendToHa(token, auth, hassUrl);
}

async function sendToHa(token, auth, hassUrl) {
  const all = await records();
  let rec = all[keyOf(hassUrl)];
  const app_data = { push_token: token, push_url: PUSH_URL };

  if (rec?.webhook_id) {   // already known to this Home Assistant: just update the token
    const r = await fetch(`${hassUrl}/api/webhook/${rec.webhook_id}`, { method: "POST", headers: json,
      body: JSON.stringify({ type: "update_registration", data: { app_data, app_version: APP_VERSION, os_version: iosVersion() } }) });
    const text = r.ok ? await r.text() : "";
    if (r.ok && text.trim()) return;       // an unknown webhook comes back empty: then register again below
  }

  const device_id = rec?.device_id ?? uuid();
  const device_name = rec?.device_name ?? `iPhone ${device_id.slice(0, 4)}`;
  if (auth.expired) await auth.refreshAccessToken();
  const r = await fetch(`${hassUrl}/api/mobile_app/registrations`, { method: "POST",
    headers: { ...json, Authorization: `Bearer ${auth.accessToken}` },
    body: JSON.stringify({ device_id, app_id: APP_ID, app_name: "Konihaus", app_version: APP_VERSION, device_name,
      manufacturer: "Apple", model: "iPhone", os_name: "iOS", os_version: iosVersion(), supports_encryption: false, app_data }) });
  if (!r.ok) throw new Error(`Home Assistant refused the registration (HTTP ${r.status})`);
  const reg = await r.json();
  all[keyOf(hassUrl)] = { device_id, device_name, webhook_id: reg.webhook_id };
  await kvSave(KEY, all);
}
