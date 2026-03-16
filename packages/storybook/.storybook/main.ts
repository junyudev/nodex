import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const rendererRoot = path.resolve(repoRoot, "src/renderer");

const config: StorybookConfig = {
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-links",
    "@storybook/addon-a11y",
  ],
  staticDirs: [
    path.resolve(repoRoot, "public"),
  ],
  stories: [
    "../../../src/renderer/**/*.stories.@(ts|tsx)",
  ],
  async viteFinal(baseConfig) {
    const { mergeConfig, searchForWorkspaceRoot } = await import("vite");

    return mergeConfig(baseConfig, {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": rendererRoot,
        },
        dedupe: ["react", "react-dom"],
      },
      server: {
        fs: {
          allow: [searchForWorkspaceRoot(process.cwd()), repoRoot, rendererRoot],
        },
      },
    });
  },
};

export default config;
