import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { searchForWorkspaceRoot } from "vite";
import { resolveMediaStore } from "../../scripts/media/store-path.mts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  site: "https://nodex.jyu.app",
  output: "static",
  outDir: "./dist",
  trailingSlash: "always",
  integrations: [react()],
  devToolbar: { enabled: false },
  vite: {
    tsconfig: "./tsconfig.json",
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
