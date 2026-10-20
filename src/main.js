import { getAuth, createConnection, subscribeEntities, callService, ERR_INVALID_AUTH } from "home-assistant-js-websocket";
import * as yaml from "js-yaml";
import "@mdi/font/css/materialdesignicons.min.css";
import "@fontsource-variable/outfit";
// only the Latin + Latin-Extended subsets (covers German and Hungarian), fewer files to copy
import "@fontsource/cormorant-garamond/latin-300.css";
import "@fontsource/cormorant-garamond/latin-400.css";
import "@fontsource/cormorant-garamond/latin-400-italic.css";
import "@fontsource/cormorant-garamond/latin-ext-300.css";
import "@fontsource/cormorant-garamond/latin-ext-400.css";
import "@fontsource/cormorant-garamond/latin-ext-400-italic.css";
import "./style.css";
import { tr, getLang, setLang, locale, LANGS } from "./i18n.js";
import { APP_VERSION } from "./version.js";
import { client } from "./client.js";
import { loadStructure, cardsFor } from "./rooms.js";
import { ensureLogin } from "./login.js";
import { MULTI, selectHome, leaveHome, resolveAddress } from "./home.js";
import { showLoader } from "./loader.js";
import { pushSupported, pushState, enablePush, syncPush, disablePush, setPushIdentity } from "./push.js";
import { loadTokens, saveTokens, clearTokens, requestPersistentStorage } from "./session.js";

const $app = document.querySelector("#app");
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
let HA_URL = import.meta.env.DEV && !MULTI ? client.devUrl : (client.hassUrl || window.location.origin);

// ---------- sign in, connect, load dashboard ----------
let ASSET_BASE = new URL(import.meta.env.BASE_URL, location.href).href; // where logo.png, dashboard.yaml, navigation.json live
let LOGO_URL = ASSET_BASE + "logo.png";
requestPersistentStorage();
let HOME = null;   // app: the chosen home (main address, optional home network address)
if (MULTI) {
  // multi-home app: asks for the home name the first time, then always uses that home's Home Assistant
  HOME = await selectHome($app, LOGO_URL);
  HA_URL = HOME.hassUrl; ASSET_BASE = HOME.assetBase; LOGO_URL = HOME.logoUrl || LOGO_URL;
  setPushIdentity(HOME.hassUrl);
  showLoader($app, LOGO_URL);
}
// forget this home (and its login) on this phone, back to the "home name" screen
async function changeHome() {
  await disablePush(HA_URL);
  try { await auth?.revoke(); } catch (e) { /* ignore */ }
  await clearTokens();
  await leaveHome();
  location.reload();
}

// a short, branded screen for "cannot reach Home Assistant" (keeps the saved login!)
function showRetry(detail = "") {
  return new Promise(resolve => {
    const wrap = h("div", "login-wrap"), card = h("div", "login-card");
    const logo = h("img", "login-logo"); logo.src = LOGO_URL; logo.alt = "";
    const btn = h("button", "login-btn", tr("Try again"));
    const go = () => { window.removeEventListener("online", go); wrap.remove(); resolve(); };
    btn.onclick = go;
    window.addEventListener("online", go);
    card.append(logo, h("div", "login-title", client.wordmark),
      h("div", "login-sub", tr("Cannot reach Konihaus Greenhub")),
      h("div", "login-note", tr("Check that VPN or Wi-Fi is on. You are still signed in.")), btn);
    if (detail) card.append(h("div", "login-detail", detail));   // what was tried and what came back
    if (MULTI) {
      const alt = h("button", "login-alt", tr("Not your home? Change home")); alt.type = "button";
      alt.onclick = changeHome;
      card.append(alt);
    }
    // web version: when the main address (Tailscale) is not reachable, the same page is also served on the home network
    const local = client.localUrl ? String(client.localUrl).replace(/\/+$/, "") : "";
    if (!MULTI && local && location.origin !== local) {
      const net = h("button", "login-alt", tr("Use the home network address")); net.type = "button";
      net.onclick = () => { location.href = local + location.pathname; };
      card.append(net);
    }
    wrap.append(card);
    $app.replaceChildren(wrap);
  });
}

let auth, conn, probeLog = "";
for (;;) {
  if (HOME) {
    // Tailscale address or home network address: whichever answers (checked again after every "Try again")
    showLoader($app, LOGO_URL);
    const at = await resolveAddress(HOME);
    probeLog = at.log.join("\n");
    HA_URL = at.url; ASSET_BASE = at.assetBase; LOGO_URL = at.logoUrl || LOGO_URL;
  }
  await ensureLogin(HA_URL, $app, LOGO_URL, MULTI ? changeHome : null, HOME?.hassUrl); // branded login when there is no saved session
  showLoader($app, LOGO_URL);   // while connecting and loading the dashboard
  try {
    // the saved login belongs to the home, not to one address: it is used with the address that answered
    const tokensHere = HOME ? async () => { const t = await loadTokens(); return t && { ...t, hassUrl: HA_URL }; } : loadTokens;
    auth = await getAuth({ hassUrl: HA_URL, loadTokens: tokensHere, saveTokens });
    conn = await createConnection({ auth });
    break;
  } catch (err) {
    if (err === ERR_INVALID_AUTH) { await clearTokens(); continue; } // session really expired: sign in again
    await showRetry(`${HA_URL}\n${err?.message ?? (typeof err === "number" ? "connection error " + err : String(err))}` + (probeLog ? "\n" + probeLog : ""));  // network problem: keep the session, retry
  }
}

const bust = MULTI ? "?_=" + Date.now() : ""; // the app may be offline-cached by HA for a long time otherwise
syncPush(auth, HA_URL); // iPhone app: keeps the notification token in Home Assistant up to date
const dashUrl = new URL("dashboard.yaml", ASSET_BASE).href + bust;
const dashRes = await fetch(dashUrl, { cache: "no-store" });
const dashText = await dashRes.text();
let dashboard;
try { dashboard = yaml.load(dashText); } catch (e) { dashboard = null; }
const view = dashboard?.views?.[0] ?? (dashboard?.sections ? dashboard : null);
if (!dashRes.ok || !view?.sections) {
  $app.textContent = `Could not load dashboard.yaml from ${dashUrl} (HTTP ${dashRes.status}). Starts with: ` + dashText.slice(0, 120);
  throw new Error("dashboard.yaml not usable");
}

let NAV = null; // optional per-client navigation.json: second badge row (rooms) per top badge
try {
  const r = await fetch(new URL("navigation.json", ASSET_BASE).href + bust, { cache: "no-store" });
  if (r.ok) NAV = await r.json();
} catch (e) { /* no navigation file: fine */ }

// ---------- helpers ----------
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const svc = (domain, service, data) => callService(conn, domain, service, data).catch(err => console.error(service, err));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const domainOf = id => (id || "").split(".")[0];
const icon = name => h("i", "mdi mdi-" + String(name).replace(/^mdi:/, "").replace(/[^a-z0-9-]/gi, ""));

const COLORS = {
  ha_green: "#5c9a47", ha_yellow: "#d9a21f", ha_red: "#d65a5a", ha_grey: "#8a8478",
  ha_blue: "#5f7fb0", darkblue: "#4f68b0", green: "#43a047", red: "#e53935", blue: "#1e88e5",
  yellow: "#fdd835", orange: "#fb8c00", pink: "#ec407a", purple: "#ab47bc", teal: "#26a69a",
  cyan: "#26c6da", amber: "#ffb300",
};
const colorOf = c => COLORS[c] ?? c;

const DEFAULT_ICONS = {
  cover: "window-shutter", light: "lightbulb", switch: "toggle-switch", climate: "thermostat",
  sensor: "eye", binary_sensor: "radiobox-blank", fan: "fan", lock: "lock", scene: "palette",
  script: "script-text", button: "gesture-tap-button", input_boolean: "toggle-switch",
};
const TAP = {
  light: ["homeassistant", "toggle"], switch: ["homeassistant", "toggle"], input_boolean: ["homeassistant", "toggle"],
  fan: ["homeassistant", "toggle"], cover: ["homeassistant", "toggle"], media_player: ["homeassistant", "toggle"],
  valve: ["homeassistant", "toggle"], scene: ["scene", "turn_on"], script: ["script", "turn_on"], button: ["button", "press"],
};
const CLASS_ICONS = {
  temperature: "thermometer", humidity: "water-percent", power: "flash", energy: "lightning-bolt", battery: "battery",
  motion: "motion-sensor", door: "door", window: "window-open-variant", co2: "molecule-co2", illuminance: "brightness-5",
  occupancy: "motion-sensor", moisture: "water-alert", pressure: "gauge", voltage: "sine-wave", current: "current-ac",
};
// what a tap does: the card's tap_action if it has one, else a sensible default for the entity type
function tapAction(c, dom, e) {
  const a = c.tap_action;
  if (a?.action === "none") return null;
  if (a?.action === "perform-action" || a?.action === "call-service") {
    const [d, sv] = String(a.perform_action ?? a.service ?? "").split(".");
    if (!d || !sv) return null;
    const target = a.target?.entity_id ? { entity_id: a.target.entity_id } : {};
    return () => svc(d, sv, { ...(a.data ?? a.service_data ?? {}), ...target });
  }
  if (a?.action === "more-info" || a?.action === "navigate" || a?.action === "url") return null;
  if (dom === "lock") return () => svc("lock", e?.state === "locked" ? "unlock" : "lock", { entity_id: c.entity });
  if (dom === "automation") return () => svc("automation", "trigger", { entity_id: c.entity });
  const t = TAP[dom];
  return t ? () => svc(t[0], t[1], { entity_id: c.entity }) : null;
}
const ACTIVE = new Set(["on", "open", "opening", "closing", "heat", "cool", "heat_cool", "auto", "playing", "unlocked"]);
const isActive = e => !!e && ACTIVE.has(e.state);

// states / modes from Home Assistant ("not_home", "heat_cool", ...) in the chosen language; anything unknown (numbers, names) stays as it is
const word = s => tr(String(s).replace(/_/g, " "));
function stateText(e) {
  if (!e) return word("unavailable");
  const a = e.attributes;
  if (domainOf(e.entity_id) === "cover") {
    const pos = a.current_position;
    return pos != null ? `${word(e.state)} · ${pos}%` : word(e.state);
  }
  if (domainOf(e.entity_id) === "light" && e.state === "on" && a.brightness != null)
    return `${word("on")} · ${Math.round(a.brightness / 2.55)}%`;
  return a.unit_of_measurement ? `${e.state} ${a.unit_of_measurement}` : word(e.state);
}

