import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { PreloadConfigFactory } from "electron-vite";
import { build, type ConfigEnv, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import electronConfig from "../electron.vite.config";

const fixtureSource = `export class RuntimeFailure extends Error {}
export function failRuntime() {
  throw new RuntimeFailure("bundle failure");
}
export function runtimeNames() {
  return [RuntimeFailure.name, failRuntime.name];
}
`;
const targets = ["main", "preload", "renderer"] as const;
let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "nodex-electron-minify-"));
  await writeFile(join(fixtureDirectory, "entry.js"), fixtureSource);
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv("SENTRY_RELEASE", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function buildFixture(target: (typeof targets)[number], environment: ConfigEnv) {
  const settings = electronConfig(environment)[target]?.build;
  const output = settings?.rollupOptions?.output;
  if (!settings || !output || Array.isArray(output)) {
    throw new Error(`Expected one configured output for ${target}`);
  }

  const result = await build({
    configFile: false,
    root: fixtureDirectory,
    logLevel: "silent",
    build: {
      ...settings,
      write: false,
      rollupOptions: {
        input: join(fixtureDirectory, "entry.js"),
        preserveEntrySignatures: "strict",
        output: { ...output, format: "cjs", entryFileNames: "fixture.cjs" },
      },
    },
  });
  if (!("output" in result)) throw new Error("Expected a single build result");
  const chunk = result.output.find(
    (file): file is Rollup.OutputChunk => file.type === "chunk" && file.isEntry,
  );
  if (!chunk) throw new Error("Expected a fixture entry");
  return { chunk, output: result.output };
}

describe("Electron build optimization", () => {
  test.each(targets)(
    "minifies %s while preserving runtime names and hidden source maps",
    async (target) => {
      const development = await buildFixture(target, { command: "build", mode: "development" });
      const production = await buildFixture(target, { command: "build", mode: "production" });
      expect(production.chunk.code.length).toBeLessThan(development.chunk.code.length);
      expect(production.chunk.code).not.toMatch(/sourceMappingURL=/);

      const fixtureModule = { exports: {} as { runtimeNames(): string[]; failRuntime(): never } };
      runInNewContext(
        production.chunk.code,
        { module: fixtureModule, exports: fixtureModule.exports },
        {
          filename: "fixture.cjs",
        },
      );
      expect(fixtureModule.exports.runtimeNames()).toEqual(["RuntimeFailure", "failRuntime"]);

      const mapAsset = production.output.find(
        (file): file is Rollup.OutputAsset =>
          file.type === "asset" && file.fileName === "fixture.cjs.map",
      );
      if (!mapAsset) throw new Error("Expected a hidden source map");
      const sourceMap = new SourceMap(JSON.parse(String(mapAsset.source)));
      let failureStack = "";
      try {
        fixtureModule.exports.failRuntime();
      } catch (error) {
        failureStack = String((error as Error).stack);
      }
      const location = failureStack.match(/fixture\.cjs:(\d+):(\d+)/);
      if (!location) throw new Error("Expected a generated error location");
      const original = sourceMap.findEntry(Number(location[1]) - 1, Number(location[2]) - 1);
      if (!("originalSource" in original) || !("originalLine" in original)) {
        throw new Error("Expected an original error location");
      }
      expect(original.originalSource).toMatch(/entry\.js$/);
      expect(original.originalLine).toBe(2);
      expect(development.output.some((file) => file.fileName.endsWith(".map"))).toBe(false);
    },
  );

  test.each(targets)("keeps %s development-server builds unminified", async (target) => {
    const served = await buildFixture(target, { command: "serve", mode: "development" });
    const development = await buildFixture(target, { command: "build", mode: "development" });
    expect(served.chunk.code).toBe(development.chunk.code);
  });
});

test.each(["development", "production"])(
  "keeps multiple %s preload entries independently executable in the sandbox",
  async (mode) => {
    const preload = electronConfig({ command: "build", mode }).preload;
    if (!preload?.build) throw new Error("Expected a preload build");
    const { rollupOptions, ...buildSettings } = preload.build;
    const entries = Object.fromEntries(
      ["first", "second"].map((name) => [name, join(fixtureDirectory, `${name}.js`)]),
    );
    for (const [name, file] of Object.entries(entries)) {
      await writeFile(
        file,
        `import { contextBridge } from "electron";
import { runtimeNames } from "./entry.js";
contextBridge.exposeInMainWorld("${name}", runtimeNames);
`,
      );
    }
    const factory = new PreloadConfigFactory(
      {
        ...preload,
        root: fixtureDirectory,
        mode,
        logLevel: "silent",
        build: {
          ...buildSettings,
          write: false,
          rolldownOptions: { ...rollupOptions, input: entries },
        },
      },
      {},
      { root: fixtureDirectory },
    );
    const result = await build({ ...(await factory.build()), configFile: false });
    if (!("output" in result)) throw new Error("Expected a single preload build result");
    const scripts = result.output.filter((file) => file.fileName.endsWith(".js"));
    expect(scripts.map((file) => file.fileName).sort()).toEqual(["first.js", "second.js"]);
    for (const script of scripts) {
      const expose = vi.fn();
      runInNewContext(script.type === "chunk" ? script.code : String(script.source), {
        require(id: string) {
          if (id !== "electron") throw new Error(`Sandbox cannot require ${id}`);
          return { contextBridge: { exposeInMainWorld: expose } };
        },
      });
      expect(expose).toHaveBeenCalledTimes(1);
      const [name, runtimeNames] = expose.mock.calls[0] as [string, () => string[]];
      expect(name).toBe(script.fileName.replace(/\.js$/, ""));
      expect(runtimeNames()).toEqual(["RuntimeFailure", "failRuntime"]);
    }
  },
);

test("keeps renderer name and preload helpers inside the lightweight bootstrap boundary", async () => {
  const renderer = electronConfig({ command: "build", mode: "production" }).renderer;
  if (!renderer?.build) throw new Error("Expected a renderer build");
  await writeFile(
    join(fixtureDirectory, "index.html"),
    '<script type="module" src="/renderer.js"></script>',
  );
  await writeFile(
    join(fixtureDirectory, "renderer.js"),
    `const openFeature = () => import("./feature.js");
globalThis.startRenderer = openFeature;
`,
  );
  await writeFile(
    join(fixtureDirectory, "feature.js"),
    `export const initializeFeature = () => initializeFeature.name;
`,
  );
  const result = await build({
    configFile: false,
    root: fixtureDirectory,
    logLevel: "silent",
    build: {
      ...renderer.build,
      write: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        ...renderer.build.rollupOptions,
        input: join(fixtureDirectory, "index.html"),
      },
    },
  });
  if (!("output" in result)) throw new Error("Expected a single renderer build result");
  const chunks = result.output.filter((file): file is Rollup.OutputChunk => file.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (!entry) throw new Error("Expected a renderer entry");
  const eagerChunks = chunks.filter((chunk) => entry.imports.includes(chunk.fileName));
  expect(entry.dynamicImports).toHaveLength(1);
  expect(eagerChunks).toHaveLength(entry.imports.length);
  expect(eagerChunks.flatMap((chunk) => chunk.moduleIds).sort()).toEqual([
    "\0rolldown/runtime.js",
    "\0vite/preload-helper.js",
  ]);
  for (const chunk of eagerChunks) {
    expect(chunk.fileName).toMatch(/^assets\/renderer-bootstrap-runtime-/);
    expect(chunk.imports.every((specifier) => entry.imports.includes(specifier))).toBe(true);
  }
});
