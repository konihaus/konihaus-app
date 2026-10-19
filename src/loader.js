// The "one moment" screen: same look as the one in index.html (shown before any JavaScript has run),
// and as the app's launch image, so starting up looks like one calm screen instead of blank gaps.
import { tr } from "./i18n.js";
export function showLoader($app, logoUrl) {
  const wrap = document.createElement("div");
  wrap.className = "boot";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", tr("Loading…"));
  const img = document.createElement("img");
  img.className = "boot-logo"; img.alt = "";
  img.src = logoUrl;
  img.onerror = () => img.remove();
  const dots = document.createElement("div");
  dots.className = "boot-dots";
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  wrap.append(img, dots);
  $app.replaceChildren(wrap);
}
