// per-client settings, injected at build time from clients/<id>/client.json
// (a mutable copy: the multi-home app overwrites name, colors... with the chosen home's settings)
export const DEFAULT_CLIENT = __CLIENT__;
export const client = { ...__CLIENT__ };

// apply the client's colors to the CSS variables used by the theme
const map = { forest: "--forest", forestDeep: "--forest-deep", forestMid: "--forest-mid", amber: "--amber", amberWarm: "--amber-warm", parchment: "--parchment" };
export function applyColors() {
  for (const [key, cssVar] of Object.entries(map)) {
    if (client.colors?.[key]) document.documentElement.style.setProperty(cssVar, client.colors[key]);
  }
}
applyColors();

// behave like a native app: no pinch zoom, no double-tap zoom (iOS ignores user-scalable=no, so block the gestures too)
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, e => e.preventDefault());
document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
