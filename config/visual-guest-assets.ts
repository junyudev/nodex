import { build } from "esbuild";
import { basename, resolve } from "node:path";
import type { Plugin } from "vite";
import { VISUAL_MODULES } from "../src/shared/visual/contract";

const ENTRY_ID = "virtual:nodex-visual-assets";
const imports = [...VISUAL_MODULES, "react/jsx-runtime"];

export function createVisualGuestAssetsPlugin(repositoryRoot: string): Plugin {
  return {
    name: "nodex:visual-guest-assets",
    resolveId(id) {
      return id === ENTRY_ID ? "\0" + ENTRY_ID : undefined;
    },
    async load(id) {
      if (id !== "\0" + ENTRY_ID) return;
      const root = resolve(repositoryRoot, "src/visual-guest");
      this.addWatchFile(resolve(root, "entry.ts"));
      this.addWatchFile(resolve(root, "geometry.ts"));
      this.addWatchFile(resolve(root, "svg-snapshot.ts"));
      this.addWatchFile(resolve(root, "measure-entry.ts"));
      return buildVisualGuestAssets(repositoryRoot);
    },
  };
}

export async function buildVisualGuestAssets(repositoryRoot: string): Promise<string> {
  const root = resolve(repositoryRoot, "src/visual-guest");
  const [modules, measure] = await Promise.all([
    build({
      absWorkingDir: repositoryRoot,
      entryPoints: [
        { in: resolve(root, "entry.ts"), out: "runtime" },
        ...imports.map((module, index) => ({ in: module, out: `module-${index}` })),
      ],
      bundle: true,
      format: "esm",
      splitting: true,
      minify: true,
      write: false,
      outdir: resolve(repositoryRoot, ".generated/visual-guest"),
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "visual-react-exports",
          setup(build) {
            build.onResolve({ filter: /^react$/ }, (args) =>
              args.kind === "entry-point"
                ? { path: "react", namespace: "visual-react" }
                : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: "visual-react" }, () => ({
              contents: `import React from "react"; export default React; export const {
              Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
              cloneElement, createContext, createElement, createRef, forwardRef, isValidElement,
              lazy, memo, startTransition, use, useActionState, useCallback, useContext,
              useDebugValue, useDeferredValue, useEffect, useEffectEvent, useId, useImperativeHandle,
              useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef,
              useState, useSyncExternalStore, useTransition, version
            } = React;`,
              resolveDir: root,
            }));
            build.onResolve({ filter: /^react\/jsx-runtime$/ }, (args) =>
              args.kind === "entry-point"
                ? { path: "react/jsx-runtime", namespace: "visual-jsx" }
                : undefined,
            );
            build.onLoad({ filter: /.*/, namespace: "visual-jsx" }, () => ({
              contents:
                'import runtime from "react/jsx-runtime"; export const { jsx, jsxs, Fragment } = runtime;',
              resolveDir: root,
            }));
          },
        },
      ],
    }),
    build({
      entryPoints: [resolve(root, "measure-entry.ts")],
      format: "iife",
      bundle: true,
      minify: true,
      write: false,
    }),
  ]);
  const assets = Object.fromEntries(
    modules.outputFiles.map((file) => [`/${basename(file.path)}`, file.text]),
  );
  const importMap = Object.fromEntries(imports.map((name, index) => [name, `/module-${index}.js`]));
  return [
    `export const assets = ${JSON.stringify(assets)};`,
    `export const importMap = ${JSON.stringify(importMap)};`,
    `export const measureScript = ${JSON.stringify(measure.outputFiles[0].text)};`,
  ].join("\n");
}
