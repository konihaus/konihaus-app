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

export default defineConfig({
  base: "./",
  publicDir: merged,
  define: { __CLIENT__: JSON.stringify(client) },
  build: { outDir: id === "konihaus" ? "dist" : `dist-${id}` },
  plugins: [
    dropLegacyFonts,
    htmlTokens,
    VitePWA({
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
    }),
  ],
});
