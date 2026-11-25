import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  build as viteBuild,
  createLogger,
  createServer as createViteServer,
  type Logger,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { createExcalidrawFontAssetPlugins } from "./excalidraw-font-assets";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const representativeFontPath = "Assistant/Assistant-Regular.woff2";

const virtualEntryPlugin: Plugin = {
  name: "test:virtual-entry",
  resolveId(id) {
    return id === "virtual:test-entry" ? `\0${id}` : null;
  },
  load(id) {
    return id === "\0virtual:test-entry" ? "export default true;" : null;
  },
};

const listen = (server: ReturnType<typeof createHttpServer>): Promise<number> =>
  new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test HTTP server has no TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });

const closeHttpServer = (server: ReturnType<typeof createHttpServer>): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });

function createWarningCapturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger = createLogger("info", { allowClearScreen: false });
  logger.warn = (message) => warnings.push(message);
  logger.warnOnce = (message) => warnings.push(message);
  return { logger, warnings };
}

describe("createExcalidrawFontAssetPlugins", () => {
  let viteServer: ViteDevServer | undefined;
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let optimizerCacheDirectory: string | undefined;

  afterEach(async () => {
    await viteServer?.close();
    if (httpServer?.listening) await closeHttpServer(httpServer);
    if (optimizerCacheDirectory) {
      await rm(optimizerCacheDirectory, { recursive: true, force: true });
    }
    viteServer = undefined;
    httpServer = undefined;
    optimizerCacheDirectory = undefined;
  });

  test("prebundles Excalidraw through the native Rolldown optimizer", async () => {
    const { logger, warnings } = createWarningCapturingLogger();
    const cacheDirectory = await mkdtemp(resolve(tmpdir(), "nodex-excalidraw-font-optimizer-"));
    optimizerCacheDirectory = cacheDirectory;
    viteServer = await createViteServer({
      cacheDir: cacheDirectory,
      configFile: false,
      customLogger: logger,
      optimizeDeps: {
        force: true,
        include: ["@excalidraw/excalidraw"],
        noDiscovery: true,
      },
      plugins: createExcalidrawFontAssetPlugins(),
      root: repositoryRoot,
      server: { middlewareMode: true },
    });

    const rolldownOptions = viteServer.config.optimizeDeps.rolldownOptions;
    expect(rolldownOptions?.treeshake).toBe(true);
    expect(rolldownOptions?.transform?.target).toBe("es2022");
    expect(viteServer.config.optimizeDeps.esbuildOptions?.plugins).toBeUndefined();

    const optimizer = viteServer.environments.client.depsOptimizer;
    if (!optimizer) throw new Error("Expected the client dependency optimizer to be available.");
    const pendingDependency =
      optimizer.metadata.discovered["@excalidraw/excalidraw"] ??
      optimizer.metadata.optimized["@excalidraw/excalidraw"];
    if (!pendingDependency)
      throw new Error("Expected Excalidraw dependency optimization to start.");
    await pendingDependency.processing;

    const optimizedDependency = optimizer.metadata.optimized["@excalidraw/excalidraw"];
    if (!optimizedDependency) {
      throw new Error("Expected Excalidraw dependency optimization to complete.");
    }
    const outputPaths = [
      optimizedDependency.file,
      ...Object.values(optimizer.metadata.chunks).map((chunk) => chunk.file),
    ];
    const output = (await Promise.all(outputPaths.map((path) => readFile(path, "utf8")))).join(
      "\n",
    );
    const sourceMapPaths = (await readdir(resolve(cacheDirectory, "deps")))
      .filter((fileName) => fileName.endsWith(".js.map"))
      .map((fileName) => resolve(cacheDirectory, "deps", fileName));
    const inputSources = (
      await Promise.all(
        sourceMapPaths.map(async (path) => {
          const sourceMap = JSON.parse(await readFile(path, "utf8")) as { sources: string[] };
          return sourceMap.sources;
        }),
      )
    ).flat();

    expect(inputSources.some((source) => source.includes("es6-promise-pool"))).toBe(true);
    expect(output).toContain("urls.length === 0 && urls.push(new URL");
    expect(warnings.some((warning) => warning.includes("optimizeDeps.esbuildOptions"))).toBe(false);
  });

  test("serves fonts without installing build-only hooks in development", async () => {
    const { logger, warnings } = createWarningCapturingLogger();

    viteServer = await createViteServer({
      configFile: false,
      customLogger: logger,
      optimizeDeps: { noDiscovery: true },
      plugins: createExcalidrawFontAssetPlugins(),
      server: { middlewareMode: true },
    });
    httpServer = createHttpServer(viteServer.middlewares);
    const port = await listen(httpServer);
    const response = await fetch(
      `http://127.0.0.1:${port}/excalidraw-assets/fonts/${representativeFontPath}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const missing = await fetch(`http://127.0.0.1:${port}/excalidraw-assets/fonts/missing.woff2`);
    const traversal = await fetch(
      `http://127.0.0.1:${port}/excalidraw-assets/fonts/%2e%2e%2fpackage.json`,
    );
    expect(missing.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(warnings.filter((warning) => warning.includes("emitFile() is not supported"))).toEqual(
      [],
    );
  });

  test("emits the complete font tree in build mode", async () => {
    const result = await viteBuild({
      build: {
        rollupOptions: { input: "virtual:test-entry" },
        write: false,
      },
      configFile: false,
      logLevel: "silent",
      plugins: [...createExcalidrawFontAssetPlugins(), virtualEntryPlugin],
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => {
      if (!("output" in entry)) throw new Error("Expected build output rather than a watcher.");
      return entry.output;
    });
    const fileNames = outputs.map((output) => output.fileName);

    expect(fileNames).toContain(`excalidraw-assets/fonts/${representativeFontPath}`);
    expect(
      fileNames.filter((fileName) => fileName.startsWith("excalidraw-assets/fonts/")).length,
    ).toBeGreaterThan(200);
  });
});
