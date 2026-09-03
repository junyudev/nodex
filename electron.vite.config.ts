import { resolve } from "path";
import { defineConfig } from "electron-vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import type { Plugin, Rollup } from "vite";
import { createExcalidrawFontAssetPlugins } from "./config/excalidraw-font-assets";
import { createStartupShellHtmlPlugin } from "./config/startup-shell-html";
import { SOURCE_ONLY_ELECTRON_MAIN_DEPENDENCIES } from "./config/electron-main-runtime-closure";
import { resolveRendererManualChunk } from "./config/renderer-manual-chunks";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "./config/renderer-vite-shared";
import { buildTopLevelRendererCsp } from "./src/shared/app-renderer-policy";

function hasSentrySourceMapUploadConfig(): boolean {
  return Boolean(
    process.env.SENTRY_AUTH_TOKEN?.trim() &&
    process.env.SENTRY_ORG?.trim() &&
    process.env.SENTRY_PROJECT?.trim(),
  );
}

function shouldEmitSentrySourceMaps(): boolean {
  return Boolean(process.env.SENTRY_RELEASE?.trim() || hasSentrySourceMapUploadConfig());
}

function createSentryPlugins() {
  if (!hasSentrySourceMapUploadConfig()) return [];

  return sentryVitePlugin({
    release: {
      name: process.env.SENTRY_RELEASE?.trim() || undefined,
    },
    sourcemaps: {
      filesToDeleteAfterUpload: "out/**/*.map",
    },
    telemetry: false,
  });
}

const sentrySourcemapSetting = shouldEmitSentrySourceMaps() ? "hidden" : false;

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

export default defineConfig({
  main: {
    plugins: createSentryPlugins(),
    build: {
      externalizeDeps: {
        exclude: [...SOURCE_ONLY_ELECTRON_MAIN_DEPENDENCIES],
      },
      sourcemap: sentrySourcemapSetting,
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
          entryFileNames: "[name].js",
          chunkFileNames: "[name]-[hash].js",
        },
      },
    },
  },
  preload: {
    plugins: [enforceSelfContainedSandboxedPreloads(), ...createSentryPlugins()],
    build: {
      sourcemap: sentrySourcemapSetting,
      rollupOptions: {
        input: {
          "avatar-overlay": resolve(__dirname, "src/preload/avatar-overlay.ts"),
          "browser-guest": resolve(__dirname, "src/preload/browser-guest.ts"),
          "global-dictation": resolve(__dirname, "src/preload/global-dictation.ts"),
          index: resolve(__dirname, "src/preload/index.ts"),
          "mcp-app-sandbox-guest": resolve(__dirname, "src/preload/mcp-app-sandbox-guest.ts"),
        },
      },
    },
  },
  renderer: {
    server: {
      port: 51284,
      strictPort: false,
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
      sourcemap: sentrySourcemapSetting,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
        output: {
          manualChunks(id) {
            return resolveRendererManualChunk(id);
          },
        },
      },
    },
    resolve: rendererViteResolve,
    plugins: [
      createStartupShellHtmlPlugin(),
      createRendererDevelopmentCspPlugin(),
      createRendererProductionCspPlugin(),
      ...createExcalidrawFontAssetPlugins(),
      ...createRendererVitePlugins(),
      ...createSentryPlugins(),
    ],
    css: rendererViteCss,
  },
});