// branded "are you sure?" dialog
function confirmDialog(title, message, okLabel) {
  return new Promise(resolve => {
    const overlay = h("div", "modal-overlay");
    const box = h("div", "modal");
    box.setAttribute("role", "alertdialog");
    box.append(h("div", "modal-title", title), h("div", "modal-text", message));
    const row = h("div", "modal-actions");
    const cancel = h("button", "chip", tr("Cancel"));
    const ok = h("button", "chip active", okLabel);
    const close = v => { overlay.remove(); resolve(v); };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(false); });
    row.append(cancel, ok);
    box.append(row);
    overlay.append(box);
    document.body.append(overlay);
    cancel.focus();
  });
}

// ---------- state ----------
let states = {};
const watched = new Set();
function collectWatched(o) {
  if (Array.isArray(o)) return o.forEach(collectWatched);
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if ((k === "entity" || k === "ring_entity") && typeof v === "string") watched.add(v);
      else collectWatched(v);
    }
  }
}

// ---------- UI pieces ----------
function slider(value, disabled, onCommit, label) {
  const wrap = h("div", "slider");
  const input = h("input");
  input.type = "range"; input.min = 0; input.max = 100; input.value = value ?? 0;
  input.disabled = disabled;
  input.style.setProperty("--pct", `${input.value}%`);
  const out = h("span", "slider-val", `${Math.round(input.value)}%`);
  input.addEventListener("input", () => {
    out.textContent = `${input.value}%`;
    input.style.setProperty("--pct", `${input.value}%`);
  });
  input.addEventListener("change", () => onCommit(Number(input.value)));
  if (label) wrap.append(h("span", "slider-label", label));
  wrap.append(input, out);
  return wrap;
}

function buttonRow(items) {
  const row = h("div", "btn-row");
  for (const { label, ico, active, onClick } of items) {
    const b = h("button", "chip" + (active ? " active" : ""));
    if (ico) b.append(icon(ico));
    if (label) b.append(h("span", null, label));
    b.onclick = onClick;
    row.append(b);
  }
  return row;
}

function feature(f, c, e) {
  const id = c.entity;
  const a = e?.attributes ?? {};
  switch (f.type) {
    case "light-brightness":
      return slider(a.brightness != null ? Math.round(a.brightness / 2.55) : 0, !e, v => svc("light", "turn_on", { entity_id: id, brightness_pct: Math.max(1, v) }));
    case "cover-position":
      return slider(a.current_position, !e, v => svc("cover", "set_cover_position", { entity_id: id, position: v }));
    case "cover-tilt-position":
      return slider(a.current_tilt_position, !e, v => svc("cover", "set_cover_tilt_position", { entity_id: id, tilt_position: v }), tr("Tilt"));
    case "cover-open-close":
      return buttonRow([
        { ico: "arrow-up", onClick: () => svc("cover", "open_cover", { entity_id: id }) },
        { ico: "stop", onClick: () => svc("cover", "stop_cover", { entity_id: id }) },
        { ico: "arrow-down", onClick: () => svc("cover", "close_cover", { entity_id: id }) },
      ]);
    case "climate-hvac-modes":
      return buttonRow((a.hvac_modes ?? []).map(m => ({
        label: word(m), active: e.state === m,
        onClick: () => svc("climate", "set_hvac_mode", { entity_id: id, hvac_mode: m }),
      })));
    default:
      return null; // unsupported feature: skipped
  }
}

