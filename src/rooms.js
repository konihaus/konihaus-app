// Levels (floors), rooms (areas) and favorites, read from Home Assistant itself.
// Floors and areas come from Settings > Areas. Favorites = everything that carries a label named "Favorite".

import { tr } from "./i18n.js";

const SHOWN = new Set([
  "climate", "light", "cover", "switch", "input_boolean", "fan", "lock", "media_player",
  "scene", "script", "button", "sensor", "binary_sensor",
]);
const ORDER = ["climate", "light", "cover", "switch", "input_boolean", "fan", "lock", "media_player",
  "scene", "script", "button", "sensor", "binary_sensor"];
const domainOf = id => id.split(".")[0];

export async function loadStructure(conn) {
  const ask = type => conn.sendMessagePromise({ type }).catch(() => null);
  const [floors, areas, devices, labels, display] = await Promise.all([
    ask("config/floor_registry/list"), ask("config/area_registry/list"), ask("config/device_registry/list"),
    ask("config/label_registry/list"), ask("config/entity_registry/list_for_display"),
  ]);
  if (!areas?.length) return null;

  // normalise the entity registry (compact "display" format, or the full list as a fallback)
  let entities = null;
  if (display?.entities) {
    entities = display.entities.map(e => ({
      id: e.ei, device: e.di ?? null, area: e.ai ?? null, labels: e.lb ?? [],
      skip: !!e.hb || e.ec != null,
    }));
  } else {
    const full = await ask("config/entity_registry/list");
    if (Array.isArray(full)) entities = full.map(e => ({
      id: e.entity_id, device: e.device_id ?? null, area: e.area_id ?? null, labels: e.labels ?? [],
      skip: !!e.hidden_by || !!e.disabled_by || !!e.entity_category,
    }));
  }
  if (!entities) return null;

  const deviceArea = new Map((devices ?? []).map(d => [d.id, d.area_id]));
  const favLabels = new Set((labels ?? []).filter(l => /^favou?rites?$/i.test(l.name)).map(l => l.label_id));

  const byArea = new Map();
  const favorites = [];
  for (const e of entities) {
    if (e.skip || !SHOWN.has(domainOf(e.id))) continue;
    if (e.labels.some(l => favLabels.has(l))) favorites.push(e.id);
    const area = e.area ?? deviceArea.get(e.device) ?? null;
    if (!area) continue;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(e.id);
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const floorList = (floors ?? []).map(f => ({ id: f.floor_id, name: f.name, icon: f.icon ?? null, level: f.level ?? 99, areas: [] }));
  const loose = { id: "_none", name: tr("Other"), icon: null, level: 1000, areas: [] };
  for (const a of areas) {
    const ids = byArea.get(a.area_id);
    if (!ids?.length) continue;
    const floor = floorList.find(f => f.id === a.floor_id) ?? loose;
    floor.areas.push({ id: a.area_id, name: a.name, icon: a.icon ?? null, entities: ids });
  }
  const all = [...floorList, loose].filter(f => f.areas.length);
  for (const f of all) f.areas.sort(byName);
  all.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  return { floors: all, favorites };
}

// turn a list of entity ids into card configs the renderer already understands
export function cardsFor(ids, states) {
  const list = ids.filter(id => states[id]);
  const rank = id => ORDER.indexOf(domainOf(id));
  const name = id => states[id].attributes.friendly_name ?? id;
  list.sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));

  return list.map(id => {
    const dom = domainOf(id), a = states[id].attributes;
    if (dom === "climate") return { type: "thermostat", entity: id, features: [{ type: "climate-hvac-modes" }] };
    const features = [];
    if (dom === "light" && (a.supported_color_modes ?? []).some(m => m !== "onoff")) features.push({ type: "light-brightness" });
    if (dom === "cover") {
      features.push({ type: "cover-open-close" });
      if (a.current_tilt_position != null) features.push({ type: "cover-tilt-position" });
    }
    const small = dom === "sensor" || dom === "binary_sensor";
    return { type: "tile", entity: id, features, span: small ? 6 : undefined };
  });
}
