import { resolve } from "path";
import { defineConfig, type UserConfig } from "electron-vite";
import type { BuildEnvironmentOptions, Plugin, Rollup } from "vite";
import { createExcalidrawFontAssetPlugins } from "./config/excalidraw-font-assets";
import { createStartupShellHtmlPlugin } from "./config/startup-shell-html";
import { createTypographyBootstrapHtmlPlugin } from "./config/typography-bootstrap";
import { BUNDLED_ELECTRON_MAIN_DEPENDENCIES } from "./config/electron-main-runtime-closure";
import { resolveNodexAccountBuildConfiguration } from "./config/nodex-account-build";
import {
  resolveRendererChunkFileName,
  resolveRendererManualChunk,
} from "./config/renderer-manual-chunks";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "./config/renderer-vite-shared";
import { buildTopLevelRendererCsp } from "./src/shared/app-renderer-policy";
import { createSentryPlugins, shouldEmitSentrySourceMaps } from "./config/sentry-build";

function enforceSelfContainedSandboxedPreloads(): Plugin {
  return {
    name: "nodex:self-contained-sandboxed-preloads",
    generateBundle(_outputOptions, bundle) {
      const chunks = Object.values(bundle).filter(
        (output): output is Rollup.OutputChunk => output.type === "chunk",
      );
      const emittedChunkNames = new Set(chunks.map((chunk) => chunk.fileName));
      const internalImports = chunks.flatMap((chunk) =>
        [...chunk.imports, ...chunk.dynamicImports]
          .filter((dependency) => emittedChunkNames.has(dependency))
          .map((dependency) => `${chunk.fileName} -> ${dependency}`),
      );
      const auxiliaryChunks = chunks
        .filter((chunk) => !chunk.isEntry)
        .map((chunk) => chunk.fileName);
      const splitOutputs = [...new Set([...internalImports, ...auxiliaryChunks])];
      if (splitOutputs.length === 0) return;

      this.error(
        "Sandboxed Electron preload entries must be self-contained; " +
          `the sandbox preload loader cannot load emitted chunks: ${splitOutputs.join(", ")}`,
      );
    },
  };
}

function createRendererDevelopmentCspPlugin(): Plugin {
  return {
    name: "nodex:renderer-development-csp",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const developmentOrigin =
          server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0] ?? null;
        if (!developmentOrigin) return;

        server.config.server.headers = {
          ...(server.config.server.headers ?? {}),
          "Content-Security-Policy": buildTopLevelRendererCsp({
            mode: "development",
            developmentOrigin,
          }),
        };
      });
    },
  };
}

function createRendererProductionCspPlugin(): Plugin {
  return {
    name: "nodex:renderer-production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: buildTopLevelRendererCsp({ mode: "production" }),
          },
          injectTo: "head",
        },
      ],
    },
  };
}

function isKnownYProsemirrorAwarenessTypeImportWarning(warning: Rollup.RollupLog): boolean {
  const importer = warning.ids?.[0]?.replaceAll("\\", "/");

  return (
    warning.code === "UNUSED_EXTERNAL_IMPORT" &&
    warning.exporter === "y-protocols/awareness" &&
    warning.names?.length === 1 &&
    warning.names[0] === "Awareness" &&
    warning.ids?.length === 1 &&
    importer?.endsWith("/node_modules/y-prosemirror/src/plugins/cursor-plugin.js") === true
  );
}

export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  const productionBuild = command === "build" && mode !== "development";
  const buildOptimization = {
    minify: productionBuild ? "oxc" : false,
    sourcemap: productionBuild || shouldEmitSentrySourceMaps() ? "hidden" : false,
  } satisfies Pick<BuildEnvironmentOptions, "minify" | "sourcemap">;

  return {
    main: {
      define: {
        __NODEX_ACCOUNT_CONFIGURATION__: JSON.stringify(
          resolveNodexAccountBuildConfiguration(process.env),
        ),
      },
      plugins: createSentryPlugins(),
      build: {
        externalizeDeps: {
          exclude: [...BUNDLED_ELECTRON_MAIN_DEPENDENCIES],
        },
        ...buildOptimization,
        rollupOptions: {
          input: {
            bootstrap: resolve(__dirname, "src/main/bootstrap.ts"),
            "git-worker": resolve(__dirname, "src/main/git-worker/entry.ts"),
            "worktree-worker": resolve(__dirname, "src/main/worktree-worker/entry.ts"),
          },
          onwarn(warning, defaultHandler) {
            if (isKnownYProsemirrorAwarenessTypeImportWarning(warning)) return;
            defaultHandler(warning);
          },
          output: {
            keepNames: productionBuild,
            entryFileNames: "[name].js",
            chunkFileNames: "[name]-[hash].js",
          },
        },
      },
    },
    preload: {
      plugins: [enforceSelfContainedSandboxedPreloads(), ...createSentryPlugins()],
      build: {
        // Sandboxed preload loaders cannot require shared chunks, including name helpers.
        isolatedEntries: true,
        externalizeDeps: false,
        ...buildOptimization,
        rollupOptions: {
          input: {
            "avatar-overlay": resolve(__dirname, "src/preload/avatar-overlay.ts"),
            "browser-guest": resolve(__dirname, "src/preload/browser-guest.ts"),
            "global-dictation": resolve(__dirname, "src/preload/global-dictation.ts"),
            index: resolve(__dirname, "src/preload/index.ts"),
            "mcp-app-sandbox-guest": resolve(__dirname, "src/preload/mcp-app-sandbox-guest.ts"),
          },
          output: { keepNames: productionBuild },
        },
      },
    },
    renderer: {
      server: {
        port: process.env.NODEX_DEV_RENDERER_PORT
          ? Number(process.env.NODEX_DEV_RENDERER_PORT)
          : 51284,
        strictPort: true,
        // Generic app/icon surfaces intentionally use Vite's /@fs route in development.
        fs: { strict: false },
        headers: {
          "Content-Security-Policy": buildTopLevelRendererCsp({
            mode: "development",
          }),
        },
      },
      root: resolve(__dirname, "src/renderer"),
      build: {
        ...buildOptimization,
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/renderer/index.html"),
          },
          output: {
            keepNames: productionBuild,
            chunkFileNames(chunk) {
              return resolveRendererChunkFileName(chunk.moduleIds);
            },
            manualChunks(id) {
              return resolveRendererManualChunk(id);
            },
          },
        },
      },
      resolve: rendererViteResolve,
      plugins: [
        createStartupShellHtmlPlugin(),
        createTypographyBootstrapHtmlPlugin(),
        createRendererDevelopmentCspPlugin(),
        createRendererProductionCspPlugin(),
        ...createExcalidrawFontAssetPlugins(),
        ...(await createRendererVitePlugins()),
        ...createSentryPlugins(),
      ],
      css: rendererViteCss,
    },
  };
});
