import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import type { DevEnvironment, EnvironmentModuleNode } from "vite-plus";
import type { TestModule } from "vite-plus/test/node";
import { relativeInput } from "./test-cache-policy.ts";

// Keep an allowlist so new Node builtins with ambient authority fail closed.
const pureBuiltins = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "constants",
  "crypto",
  "events",
  "path",
  "path/posix",
  "path/win32",
  "querystring",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
]);

export function builtinReason(request: string) {
  const name = request.replace(/^node:/u, "");
  return (request.startsWith("node:") || isBuiltin(request)) && !pureBuiltins.has(name)
    ? "Node builtin " + name
    : undefined;
}

// Oxc's explicit-resource-management transform embeds this helper in the locked Vite toolchain.
const lockedVirtualModules = new Set(["\0@oxc-project+runtime@0.155.0/helpers/esm/usingCtx.js"]);

const rendererWorkerUrls = new Map([
  [
    "src/renderer/features/dictation/dictation-streaming-client.ts",
    "./dictation-pcm-worklet.ts?worker&url",
  ],
  ["src/renderer/lib/highlight-pool.tsx", "./highlight.worker.ts?worker&url"],
  [
    "src/renderer/lib/realtime-voice/realtime-voice-media.ts",
    "./realtime-voice-audio-worklet.ts?worker&url",
  ],
]);

// Tooling can invoke tools through dependencies even with no direct Node builtin import.
const pureToolingImports = new Set([
  "@effect/vitest",
  "effect",
  "effect/Effect",
  "effect/testing",
  "vite-plus/test",
  "vitest",
]);

const scriptFile = (file: string) => /\.[cm]?[jt]sx?$/u.test(file);

interface SourceInputs {
  readonly reason?: string;
  readonly staticRequests?: readonly string[];
  readonly workerUrl?: string;
  readonly expandsGlob?: boolean;
  readonly customEnvironment?: boolean;
}

