// Multi-home app: the first time the app starts it asks for the "home name".
// The name is looked up in the registry (homes.json) which gives the Home Assistant address;
// the home's own look (name, colors, logo, dashboard) is then read from that Home Assistant,
// from /local/konihaus/ (the same files the web version uses). The chosen home is remembered
// until "Leave home" is used in Settings.
import { client, DEFAULT_CLIENT, applyColors } from "./client.js";
import { tr } from "./i18n.js";
import { homeKey, normalizeHome } from "./homekey.js";
import { loadHomeRec, saveHomeRec, clearHomeRec } from "./session.js";

export const MULTI = __MULTI__;           // true only in the app build (vite --mode app)
const REGISTRY_URL = __REGISTRY_URL__;    // optional online registry, tried before the bundled one
const DEFAULT_BASE = "/local/konihaus/";

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

async function fetchJson(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const trimUrl = u => String(u).trim().replace(/\/+$/, "");
const withSlash = p => (p.startsWith("/") ? p : "/" + p).replace(/\/*$/, "/");

// -> entry | null (registry read, name not in it); throws when no registry could be read
async function lookup(name) {
  const key = homeKey(name);
  const bundled = new URL("homes.json", new URL(import.meta.env.BASE_URL, location.href)).href;
  const sources = [REGISTRY_URL, bundled].filter(Boolean);
  let reached = false;
  for (const url of sources) {
    try {
      const reg = await fetchJson(url);
      reached = true;
      const entry = reg?.homes?.[key];
      if (entry?.hassUrl) return entry;
    } catch { /* try the next source */ }
  }
  if (!reached) throw new Error("registry unreachable");
  return null;
}

// the home's own settings: home.json is written next to dashboard.yaml by the normal build
async function loadConfig(assetBase) {
  try { return await fetchJson(assetBase + "home.json?_=" + Date.now(), 6000); } catch { return {}; }
}

const probeImage = url => new Promise(resolve => {
  const img = new Image();
  img.onload = () => resolve(true);
  img.onerror = () => resolve(false);
  img.src = url;
});

// make the chosen home the active look & feel
function adopt(rec) {
  const cfg = rec.cfg ?? {};
  const name = rec.name || cfg.name || DEFAULT_CLIENT.name;
  const colors = { ...DEFAULT_CLIENT.colors, ...(cfg.colors ?? {}) };
  Object.assign(client, {
    name,
    shortName: cfg.shortName ?? name,
    wordmark: cfg.wordmark ?? name.toLowerCase(),
    tagline: cfg.tagline ?? tr("Welcome home"),
    description: cfg.description ?? name,
    colors,
  });
  applyColors();
}

async function build(entry, typed) {
  const hassUrl = trimUrl(entry.hassUrl);
  const path = withSlash(entry.base ?? DEFAULT_BASE);
  const assetBase = hassUrl + path;                                  // the saved addresses always start from the main one
  const localUrl = entry.localUrl ? trimUrl(entry.localUrl) : "";   // optional address on the home network
  // read the home's files from whichever address answers (Tailscale may be off)
  const via = await resolveAddress({ hassUrl, localUrl, assetBase, logoUrl: "" });
  const [cfg, hasLogo] = await Promise.all([loadConfig(via.assetBase), probeImage(via.assetBase + "logo.png")]);
  const name = entry.name || cfg.name || typed.trim();
  return { hassUrl, localUrl, assetBase, name, cfg, logoUrl: hasLogo ? assetBase + "logo.png" : "" };
}

// The addresses of a home can change with a new app version: the registry inside the app is read at every
// start (instant, it is a file of the app) and a saved home gets its current addresses from it.
async function syncAddresses(rec) {
  try {
    const bundled = new URL("homes.json", new URL(import.meta.env.BASE_URL, location.href)).href;
    const reg = await fetchJson(bundled, 2000);
    const entry = Object.values(reg?.homes ?? {}).find(e => e?.hassUrl && trimUrl(e.hassUrl) === rec.hassUrl);
    if (!entry) return rec;
    const localUrl = entry.localUrl ? trimUrl(entry.localUrl) : "";
    if (localUrl === (rec.localUrl ?? "")) return rec;
    const next = { ...rec, localUrl };
    saveHomeRec(next).catch(() => {});
    return next;
  } catch { return rec; }
}

