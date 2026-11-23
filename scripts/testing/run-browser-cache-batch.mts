import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import type { DevEnvironment, EnvironmentModuleNode, Plugin, ViteDevServer } from "vite-plus";
import { createVitest, type Reporter, type TestModule } from "vite-plus/test/node";
import { parseSync } from "oxc-parser";
import { suiteConfig } from "../../config/test-suites.ts";
import { ciPlaywrightProvider } from "../../config/vitest-browser-diagnostics.ts";
import { testObservation } from "../../config/vitest-observation.ts";
import { createTypographyBootstrapScript } from "../../config/typography-bootstrap.ts";
import {
  browserFileId,
  browserFileInput,
  browserRequestInput,
  type BrowserCacheExclusion,
} from "./browser-cache-inputs.ts";
import { fullyPassed, literalImports, readGlobs } from "./test-cache-graph.ts";
import {
  localInputReader,
  resolutionProbes,
  type LocalInputs,
  type PathState,
} from "./test-cache-inputs.ts";
import { relativeInput } from "./test-cache-policy.ts";

export interface BrowserBatchEvidence {
  readonly files: readonly string[];
  readonly inputs: readonly string[];
  readonly immutableUrls: readonly string[];
  readonly exclusions: readonly BrowserCacheExclusion[];
  readonly local: Omit<LocalInputs, "topology">;
  readonly broadTopology: boolean;
}

function browserObservation() {
  const contexts = new WeakSet<BrowserContext>();
  const requests = new Map<string, { url: string; method: string }>();
  const sockets = new Set<string>();
  let contextCount = 0;
  let serviceWorker = false;
  return {
    requests,
    sockets,
    get contextCount() {
      return contextCount;
    },
    get serviceWorker() {
      return serviceWorker;
    },
    attach(context: BrowserContext) {
      if (contexts.has(context)) return;
      contexts.add(context);
      contextCount++;
      // The context sees navigations before a Frame exists and traffic from
      // workers. Never use frame attribution to decide what belongs to the suite.
      context.on("request", (request) => {
        serviceWorker ||= request.serviceWorker() !== null;
        const url = request.url();
        const method = request.method();
        requests.set(method + " " + url, { url, method });
      });
      context.on("response", (response) => {
        serviceWorker ||= response.fromServiceWorker();
      });
      context.on("serviceworker", () => {
        serviceWorker = true;
      });
      context.on("page", (page) => page.on("websocket", (socket) => sockets.add(socket.url())));
    },
  };
}

function viteObservation() {
  const servers = new Set<ViteDevServer>();
  const optimizedSources = new Set<string>();
  let optimizationObserved = false;
  const plugin: Plugin = {
    name: "nodex:browser-cache-inputs",
    configureServer(server) {
      servers.add(server);
    },
    config: () => ({
      optimizeDeps: {
        rolldownOptions: {
          plugins: [
            {
              name: "nodex:browser-cache-optimizer-inputs",
              generateBundle(_, bundle) {
                optimizationObserved = true;
                const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
                for (const id of chunks.flatMap((chunk) => chunk.moduleIds))
                  optimizedSources.add(id);
              },
            },
          ],
        },
      },
    }),
  };
  return {
    servers,
    optimizedSources,
    plugin,
    get optimizationObserved() {
      return optimizationObserved;
    },
  };
}

function graphInputs(
  client: DevEnvironment,
  roots: Iterable<string>,
  exclude: (reason: string, input?: string) => void,
) {
  const nodes = new Set<EnvironmentModuleNode>();
  for (const file of roots) {
    const modules = client.moduleGraph.getModulesByFile(file);
    if (!modules?.size)
      exclude("missing Vite client graph root", relativeInput(client.config.root, file));
    for (const node of modules ?? []) nodes.add(node);
  }
  // Set iteration also visits nodes appended by static and dynamic edges.
  for (const node of nodes) {
    for (const imported of node.importedModules) nodes.add(imported);
  }
  return [...nodes].map((node) => node.id ?? node.url);
}