// a heading with a card_mod badge (content: '...'; background: red) -> real badge
function badgeFrom(c) {
  const css = c.card_mod?.style;
  if (typeof css !== "string") return null;
  const text = css.match(/content:\s*'([^']*)'/)?.[1];
  const bg = css.match(/background:\s*([a-z#0-9(),. ]+?);/i)?.[1];
  return text ? { text, bg: colorOf(bg?.trim() ?? "red") } : null;
}

// ---------- visibility conditions (state, numeric_state, and / or / not) ----------
const DASH_ENTITY = "input_select.dashboard";
let dashSel = null; // the badge chosen in this app; it replaces the real input_select state locally
const stateVal = id => (id === DASH_ENTITY && dashSel != null ? dashSel : states[id]?.state);
function condOk(c) {
  switch (c?.condition) {
    case "state": {
      const v = stateVal(c.entity);
      const want = [].concat(c.state ?? []).map(String), not = [].concat(c.state_not ?? []).map(String);
      if (want.length && !want.includes(String(v))) {
        // "1" vs "1.0" style numbers
        if (!want.some(w => num(w) != null && num(w) === num(v))) return false;
      }
      return !not.includes(String(v));
    }
    case "numeric_state": {
      const n = num(stateVal(c.entity));
      if (n == null) return false;
      if (c.above != null && !(n > num(c.above))) return false;
      if (c.below != null && !(n < num(c.below))) return false;
      return true;
    }
    case "and": return (c.conditions ?? []).every(condOk);
    case "or": return (c.conditions ?? []).some(condOk);
    case "not": return !(c.conditions ?? []).every(condOk);
    default: return true; // screen, user, time...: always shown
  }
}
const condsOk = list => (list ?? []).every(condOk);


// ---------- weather: current conditions + hourly / daily forecast chart ----------
const WEATHER_ICONS = {
  "clear-night": "weather-night", cloudy: "weather-cloudy", exceptional: "alert-circle-outline", fog: "weather-fog",
  hail: "weather-hail", lightning: "weather-lightning", "lightning-rainy": "weather-lightning-rainy",
  partlycloudy: "weather-partly-cloudy", pouring: "weather-pouring", rainy: "weather-rainy", snowy: "weather-snowy",
  "snowy-rainy": "weather-snowy-rainy", sunny: "weather-sunny", windy: "weather-windy", "windy-variant": "weather-windy-variant",
};
const forecasts = {}; // "entity|hourly" -> list; filled by a websocket subscription, redraws when it arrives
function forecastFor(entityId, type) {
  const key = entityId + "|" + type;
  if (!(key in forecasts)) {
    forecasts[key] = null;
    conn.subscribeMessage(msg => { forecasts[key] = msg?.forecast ?? []; signature = null; schedule(); },
      { type: "weather/subscribe_forecast", forecast_type: type, entity_id: entityId })
      .catch(() => { forecasts[key] = []; signature = null; schedule(); });
  }
  return forecasts[key];
}
const weatherMode = {}; // which forecast (hourly / daily) each card is showing

function forecastChart(list, type, slots, precision) {
  const now = Date.now();
  const items = list.filter(f => new Date(f.datetime).getTime() > now - (type === "hourly" ? 3600e3 : 86400e3)).slice(0, slots);
  const W = 58, H = 74, PAD = 12;
  const temps = items.map(f => num(f.temperature)).filter(v => v != null);
  const lo = Math.min(...temps), hi = Math.max(...temps), span = hi - lo || 1;
  const x = i => i * W + W / 2;
  const y = t => PAD + (1 - (t - lo) / span) * (H - 2 * PAD - 18);

  const wrap = h("div", "wx-scroll");
  const inner = h("div", "wx-inner");
  inner.style.width = items.length * W + "px";

  // time + icon row
  const top = h("div", "wx-row");
  for (const f of items) {
    const d = new Date(f.datetime);
    const slot = h("div", "wx-slot");
    slot.append(h("div", "wx-time", type === "hourly" ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(locale(), { weekday: "short" })));
    const ic = h("div", "wx-ic"); ic.append(icon(WEATHER_ICONS[f.condition] ?? "weather-cloudy")); slot.append(ic);
    top.append(slot);
  }
  inner.append(top);

  // temperature line + precipitation bars
  const svg = svgEl("svg", { viewBox: `0 0 ${items.length * W} ${H}`, width: items.length * W, height: H, class: "wx-svg" });
  items.forEach((f, i) => {
    const p = num(f.precipitation_probability) ?? (num(f.precipitation) != null ? Math.min(100, num(f.precipitation) * 20) : 0);
    if (p > 0) svg.append(svgEl("rect", { x: x(i) - 9, y: H - 4 - (p / 100) * 18, width: 18, height: (p / 100) * 18, rx: 3, fill: "#5f7fb0", "fill-opacity": 0.45 }));
  });
  const pts = items.map((f, i) => num(f.temperature) != null ? [x(i), y(num(f.temperature))] : null).filter(Boolean);
  if (pts.length > 1) svg.append(svgEl("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: "var(--amber)", "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  items.forEach((f, i) => {
    const t = num(f.temperature); if (t == null) return;
    svg.append(svgEl("circle", { cx: x(i), cy: y(t), r: 3.5, fill: "var(--amber)" }));
    const label = svgEl("text", { x: x(i), y: y(t) - 9, "text-anchor": "middle", class: "wx-temp" });
    label.textContent = t.toFixed(precision) + "°";
    svg.append(label);
  });
  inner.append(svg);
  wrap.append(inner);
  return wrap;
}

function renderWeather(c) {
  const id = typeof c.entity === "object" ? c.entity?.entity : c.entity;
  const e = states[id];
  const card = h("div", "card weather");
  if (!e) { card.append(h("div", "tile-state", tr("Weather unavailable"))); return card; }
  const a = e.attributes, fc = c.forecast ?? {}, prec = c.current?.temperature_precision ?? 1;

  if (c.show_current !== false) {
    const cur = h("div", "wx-current");
    const ic = h("div", "wx-big"); ic.append(icon(WEATHER_ICONS[e.state] ?? "weather-cloudy")); cur.append(ic);
    const tEntity = states[c.current?.temperature_entity];
    const t = num(tEntity?.state) ?? num(a.temperature);
    const txt = h("div", "wx-cur-text");
    txt.append(h("div", "wx-cur-temp", t != null ? `${t.toFixed(prec)}°` : "–"));
    const sec = c.current?.secondary_info_attribute ? a[c.current.secondary_info_attribute] : null;
    txt.append(h("div", "tile-state", word(e.state === "partlycloudy" ? "partly cloudy" : e.state.replace(/-/g, " ")) + (sec != null ? ` · ${sec}${c.current.secondary_info_attribute === "humidity" ? "%" : ""}` : "")));
    cur.append(txt);
    card.append(cur);
  }

  if (c.show_forecast !== false) {
    const key = c.entity + "|" + (c.name ?? "") + "|" + (fc.daily_slots ?? "") + (fc.hourly_slots ?? "");
    const toggles = c.forecast_action?.tap_action?.action === "toggle-forecast";
    const type = weatherMode[key] ?? (c.default_forecast === "daily" ? "daily" : "hourly");
    const list = forecastFor(id, type);
    if (toggles) {
      const row = h("div", "wx-toggle");
      for (const t of ["hourly", "daily"]) {
        const b = h("button", "chip" + (t === type ? " active" : ""), tr(t));
        b.onclick = () => { weatherMode[key] = t; signature = null; schedule(); };
        row.append(b);
      }
      card.append(row);
    }
    if (list == null) card.append(h("div", "tile-state", tr("Loading forecast…")));
    else if (!list.length) card.append(h("div", "tile-state", tr("No forecast available")));
    else card.append(forecastChart(list, type, type === "daily" ? (fc.daily_slots ?? 7) : (fc.hourly_slots ?? 12), fc.temperature_precision ?? 0));
  }
  return card;
}

// ---------- statistics-graph: long-term statistics as line / bar chart ----------
const stats = {}; // key -> {data, at}; fetched through the recorder, refreshed every 5 minutes
function statsFor(c) {
  const ids = (c.entities ?? []).map(e => typeof e === "string" ? e : e.entity);
  const period = c.period ?? "hour", days = c.days_to_show ?? 7;
  const types = (c.stat_types?.length ? c.stat_types : ["mean"]);
  const key = [ids.join(","), period, days, types.join(",")].join("|");
  const old = stats[key];
  if (!old || (!old.busy && Date.now() - old.at > 300e3)) {
    stats[key] = { data: old?.data ?? null, at: Date.now(), busy: true };
    conn.sendMessagePromise({ type: "recorder/statistics_during_period", start_time: new Date(Date.now() - days * 86400e3).toISOString(),
      statistic_ids: ids, period, types: [...new Set([...types, "mean", "state", "sum"])] })
      .then(r => { stats[key] = { data: r, at: Date.now() }; })
      .catch(() => { stats[key] = { data: {}, at: Date.now() }; })
      .finally(() => { signature = null; schedule(); });
  }
  return { ids, types, period, days, data: stats[key].data };
}
const LINE_COLORS = ["#c47a28", "#3f6b50", "#5f7fb0", "#a65b5b", "#7a6aa8"];

function renderStatsGraph(c) {
  const card = h("div", "card statgraph");
  if (c.title) card.append(h("div", "stat-title", c.title));
  const { ids, types, period, data } = statsFor(c);
  if (data == null) { card.append(h("div", "tile-state", tr("Loading…"))); return card; }
  const bar = c.chart_type === "bar" || c.chart_type === "bar-stack";
  const series = ids.map((id, i) => ({ id, color: LINE_COLORS[i % LINE_COLORS.length], name: states[id]?.attributes?.friendly_name ?? id,
    pts: (data[id] ?? []).map(r => ({ t: r.start, mean: num(r.mean ?? r.state ?? r.sum), min: num(r.min), max: num(r.max) })).filter(p => p.mean != null) }));
  const all = series.flatMap(s => s.pts);
  if (!all.length) { card.append(h("div", "tile-state", tr("No statistics yet"))); return card; }
  const W = 340, H = 140, L = 34, R = 6, T = 8, B = 20;
  const vals = all.flatMap(p => [p.mean, ...(!bar && types.includes("min") && p.min != null ? [p.min] : []), ...(!bar && types.includes("max") && p.max != null ? [p.max] : [])]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (bar && !c.fit_y_data) lo = Math.min(0, lo);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06; if (!bar) { lo -= pad; hi += pad; }
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t)) || t0 + 1;
  const X = t => L + (t - t0) / ((t1 - t0) || 1) * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "stat-svg" });
  const fmt = v => Math.abs(hi - lo) >= 10 ? v.toFixed(0) : v.toFixed(1);
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3, y = Y(v);
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y, stroke: "var(--chip-line)", "stroke-width": 0.6 }));
    const tx = svgEl("text", { x: L - 4, y: y + 3, "text-anchor": "end", class: "stat-ax" }); tx.textContent = fmt(v); svg.append(tx);
  }
  const fmtT = ms => { const d = new Date(ms); return period === "day" || c.days_to_show > 4 ? d.toLocaleDateString(locale(), { day: "numeric", month: "numeric" }) : d.toLocaleDateString(locale(), { weekday: "short" }) + " " + d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }); };
  [[t0, "start"], [t1, "end"]].forEach(([t, a]) => { const tx = svgEl("text", { x: a === "start" ? L : W - R, y: H - 5, "text-anchor": a, class: "stat-ax" }); tx.textContent = fmtT(t); svg.append(tx); });
  const bw = Math.max(1, (W - L - R) / Math.max(...series.map(s => s.pts.length)) - 1);
  series.forEach((s, si) => {
    if (bar) {
      const slot = bw / series.length;
      s.pts.forEach(p => svg.append(svgEl("rect", { x: X(p.t) - bw / 2 + si * slot, y: Math.min(Y(p.mean), Y(Math.max(lo, 0))), width: Math.max(0.8, slot), height: Math.abs(Y(Math.max(lo, 0)) - Y(p.mean)), fill: s.color, "fill-opacity": 0.8 })));
      return;
    }
    const withBand = types.includes("min") && types.includes("max") && s.pts.some(p => p.min != null && p.max != null);
    if (withBand) {
      const up = s.pts.filter(p => p.max != null).map(p => `${X(p.t)},${Y(p.max)}`);
      const dn = s.pts.filter(p => p.min != null).map(p => `${X(p.t)},${Y(p.min)}`).reverse();
      svg.append(svgEl("polygon", { points: [...up, ...dn].join(" "), fill: s.color, "fill-opacity": 0.15 }));
    }
    svg.append(svgEl("polyline", { points: s.pts.map(p => `${X(p.t)},${Y(p.mean)}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 1.8, "stroke-linejoin": "round" }));
  });
  card.append(svg);
  if (!c.hide_legend || series.length > 1) {
    const lg = h("div", "stat-legend");
    for (const s of series) { const i = h("span", "stat-key"); i.style.setProperty("--k", s.color); i.textContent = s.name; lg.append(i); }
    if (!c.hide_legend) card.append(lg);
  }
  return card;
}

// ---------- card renderers ----------
const renderers = {
  heading: c => {
    const el = h("div", "heading");
    if (c.icon) el.append(icon(c.icon));
    el.append(h("span", "heading-text", c.heading ?? ""));
    const badge = badgeFrom(c);
    if (badge) {
      const b = h("span", "badge", badge.text);
      b.style.background = badge.bg;
      el.append(b);
    }
    return el;
  },

  tile: c => {
    // any climate entity gets the full thermostat card (temperature up / down, hvac modes)
    if (domainOf(c.entity) === "climate") return renderers.thermostat({ ...c, features: [{ type: "climate-hvac-modes" }] });
    const e = states[c.entity];
    const dom = domainOf(c.entity);
    const card = h("div", "card tile" + (isActive(e) ? " on" : "") + (e ? "" : " unavailable"));
    if (c.color) card.style.setProperty("--tile-color", colorOf(c.color));

    const row = h("div", "tile-row");
    const ico = h("div", "tile-icon");
    ico.append(icon(c.icon ?? e?.attributes.icon ?? CLASS_ICONS[e?.attributes.device_class] ?? DEFAULT_ICONS[dom] ?? "circle-outline"));
    const txt = h("div", "tile-text");
    txt.append(h("div", "tile-name", c.name ?? e?.attributes.friendly_name ?? c.entity));
    if (!c.hide_state) txt.append(h("div", "tile-state", stateText(e)));
    row.append(ico, txt);
    const act = tapAction(c, dom, e);
    if (act) { row.onclick = act; row.style.cursor = "pointer"; } else row.style.cursor = "default";
    if (c.span) card.classList.add("span" + c.span);
    card.append(row);

    // shades and windows: up / stop / down buttons, and a slider only for the tilt
    const feats = dom === "cover"
      ? [{ type: "cover-open-close" }, ...(e?.attributes.current_tilt_position != null ? [{ type: "cover-tilt-position" }] : [])]
      : (c.features ?? []);
    for (const f of feats) {
      const fe = feature(f, c, e);
      if (fe) card.append(fe);
    }
    if (card.children.length > 1) card.classList.add("has-feat");   // buttons / slider under the name
    return card;
  },

  thermostat: c => {
    const e = states[c.entity];
    const a = e?.attributes ?? {};
    const card = h("div", "card thermostat");
    card.append(h("div", "thermo-name", c.name ?? a.friendly_name ?? c.entity));

    const main = h("div", "thermo-main");
    const cur = h("div", "thermo-current");
    cur.append(h("div", "thermo-big", a.current_temperature != null ? `${a.current_temperature}°` : "–"));
    cur.append(h("div", "thermo-sub", word(a.hvac_action ? a.hvac_action : (e?.state ?? "unavailable"))));
    main.append(cur);

    const target = num(a.temperature);
    if (target != null) {
      const step = num(a.target_temp_step) ?? 0.5;
      const set = t => svc("climate", "set_temperature", {
        entity_id: c.entity,
        temperature: Math.min(a.max_temp ?? 35, Math.max(a.min_temp ?? 5, t)),
      });
      const box = h("div", "thermo-target");
      const minus = h("button", "round", "−");
      const plus = h("button", "round", "+");
      minus.onclick = () => set(target - step);
      plus.onclick = () => set(target + step);
      box.append(minus, h("div", "thermo-set", `${target}°`), plus);
      main.append(box);
    }
    card.append(main);

    for (const f of c.features ?? []) {
      const fe = feature(f, c, e);
      if (fe) card.append(fe);
    }
    return card;
  },

  "picture-entity": c => {
    const e = states[c.entity];
    const card = h("div", "card picture");
    const img = h("img");
    const src = () => HA_URL + (states[c.entity]?.attributes.entity_picture ?? "") + "&_=" + Date.now();
    if (e?.attributes.entity_picture) {
      img.src = src(); img.alt = c.name ?? e.attributes.friendly_name ?? "";
      const t = setInterval(() => { if (!img.isConnected) clearInterval(t); else img.src = src(); }, 10000); // camera snapshot refresh
      card.append(img);
    }
    card.append(h("div", "picture-name", c.name ?? e?.attributes.friendly_name ?? c.entity));
    return card;
  },

  "custom:weather-forecast-card": renderWeather,
  "statistics-graph": renderStatsGraph,
  "weather-forecast": renderWeather,

  // mushroom cards -> the same look as a tile
  "custom:mushroom-entity-card": c => renderers.tile({ ...c, hide_state: c.secondary_info === "none" }),
  "custom:mushroom-light-card": c => renderers.tile({ ...c, features: c.show_brightness_control === false ? [] : [{ type: "light-brightness" }] }),

  "custom:ring-tile": c => {
    const ringId = c.ring_entity ?? (typeof c.entity === "object" ? c.entity?.entity : c.entity);
    const ve = states[ringId];
    const value = num(ve?.state);
    const min = c.min ?? 0, max = c.max ?? 100;
    const frac = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));

    // colour = highest threshold <= value
    let color = COLORS.ha_grey;
    const th = Object.entries(c.colour ?? {}).map(([k, v]) => [Number(k), v]).sort((x, y) => x[0] - y[0]);
    if (th.length) {
      color = colorOf(th[0][1]);
      for (const [k, v] of th) if (value != null && value >= k) color = colorOf(v);
    }

    const open = c.ring_type === "open";
    const R = 40, C = 2 * Math.PI * R;
    const sweep = open ? 270 : 360;
    const start = open ? 135 : -90; // degrees
    const arc = C * (sweep / 360);

    const card = h("div", "ring");
    const svg = svgEl("svg", { viewBox: "0 0 100 100", class: "ring-svg" });
    const track = svgEl("circle", {
      cx: 50, cy: 50, r: R, fill: "none", stroke: "currentColor", "stroke-opacity": 0.12, "stroke-width": 8,
      "stroke-linecap": "round", "stroke-dasharray": `${arc} ${C}`, transform: `rotate(${start} 50 50)`,
    });
    const val = svgEl("circle", {
      cx: 50, cy: 50, r: R, fill: "none", stroke: color, "stroke-width": 8,
      "stroke-linecap": "round", "stroke-dasharray": `${arc * frac} ${C}`, transform: `rotate(${start} 50 50)`,
    });
    svg.append(track, val);
    if (c.indicator === "dot" && value != null) {
      const ang = (start + sweep * frac) * Math.PI / 180;
      svg.append(svgEl("circle", { cx: 50 + R * Math.cos(ang), cy: 50 + R * Math.sin(ang), r: 4.5, fill: "currentColor" }));
    }
    card.append(svg);

    const unit = ve?.attributes.unit_of_measurement ?? "";
    const center = h("div", "ring-center");
    center.append(h("div", "ring-value", value != null ? String(Math.round(value * 10) / 10) : "–"));
    if (unit) center.append(h("div", "ring-unit", unit));
    card.append(center);
    card.append(h("div", "ring-name", c.name ?? ve?.attributes.friendly_name ?? ""));
    return card;
  },

  conditional: c => {
    return condsOk(c.conditions) && c.card ? renderCard(c.card) : null;
  },

  grid: c => {
    const d = h("div", "subgrid");
    d.append(...(c.cards ?? []).map(renderCard).filter(Boolean));
    return d;
  },
};

function renderCard(c) {
  // card-level visibility: only simple state conditions
  const visibleNow = condsOk(c.visibility);
  if (!visibleNow || !renderers[c.type]) return null; // unknown types are skipped
  const el = renderers[c.type](c);
  const cols = c.grid_options?.columns === "full" ? 12 : Number(c.grid_options?.columns);
  if (el && cols >= 1 && cols <= 12 && c.type !== "custom:ring-tile" && !el.classList.contains("heading") && !el.classList.contains("subgrid")) el.classList.add("span" + cols); // rings: always 3 per row
  if (el && ![...el.classList].some(k => k.startsWith("span")))
    el.classList.add(c.type === "custom:ring-tile" ? "span4" : "span12");
  return el;
}

// ---------- dashboard-driven navigation (top badges = the dashboard's own badges) ----------
// Same idea as Home Assistant: a badge picks input_select.dashboard, sections show for the picked value.
const topBadges = (view.badges ?? [])
  .filter(b => b?.tap_action?.data?.option && !(NAV?.skip ?? []).includes(b.tap_action.data.option))
  .map(b => ({ option: b.tap_action.data.option, label: b.name ?? b.tap_action.data.option, ico: b.icon, visibility: b.visibility }));
const dashMode = topBadges.length > 0;
if (dashMode) collectWatched(view.badges); // so the armed/unarmed state redraws the badges

const DASH_KEY = "konihaus.dashboard";
let dash = { top: topBadges[0]?.option, room: "All" };
try { const sv = JSON.parse(localStorage.getItem(DASH_KEY) ?? "null"); if (sv?.top) dash = sv; } catch (e) { /* ignore */ }

const visibleTop = () => topBadges.filter(b => condsOk(b.visibility));
const headingOf = c => c.type === "heading" ? c.heading : (c.type === "conditional" && c.card?.type === "heading" ? c.card.heading : null);
const primaryEntity = c => c.entity ?? c.card?.entity ?? c.ring_entity ?? "";
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

// sort a page's cards into rooms: a heading starts a room, "assign" rules override, the rest follows the last heading
function groupRooms(sections, cfg, topOption) {
  const lc = x => String(x).trim().toLowerCase();
  const names = new Map(cfg.rooms.map(r => [lc(r), r]));
  const alias = new Map(Object.entries(cfg.aliases ?? {}).map(([k, v]) => [lc(k), v]));
  const resolve = label => {
    const a = alias.get(lc(label)) ?? label;
    return names.get(lc(a)) ?? cfg.common ?? null;
  };
  const rules = (NAV?.assign ?? []).filter(r => !r.in || r.in === topOption).map(r => ({ re: globRe(r.match), room: r.room }));
  return sections.map(cards => {
    let cur = cfg.rooms[0];
    return cards.map(c => {
      const hd = headingOf(c);
      if (hd != null) cur = resolve(hd);
      const ent = primaryEntity(c);
      const rule = rules.find(r => r.re.test(ent));
      return { card: c, room: rule ? rule.room : cur };
    });
  });
}

function dashPage() {
  const tops = visibleTop();
  const top = tops.find(b => b.option === dash.top) ?? tops[0];
  dash.top = top?.option;
  dashSel = dash.top ?? null; // the local stand-in for input_select.dashboard
  const sections = view.sections.filter(sec => condsOk(sec.visibility)).map(sec => sec.cards ?? []);
  const cfg = NAV?.rooms?.[dash.top];
  if (!cfg) return { title: top?.label ?? client.name, sub: "", sections, rooms: null };

  const grouped = groupRooms(sections, cfg, dash.top);
  const present = new Set(grouped.flat().map(x => x.room));
  const rooms = [...cfg.rooms, ...(cfg.common ? [cfg.common] : [])].filter((r, i, a) => present.has(r) && a.indexOf(r) === i);
  if (dash.room !== "All" && !rooms.includes(dash.room)) dash.room = "All";
  const shown = dash.room === "All" ? sections
    : grouped.map(sec => sec.filter(x => x.room === dash.room).map(x => x.card)).filter(a => a.length);
  return { title: dash.room === "All" ? (top?.label ?? "") : dash.room, sub: dash.room === "All" ? "" : (top?.label ?? ""), sections: shown, rooms };
}
function selectDash(next) {
  dash = { ...dash, ...next };
  try { localStorage.setItem(DASH_KEY, JSON.stringify(dash)); } catch (e) { /* ignore */ }
  scrollToTop = true;
  render();
  signature = sig();
}
function dashRows(page) {
  const rows = [badgeRow(visibleTop().map(b => ({
    label: b.label, ico: b.ico, active: b.option === dash.top,
    onClick: () => selectDash({ top: b.option, room: "All" }),
  })))];
  if (page.rooms?.length) {
    rows.push(badgeRow(["All", ...page.rooms].map(r => ({ label: r === "All" ? tr("All") : r, active: r === dash.room, onClick: () => selectDash({ room: r }) }))));
  }
  return rows;
}

// ---------- levels, rooms, favorites (Home Assistant floors and areas; used when the dashboard has no badges) ----------
let structure = null;
const staleDashboard = !!NAV && !dashMode; // navigation.json is there, but dashboard.yaml has no badges: an old copy is still in www
if (!dashMode && !NAV) { try { structure = await loadStructure(conn); } catch (e) { console.warn("rooms unavailable", e); } }

const SEL_KEY = "konihaus.selection";
let sel = { p: structure?.favorites.length ? "fav" : "home" };
try { const saved = JSON.parse(localStorage.getItem(SEL_KEY) ?? "null"); if (saved?.p) sel = saved; } catch (e) { /* ignore */ }

function floorOf(id) { return structure?.floors.find(f => f.id === id); }
function validSel() {
  if (!structure) return { p: "home" };
  if (sel.p === "fav" && !structure.favorites.length) return { p: "home" };
  if (sel.p === "floor") {
    const f = floorOf(sel.f);
    if (!f) return { p: "home" };
    if (sel.a !== "all" && !f.areas.some(a => a.id === sel.a)) return { p: "floor", f: f.id, a: "all" };
  }
  return sel;
}
function select(next) {
  sel = next;
  try { localStorage.setItem(SEL_KEY, JSON.stringify(sel)); } catch (e) { /* ignore */ }
  scrollToTop = true;
  render();
  signature = sig();
}
let scrollToTop = false;

// what the current selection shows: a title, a small line, and sections of cards
function currentPage() {
  if (staleDashboard) return { title: client.name, sub: "", sections: [], rooms: null, stale: true };
  if (dashMode) return dashPage();
  sel = validSel();
  if (sel.p === "fav") {
    return { title: tr("Favorites"), sub: "", sections: [cardsFor(structure.favorites, states)] };
  }
  if (sel.p === "floor") {
    const f = floorOf(sel.f);
    if (sel.a === "all") {
      return { title: f.name, sub: tr("All rooms"), sections: f.areas.map(a => [{ type: "heading", heading: a.name, icon: a.icon }, ...cardsFor(a.entities, states)]) };
    }
    const a = f.areas.find(x => x.id === sel.a);
    return { title: a.name, sub: f.name, sections: [cardsFor(a.entities, states)] };
  }
  return { title: view.title ?? client.name, sub: "", sections: view.sections.map(sec => sec.cards ?? []) };
}

// scrollable badge rows under the header
function badgeRow(items) {
  const row = h("div", "badges");
  for (const it of items) {
    const b = h("button", "badge-pill" + (it.active ? " active" : ""));
    b.type = "button";
    if (it.ico) b.append(icon(it.ico));
    b.append(h("span", null, it.label));
    b.onclick = it.onClick;
    row.append(b);
  }
  return row;
}
function levelRow() {
  const items = [];
  if (structure.favorites.length) items.push({ label: tr("Favorites"), ico: "star-outline", active: sel.p === "fav", onClick: () => select({ p: "fav" }) });
  items.push({ label: view.title ?? tr("Home"), ico: "home-outline", active: sel.p === "home", onClick: () => select({ p: "home" }) });
  for (const f of structure.floors) {
    items.push({ label: f.name, ico: f.icon, active: sel.p === "floor" && sel.f === f.id, onClick: () => select({ p: "floor", f: f.id, a: "all" }) });
  }
  return badgeRow(items);
}
function roomRow() {
  const f = floorOf(sel.f);
  const items = [{ label: tr("All"), active: sel.a === "all", onClick: () => select({ p: "floor", f: f.id, a: "all" }) }];
  for (const a of f.areas) items.push({ label: a.name, ico: a.icon, active: sel.a === a.id, onClick: () => select({ p: "floor", f: f.id, a: a.id }) });
  return badgeRow(items);
}

// ---------- render loop ----------
// ---------- energy page (bottom menu): same data as the Home Assistant energy dashboard ----------
let tab = "home";
const energy = { range: "today", prefs: undefined, cache: {} };
const RANGES = [["today", "Today"], ["week", "7 days"], ["month", "30 days"], ["year", "This year"]];
const toKwh = (v, unit) => unit === "Wh" ? v / 1000 : unit === "MWh" ? v * 1000 : v;

function energySetup(prefs) {
  const g = { gridIn: [], gridOut: [], solar: [], battIn: [], battOut: [], gas: [], water: [], devices: [] };
  for (const src of prefs?.energy_sources ?? []) {
    if (src.type === "grid") {
      for (const f of src.flow_from ?? []) g.gridIn.push(f.stat_energy_from);
      for (const f of src.flow_to ?? []) g.gridOut.push(f.stat_energy_to);
      if (src.stat_energy_from) g.gridIn.push(src.stat_energy_from);   // older config format
      if (src.stat_energy_to) g.gridOut.push(src.stat_energy_to);
    } else if (src.type === "solar") g.solar.push(src.stat_energy_from);
    else if (src.type === "battery") { g.battOut.push(src.stat_energy_from); g.battIn.push(src.stat_energy_to); }
    else if (src.type === "gas") g.gas.push(src.stat_energy_from);
    else if (src.type === "water") g.water.push(src.stat_energy_from);
  }
  for (const d of prefs?.device_consumption ?? []) g.devices.push({ id: d.stat_consumption, name: d.name });
  for (const k of Object.keys(g)) if (k !== "devices") g[k] = [...new Set(g[k].filter(Boolean))];
  return g;
}

function energyRange() {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (energy.range === "today") return { start: d, period: "hour" };
  if (energy.range === "week") { d.setDate(d.getDate() - 6); return { start: d, period: "day" }; }
  if (energy.range === "month") { d.setDate(d.getDate() - 29); return { start: d, period: "day" }; }
  return { start: new Date(now.getFullYear(), 0, 1), period: "month" };
}

// electricity flows with their price setup (for the cost tile)
function energyFlows(prefs) {
  const from = [], to = [];
  for (const src of prefs?.energy_sources ?? []) {
    if (src.type !== "grid") continue;
    for (const f of src.flow_from ?? []) from.push({ stat: f.stat_energy_from, cost: f.stat_cost, price: f.number_energy_price, priceEntity: f.entity_energy_price });
    for (const f of src.flow_to ?? []) to.push({ stat: f.stat_energy_to, cost: f.stat_compensation, price: f.number_energy_price, priceEntity: f.entity_energy_price });
  }
  return { from, to };
}
function energyPrevRange() {
  const { start } = energyRange();
  const days = { today: 1, week: 7, month: 30 }[energy.range];
  if (!days) return null;
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - days);
  return { prevStart, end: start, elapsed: Date.now() - start.getTime(), label: { today: "yesterday", week: "previous 7 days", month: "previous 30 days" }[energy.range] };
}
function energyData() {
  const refresh = () => { signature = null; schedule(); };
  if (energy.currency === undefined) {
    energy.currency = null;
    conn.sendMessagePromise({ type: "get_config" }).then(c => { energy.currency = c?.currency ?? ""; }).catch(() => { energy.currency = ""; }).finally(refresh);
  }
  if (energy.prefs === undefined) {
    energy.prefs = null;
    conn.sendMessagePromise({ type: "energy/get_prefs" }).then(p => { energy.prefs = p; }).catch(() => { energy.prefs = { error: true }; }).finally(refresh);
    return null;
  }
  if (!energy.prefs || energy.prefs.error) return null;
  const setup = energySetup(energy.prefs);
  const fl = energyFlows(energy.prefs);
  const costIds = [...fl.from, ...fl.to].map(f => f.cost).filter(Boolean);
  const mainIds = [...new Set([...Object.entries(setup).flatMap(([k, v]) => k === "devices" ? [] : v)])];
  const ids = [...new Set([...mainIds, ...setup.devices.map(x => x.id), ...costIds])];
  const { start, period } = energyRange();
  const pr = energyPrevRange();
  if (pr && mainIds.length) {
    const pk = energy.range + "|prev", po = energy.cache[pk];
    if (!po || (!po.busy && Date.now() - po.at > 300e3)) {
      energy.cache[pk] = { data: po?.data ?? null, at: Date.now(), busy: true };
      conn.sendMessagePromise({ type: "recorder/statistics_during_period", start_time: pr.prevStart.toISOString(), end_time: pr.end.toISOString(), statistic_ids: mainIds, period, types: ["change"] })
        .then(r => { energy.cache[pk] = { data: r, at: Date.now() }; })
        .catch(() => { energy.cache[pk] = { data: {}, at: Date.now() }; })
        .finally(refresh);
    }
  }
  const key = energy.range, old = energy.cache[key];
  if (ids.length && (!old || (!old.busy && Date.now() - old.at > 300e3))) {
    energy.cache[key] = { data: old?.data ?? null, at: Date.now(), busy: true };
    conn.sendMessagePromise({ type: "recorder/statistics_during_period", start_time: start.toISOString(), statistic_ids: ids, period, types: ["change"] })
      .then(r => { energy.cache[key] = { data: r, at: Date.now() }; })
      .catch(() => { energy.cache[key] = { data: {}, at: Date.now() }; })
      .finally(refresh);
  }
  const data = energy.cache[key]?.data;
  const prevData = pr ? energy.cache[energy.range + "|prev"]?.data : null;
  return data ? { setup, data, period, start, flows: fl, prev: prevData ? { data: prevData, ...pr } : null, currency: energy.currency } : null;
}

// per-statistic series [{t, v}] in kWh (or the sensor's own unit for gas / water)
function seriesOf(data, id, convert = true) {
  const unit = states[id]?.attributes?.unit_of_measurement;
  return (data[id] ?? []).map(r => ({ t: r.start, v: convert ? toKwh(num(r.change) ?? 0, unit) : (num(r.change) ?? 0) }));
}
function sumSeries(data, ids, convert = true) {
  const m = new Map();
  for (const id of ids) for (const p of seriesOf(data, id, convert)) m.set(p.t, (m.get(p.t) ?? 0) + p.v);
  return [...m].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}
const total = pts => pts.reduce((a, p) => a + p.v, 0);
const fmtKwh = v => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + " kWh";

function energyChart(groups, period) {
  const W = 340, H = 150, L = 34, R = 6, T = 8, B = 20;
  const times = [...new Set(groups.flatMap(g => g.pts.map(p => p.t)))].sort((a, b) => a - b);
  if (!times.length) return h("div", "tile-state", tr("No data in this period"));
  const max = Math.max(...groups.flatMap(g => g.pts.map(p => p.v)), 0.1);
  const slot = (W - L - R) / times.length, bw = Math.max(1.5, slot * 0.8 / groups.length);
  const Y = v => T + (1 - v / max) * (H - T - B);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "stat-svg" });
  for (let i = 0; i <= 3; i++) {
    const v = max * i / 3, y = Y(v);
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y, stroke: "var(--chip-line)", "stroke-width": 0.6 }));
    const tx = svgEl("text", { x: L - 4, y: y + 3, "text-anchor": "end", class: "stat-ax" }); tx.textContent = v >= 10 ? v.toFixed(0) : v.toFixed(1); svg.append(tx);
  }
  groups.forEach((g, gi) => {
    const byT = new Map(g.pts.map(p => [p.t, p.v]));
    times.forEach((t, ti) => { const v = byT.get(t); if (v > 0) svg.append(svgEl("rect", { x: L + ti * slot + slot * 0.1 + gi * bw, y: Y(v), width: bw, height: H - B - Y(v), rx: 1, fill: g.color })); });
  });
  const lab = t => { const d = new Date(t); return period === "hour" ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : period === "month" ? d.toLocaleDateString(locale(), { month: "short" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "numeric" }); };
  [[times[0], "start", L], [times[times.length - 1], "end", W - R]].forEach(([t, a, x]) => { const tx = svgEl("text", { x, y: H - 5, "text-anchor": a, class: "stat-ax" }); tx.textContent = lab(t); svg.append(tx); });
  return svg;
}

// stacked bars: one colored segment per series for every time slot
function stackedChart(series, period) {
  const W = 340, H = 160, L = 34, R = 6, T = 8, B = 20;
  const times = [...new Set(series.flatMap(g => g.pts.map(p => p.t)))].sort((a, b) => a - b);
  if (!times.length) return h("div", "tile-state", tr("No data in this period"));
  const sums = times.map(t => series.reduce((a, g) => a + (g.pts.find(p => p.t === t)?.v ?? 0), 0));
  const max = Math.max(...sums, 0.1);
  const slot = (W - L - R) / times.length, bw = Math.max(1.5, slot * 0.8);
  const Y = v => T + (1 - v / max) * (H - T - B);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "stat-svg" });
  for (let i = 0; i <= 3; i++) {
    const v = max * i / 3, y = Y(v);
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y, stroke: "var(--chip-line)", "stroke-width": 0.6 }));
    const tx = svgEl("text", { x: L - 4, y: y + 3, "text-anchor": "end", class: "stat-ax" }); tx.textContent = v >= 10 ? v.toFixed(0) : v.toFixed(1); svg.append(tx);
  }
  times.forEach((t, ti) => {
    let acc = 0;
    for (const g of series) {
      const v = g.pts.find(p => p.t === t)?.v ?? 0; if (v <= 0) continue;
      svg.append(svgEl("rect", { x: L + ti * slot + (slot - bw) / 2, y: Y(acc + v), width: bw, height: Math.max(0.5, Y(acc) - Y(acc + v)), fill: g.color }));
      acc += v;
    }
  });
  const lab = t => { const d = new Date(t); return period === "hour" ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : period === "month" ? d.toLocaleDateString(locale(), { month: "short" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "numeric" }); };
  [[times[0], "start", L], [times[times.length - 1], "end", W - R]].forEach(([t, a, x]) => { const tx = svgEl("text", { x, y: H - 5, "text-anchor": a, class: "stat-ax" }); tx.textContent = lab(t); svg.append(tx); });
  return svg;
}

function renderEnergy(top) {
  watched.clear();
  const hero = h("div", "hero-text");
  hero.append(h("div", "hero-title", tr("Energy")), h("div", "hero-sub", tr(RANGES.find(r => r[0] === energy.range)[1])));
  const header = h("header", "hero");
  header.append(top, hero, badgeRow(RANGES.map(([id, label]) => ({ label: tr(label), active: energy.range === id, onClick: () => { energy.range = id; signature = null; schedule(); } }))));

  const sheet = h("div", "sheet"), wrap = h("main", "sections energy-page"), sec = h("section", "section");
  wrap.append(sec); sheet.append(wrap);
  const res = energyData();
  if (energy.prefs?.error) sec.append(h("div", "empty", tr("Could not read the energy configuration from Home Assistant.")));
  else if (!res) sec.append(h("div", "empty", energy.prefs && !energySetup(energy.prefs).gridIn.length && !energySetup(energy.prefs).solar.length && !energySetup(energy.prefs).devices.length ? tr("The Home Assistant energy dashboard has nothing configured.") : tr("Loading energy data…")));
  else {
    const { setup: s, data, period, start, flows, prev, currency } = res;
    const gridIn = sumSeries(data, s.gridIn), gridOut = sumSeries(data, s.gridOut), solar = sumSeries(data, s.solar);
    const battIn = sumSeries(data, s.battIn), battOut = sumSeries(data, s.battOut);
    const home = total(gridIn) + total(solar) + total(battOut) - total(gridOut) - total(battIn);
    // comparison with the previous period (same elapsed time)
    const prevTotal = (ids, sign = 1) => {
      if (!prev) return null;
      const m = new Map();
      for (const id of ids) for (const p of seriesOf(prev.data, id)) if (p.t - prev.prevStart.getTime() < prev.elapsed) m.set(p.t, (m.get(p.t) ?? 0) + p.v);
      return sign * [...m.values()].reduce((a, v) => a + v, 0);
    };
    const delta = (cur, before) => {
      if (before == null || before < 0.05) return null;
      const pct = Math.round((cur - before) / before * 100);
      return { text: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% ${tr("vs")} ${tr(prev.label)}`, up: pct >= 0 };
    };
    const homePrev = prev ? prevTotal(s.gridIn) + prevTotal(s.solar) + prevTotal(s.battOut) - prevTotal(s.gridOut) - prevTotal(s.battIn) : null;
    const tiles = [];
    const add = (label, ico, val, color, d) => tiles.push([label, ico, val, color, d]);
    if (s.gridIn.length) add(tr("Grid consumption"), "transmission-tower-export", fmtKwh(total(gridIn)), "#c47a28", delta(total(gridIn), prevTotal(s.gridIn)));
    if (s.gridOut.length) add(tr("Returned to grid"), "transmission-tower-import", fmtKwh(total(gridOut)), "#5f7fb0");
    if (s.solar.length) add(tr("Solar"), "solar-power", fmtKwh(total(solar)), "#3f6b50");
    if (s.battIn.length || s.battOut.length) add(tr("Battery in / out"), "battery-charging", `${total(battIn).toFixed(1)} / ${total(battOut).toFixed(1)} kWh`, "#7a6aa8");
    if (s.gridIn.length || s.solar.length) add(tr("Home usage"), "home-lightning-bolt-outline", fmtKwh(Math.max(0, home)), "#a65b5b", delta(home, homePrev));
    if (energy.range !== "today") {
      const days = Math.max(1, Math.ceil((Date.now() - start.getTime()) / 86400e3));
      add(tr("Daily average"), "chart-timeline-variant", fmtKwh(Math.max(0, home) / days), "#7a6aa8");
    }
    if (s.gas.length) add(tr("Gas"), "fire", `${total(sumSeries(data, s.gas, false)).toFixed(1)} ${states[s.gas[0]]?.attributes?.unit_of_measurement ?? ""}`, "#c47a28");
    if (s.water.length) add(tr("Water"), "water-outline", `${total(sumSeries(data, s.water, false)).toFixed(1)} ${states[s.water[0]]?.attributes?.unit_of_measurement ?? ""}`, "#5f7fb0");
    // cost: HA's own cost statistic when it has one, otherwise the fixed or current price times the energy
    let cost = 0, approx = false, haveCost = false;
    const flowCost = (f, kwh) => {
      if (f.cost) { haveCost = true; return total(sumSeries(data, [f.cost], false)); }
      const price = f.price ?? num(states[f.priceEntity]?.state);
      if (price == null) return 0;
      haveCost = true; if (f.price == null) approx = true;
      return kwh * price;
    };
    for (const f of flows.from) cost += flowCost(f, total(sumSeries(data, [f.stat])));
    for (const f of flows.to) cost -= flowCost(f, total(sumSeries(data, [f.stat])));
    if (haveCost) add(tr("Cost"), "cash", `${approx ? "≈ " : ""}${cost.toFixed(2)} ${currency ?? ""}`.trim(), "#3f6b50");

    const grid = h("div", "card en-tiles span12");
    for (const [label, ico, val, color, d] of tiles) {
      const t = h("div", "en-tile"); t.style.setProperty("--k", color);
      const ic = h("div", "en-ic"); ic.append(icon(ico));
      t.append(ic, h("div", "en-val", val), h("div", "tile-state", label));
      if (d) t.append(h("div", "en-delta " + (d.up ? "up" : "down"), d.text));
      grid.append(t);
    }
    sec.append(grid);

    const groups = [[tr("Consumption"), gridIn, "#c47a28"], [tr("Solar"), solar, "#3f6b50"], [tr("Returned"), gridOut, "#5f7fb0"]].filter(g => g[1].length).map(([name, pts, color]) => ({ name, pts, color }));
    if (groups.length) {
      const card = h("div", "card statgraph en-chart span12");
      card.append(h("div", "stat-title", tr("Electricity (kWh)")), energyChart(groups, period));
      const lg = h("div", "stat-legend");
      for (const g of groups) { const i = h("span", "stat-key"); i.style.setProperty("--k", g.color); i.textContent = g.name; lg.append(i); }
      card.append(lg); sec.append(card);
    }

    const devs = s.devices.map(d => ({ id: d.id, name: d.name ?? states[d.id]?.attributes?.friendly_name ?? d.id, v: total(sumSeries(data, [d.id])) })).sort((a, b) => b.v - a.v);
    const untracked = Math.max(0, home - devs.reduce((a, d) => a + d.v, 0));
    if (devs.length && (s.gridIn.length || s.solar.length) && untracked > 0.05) devs.push({ name: tr("Untracked consumption"), v: untracked, grey: true });
    devs.sort((a, b) => b.v - a.v);
    if (devs.length) {
      const card = h("div", "card en-devices en-devs span12");
      card.append(h("div", "stat-title", tr("Devices")));
      const top = Math.max(devs[0].v, 0.001);
      for (const d of devs) {
        const row = h("div", "en-dev");
        const bar = h("div", "en-bar" + (d.grey ? " grey" : "")); bar.style.setProperty("--w", Math.max(1, d.v / top * 100) + "%");
        row.append(h("div", "en-dev-name", d.name), h("div", "en-dev-val", fmtKwh(d.v)), bar);
        card.append(row);
      }
      sec.append(card);

      // devices over time (stacked), with the untracked remainder in grey
      const COLORS = ["#c47a28", "#3f6b50", "#5f7fb0", "#a65b5b", "#7a6aa8", "#2a9d8f"];
      const real = devs.filter(d => d.id);
      const top6 = real.slice(0, 6).map((d, i) => ({ name: d.name, color: COLORS[i], pts: sumSeries(data, [d.id]) }));
      const rest = real.slice(6);
      if (rest.length) top6.push({ name: tr("Other devices"), color: "#9aa59d", pts: sumSeries(data, rest.map(d => d.id)) });
      if (s.gridIn.length || s.solar.length) {
        const times = [...new Set([...gridIn, ...solar, ...gridOut, ...battIn, ...battOut].map(p => p.t))].sort((a, b) => a - b);
        const at = (pts, t) => pts.find(p => p.t === t)?.v ?? 0;
        const pts = times.map(t => ({ t, v: Math.max(0, at(gridIn, t) + at(solar, t) + at(battOut, t) - at(gridOut, t) - at(battIn, t) - top6.reduce((a, g) => a + at(g.pts, t), 0)) }));
        top6.push({ name: tr("Untracked consumption"), color: "#cfd3cd", pts });
      }
      const wide = h("div", "card statgraph en-wide span12");
      wide.append(h("div", "stat-title", tr("Devices over time (kWh)")), stackedChart(top6, period));
      const lg2 = h("div", "stat-legend");
      for (const g of top6) { const i = h("span", "stat-key"); i.style.setProperty("--k", g.color); i.textContent = g.name; lg2.append(i); }
      wide.append(lg2); sec.append(wide);
    }
  }
  $app.replaceChildren(header, sheet, bottomNav());
  window.scrollTo(0, 0);
}

// ---------- security tab: cockpit of windows / doors / roof windows + surveillance cameras ----------
let secSub = "cockpit";
const SEC_GROUPS = [["windows", "Windows", "window"], ["doors", "Doors", "door"], ["roof", "Roof windows", "window"]];
function securityConfig() {
  if (NAV?.security) return NAV.security;
  const ids = Object.keys(states), pick = cls => ids.filter(id => id.startsWith("binary_sensor.") && cls.includes(states[id].attributes?.device_class));
  return { windows: pick(["window"]), doors: [...ids.filter(id => id.startsWith("lock.")), ...pick(["door", "garage_door", "opening"])], roof: [] };
}
const entName = it => typeof it === "string" ? null : it.name;
const entId = it => typeof it === "string" ? it : it.entity;
function openInfo(id) {
  const e = states[id]; if (!e) return { known: false };
  const dom = domainOf(id);
  if (dom === "binary_sensor") return { known: true, open: e.state === "on", text: e.state === "on" ? tr("Open") : tr("Closed") };
  if (dom === "lock") return { known: true, open: e.state !== "locked", text: e.state === "locked" ? tr("Locked") : tr("Unlocked") };
  if (dom === "cover") {
    const pos = num(e.attributes.current_position), open = e.state !== "closed";
    return { known: true, open, text: open ? (pos != null && pos < 100 ? `${tr("Open")} ${pos}%` : tr("Open")) : tr("Closed") };
  }
  return { known: true, open: e.state === "on", text: e.state };
}
const SEC_ICONS = { window: [ "window-closed-variant", "window-open-variant" ], door: [ "door-closed", "door-open" ] };

function renderSecurity(top) {
  watched.clear();
  const cfg = securityConfig();
  const groups = SEC_GROUPS.map(([k, label, kind]) => ({ k, label, kind, items: (cfg[k] ?? []).map(it => ({ id: entId(it), name: entName(it) })).filter(x => states[x.id]) })).filter(g => g.items.length);
  groups.forEach(g => g.items.forEach(x => watched.add(x.id)));
  const openList = groups.flatMap(g => g.items.filter(x => openInfo(x.id).open));

  const hero = h("div", "hero-text");
  hero.append(h("div", "hero-title", tr("Security")));
  hero.append(h("div", "hero-sub", openList.length ? tr("{n} open", { n: openList.length }) : tr("All closed")));
  const header = h("header", "hero");
  header.append(top, hero, badgeRow([
    { label: tr("Cockpit"), ico: "shield-check-outline", active: secSub === "cockpit", onClick: () => { secSub = "cockpit"; signature = null; schedule(); } },
    { label: tr("Surveillance"), ico: "camera", active: secSub === "surveillance", onClick: () => { secSub = "surveillance"; signature = null; schedule(); } },
  ]));

  const sheet = h("div", "sheet"), wrap = h("main", "sections"), section = h("section", "section");
  wrap.append(section); sheet.append(wrap);
  if (secSub === "surveillance") {
    wrap.classList.add("cam-page");   // cameras: 2 columns on wide screens, 1 below 1000px
    const keep = dashSel; dashSel = "Surveilance";
    const secs = view.sections.filter(x => condsOk(x.visibility)).map(x => x.cards ?? []);
    for (const cards of secs) { collectWatched(cards); section.append(...cards.map(renderCard).filter(Boolean)); }
    dashSel = keep;
    if (!section.children.length) section.append(h("div", "empty", tr("No cameras found in the dashboard.")));
  } else {
    const status = h("div", "card sec-status span12" + (openList.length ? " alert" : " ok"));
    const ic = h("div", "sec-ic"); ic.append(icon(openList.length ? "shield-alert-outline" : "shield-check"));
    const tx = h("div", "sec-text");
    tx.append(h("div", "sec-big", openList.length ? tr("{n} open", { n: openList.length }) : tr("Everything closed")));
    tx.append(h("div", "tile-state", openList.length ? openList.map(x => x.name ?? states[x.id].attributes.friendly_name ?? x.id).join(", ") : tr("All windows, doors and roof windows are closed")));
    status.append(ic, tx);
    section.append(status);
    for (const g of groups) {
      const card = h("div", "card sec-group span12");
      const nOpen = g.items.filter(x => openInfo(x.id).open).length;
      card.append(h("div", "stat-title", `${tr(g.label)} · ${nOpen ? tr("{n} open", { n: nOpen }) : tr("closed")}`));
      const grid = h("div", "sec-grid");
      for (const x of g.items) {
        const info = openInfo(x.id), e = states[x.id];
        const kind = domainOf(x.id) === "lock" ? "door" : g.kind;
        const cell = h("button", "sec-item" + (info.open ? " open" : ""));
        cell.type = "button";
        const i = h("div", "sec-item-ic"); i.append(icon(domainOf(x.id) === "lock" ? (info.open ? "lock-open-variant" : "lock") : SEC_ICONS[kind][info.open ? 1 : 0]));
        cell.append(i, h("div", "sec-item-name", x.name ?? e.attributes.friendly_name ?? x.id), h("div", "sec-item-state", info.text));
        grid.append(cell);
      }
      card.append(grid); section.append(card);
    }
    if (!groups.length) section.append(h("div", "empty", tr("No window or door sensors found.")));
  }
  $app.replaceChildren(header, sheet, bottomNav());
  if (scrollToTop) { window.scrollTo(0, 0); scrollToTop = false; }
}

async function doLogout() {
  const ok = await confirmDialog(tr("Sign out?"), tr("You will need to enter your username and password again on this device."), tr("Sign out"));
  if (!ok) return;
  await disablePush(HA_URL);
  try { await auth.revoke(); } catch (e) { /* ignore */ }
  await clearTokens();
  location.reload();
}

// ---------- settings: notifications (iPhone app) ----------
const pushInfo = { state: undefined, busy: false, error: "" };
function pushCard() {
  const refresh = () => { signature = null; schedule(); };
  if (pushInfo.state === undefined) {
    pushInfo.state = null;
    pushState(HA_URL).then(s => { pushInfo.state = s; }).catch(() => { pushInfo.state = { permission: "prompt", registered: false, service: "" }; }).finally(refresh);
  }
  const s = pushInfo.state;
  const card = h("div", "card set-card span12");
  card.append(h("div", "stat-title", tr("Notifications")));
  const on = s?.permission === "granted" && s.registered;
  card.append(settingsRow(tr("Status"), !s ? tr("Loading…") : on ? tr("Enabled") : s.permission === "denied" ? tr("Blocked in iOS Settings") : tr("Not enabled")));
  if (on && s.service) card.append(settingsRow(tr("Home Assistant service"), s.service));
  if (s && s.permission !== "denied" && !on) {
    const b = h("button", "set-btn"); b.type = "button"; b.disabled = pushInfo.busy;
    b.append(icon("bell-ring-outline"), h("span", null, tr("Enable notifications")));
    b.onclick = async () => {
      pushInfo.busy = true; pushInfo.error = ""; refresh();
      try { await enablePush(auth, HA_URL); } catch (e) { pushInfo.error = String(e?.message ?? e); }
      pushInfo.state = undefined; pushInfo.busy = false; refresh();
    };
    card.append(b);
  }
  if (pushInfo.error) card.append(h("div", "tile-state set-hint", tr("Could not enable notifications:") + " " + pushInfo.error));
  card.append(h("div", "tile-state set-hint", on ? tr("Use this service in Home Assistant automations to send a notification to this phone.") : tr("Lets your home send you alerts, for example when a door is open.")));
  return card;
}

async function doLeaveHome() {
  const ok = await confirmDialog(tr("Leave home?"), tr("You will be signed out of {name}. To connect again you need the home name and your login.", { name: client.name }), tr("Leave home"));
  if (!ok) return;
  await changeHome();
}

// ---------- climate tab: the dashboard's Heatpump section (heating / cooling / solar) ----------
function renderClimate(top) {
  watched.clear();
  const hero = h("div", "hero-text");
  hero.append(h("div", "hero-title", tr("Climate")));
  const header = h("header", "hero");
  header.append(top, hero);
  const sheet = h("div", "sheet"), wrap = h("main", "sections");
  const keep = dashSel; dashSel = "Heatpump";
  const cols = dashColumns();                      // 1 on phones; 2-3 on iPad / desktop
  const groups = [];
  for (const sec of view.sections.filter(x => condsOk(x.visibility))) {
    const cards = sec.cards ?? [];
    collectWatched(cards);
    const el = h("section", "section");
    el.append(...cards.map(renderCard).filter(Boolean));
    groups.push(el);
  }
  dashSel = keep;
  let masonryWrap = null;
  if (cols > 1) {
    // wide screens: the rings become the first row, 2x / 3x bigger (as many times as there are columns), the rest flows into the columns
    const ringRow = h("div", "ring-row");
    ringRow.style.setProperty("--n", cols);
    for (const g of groups) {
      ringRow.append(...g.querySelectorAll(".ring"));
      for (const sg of g.querySelectorAll(".subgrid")) if (!sg.children.length) sg.remove();
    }
    masonryWrap = h("div", "sections masonry");
    wrap.classList.add("climate-wide");
    wrap.append(...(ringRow.children.length ? [ringRow] : []), masonryWrap);
  } else wrap.append(...groups);
  sheet.append(wrap);
  $app.replaceChildren(header, sheet, bottomNav());
  if (masonryWrap) masonry(masonryWrap, groups.filter(g => g.children.length), cols);
  if (scrollToTop) { window.scrollTo(0, 0); scrollToTop = false; }
}

// ---------- settings tab ----------
const settingsInfo = { user: undefined, config: undefined };
function settingsLoad() {
  const refresh = () => { signature = null; schedule(); };
  if (settingsInfo.user === undefined) {
    settingsInfo.user = null;
    conn.sendMessagePromise({ type: "auth/current_user" }).then(u => { settingsInfo.user = u; }).catch(() => { settingsInfo.user = {}; }).finally(refresh);
  }
  if (settingsInfo.config === undefined) {
    settingsInfo.config = null;
    conn.sendMessagePromise({ type: "get_config" }).then(c => { settingsInfo.config = c; }).catch(() => { settingsInfo.config = {}; }).finally(refresh);
  }
}
async function reloadApp() {
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) { /* ignore */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (e) { /* ignore */ }
  location.reload();
}
function settingsRow(label, value) {
  const row = h("div", "set-row");
  row.append(h("div", "set-label", label), h("div", "set-value", value ?? "–"));
  return row;
}
function renderSettings(top) {
  watched.clear();
  settingsLoad();
  const hero = h("div", "hero-text");
  hero.append(h("div", "hero-title", tr("Settings")));
  const header = h("header", "hero");
  header.append(top, hero);
  const sheet = h("div", "sheet"), wrap = h("main", "sections"), sec = h("section", "section");
  wrap.append(sec); sheet.append(wrap);

  // language
  const lang = h("div", "card set-card span12");
  lang.append(h("div", "stat-title", tr("Language")));
  const chips = h("div", "set-chips");
  for (const [code, name] of LANGS) {
    const b = h("button", "chip" + (code === getLang() ? " active" : ""), name);
    b.type = "button";
    b.onclick = () => { setLang(code); signature = null; scrollToTop = false; render(); signature = sig(); };
    chips.append(b);
  }
  lang.append(chips); sec.append(lang);

  // account + Home Assistant
  const u = settingsInfo.user, cfg = settingsInfo.config;
  const acc = h("div", "card set-card span12");
  acc.append(h("div", "stat-title", tr("Account")));
  if (MULTI) acc.append(settingsRow(tr("Home"), client.name));
  acc.append(settingsRow(tr("Signed in as"), u ? (u.name ?? "–") : tr("Loading…")));
  if (u?.is_admin != null) acc.append(settingsRow(tr("Role"), u.is_admin ? tr("Administrator") : tr("User")));
  const so = h("button", "set-btn danger"); so.type = "button"; so.append(icon("logout-variant"), h("span", null, tr("Sign out"))); so.onclick = doLogout;
  acc.append(so);
  if (MULTI) {
    const lh = h("button", "set-btn danger"); lh.type = "button"; lh.append(icon("home-export-outline"), h("span", null, tr("Leave home"))); lh.onclick = doLeaveHome;
    acc.append(lh, h("div", "tile-state set-hint", tr("Signs you out and forgets this home on this device.")));
  }
  sec.append(acc);

  if (pushSupported()) sec.append(pushCard());

  const ha = h("div", "card set-card span12");
  ha.append(h("div", "stat-title", tr("Home Assistant")));
  ha.append(settingsRow(tr("Address"), HA_URL.replace(/^https?:\/\//, "")));
  if (cfg?.version) ha.append(settingsRow(tr("Version"), cfg.version));
  if (cfg?.location_name) ha.append(settingsRow(tr("Location"), cfg.location_name));
  ha.append(settingsRow(tr("Status"), tr("Connected")));
  sec.append(ha);

  // app
  const app = h("div", "card set-card span12");
  app.append(h("div", "stat-title", tr("App")));
  app.append(settingsRow(tr("App version"), `${client.name} ${APP_VERSION}`));
  const rl = h("button", "set-btn"); rl.type = "button"; rl.append(icon("reload"), h("span", null, tr("Reload app"))); rl.onclick = reloadApp;
  app.append(rl, h("div", "tile-state set-hint", tr("Clears the cache and loads the latest version.")));
  sec.append(app);

  $app.replaceChildren(header, sheet, bottomNav());
  if (scrollToTop) { window.scrollTo(0, 0); scrollToTop = false; }
}

// wide screens: heading-led groups flow into 2-3 columns, each group goes to the currently shortest column
const dashColumns = () => Math.max(1, Math.min(3, Math.floor((Math.min(window.innerWidth, 1468) - 32) / 430)));
function splitAtHeadings(cards) {
  const out = [];
  for (const c of cards) {
    if (headingOf(c) != null || !out.length) out.push([]);
    out[out.length - 1].push(c);
  }
  return out;
}
const spanOf = el => { for (const k of el.classList) { const m = /^span(\d+)$/.exec(k); if (m) return +m[1]; } return 12; };
// a group = a 12-column grid of cards; a "row" = the cards that sit side by side (a heading stays with the row after it)
function rowsOf(sec) {
  const rows = []; let cur = null, used = 0;
  for (const el of sec.children) {
    const w = spanOf(el), head = el.classList.contains("heading");
    if (cur && cur.head) { cur.els.push(el); if (!head) { cur.head = false; used = w; } continue; }
    if (cur && !head && used + w <= 12) { cur.els.push(el); used += w; continue; }
    cur = { els: [el], head }; used = head ? 0 : w; rows.push(cur);
  }
  return rows;
}
// few groups, many columns (e.g. Favorites = 2 groups on a 3-column screen): the rows are spread evenly, in reading order
function spread(cols, groups) {
  cols[0].append(...groups);                                   // all in one column first, to measure the rows
  const units = [];
  groups.forEach((g, gi) => {
    for (const r of rowsOf(g)) {
      const rects = r.els.map(e => e.getBoundingClientRect());
      r.h = Math.max(...rects.map(x => x.bottom)) - Math.min(...rects.map(x => x.top)) + 10;
      r.g = gi; units.push(r);
    }
  });
  const target = units.reduce((t, u) => t + u.h, 0) / cols.length;
  let k = 0, acc = 0, last = null;
  for (const u of units) {
    if (k < cols.length - 1 && acc + u.h / 2 > target * (k + 1)) k++;
    acc += u.h;
    if (!last || last.k !== k || last.g !== u.g) { last = { k, g: u.g, sec: h("section", "section") }; cols[k].append(last.sec); }
    last.sec.append(...u.els);
  }
  groups.forEach(g => g.remove());
}
function masonry(wrap, groups, n) {
  const cols = Array.from({ length: n }, () => h("div", "mcol"));
  wrap.append(...cols);
  if (groups.length <= n) return spread(cols, groups);
  for (const g of groups) {
    const shortest = cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(g);
  }
}
let layoutKey = dashColumns();
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const k = dashColumns();
    if (k !== layoutKey) { layoutKey = k; signature = null; schedule(); }
  }, 150);
});

function render() {
  const top = h("div", "topbar");
  const logo = h("img", "brand-logo");
  logo.src = LOGO_URL; logo.alt = "";
  const logout = h("button", "logout");
  logout.title = tr("Sign out"); logout.setAttribute("aria-label", tr("Sign out"));
  logout.append(icon("logout"));
  logout.onclick = doLogout;
  top.append(logo, h("div", "brand", client.wordmark), h("div", "spacer"), logout);
  if (tab === "energy") return renderEnergy(top);
  if (tab === "climate") return renderClimate(top);
  if (tab === "settings") return renderSettings(top);
  if (tab === "security") return renderSecurity(top);
  const page = currentPage();
  watched.clear();
  collectWatched(page.sections);
  if (dashMode) collectWatched(view.badges);
  const lightsOn = [...watched].filter(id => id.startsWith("light.") && states[id]?.state === "on").length; // only lights shown on this page
  const hero = h("div", "hero-text");
  hero.append(h("div", "hero-title", page.title));
  const sub = lightsOn ? (lightsOn === 1 ? tr("1 light is on") : tr("{n} lights are on", { n: lightsOn })) : page.sub;
  if (sub) hero.append(h("div", "hero-sub", sub));
  const wrap = h("main", "sections");
  const cols = dashColumns();                       // 1 on phones, 2+ on iPad / desktop
  const groups = [];
  for (const cards of page.sections) {
    for (const part of (cols > 1 ? splitAtHeadings(cards) : [cards])) {
      const sec = h("section", "section");
      sec.append(...part.map(renderCard).filter(Boolean));
      if (cols > 1 && !sec.children.length) continue;
      groups.push(sec);
    }
  }
  if (cols === 1) wrap.append(...groups);
  else wrap.classList.add("masonry");
  const header = h("header", "hero");
  header.append(top, hero);
  if (dashMode) header.append(...dashRows(page));
  else if (structure) {
    header.append(levelRow());
    if (sel.p === "floor") header.append(roomRow());
  }
  const sheet = h("div", "sheet");
  if (page.stale) {
    sheet.append(h("div", "empty", tr("The dashboard.yaml on the server is an old copy (it has no badges). Delete the old files in /config/www/konihaus and copy the new build again.")));
  } else if (cols > 1 ? !groups.length : (!wrap.children.length || ![...wrap.children].some(x => x.children.length))) sheet.append(h("div", "empty", tr("Nothing to show here yet.")));
  sheet.append(wrap);

  // keep the badge rows where the user scrolled them (the page is redrawn on every state change)
  const old = [...$app.querySelectorAll(".badges")].map(r => r.scrollLeft);
  const keepY = scrollToTop ? 0 : window.scrollY;
  $app.replaceChildren(header, sheet, bottomNav());
  if (cols > 1) { masonry(wrap, groups, cols); window.scrollTo(0, keepY); }
  const rows = [...$app.querySelectorAll(".badges")];
  rows.forEach((r, i) => {
    if (scrollToTop) r.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "center" });
    else if (old[i]) r.scrollLeft = old[i];
  });
  if (scrollToTop) { window.scrollTo(0, 0); scrollToTop = false; }
}