// Which address answers right now? Home Assistant's main address (e.g. over Tailscale) and, when the home has
// one, its address on the home network (e.g. http://192.168.1.148:8123). Both are asked at the same time and the
// first that really serves this home's files wins, so Tailscale off at home simply means "use the local address".
// -> { url, assetBase, logoUrl, log }  (log = what each address answered, for the error screen; url = main address when none answered: the caller shows its usual error)
export async function resolveAddress(rec, ms = 4000) {
  const path = rec.assetBase.slice(rec.hassUrl.length);          // "/local/konihaus/"
  const at = url => ({ url, assetBase: url + path, logoUrl: rec.logoUrl ? url + path + "logo.png" : "" });
  if (!rec.localUrl) return { ...at(rec.hassUrl), log: [] };
  // dashboard.yaml: the one file every home must serve (home.json may be missing on older installs)
  const log = [];
  const probe = async url => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url + path + "dashboard.yaml?_=" + Date.now(), { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      log.push(url + " ok"); return url;
    } catch (e) { log.push(url + " " + (e?.name === "AbortError" ? "no answer" : e?.message ?? e)); return null; }
    finally { clearTimeout(timer); }
  };
  const winner = await new Promise(resolve => {
    let left = 2;
    for (const p of [probe(rec.hassUrl), probe(rec.localUrl)]) p.then(u => { if (u) resolve(u); else if (--left === 0) resolve(null); });
  });
  return { ...at(winner ?? rec.hassUrl), log };
}

// background refresh of the home's look (picked up on the next start)
function refreshInBackground(rec) {
  loadConfig(rec.assetBase).then(cfg => {
    if (cfg && Object.keys(cfg).length && JSON.stringify(cfg) !== JSON.stringify(rec.cfg)) saveHomeRec({ ...rec, cfg });
  });
}

// Returns { hassUrl, assetBase, logoUrl, name } for the chosen home (asks the first time).
export async function selectHome($app, bundledLogo) {
  const stored = await loadHomeRec();
  if (stored?.hassUrl) {
    const saved = await syncAddresses(stored);
    adopt(saved);
    refreshInBackground(saved);
    return saved;
  }
  const rec = await askForHome($app, bundledLogo);
  await saveHomeRec(rec);
  adopt(rec);
  return rec;
}

export async function leaveHome() { await clearHomeRec(); }

function askForHome($app, logoUrl) {
  return new Promise(resolve => {
    const wrap = h("div", "login-wrap"), card = h("div", "login-card");
    const logo = h("img", "login-logo"); logo.src = logoUrl; logo.alt = "";
    const form = h("form", "login-form");
    form.noValidate = true;
    const label = h("label", "login-field");
    const input = h("input");
    input.name = "home"; input.type = "text"; input.autocomplete = "off";
    input.autocapitalize = "none"; input.spellcheck = false; input.enterKeyHint = "go";
    input.placeholder = tr("e.g. your family name");
    label.append(h("span", "login-label", tr("Home name")), input);
    const err = h("div", "login-error"); err.setAttribute("role", "alert");
    const button = h("button", "login-btn", tr("Continue")); button.type = "submit";
    form.append(label, button);
    card.append(logo, h("div", "login-title", DEFAULT_CLIENT.wordmark),
      h("div", "login-sub", tr("Enter your home name to get started")), form, err);
    wrap.append(card);
    $app.replaceChildren(wrap);
    setTimeout(() => input.focus(), 0);

    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      if (!normalizeHome(input.value)) { err.textContent = tr("Please enter the name of your home."); return; }
      button.disabled = true; button.textContent = tr("Looking up your home…");
      try {
        const entry = await lookup(input.value);
        if (!entry) { err.textContent = tr("We couldn't find a home with that name. Check the spelling."); return; }
        const rec = await build(entry, input.value);
        wrap.remove();
        resolve(rec);
      } catch {
        err.textContent = tr("Cannot reach the Konihaus service. Check your internet connection.");
      } finally {
        button.disabled = false; button.textContent = tr("Continue");
      }
    });
  });
}
