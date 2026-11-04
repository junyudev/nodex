import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, type Rollup } from "vite";
import { describe, expect, test, vi } from "vite-plus/test";
import electronConfig from "./electron.vite.config";
import { resolveRendererManualChunk } from "./renderer-manual-chunks";

describe("resolveRendererManualChunk", () => {
  test("isolates React runtime packages", () => {
    expect(resolveRendererManualChunk("/Users/asc/repo/nodex/node_modules/react/index.js")).toBe(
      "vendor-react",
    );
    expect(resolveRendererManualChunk("C:\\repo\\nodex\\node_modules\\react-dom\\client.js")).toBe(
      "vendor-react",
    );
  });

  test("keeps editor and markdown dependencies in one chunk", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@streamdown/cjk/dist/index.js",
      ),
    ).toBe("vendor-editor-markdown");
    expect(
      resolveRendererManualChunk("C:\\repo\\nodex\\node_modules\\streamdown\\dist\\index.js"),
    ).toBe("vendor-editor-markdown");
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@blocknote/core/dist/index.js",
      ),
    ).toBe("vendor-editor-markdown");
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/third_party/blocknote/packages/core/src/index.ts",
      ),
    ).toBe("vendor-editor-markdown");
  });

  test("keeps the read-only snippet engine out of the shared editor chunk", () => {
    expect(
      resolveRendererManualChunk("/repo/node_modules/@streamdown/code/dist/index.js"),
    ).toBeUndefined();
  });

  test("groups canvas dependencies together", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/@excalidraw/excalidraw/dist/prod/index.js",
      ),
    ).toBe("vendor-excalidraw");
  });

  test("groups graph dependencies together", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/node_modules/cytoscape/dist/cytoscape.esm.mjs",
      ),
    ).toBe("vendor-cytoscape");
  });

  test("keeps local application modules in the entry graph", () => {
    expect(
      resolveRendererManualChunk(
        "/Users/asc/repo/nodex/src/renderer/components/workbench/stage-threads/markdown/markdown-core.tsx",
      ),
    ).toBe(undefined);
  });
});

test("keeps runtime packages shared with the Workbench out of the on-demand Canvas vendor", async () => {
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv("SENTRY_RELEASE", "");
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nodex-renderer-chunks-")));
  try {
    const files = {
      "index.html": '<script type="module" src="/renderer.js"></script>',
      "renderer.js": `globalThis.activate = () => import("./workbench.js");
globalThis.openCanvas = () => import("./canvas.js");
`,
      "workbench.js": `import { __assign } from "tslib";
import { useSyncExternalStore } from "use-sync-external-store/shim";
export const render = () => __assign({ store: useSyncExternalStore }, { workbench: true });
`,
      "canvas.js": `import { draw } from "@excalidraw/excalidraw";
export const open = () => draw();
`,
      "node_modules/tslib/package.json": '{ "name": "tslib", "module": "tslib.es6.mjs" }',
      "node_modules/tslib/tslib.es6.mjs": `export function __assign(target, ...sources) {
  return Object.assign(target, ...sources);
}
`,
      "node_modules/use-sync-external-store/package.json": '{ "name": "use-sync-external-store" }',
      "node_modules/use-sync-external-store/shim/package.json": '{ "module": "index.js" }',
      "node_modules/use-sync-external-store/shim/index.js": `import { useState } from "react";
export const useSyncExternalStore = (subscribe, read) => useState(read())[0];
`,
      "node_modules/react/package.json": '{ "name": "react", "module": "index.js" }',
      "node_modules/react/index.js":
        "export function useState(value) {\n  return [value, () => {}];\n}\n",
      "node_modules/@excalidraw/excalidraw/package.json":
        '{ "name": "@excalidraw/excalidraw", "module": "index.js" }',
      "node_modules/@excalidraw/excalidraw/index.js": `import { useState } from "react";
import { __assign } from "tslib";
import { useSyncExternalStore } from "use-sync-external-store/shim";
export const draw = () => __assign({ store: useSyncExternalStore, state: useState }, { drawn: true });
`,
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(fixture, file)), { recursive: true });
      await writeFile(join(fixture, file), content);
    }
    const renderer = (await electronConfig({ command: "build", mode: "production" })).renderer;
    if (!renderer?.build) throw new Error("Expected a renderer build");
    const result = await build({
      configFile: false,
      root: fixture,
      logLevel: "silent",
      build: {
        ...renderer.build,
        write: false,
        modulePreload: { polyfill: false },
        rollupOptions: { ...renderer.build.rollupOptions, input: join(fixture, "index.html") },
      },
    });
    if (!("output" in result)) throw new Error("Expected a single renderer build result");
    const chunks = new Map(
      result.output
        .filter((file): file is Rollup.OutputChunk => file.type === "chunk")
        .map((chunk) => [chunk.fileName, chunk]),
    );
    const workbench = [...chunks.values()].find((chunk) =>
      chunk.facadeModuleId?.endsWith("/workbench.js"),
    );
    if (!workbench) throw new Error("Expected a Workbench chunk");
    const reachable = new Set([workbench.fileName]);
    for (const fileName of reachable) {
      for (const dependency of chunks.get(fileName)?.imports ?? []) reachable.add(dependency);
    }

    const reachableModules = [...reachable].flatMap(
      (fileName) => chunks.get(fileName)?.moduleIds ?? [],
    );
    expect(reachableModules.some((id) => id.includes("/node_modules/tslib/"))).toBe(true);
    expect(reachableModules.filter((id) => id.includes("/@excalidraw/"))).toEqual([]);
    const ownerOf = (fragment: string) =>
      [...chunks.values()].find((chunk) => chunk.moduleIds.some((id) => id.includes(fragment)))
        ?.name;
    expect(ownerOf("/node_modules/react/")).toBe("vendor-react");
    expect(ownerOf("/node_modules/use-sync-external-store/")).toBe("vendor-shared-helpers");
  } finally {
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  }
});