async function resolutionEvidence(root: string, files: Iterable<string>, client: DevEnvironment) {
  const reader = localInputReader(root);
  const probes: Record<string, PathState> = {};
  const globs: Record<string, readonly string[]> = {};
  await Promise.all(
    [...files]
      .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file))
      .map(async (file) => {
        const importer = path.join(root, file);
        const parsedSource = await readFile(importer, "utf8");
        const parsed = parseSync(file, parsedSource);
        if (parsed.errors.length) return;
        const { staticImports, staticExports, dynamicImports, importMetas } = parsed.module;
        const dynamic = literalImports(parsedSource, dynamicImports);
        const requests = new Set([
          ...(dynamic ?? []),
          ...staticImports.map(({ moduleRequest }) => moduleRequest.value),
          ...staticExports.flatMap(({ entries }) =>
            entries.flatMap(({ moduleRequest }) => (moduleRequest ? [moduleRequest.value] : [])),
          ),
        ]);
        const patterns = importMetas.length ? readGlobs(file, parsed) : [];
        for (const pattern of patterns ?? []) {
          const members = await reader.glob(pattern);
          if (members) globs[pattern] = members;
        }
        for (const request of requests) {
          if (!/^(?:@\/|\.\.?\/)/u.test(request) || client.config.resolve.tsconfigPaths) continue;
          const resolved = await client.pluginContainer
            .resolveId(request, importer)
            .catch(() => undefined);
          const evidence =
            resolved &&
            (await resolutionProbes(
              root,
              importer,
              request,
              resolved.id,
              client.config.resolve.extensions,
              reader,
            ));
          if (evidence) Object.assign(probes, evidence);
        }
      }),
  );
  return { probes, globs };
}

