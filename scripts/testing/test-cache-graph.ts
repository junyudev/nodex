import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor, type ParseResult } from "oxc-parser";
import type { DevEnvironment, EnvironmentModuleNode } from "vite-plus";
import type { TestModule } from "vite-plus/test/node";
import {
  cleanId,
  localInputReader,
  resolutionProbes,
  simpleGlob,
  workspaceExportReader,
  type PathState,
  type LocalInputs,
} from "./test-cache-inputs.ts";
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
  readonly workerUrl?: string;
  readonly staticRequests?: readonly string[];
  readonly dynamicRequests?: readonly string[];
  readonly globs?: readonly string[];
  readonly customEnvironment?: boolean;
}

function readGlobs(file: string, parsed: ParseResult) {
  const patterns: string[] = [];
  let unsupported = false;
  new Visitor({
    CallExpression(call) {
      const { callee, arguments: args } = call;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.object.type !== "MetaProperty" ||
        callee.object.meta.name !== "import" ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "glob"
      )
        return;
      const [pattern, options] = args;
      if (
        pattern?.type !== "Literal" ||
        typeof pattern.value !== "string" ||
        (options &&
          (options.type !== "ObjectExpression" ||
            options.properties.some(
              (property) =>
                property.type !== "Property" ||
                property.computed ||
                property.key.type !== "Identifier" ||
                !["eager", "import", "query"].includes(property.key.name),
            ))) ||
        args.length > 2
      ) {
        unsupported = true;
        return;
      }
      const value = pattern.value;
      const resolved = value.startsWith("/")
        ? value.slice(1)
        : /^\.\.?\//u.test(value)
          ? path.posix.join(path.posix.dirname(file), value)
          : "";
      if (simpleGlob(resolved)) patterns.push(resolved);
      else unsupported = true;
    },
  }).visit(parsed.program);
  return unsupported ? undefined : patterns;
}