function inspectSource(file: string, source: string, rendererJsdom: boolean): SourceInputs {
  const workerUrl = rendererJsdom ? rendererWorkerUrls.get(file) : undefined;
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) return { reason: "unparsed module" };
  const { staticImports, staticExports, dynamicImports } = parsed.module;
  const staticRequests = [
    ...staticImports
      .filter(({ entries }) => entries.length === 0 || entries.some(({ isType }) => !isType))
      .map(({ moduleRequest }) => moduleRequest.value),
    ...staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest, isType }) =>
        moduleRequest && !isType ? [moduleRequest.value] : [],
      ),
    ),
  ];
  const requests = [
    ...staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) => (moduleRequest ? [moduleRequest.value] : [])),
    ),
  ];
  for (const {
    moduleRequest: { start, end },
  } of dynamicImports) {
    const literal = /^(['"`])([^'"$`\\]+)\1$/u.exec(source.slice(start, end).trim());
    if (!literal) return { reason: "computed import" };
    requests.push(literal[2]);
  }
  for (const request of requests) {
    const reason = builtinReason(request);
    if (reason) return { reason };
    if (
      /^https?:/u.test(request) ||
      (/[?&](?:shared)?worker(?:[&=]|$)/u.test(request) && request !== workerUrl)
    )
      return { reason: "external execution" };
    if (
      /^(?:scripts|config)\//u.test(file) &&
      !request.startsWith(".") &&
      !isBuiltin(request) &&
      !pureToolingImports.has(request)
    )
      return { reason: "tooling dependency" };
  }
  // This private class method looks like CommonJS to the conservative source check.
  const loaderSource =
    file === "src/renderer/lib/local-structural-transaction-presentation.ts"
      ? source.replace(/\b(?:this\.|private )require\s*\(/gu, "(")
      : source;
  if (
    /\b(?:require|createRequire|process\.(?:getBuiltinModule|dlopen)|import\.meta\.resolve)\s*\(/u.test(
      loaderSource,
    )
  )
    return { reason: "runtime module resolution" };
  if (/\bprocess\.(?:cwd|chdir)\s*\(/u.test(source)) return { reason: "checkout-dependent code" };
  if (
    /^(?:scripts|config)\//u.test(file) &&
    /\b(?:process\s*(?:\[|\.(?!(?:platform|arch|versions)\b))|fetch\s*\()/u.test(source)
  )
    return { reason: "ambient tooling inputs" };
  // jsdom has no native Worker or AudioWorklet. This factory uses the recorded URL,
  // and the renderer tests that exercise the worklet clients mock addModule.
  const workerSource =
    workerUrl &&
    file === "src/renderer/lib/highlight-pool.tsx" &&
    staticRequests.includes(workerUrl)
      ? source.replace(
          /\bnew Worker\(highlightWorkerUrl, \{ type: "module", name: profile\.name \}\)/gu,
          "",
        )
      : source;
  if (/\b(?:Worker|SharedWorker)\s*\(/u.test(workerSource)) return { reason: "worker script" };
  return {
    staticRequests,
    workerUrl: workerUrl && requests.includes(workerUrl) ? workerUrl : undefined,
  };
}

export function sourceReason(file: string, source: string, rendererJsdom = false) {
  return scriptFile(file) ? inspectSource(file, source, rendererJsdom).reason : undefined;
}

export function virtualModuleReason(id: string) {
  return (id.startsWith("\0") || id.startsWith("virtual:")) && !lockedVirtualModules.has(id)
    ? "virtual module"
    : undefined;
}

export interface TestEvidence {
  readonly file: string;
  readonly passed: boolean;
  readonly deps?: readonly string[];
  readonly reason?: string;
  readonly input?: string;
  readonly durationMs?: number;
}

interface RecordedProject {
  readonly modules: readonly string[];
  readonly files: Record<string, readonly number[] | undefined>;
  readonly globalSetup?: readonly number[];
}

function fullyPassed(module: TestModule) {
  if (module.state() !== "passed") return false;
  const tests = [...module.children.allTests()];
  return (
    tests.length > 0 &&
    [...module.children.allSuites()].every((suite) => suite.state() === "passed") &&
    tests.every((test) => {
      const diagnostic = test.diagnostic();
      return test.result().state === "passed" && diagnostic?.retryCount === 0 && !diagnostic.flaky;
    })
  );
}

const cleanId = (id: string) => id.split(/[?#]/u, 1)[0];
const dependencyPackage = (id: string) => /(?:^|\/)node_modules\//u.test(id);
const nativeArtifact = (id: string) => /\.(?:node|dylib|dll|so)$/u.test(cleanId(id));

/** Worker records already supply the dynamic imports evaluated by this file. */
export function graphInputs(
  imports: Iterable<{ id: string | null; url: string }>,
  transform: { deps?: readonly string[]; dynamicDeps?: readonly string[] } | null,
  expandsGlob: boolean,
) {
  const eager = new Set(transform?.deps);
  const lazy = new Set(expandsGlob ? [] : transform?.dynamicDeps);
  return [...imports].flatMap(({ id, url }) =>
    id && (!lazy.has(url) || eager.has(url)) ? [id] : [],
  );
}

export function dependencyReader(
  root: string,
  workspace: ReadonlySet<string>,
  rendererJsdom = false,
) {
  const inspected = new Map<string, Promise<SourceInputs>>();
  const modules = new Map<EnvironmentModuleNode, Promise<{ edges: string[]; reason?: string }>>();
  const staticEdges = new Map<DevEnvironment, Map<string, Promise<(string | undefined)[]>>>();
  const checkSource = (file: string): Promise<SourceInputs> => {
    const existing = inspected.get(file);
    if (existing) return existing;
    const pending = scriptFile(file)
      ? readFile(path.join(root, file), "utf8")
          .then((source) => ({
            ...inspectSource(file, source, rendererJsdom),
            customEnvironment: /@(?:vitest|jest)-environment\s+(?!jsdom\b)/u.test(source),
            expandsGlob: /\bimport\s*\.\s*meta\s*\.\s*glob\b/u.test(source),
          }))
          .catch(() => ({ reason: "unreadable module" }))
      : Promise.resolve({});
    inspected.set(file, pending);
    return pending;
  };

  function workerEdges(environment: DevEnvironment, importer: string, requests: readonly string[]) {
    let byImporter = staticEdges.get(environment);
    if (!byImporter) {
      byImporter = new Map();
      staticEdges.set(environment, byImporter);
    }
    const existing = byImporter.get(importer);
    if (existing) return existing;
    const pending = Promise.all(
      requests.map(async (request) => {
        if (isBuiltin(request)) return request;
        const resolved = await environment.pluginContainer
          .resolveId(request, importer)
          .catch(() => null);
        return resolved?.id;
      }),
    );
    byImporter.set(importer, pending);
    return pending;
  }

  function graphEdges(
    environment: DevEnvironment,
    node: EnvironmentModuleNode,
    expandsGlob: boolean,
  ) {
    const existing = modules.get(node);
    if (existing) return existing;
    const pending = (async () => {
      const edges = graphInputs(node.importedModules, node.transformResult, expandsGlob);
      if (!node.id) return { edges };
      // The pinned Vitest keeps mock targets in the transform result, including
      // restored FS module-cache entries. Resolve them like its related walker.
      const transformed = node.transformResult as typeof node.transformResult & {
        __vitestStaticMocks?: readonly { specifier: string }[] | null;
      };
      const mocks =
        transformed?.__vitestStaticMocks ??
        (environment.pluginContainer.getModuleInfo(node.id)?.meta?.vitestStaticMocks as
          | readonly { specifier: string }[]
          | undefined);
      for (const { specifier } of mocks ?? []) {
        const reason = builtinReason(specifier);
        if (reason) return { edges, reason };
        const resolved = await environment.pluginContainer
          .resolveId(specifier, node.id)
          .catch(() => null);
        if (resolved) edges.push(resolved.id);
        else return { edges, reason: "unresolved mock target" };
      }
      return { edges };
    })();
    modules.set(node, pending);
    return pending;
  }

  return async (
    module: TestModule,
    project: RecordedProject | undefined,
  ): Promise<TestEvidence> => {
    const file = module.relativeModuleId;
    if (!fullyPassed(module)) return { file, passed: false, reason: "incomplete pass" };
    const spec = module.toTestSpecification();
    const recorded = project?.files[file];
    const environment = module.viteEnvironment;
    if (!recorded || !environment) return { file, passed: true, reason: "missing module graph" };
    const deps = new Set<string>();
    const workerInputs = new Set<string>();
    const ids = new Set([
      module.moduleId,
      ...spec.project.config.setupFiles,
      ...[...recorded, ...(project.globalSetup ?? [])].map((index) =>
        path.resolve(root, project.modules[index]),
      ),
    ]);
    // A conventional external snapshot is also an input when present. The
    // workspace topology covers creation or deletion of an absent snapshot.
    const snapshot = path.posix.join(
      path.posix.dirname(file),
      "__snapshots__",
      path.posix.basename(file) + ".snap",
    );
    if (workspace.has(snapshot)) deps.add(snapshot);
    for (const id of ids) {
      const reason = builtinReason(id);
      if (reason || nativeArtifact(id))
        return { file, passed: true, reason: reason ?? "native artifact" };
      const virtual = virtualModuleReason(id);
      if (virtual) return { file, passed: true, reason: virtual, input: id };
      // Pure builtins have no workspace file. Node's version is in the global key.
      if (lockedVirtualModules.has(id) || dependencyPackage(id) || isBuiltin(id)) continue;
      const absolute = id.startsWith("file:") ? fileURLToPath(cleanId(id)) : cleanId(id);
      const input = relativeInput(root, absolute);
      if (!input || !workspace.has(input))
        return {
          file,
          passed: true,
          reason: "untracked module path",
          input: relativeInput(root, absolute) ?? id,
        };
      deps.add(input);
      const source = await checkSource(input);
      if (source.reason) return { file, passed: true, reason: source.reason, input };
      if (source.workerUrl) {
        // Queue the plain entry separately from its Vite ?worker&url wrapper.
        const [entry] = await workerEdges(environment, absolute, [cleanId(source.workerUrl)]);
        if (!entry || !workspace.has(relativeInput(root, entry) ?? ""))
          return { file, passed: true, reason: "unresolved worker entry", input };
        workerInputs.add(entry);
      }
      const nodes = new Set(environment.moduleGraph.getModulesByFile(absolute));
      const node = environment.moduleGraph.getModuleById(id);
      if (node) nodes.add(node);
      for (const imported of nodes) {
        const { edges, reason: unsafe } = await graphEdges(
          environment,
          imported,
          source.expandsGlob === true,
        );
        if (unsafe) return { file, passed: true, reason: unsafe };
        for (const edge of edges) ids.add(edge);
      }
    }
    if (workerInputs.size > 0 && (await checkSource(file)).customEnvironment)
      return { file, passed: true, reason: "custom worker environment" };
    // Vite only loaded the URL wrapper. Resolve the worker's static imports
    // even if Vite never transformed its source as a script.
    for (const id of workerInputs) {
      const reason = builtinReason(id) ?? virtualModuleReason(id);
      if (reason || nativeArtifact(id))
        return { file, passed: true, reason: reason ?? "native artifact", input: id };
      if (lockedVirtualModules.has(id) || dependencyPackage(id) || isBuiltin(id)) continue;
      const input = relativeInput(root, cleanId(id));
      if (id !== cleanId(id) || !input || !workspace.has(input))
        return { file, passed: true, reason: "untracked worker input", input: id };
      deps.add(input);
      const source = await checkSource(input);
      if (source.reason || source.workerUrl || source.expandsGlob)
        return { file, passed: true, reason: source.reason ?? "opaque worker input", input };
      const edges = await workerEdges(environment, id, source.staticRequests ?? []);
      for (const edge of edges) {
        if (!edge) return { file, passed: true, reason: "unresolved worker import", input };
        workerInputs.add(edge);
      }
    }
    return { file, passed: true, deps: [...deps].sort() };
  };
}

export async function recordedProjects(cacheDir: string) {
  const contents = await readFile(path.join(cacheDir, "dependencies.json"), "utf8").catch(
    () => undefined,
  );
  if (!contents) return {};
  const report = JSON.parse(contents) as {
    version: number;
    projects: Record<string, RecordedProject>;
  };
  return report.version === 1 ? report.projects : {};
}