// bottom menu: only the look for now, the buttons do nothing yet (home is the active one)
const TABS = [
  { id: "climate", icon: "sun-thermometer-outline", label: "Climate" },
  { id: "security", icon: "shield-check-outline", label: "Security" },
  { id: "home", icon: "home", label: "Home", logo: true },
  { id: "energy", icon: "lightning-bolt", label: "Energy" },
  { id: "settings", icon: "cog-outline", label: "Settings" },
];
function bottomNav() {
  const nav = h("nav", "tabbar");
  nav.setAttribute("aria-label", tr("Main menu"));
  for (const t of TABS) {
    const on = t.id === tab;
    const b = h("button", "tab" + (on ? " active" : ""));
    b.type = "button"; b.title = tr(t.label); b.setAttribute("aria-label", tr(t.label));
    if (on) b.setAttribute("aria-current", "page");
    if (["home", "energy", "security", "climate", "settings"].includes(t.id)) b.onclick = () => { if (tab !== t.id) { tab = t.id; scrollToTop = true; signature = null; schedule(); } };
    const ic = h("span", "tab-ic");
    if (t.logo) { const img = h("img", "tab-logo"); img.src = LOGO_URL; img.alt = ""; ic.append(img); }
    else ic.append(icon(t.icon));
    b.append(ic);
    nav.append(b);
  }
  return nav;
}

// only redraw when something we show has changed; never while the user is dragging
let signature = null;
let busy = false, pending = false, queued = false;
function sig() { return [...watched].map(id => states[id]?.last_updated ?? "-").join("|"); }
function schedule() {
  const s = sig();
  if (s === signature) return;
  if (busy) { pending = true; return; }
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); signature = sig(); });
}
$app.addEventListener("pointerdown", () => { busy = true; });
const release = () => { busy = false; if (pending) { pending = false; schedule(); } };
window.addEventListener("pointerup", release);
window.addEventListener("pointercancel", release);

subscribeEntities(conn, e => { states = e; schedule(); });