function literalImports(source: string, imports: ParseResult["module"]["dynamicImports"]) {
  const requests: string[] = [];
  for (const {
    moduleRequest: { start, end },
  } of imports) {
    const literal = /^(['"`])([^'"`$\\]+)\1$/u.exec(source.slice(start, end).trim());
    if (!literal) return undefined;
    requests.push(literal[2]);
  }
  return requests;
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
  const dynamicRequests = literalImports(source, dynamicImports);
  if (!dynamicRequests) return { reason: "computed import" };
  for (const request of [...requests, ...dynamicRequests]) {
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
  const globs = parsed.module.importMetas.length > 0 ? readGlobs(file, parsed) : [];
  if (!globs) return { reason: "unsupported glob" };
  return {
    staticRequests,
    dynamicRequests,
    workerUrl: workerUrl && staticRequests.includes(workerUrl) ? workerUrl : undefined,
    globs: globs.length > 0 ? globs : undefined,
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
  readonly local?: Omit<LocalInputs, "topology">;
  readonly broadTopology?: boolean;
  readonly reason?: string;
  readonly input?: string;
  readonly durationMs?: number;
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

const dependencyPackage = (id: string) => /(?:^|\/)node_modules\//u.test(id);
const nativeArtifact = (id: string) => /\.(?:node|dylib|dll|so)$/u.test(cleanId(id));

/** Worker records supply evaluated lazy imports. Keep static imports and watched inputs. */
export function graphInputs(
  imports: Iterable<{ id: string | null; url: string }>,
  eagerImports: readonly string[],
  lazyImports: readonly string[],
) {
  // Import analysis adds ?import to resource URLs before the module graph normalizes them.
  const identity = (id: string) => id.replace(/([?&])import(?:&|$)/u, "$1").replace(/[?&]$/u, "");
  const eager = new Set(eagerImports.map(identity));
  const lazy = new Set(lazyImports.map(identity));
  return [...imports].flatMap(({ id, url }) => {
    if (!id) return [];
    const names = [identity(id), identity(url)];
    return names.some((name) => lazy.has(name)) && !names.some((name) => eager.has(name))
      ? []
      : [id];
  });
}

export function dependencyReader(
  root: string,
  workspace: ReadonlySet<string>,
  rendererJsdom = false,
) {
  const paths = localInputReader(root);
  const workspaceExport = workspaceExportReader(root, workspace);
  const inspected = new Map<string, Promise<SourceInputs>>();
  const modules = new Map<
    EnvironmentModuleNode,
    Promise<{ edges: string[]; mocks?: readonly StaticMock[]; reason?: string }>
  >();
  const resolutions = new Map<DevEnvironment, Map<string, Promise<string | undefined>>>();
  const imports = new Map<
    DevEnvironment,
    Map<
      string,
      Promise<{
        probes: LocalInputs["probes"];
        broadTopology: boolean;
      }>
    >
  >();
  const checkSource = (file: string): Promise<SourceInputs> => {
    const existing = inspected.get(file);
    if (existing) return existing;
    const pending = scriptFile(file)
      ? readFile(path.join(root, file), "utf8")
          .then((source) => ({
            ...inspectSource(file, source, rendererJsdom),
            customEnvironment: /@(?:vitest|jest)-environment\s+(?!jsdom\b)/u.test(source),
          }))
          .catch(() => ({ reason: "unreadable module" }))
      : Promise.resolve({});
    inspected.set(file, pending);
    return pending;
  };

  function resolve(environment: DevEnvironment, importer: string, request: string) {
    if (isBuiltin(request)) return Promise.resolve(request);
    let resolved = resolutions.get(environment);
    if (!resolved) resolutions.set(environment, (resolved = new Map()));
    const key = JSON.stringify([importer, request]);
    const existing = resolved.get(key);
    if (existing) return existing;
    const pending = environment.pluginContainer
      .resolveId(request, importer)
      .then((result) => result?.id)
      .catch(() => undefined);
    resolved.set(key, pending);
    return pending;
  }

  function importInputs(
    environment: DevEnvironment,
    importer: string,
    requests: readonly string[],
  ) {
    let files = imports.get(environment);
    if (!files) imports.set(environment, (files = new Map()));
    const key = JSON.stringify([importer, requests]);
    const existing = files.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const probes: Record<string, PathState> = {};
      let broadTopology = false;
      for (const request of requests) {
        if (isBuiltin(request)) continue;
        const resolved = await resolve(environment, importer, request);
        const bare = /^(?:@[\w.-]+\/)?[\w][\w./-]*$/u.test(request);
        // Bare requests that stay in the install are covered by its locked identity.
        if (bare && resolved && (dependencyPackage(resolved) || resolved === request)) continue;
        const target = resolved && relativeInput(root, cleanId(resolved));
        if (
          bare &&
          target &&
          (await workspaceExport(request, target)) &&
          (await paths.state(target)) === "file"
        ) {
          probes[target] = "file";
          continue;
        }
        const extensions = environment.config.resolve.extensions;
        const evidence =
          resolved && !environment.config.resolve.tsconfigPaths
            ? await resolutionProbes(root, importer, request, resolved, extensions, paths)
            : undefined;
        if (evidence) Object.assign(probes, evidence);
        else broadTopology = true;
      }
      return { probes, broadTopology };
    })();
    files.set(key, pending);
    return pending;
  }

  interface StaticMock {
    specifier: string;
    automock?: boolean;
  }

  function graphEdges(
    environment: DevEnvironment,
    node: EnvironmentModuleNode,
    source: SourceInputs,
  ) {
    const existing = modules.get(node);
    if (existing) return existing;
    const pending = (async () => {
      const transform = node.transformResult;
      const eager = [...(transform?.deps ?? [])];
      const lazy = [...(transform?.dynamicDeps ?? [])];
      if (node.id && source.dynamicRequests?.length) {
        const importer = node.id;
        const resolveRequests = (requests: readonly string[]) =>
          Promise.all(requests.map((request) => resolve(environment, importer, request)));
        const [statics, dynamics] = await Promise.all([
          resolveRequests(source.staticRequests ?? []),
          resolveRequests(source.dynamicRequests),
        ]);
        eager.push(...statics.filter((id) => id !== undefined));
        lazy.push(...dynamics.filter((id) => id !== undefined));
      }
      // Client transforms lack dynamicDeps and glob expansion creates additional
      // dynamic imports. Read the final URLs as well as source resolution IDs.
      if (node.id && transform && !transform.ssr && node.importedModules.size > 0) {
        const parsed = parseSync("transform.js", transform.code);
        if (parsed.errors.length > 0) return { edges: [], reason: "unparsed transform" };
        const { dynamicImports, staticImports, staticExports } = parsed.module;
        const requests = literalImports(transform.code, dynamicImports);
        if (!requests) return { edges: [], reason: "computed transformed import" };
        lazy.push(...requests);
        eager.push(...staticImports.map(({ moduleRequest }) => moduleRequest.value));
        for (const { entries } of staticExports) {
          for (const { moduleRequest } of entries) {
            if (moduleRequest) eager.push(moduleRequest.value);
          }
        }
      }
      const edges = graphInputs(node.importedModules, eager, lazy);
      if (!node.id) return { edges };
      // The pinned Vitest keeps mock targets in the transform result, including
      // restored FS module-cache entries. Resolve them like its related walker.
      const transformed = node.transformResult as typeof node.transformResult & {
        __vitestStaticMocks?: readonly StaticMock[] | null;
      };
      const mocks =
        transformed?.__vitestStaticMocks ??
        (environment.pluginContainer.getModuleInfo(node.id)?.meta?.vitestStaticMocks as
          | readonly StaticMock[]
          | undefined);
      for (const { specifier } of mocks ?? []) {
        const reason = builtinReason(specifier);
        if (reason) return { edges, reason };
        const resolved = await resolve(environment, node.id, specifier);
        if (resolved) edges.push(resolved);
        else return { edges, reason: "unresolved mock target" };
      }
      return { edges, mocks };
    })();
    modules.set(node, pending);
    return pending;
  }

  return async (
    module: TestModule,
    recorded: readonly string[] | undefined,
    globalSetup?: readonly string[],
  ): Promise<TestEvidence> => {
    const file = module.relativeModuleId;
    if (!fullyPassed(module)) return { file, passed: false, reason: "incomplete pass" };
    const spec = module.toTestSpecification();
    const environment = module.viteEnvironment;
    if (!recorded || !environment || (spec.project.config.globalSetup?.length && !globalSetup))
      return { file, passed: true, reason: "missing module graph" };
    const deps = new Set<string>();
    const probes: Record<string, PathState> = {};
    const globs: Record<string, readonly string[]> = {};
    // Enabled CSS preprocessing can resolve additional paths through its own resolver.
    const css = spec.project.config.css;
    let broadTopology =
      css === true ||
      Boolean(css && css.include && (!Array.isArray(css.include) || css.include.length > 0));
    const recordImports = async (importer: string, requests: readonly string[]) => {
      if (requests.length === 0) return;
      const evidence = await importInputs(environment, importer, requests);
      Object.assign(probes, evidence.probes);
      broadTopology ||= evidence.broadTopology;
    };
    const workerInputs = new Set<string>();
    const ids = new Set([
      module.moduleId,
      ...spec.project.config.setupFiles,
      ...recorded,
      ...(globalSetup ?? []),
    ]);
    if (
      spec.project.config.snapshotOptions?.resolveSnapshotPath ||
      spec.project.config.snapshotEnvironment
    )
      return { file, passed: true, reason: "custom snapshot path" };
    const snapshot = path.posix.join(
      path.posix.dirname(file),
      "__snapshots__",
      path.posix.basename(file) + ".snap",
    );
    const snapshotState = await paths.state(snapshot);
    if (snapshotState === "file") deps.add(snapshot);
    else if (snapshotState === "absent") probes[snapshot] = snapshotState;
    else return { file, passed: true, reason: "untracked snapshot", input: snapshot };
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
      await recordImports(absolute, [
        ...(source.staticRequests ?? []),
        ...(source.dynamicRequests ?? []),
      ]);
      for (const pattern of source.globs ?? []) {
        const matched = await paths.glob(pattern);
        if (!matched) return { file, passed: true, reason: "untracked glob", input: pattern };
        globs[pattern] = matched;
      }
      if (source.workerUrl) {
        // Queue the plain entry separately from its Vite ?worker&url wrapper.
        const entry = await resolve(environment, absolute, cleanId(source.workerUrl));
        await recordImports(absolute, [cleanId(source.workerUrl)]);
        if (!entry || !workspace.has(relativeInput(root, entry) ?? ""))
          return { file, passed: true, reason: "unresolved worker entry", input };
        workerInputs.add(entry);
      }
      const nodes = new Set(environment.moduleGraph.getModulesByFile(absolute));
      const node = environment.moduleGraph.getModuleById(id);
      if (node) nodes.add(node);
      for (const imported of nodes) {
        const { edges, mocks, reason: unsafe } = await graphEdges(environment, imported, source);
        if (unsafe) return { file, passed: true, reason: unsafe };
        await recordImports(absolute, mocks?.map(({ specifier }) => specifier) ?? []);
        // Automocks can pick up new manual mocks through Vitest's own resolver.
        broadTopology ||= mocks?.some(({ automock }) => automock) ?? false;
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
      if (source.reason || source.workerUrl || source.globs)
        return { file, passed: true, reason: source.reason ?? "opaque worker input", input };
      const requests = source.staticRequests ?? [];
      await recordImports(id, requests);
      for (const request of requests) {
        const edge = await resolve(environment, id, request);
        if (!edge) return { file, passed: true, reason: "unresolved worker import", input };
        workerInputs.add(edge);
      }
    }
    return { file, passed: true, deps: [...deps].sort(), local: { probes, globs }, broadTopology };
  };
}
