import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import fs from "node:fs";
import path from "node:path";

// ---- per-client build: CLIENT=<id> npm run build  (see clients/README.md) ----
const id = process.env.CLIENT || "konihaus";
const clientDir = path.resolve("clients", id);
if (!fs.existsSync(path.join(clientDir, "client.json"))) {
  throw new Error(`Unknown client "${id}": clients/${id}/client.json not found`);
}
const client = JSON.parse(fs.readFileSync(path.join(clientDir, "client.json"), "utf8"));
const colors = client.colors ?? {};

// merged public folder: shared defaults, then the client's own files on top
const merged = path.resolve("node_modules", ".cache", `public-${id}`);
fs.rmSync(merged, { recursive: true, force: true });
fs.mkdirSync(merged, { recursive: true });
fs.cpSync(path.resolve("public"), merged, { recursive: true });
if (fs.existsSync(path.join(clientDir, "public"))) fs.cpSync(path.join(clientDir, "public"), merged, { recursive: true });

// fill the name and colors into index.html
const htmlTokens = {
  name: "client-html",
  transformIndexHtml: html => html
    .replaceAll("%CLIENT_NAME%", client.name)
    .replaceAll("%CLIENT_SHORT%", client.shortName ?? client.name)
    .replaceAll("%CLIENT_THEME%", colors.forest ?? "#2a4a35"),
};

// every modern browser uses the .woff2 fonts, so drop the old-format copies (.eot/.ttf/.woff) from the build
const dropLegacyFonts = {
  name: "drop-legacy-fonts",
  enforce: "post",
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) if (/\.(eot|ttf|woff)$/.test(name)) delete bundle[name];
  },
};

// home.json = this client's name/colors/tagline, published next to dashboard.yaml so the multi-home app can read it.
// homes.json (app build only) = the registry: hashed home name -> Home Assistant address.
const homeFiles = app => ({
  name: "home-files",
  closeBundle() {   // the files copied from public/ come after generateBundle: remove them here
    if (app) for (const name of ["dashboard.yaml", "navigation.json"]) fs.rmSync(path.join("dist-app", name), { force: true });
  },
  generateBundle(_, bundle) {
    this.emitFile({ type: "asset", fileName: "home.json", source: JSON.stringify(client, null, 2) });
    if (!app) return;
    // the app gets each home's dashboard from that home's Home Assistant, never from its own bundle
    for (const name of ["dashboard.yaml", "navigation.json"]) delete bundle[name];
    if (fs.existsSync("homes.json"))
      this.emitFile({ type: "asset", fileName: "homes.json", source: fs.readFileSync("homes.json", "utf8") });
  },
});

export default defineConfig(({ mode }) => {
const app = mode === "app"; // multi-home app build: npm run build:app
return {
  base: "./",
  publicDir: merged,
  define: { __CLIENT__: JSON.stringify(client), __MULTI__: JSON.stringify(app), __REGISTRY_URL__: JSON.stringify(process.env.REGISTRY_URL ?? ""), __PUSH_URL__: JSON.stringify(process.env.PUSH_URL ?? "") },
  build: {
    outDir: app ? "dist-app" : id === "konihaus" ? "dist" : `dist-${id}`,
    // the iPhone app supports iOS 15 and newer (iPhone 12 and every later model): Safari 15 is the oldest browser engine it must run on
    ...(app ? { target: "safari15", cssTarget: "safari15" } : {}),
  },
  plugins: [
    dropLegacyFonts,
    htmlTokens,
    homeFiles(app),
    ...(app ? [] : [VitePWA({
      registerType: "autoUpdate",
      workbox: { globPatterns: ["**/*.{js,css,html,woff2,png,svg}"] },
      includeAssets: ["apple-touch-icon-v2.png"],
      manifest: {
        name: client.name,
        short_name: client.shortName ?? client.name,
        description: client.description ?? client.name,
        theme_color: colors.forest ?? "#2a4a35",
        background_color: colors.forest ?? "#2a4a35",
        display: "standalone",
        start_url: "./index.html",
        scope: "./",
        icons: [
          { src: "icon-192-v2.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512-v2.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512-maskable-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    })]),
  ],
};
});