async function recordInputs(
  root: string,
  workspace: ReadonlySet<string>,
  modules: readonly TestModule[],
  browser: ReturnType<typeof browserObservation>,
  vite: ReturnType<typeof viteObservation>,
): Promise<BrowserBatchEvidence> {
  const files = modules.map(({ relativeModuleId }) => relativeModuleId).sort();
  const inputs = new Set(files);
  const immutableUrls = new Set<string>();
  let typographyRequested = false;
  const exclusions = new Map<string, BrowserCacheExclusion>();
  const exclude = (reason: string, input?: string) =>
    exclusions.set(JSON.stringify([reason, input]), { reason, input });
  const admit = (input: ReturnType<typeof browserRequestInput>) => {
    if (input.kind === "file") inputs.add(input.input);
    if (input.kind === "external") immutableUrls.add(input.input);
    if (input.kind === "typography") typographyRequested = true;
    if (input.kind === "opaque") exclude(input.exclusion.reason, input.exclusion.input);
  };
  const project = modules[0]?.toTestSpecification().project;
  const server = project?.browser?.vite;
  const client = server?.environments.client;
  if (!project || !server || !client || !vite.servers.has(server))
    return {
      files,
      inputs: [],
      immutableUrls: [],
      exclusions: [{ reason: "missing Vite browser server" }],
      local: { probes: {}, globs: {} },
      broadTopology: true,
    };

  const setup = project.config.setupFiles;
  if (modules.some((module) => module.toTestSpecification().project !== project))
    exclude("unexpected browser project");
  if (modules.some((module) => !fullyPassed(module))) exclude("browser tests skipped or retried");
  if (
    Object.keys(project.config.browser.commands ?? {}).length > 0 ||
    project.config.browser.testerHtmlPath ||
    project.config.globalSetup?.length ||
    project.config.snapshotOptions?.resolveSnapshotPath ||
    project.config.snapshotEnvironment
  )
    exclude("custom browser Node-side test inputs");
  if (!browser.contextCount || !browser.requests.size)
    exclude("missing browser context request log");

  const origins = new Set(server.resolvedUrls?.local.map((url) => new URL(url).origin));
  const optimizedEntries = client.depsOptimizer?.metadata.depInfoList ?? [];
  // The optimizer can replace its metadata during a run. Its private cache
  // directory still identifies chunks from earlier generations we observed.
  const isOptimized = (file: string) => client.depsOptimizer?.isOptimizedDepFile(file) ?? false;
  const context = {
    root,
    files: workspace,
    isOptimized,
    origins,
    publicDir: server.config.publicDir,
  };
  const admitFile = async (id: string) => {
    // pnpm workspace aliases are file links, whereas direct installed paths are
    // canonicalized under .pnpm. Verify the target before granting install identity.
    const filename = browserFileId(id);
    if (path.isAbsolute(filename) && !isOptimized(filename)) {
      const canonical = await realpath(filename).catch(() => undefined);
      if (canonical && relativeInput(root, canonical)?.startsWith("node_modules/.pnpm/")) return;
      if (canonical && relativeInput(root, filename)?.startsWith("node_modules/")) {
        admit(browserFileInput(canonical, context));
        return;
      }
    }
    admit(browserFileInput(id, context));
  };
  if (optimizedEntries.length && !vite.optimizationObserved)
    exclude("missing Vite optimizer inputs");
  const rootIds = [...modules.map(({ moduleId }) => moduleId), ...setup];
  const graph = graphInputs(client, rootIds, exclude);
  await Promise.all(Array.from(new Set([...rootIds, ...graph]), admitFile));
  const admitRequests = () => {
    for (const request of browser.requests.values()) {
      try {
        admit(browserRequestInput(request, context));
      } catch {
        exclude("unreadable browser request URL");
      }
    }
  };
  admitRequests();
  const { probes, globs } = await resolutionEvidence(root, inputs, client);
  // CSS dependencies (including Tailwind scanner inputs), worker bundle inputs,
  // and workspace files used to build optimized dependencies can bypass ESM edges.
  await Promise.all(
    Array.from(
      new Set([
        ...client.pluginContainer.watchFiles,
        ...server.config.configFileDependencies,
        ...vite.optimizedSources,
        ...optimizedEntries.flatMap(({ src }) => (src ? [src] : [])),
      ]),
      admitFile,
    ),
  );
  const reader = localInputReader(root);
  for (const file of files) {
    const snapshot = path.posix.join(
      path.posix.dirname(file),
      "__snapshots__",
      path.posix.basename(file) + ".snap",
    );
    const state = await reader.state(snapshot);
    if (state === "file") inputs.add(snapshot);
    else if (state === "absent") probes[snapshot] = state;
    else exclude("unaccounted browser snapshot", snapshot);
  }
  if (browser.serviceWorker) exclude("service worker");
  admitRequests();
  if (typographyRequested) {
    try {
      let bootstrapInputs: string[] = [];
      createTypographyBootstrapScript((files) => {
        bootstrapInputs = files;
      });
      await Promise.all(bootstrapInputs.map(admitFile));
    } catch {
      exclude("unaccounted typography bootstrap inputs");
    }
    admitRequests();
  }
  for (const socket of browser.sockets) {
    const url = new URL(socket);
    const origin = url.origin.replace(/^ws/u, "http");
    const token = url.searchParams.get("token");
    const runner =
      url.pathname === "/__vitest_browser_api__" && token === project.vitest.config.api.token;
    const hmr = url.pathname === "/" && token === server.config.webSocketToken;
    if (!origins.has(origin) || (!runner && !hmr))
      exclude("unknown browser WebSocket", origin + url.pathname);
  }
  return {
    files,
    inputs: [...inputs].sort(),
    immutableUrls: [...immutableUrls].sort(),
    exclusions: [...exclusions.values()],
    local: {
      probes: Object.fromEntries(Object.entries(probes).sort(([a], [b]) => a.localeCompare(b))),
      globs: Object.fromEntries(Object.entries(globs).sort(([a], [b]) => a.localeCompare(b))),
    },
    // CSS and browser/optimizer asset resolution are wider than the JS graph.
    broadTopology: true,
  };
}

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Expected browser batch directory.");
const root = process.cwd();
const workspace = new Set<string>(
  JSON.parse(await readFile(path.join(directory, "workspace.json"), "utf8")),
);
const browser = browserObservation();
const vite = viteObservation();
let evidence: BrowserBatchEvidence | undefined;
let captured: string | undefined;
const observationStamp = () =>
  JSON.stringify([
    browser.requests.size,
    browser.sockets.size,
    browser.contextCount,
    browser.serviceWorker,
  ]);
const recorder: Reporter = {
  async onTestRunEnd(modules, errors, reason) {
    if (reason !== "passed" || errors.length > 0) return;
    evidence = await recordInputs(root, workspace, modules, browser, vite);
    captured = observationStamp();
  },
};

const runner = await createVitest(
  {
    config: suiteConfig("browser"),
    watch: false,
    allowOnly: false,
    fsModuleCache: false,
    browser: { provider: ciPlaywrightProvider(browser.attach) },
    reporters: [...testObservation("browser").reporters, recorder],
  },
  { cacheDir: path.join(directory, "vite"), plugins: [vite.plugin] },
);
try {
  await runner.start();
} finally {
  await runner.close();
}
if (evidence) {
  const exclusions =
    captured === observationStamp()
      ? evidence.exclusions
      : [...evidence.exclusions, { reason: "browser traffic continued after recording" }];
  await writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify({ ...evidence, exclusions }),
  );
}
