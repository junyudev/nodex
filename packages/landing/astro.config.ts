import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://nodex.jyu.app",
  output: "static",
  outDir: "./dist",
  trailingSlash: "always",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
