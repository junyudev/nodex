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

export function sourceReason(file: string, source: string): string | undefined {
  if (!/\.[cm]?[jt]sx?$/u.test(file)) return undefined;
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) return "unparsed module";
  const { staticImports, staticExports, dynamicImports } = parsed.module;
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
    if (!literal) return "computed import";
    requests.push(literal[2]);
  }
  for (const request of requests) {
    const reason = builtinReason(request);
    if (reason) return reason;
    if (/^https?:/u.test(request) || /[?&](?:shared)?worker(?:[&=]|$)/u.test(request))
      return "external execution";
  }
  if (
    /\b(?:require|createRequire|process\.(?:getBuiltinModule|dlopen)|import\.meta\.resolve)\s*\(/u.test(
      source,
    )
  )
    return "runtime module resolution";
  if (/\bprocess\.(?:cwd|chdir)\s*\(/u.test(source)) return "checkout-dependent code";
  // A worker script is loaded outside the module graph, so its content is not a recorded input.
  // Network clients are not excluded: a response is not a checkout input, and a test can only
  // reach a server of its own through the Node builtins rejected above.
  if (/\b(?:Worker|SharedWorker)\s*\(/u.test(source)) return "worker script";
  return undefined;
}

export interface TestEvidence {
  readonly file: string;
  readonly passed: boolean;
  readonly deps?: readonly string[];
  readonly reason?: string;
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

export function dependencyReader(root: string, workspace: ReadonlySet<string>) {
  const inspected = new Map<string, Promise<{ reason?: string; expandsGlob: boolean }>>();
  const modules = new Map<EnvironmentModuleNode, Promise<{ edges: string[]; reason?: string }>>();
  const checkSource = (file: string): Promise<{ reason?: string; expandsGlob: boolean }> => {
    const existing = inspected.get(file);
    if (existing) return existing;
    const pending = /\.[cm]?[jt]sx?$/u.test(file)
      ? readFile(path.join(root, file), "utf8")
          .then((source) => ({
            reason: sourceReason(file, source),
            expandsGlob: /\bimport\s*\.\s*meta\s*\.\s*glob\b/u.test(source),
          }))
          .catch(() => ({ reason: "unreadable module", expandsGlob: false }))
      : Promise.resolve({ expandsGlob: false });
    inspected.set(file, pending);
    return pending;
  };

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
      if (dependencyPackage(id)) continue;
      if (id.startsWith("\0") || id.startsWith("virtual:"))
        return { file, passed: true, reason: "virtual module" };
      const absolute = id.startsWith("file:") ? fileURLToPath(cleanId(id)) : cleanId(id);
      const input = relativeInput(root, absolute);
      if (!input || !workspace.has(input))
        return { file, passed: true, reason: "untracked module path" };
      deps.add(input);
      const { reason: source, expandsGlob } = await checkSource(input);
      if (source) return { file, passed: true, reason: source };
      const nodes = new Set(environment.moduleGraph.getModulesByFile(absolute));
      const node = environment.moduleGraph.getModuleById(id);
      if (node) nodes.add(node);
      for (const imported of nodes) {
        const { edges, reason: unsafe } = await graphEdges(environment, imported, expandsGlob);
        if (unsafe) return { file, passed: true, reason: unsafe };
        for (const edge of edges) ids.add(edge);
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
