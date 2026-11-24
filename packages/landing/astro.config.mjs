import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

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
        configureServer(server) {
          // Vite watches imported files outside its root, but needs the directory to detect additions.
          server.watcher.add(fileURLToPath(new URL("../../changes/", import.meta.url)));
        },
      },
    ],
  },
});
