import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import type { AstroUserConfig } from "astro";
import { defineConfig } from "astro/config";

import { landingMediaStatus } from "./src/constants/media";

if (process.env.NODEX_REQUIRE_LANDING_MEDIA === "1" && landingMediaStatus !== "ready") {
  throw new Error("Landing product media must be reviewed before deployment.");
}

type AstroVitePlugins = NonNullable<NonNullable<AstroUserConfig["vite"]>["plugins"]>;

// Astro and Nodex resolve separate Vite+ instances with different esbuild peers.
// Their runtime plugin contract is compatible; isolate the nominal type difference here.
const createTailwindPlugins = tailwindcss as unknown as () => AstroVitePlugins;

export default defineConfig({
  site: "https://nodex.jyu.app",
  trailingSlash: "always",
  integrations: [sitemap()],
  vite: {
    plugins: createTailwindPlugins(),
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
    routing: {
      fallbackType: "rewrite",
      prefixDefaultLocale: false,
    },
  },
});
