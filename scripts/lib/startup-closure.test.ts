import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import electronConfig from "../../config/electron.vite.config";
import { measureWorkbenchClosure } from "./startup-closure";

// A Workbench root, an on-demand Canvas, and a root that imports the Canvas package
// directly, built with the production renderer configuration.
const fixtureFiles = {
  "index.html": '<script type="module" src="/renderer.js"></script>',
  "renderer.js": `globalThis.activate = () => import("./application-renderer.js");
globalThis.activateDirectly = () => import("./direct-renderer.js");
globalThis.openCanvas = () => import("./canvas.js");
`,
  "application-renderer.js": `import "./application.css";
import { shared } from "./shared.js";
export const render = () => ({ ...shared });
`,
  "direct-renderer.js": `import { draw } from "@excalidraw/excalidraw";
export const render = () => draw();
`,
  "canvas.js": `import { draw } from "@excalidraw/excalidraw";
export const open = () => draw();
`,
  "shared.js": "export const shared = { workbench: true };\n",
  "application.css": ".workbench { display: grid; }\n",
  "node_modules/@excalidraw/excalidraw/package.json":
    '{ "name": "@excalidraw/excalidraw", "module": "index.js" }',
  "node_modules/@excalidraw/excalidraw/index.js": `import "./index.css";
export const draw = () => ({ elements: [], drawn: true });
`,
  "node_modules/@excalidraw/excalidraw/index.css": ".excalidraw { position: relative; }\n",
} as const;

let fixtureDirectory: string;
let rendererDirectory: string;

beforeAll(async () => {
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv("SENTRY_RELEASE", "");
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), "nodex-startup-closure-")));
  rendererDirectory = join(fixtureDirectory, "out");
  for (const [file, content] of Object.entries(fixtureFiles)) {
    await mkdir(dirname(join(fixtureDirectory, file)), { recursive: true });
    await writeFile(join(fixtureDirectory, file), content);
  }
  const renderer = (await electronConfig({ command: "build", mode: "production" })).renderer;
  if (!renderer?.build) throw new Error("Expected a renderer build");
  await build({
    configFile: false,
    root: fixtureDirectory,
    // The desktop renderer is served from its own directory, as electron-vite configures it.
    base: "./",
    logLevel: "silent",
    build: {
      ...renderer.build,
      outDir: rendererDirectory,
      modulePreload: { polyfill: false },
      rollupOptions: {
        ...renderer.build.rollupOptions,
        input: join(fixtureDirectory, "index.html"),
      },
    },
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

const measure = (rootChunkName: string) =>
  measureWorkbenchClosure({
    rendererDirectory,
    rootChunkName,
    onDemandPackages: ["@excalidraw/excalidraw"],
  });

test("measures the Workbench closure and finds where on-demand packages live", () => {
  const closure = measure("application-renderer");

  expect(closure.violations).toEqual([]);
  expect(closure.onDemandPackageFiles.get("@excalidraw/excalidraw")).toEqual([
    expect.stringMatching(/^assets\/vendor-excalidraw-[\w-]+\.js$/u),
  ]);
  expect(closure.root).toMatch(/^assets\/application-renderer-[\w-]+\.js$/u);
  expect(closure.javaScript.files).toBe(2);
  expect(closure.css.files).toBe(1);
});

test("reports the import path that brings an on-demand package into the Workbench", () => {
  const closure = measure("direct-renderer");

  expect(closure.violations).toEqual([
    {
      packageName: "@excalidraw/excalidraw",
      file: expect.stringMatching(/^assets\/vendor-excalidraw-[\w-]+\.js$/u),
      modules: 1,
      chain: [
        expect.stringMatching(/^assets\/direct-renderer-[\w-]+\.js$/u),
        expect.stringMatching(/^assets\/vendor-excalidraw-[\w-]+\.js$/u),
      ],
    },
  ]);
  // Excalidraw's stylesheet travels with the Workbench import that reaches it.
  expect(closure.css.files).toBe(1);
});
