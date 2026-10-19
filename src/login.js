// Branded sign-in screen. Uses Home Assistant's own login API (same calls as its login page),
// then stores the tokens where home-assistant-js-websocket expects them.
import { loadTokens, saveTokens } from "./session.js";
import { client } from "./client.js";
import { MULTI } from "./home.js";
import { tr } from "./i18n.js";

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const LABELS = { username: "Username", password: "Password", code: "Authentication code" };   // shown through tr()
const AUTOCOMPLETE = { username: "username", password: "current-password", code: "one-time-code" };
const ERRORS = {
  invalid_auth: "Wrong username or password.",
  invalid_code: "That code was not accepted. Try the next one.",
};

// Resolves "ok" (tokens stored) or "fallback" (use the standard Home Assistant login redirect).
// onChangeHome (multi-home app only): shows a "Not your home?" link that forgets the chosen home.
// idUrl (app only): the home's main address. The login always names it as its client, whichever address
// (Tailscale or home network) is used to reach Home Assistant, so the saved login stays valid on both.
export async function ensureLogin(hassUrl, $app, logoUrl, onChangeHome, idUrl = hassUrl) {
  if (location.search.includes("auth_callback") || await loadTokens()) return "ok";
  return new Promise(resolve => showLogin(hassUrl, $app, logoUrl, resolve, onChangeHome, idUrl));
}

function showLogin(hassUrl, $app, logoUrl, done, onChangeHome, idUrl) {
  // web version: the page itself is the OAuth client. App: no web address of its own, so the home's
  // address is used (Home Assistant only needs client_id and redirect_uri on the same host; nothing is redirected).
  const clientId = MULTI ? idUrl + "/" : `${location.protocol}//${location.host}/`;
  const redirectUri = MULTI ? clientId + "local/konihaus/index.html" : location.origin + location.pathname;

  const api = async (path, body) => {
    const res = await fetch(hassUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const wrap = h("div", "login-wrap");
  const card = h("div", "login-card");
  const logo = h("img", "login-logo");
  logo.src = logoUrl; logo.alt = "";
  const title = h("div", "login-title", client.wordmark);
  const sub = h("div", "login-sub", client.tagline ?? "Welcome home");
  const form = h("form", "login-form");
  form.noValidate = true;
  const err = h("div", "login-error");
  err.setAttribute("role", "alert");
  const button = h("button", "login-btn", tr("Sign in"));
  button.type = "submit";
  const alt = h("button", "login-alt", tr("Use the standard Home Assistant sign-in"));
  alt.type = "button";
  alt.onclick = () => { wrap.remove(); done("fallback"); };
  card.append(logo, title, sub, form, err);
  if (!MULTI) card.append(alt); // the standard HA sign-in redirects away from the page, which the app cannot come back from
  if (onChangeHome) {
    const change = h("button", "login-alt", tr("Not your home? Change home"));
    change.type = "button";
    change.onclick = onChangeHome;
    card.append(change);
  }
  wrap.append(card);
  $app.replaceChildren(wrap);

  let flow = null;
  let fields = [];

  function renderForm(schema) {
    fields = schema.map(f => f.name);
    form.replaceChildren();
    schema.forEach((f, i) => {
      const label = h("label", "login-field");
      label.append(h("span", "login-label", tr(LABELS[f.name] ?? f.name)));
      const input = h("input");
      input.name = f.name;
      input.type = f.name === "password" ? "password" : "text";
      input.autocomplete = AUTOCOMPLETE[f.name] ?? "off";
      if (f.name === "code") input.inputMode = "numeric";
      input.autocapitalize = "none"; input.spellcheck = false;
      label.append(input);
      form.append(label);
      if (i === 0) setTimeout(() => input.focus(), 0);
    });
    form.append(button);
  }

  async function start() {
    err.textContent = "";
    try {
      flow = await api("/auth/login_flow", {
        client_id: clientId, redirect_uri: redirectUri, handler: ["homeassistant", null],
      });
      if (flow.type !== "form") throw new Error("unexpected flow");
      renderForm(flow.data_schema ?? []);
    } catch {
      err.textContent = tr("Cannot reach Konihaus Greenhub. Check your connection or VPN.");
    }
  }

  async function exchange(code) {
    const res = await fetch(hassUrl + "/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, code, grant_type: "authorization_code" }).toString(),
    });
    if (!res.ok) throw new Error("token exchange failed");
    const t = await res.json();
    await saveTokens({
      hassUrl, clientId,
      expires: Date.now() + t.expires_in * 1000,
      expires_in: t.expires_in,
      refresh_token: t.refresh_token,
      access_token: t.access_token,
    });
  }

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    if (!flow) return start();
    err.textContent = "";
    button.disabled = true;
    try {
      const payload = { client_id: clientId };
      for (const name of fields) payload[name] = form.elements[name].value;
      const r = await api(`/auth/login_flow/${flow.flow_id}`, payload);
      if (r.type === "create_entry") {
        await exchange(r.result);
        wrap.remove();
        done("ok");
        return;
      }
      if (r.type === "form") {
        flow = r;
        renderForm(r.data_schema ?? []);
        const code = r.errors?.base;
        if (code) err.textContent = tr(ERRORS[code] ?? "Sign-in failed.");
        return;
      }
      await start(); // abort or something unexpected: start over
      err.textContent = tr("Sign-in expired. Please try again.");
    } catch {
      err.textContent = tr("Cannot reach Konihaus Greenhub. Check your connection or VPN.");
    } finally {
      button.disabled = false;
    }
  });

  start();
}
