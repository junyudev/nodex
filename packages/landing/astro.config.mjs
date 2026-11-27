import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { searchForWorkspaceRoot } from "vite";
import { resolveMediaStore } from "../../scripts/media/store-path.mts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Each social card's content hash. Link previews cache an image by its URL, so a card recorded
 * again gets a new one and every platform that reads the page again fetches the new image.
 */
const publicDirectory = new URL("./public/", import.meta.url);
const socialCardVersions = Object.fromEntries(
  readdirSync(publicDirectory)
    .filter((name) => /^og(?:-[a-z]+)?\.png$/u.test(name))
    .map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(name, publicDirectory)))
        .digest("hex")
        .slice(0, 12),
    ]),
);

export default defineConfig({
  site: "https://nodex.jyu.app",
  output: "static",
  outDir: "./dist",
  trailingSlash: "always",
  integrations: [react()],
  devToolbar: { enabled: false },
  vite: {
    tsconfig: "./tsconfig.json",
    define: { __SOCIAL_CARD_VERSIONS__: JSON.stringify(socialCardVersions) },
    plugins: [
      tailwindcss(),
      {
        name: "watch-release-note-fragments",
        apply: "serve",
        config() {
          if (
            !process.env.NODEX_MEDIA_STORE &&
            !existsSync(new URL("../../.git", import.meta.url))
          ) {
            return;
          }
          return {
            server: {
              fs: {
                allow: [searchForWorkspaceRoot(repositoryRoot), resolveMediaStore(repositoryRoot)],
              },
            },
          };
        },
        configureServer(server) {
          // Vite watches imported files outside its root, but needs the directory to detect additions.
          server.watcher.add(fileURLToPath(new URL("../../changes/", import.meta.url)));
        },
      },
    ],
  },
});
