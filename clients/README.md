# Per-client builds

One folder per client: `clients/<id>/`

- `client.json`  name, wordmark, colors, optional fixed `hassUrl`
- `public/`      optional overrides for anything in the shared `public/` folder:
                 `dashboard.yaml`, `logo.png`, `icon-192-v2.png`, `icon-512-v2.png`,
                 `icon-512-maskable-v2.png`, `apple-touch-icon-v2.png`, `favicon-v2.png`

Anything not overridden falls back to the shared `public/` (Konihaus defaults).

New client:  copy `clients/_template` to `clients/<id>`, edit, drop in their `dashboard.yaml` (and logo/icons).

Build:       CLIENT=<id> npm run build      ->  dist-<id>/
Develop:     CLIENT=<id> npm run dev
Deploy:      copy the contents of dist-<id>/ to that client's /config/www/konihaus/

If you change an icon later, rename it (e.g. -v3) and update the names in vite.config.js:
Home Assistant caches /local/ files for about a year.

## Navigation (badges)

If the client's `dashboard.yaml` has `badges:` that set `input_select.dashboard` (like the Konihaus dashboard), those
badges become the top row, and each section shows when its `visibility` matches the picked badge.

`navigation.json` (optional, in `clients/<id>/public/`) adds the second badge row:

- `skip`:    badges to leave out, e.g. `["Music"]`
- `rooms`:   per top badge: `rooms` (order of the second row), `common` (name of the catch-all room), `aliases` (heading text -> room)
- `assign`:  rules that override the heading order: `{ "match": "scene.closet_*", "room": "Bedroom", "in": "Rooms" }`

A heading card starts a room; the cards after it belong to that room until the next heading.
Headings that are not in the room list go to `common`.

Without badges in the dashboard, the app falls back to Home Assistant floors and areas
(and a label named `Favorite`).
