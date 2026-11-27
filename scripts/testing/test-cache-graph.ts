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
import type { TestEvidence } from "./test-cache-evidence.ts";
import { relativeInput } from "./test-cache-policy.ts";

// The pinned transform runtime supplies these helpers; unknown virtual modules lack a file identity.
const lockedVirtualModules = new Set(["\0@oxc-project+runtime@0.155.0/helpers/esm/usingCtx.js"]);

const scriptFile = (file: string) => /\.[cm]?[jt]sx?$/u.test(file);

interface SourceInputs {
  readonly reason?: string;
  readonly staticRequests?: readonly string[];
  readonly dynamicRequests?: readonly string[];
  readonly globs?: readonly string[];
}

export function readGlobs(file: string, parsed: ParseResult) {
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

export function literalImports(source: string, imports: ParseResult["module"]["dynamicImports"]) {
  const requests: string[] = [];
  for (const {
    moduleRequest: { start, end },
  } of imports) {
    const literal = /^(['"`])([^'"`$\\]+)\1$/u.exec(source.slice(start, end).trim());
    if (literal) requests.push(literal[2]);
  }
  return requests;
}

function inspectSource(file: string, source: string): SourceInputs {
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) return { reason: "unparsed module resolution" };
  const { staticImports, staticExports, dynamicImports, importMetas } = parsed.module;
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
  const globs = importMetas.length ? readGlobs(file, parsed) : [];
  // A Vite glob can change its expansion without changing any loaded module.
  if (!globs) return { reason: "unsupported glob" };
  return { staticRequests, dynamicRequests: literalImports(source, dynamicImports), globs };
}

export function virtualModuleReason(id: string) {
  return (id.startsWith("\0") || id.startsWith("virtual:")) && !lockedVirtualModules.has(id)
    ? "virtual module"
    : undefined;
}

export function fullyPassed(module: TestModule) {
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
const workerModule = (id: string) => /[?&](?:shared)?worker(?:[&=]|$)/u.test(id);

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

export function dependencyReader(root: string, workspace: ReadonlySet<string>) {
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
          .then((source) => inspectSource(file, source))
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
    mockOnlyModuleIds?: readonly string[],
  ): Promise<TestEvidence> => {
    const file = relativeInput(root, module.moduleId) ?? module.relativeModuleId;
    if (!fullyPassed(module)) return { file, passed: false, reason: "incomplete pass" };
    const spec = module.toTestSpecification();
    const environment = module.viteEnvironment;
    if (!recorded || !environment) return { file, passed: true, reason: "missing module graph" };
    // Global setup runs in the Vitest parent, outside the per-file recorder.
    if (spec.project.config.globalSetup?.length)
      return { file, passed: true, reason: "unobserved global setup" };
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
    const ids = new Set([module.moduleId, ...spec.project.config.setupFiles, ...recorded]);
    const mockOnly = new Set(mockOnlyModuleIds);
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
      if (id.startsWith("node:") || isBuiltin(id) || lockedVirtualModules.has(id)) continue;
      const virtual = virtualModuleReason(id);
      if (virtual) return { file, passed: true, reason: virtual, input: id };
      if (cleanId(id) === path.join(import.meta.dirname, "setup-test-observation.ts")) continue;
      // Installed modules are keyed by the locked install, except recorded native loads.
      if (dependencyPackage(id)) continue;
      // Loading native code from a transform can bypass the worker hooks.
      if (nativeArtifact(id)) return { file, passed: true, reason: "native module graph input" };
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
      const nodes = new Set(environment.moduleGraph.getModulesByFile(absolute));
      const node = environment.moduleGraph.getModuleById(id);
      if (node) nodes.add(node);
      for (const imported of nodes) {
        const { edges, mocks, reason: unsafe } = await graphEdges(environment, imported, source);
        if (unsafe) return { file, passed: true, reason: unsafe };
        await recordImports(absolute, mocks?.map(({ specifier }) => specifier) ?? []);
        // Automocks can pick up new manual mocks through Vitest's own resolver.
        broadTopology ||= mocks?.some(({ automock }) => automock) ?? false;
        // A shared transform can expose assets of an implementation only another test loaded.
        // Keep graph-only inputs when the worker cannot prove the implementation was replaced.
        const includeAssets = !imported.id || !mockOnly.has(imported.id);
        for (const edge of edges) {
          if (includeAssets && (!scriptFile(cleanId(edge)) || workerModule(edge))) ids.add(edge);
        }
        // Bundled worker URLs do not enumerate their build inputs in the SSR graph.
        if (imported.id && workerModule(imported.id)) {
          const watched = environment.pluginContainer.getModuleInfo(imported.id);
          if (!watched && imported.importedModules.size === 0)
            return { file, passed: true, reason: "missing worker build graph", input };
        }
      }
    }
    return { file, passed: true, deps: [...deps].sort(), local: { probes, globs }, broadTopology };
  };
}
