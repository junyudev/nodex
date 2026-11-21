import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  dynamicImportPreloads,
  eagerRequireSpecifiers,
  emittedModuleImports,
  rendererHtmlEntry,
  resolveEmittedSpecifier,
  staticClosure,
  type EmittedModuleImports,
} from "./emitted-module-graph";

export interface ByteTotal {
  readonly files: number;
  readonly bytes: number;
}

export interface OnDemandPackageViolation {
  readonly packageName: string;
  readonly file: string;
  readonly modules: number;
  /** The static import path from the Workbench root to the chunk that carries the package. */
  readonly chain: readonly string[];
}

export interface WorkbenchClosure {
  readonly root: string;
  readonly javaScript: ByteTotal;
  readonly css: ByteTotal;
  /** Every chunk that carries each on-demand package, wherever it is in the build. */
  readonly onDemandPackageFiles: ReadonlyMap<string, readonly string[]>;
  readonly violations: readonly OnDemandPackageViolation[];
}

export interface WorkbenchClosureOptions {
  readonly rendererDirectory: string;
  /** Rolldown names a dynamic root's chunk after its module, as `<name>-<hash>.js`. */
  readonly rootChunkName: string;
  readonly onDemandPackages: readonly string[];
}

/** The npm package that owns a bundled module path, or undefined for application source. */
function packageOwner(modulePath: string): string | undefined {
  const normalized = `/${modulePath.replaceAll("\\", "/")}`;
  const index = normalized.lastIndexOf("/node_modules/");
  if (index < 0) return undefined;
  const [scope, name] = normalized.slice(index + "/node_modules/".length).split("/");
  if (!scope) return undefined;
  return scope.startsWith("@") && name ? `${scope}/${name}` : scope;
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

/** Count bundled modules per npm package from a chunk's hidden source map. */
function sourceMapPackages(chunkPath: string): ReadonlyMap<string, number> | undefined {
  const mapPath = `${chunkPath}.map`;
  if (!existsSync(mapPath)) return undefined;
  const { sources } = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: unknown };
  if (!Array.isArray(sources)) throw new Error(`${mapPath} has no sources`);
  const owners = new Map<string, number>();
  for (const source of sources) {
    const owner = typeof source === "string" ? packageOwner(source) : undefined;
    if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1);
  }
  return owners;
}

/**
 * Measure what activating an ordinary Workbench loads: the application root that the
 * startup controller imports, every chunk it reaches through static imports, and the
 * stylesheets Vite preloads with that import. Package ownership comes from the hidden
 * production source maps, so a package is found however Rolldown names or merges its chunk.
 */
export function measureWorkbenchClosure(options: WorkbenchClosureOptions): WorkbenchClosure {
  const rendererDirectory = path.resolve(options.rendererDirectory);
  const relative = (file: string) => path.relative(rendererDirectory, file).replaceAll("\\", "/");
  const html = readFileSync(path.join(rendererDirectory, "index.html"), "utf8");
  const entrySpecifier = rendererHtmlEntry(html);
  if (!entrySpecifier) throw new Error("index.html has no module entry");
  const entry = path.resolve(rendererDirectory, entrySpecifier);

  const modules = new Map<string, EmittedModuleImports & { readonly bytes: number }>();
  const readModule = (file: string) => {
    const known = modules.get(file);
    if (known) return known;
    const source = readFileSync(file, "utf8");
    const parsed = { ...emittedModuleImports(file, source), bytes: Buffer.byteLength(source) };
    modules.set(file, parsed);
    return parsed;
  };
  const localImports = (file: string, specifiers: readonly string[]) =>
    specifiers.flatMap((specifier) => {
      const resolved = resolveEmittedSpecifier(file, specifier);
      return resolved ? [resolved] : [];
    });

  const rootPattern = new RegExp(
    `^${options.rootChunkName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-[\\w-]+\\.js$`,
    "u",
  );
  const roots = localImports(entry, readModule(entry).dynamicImports).filter((file) =>
    rootPattern.test(path.basename(file)),
  );
  if (roots.length !== 1) {
    throw new Error(
      `the renderer entry must dynamically import exactly one ${options.rootChunkName} chunk; found ${roots.length}`,
    );
  }
  const root = roots[0] as string;
  const closure = staticClosure([root], (file) =>
    localImports(file, readModule(file).staticImports),
  );

  const preloads = dynamicImportPreloads(entry, readFileSync(entry, "utf8"));
  const rootPreloads = [...preloads].find(
    ([specifier]) => resolveEmittedSpecifier(entry, specifier) === root,
  )?.[1];
  if (!rootPreloads)
    throw new Error(`${relative(entry)} imports ${relative(root)} without preloads`);
  const preloadedFiles = localImports(entry, rootPreloads);
  const preloadedJavaScript = new Set(preloadedFiles.filter((file) => file.endsWith(".js")));
  const staticJavaScript = new Set(closure.files.filter((file) => file !== entry));
  const unexplained = [
    ...[...preloadedJavaScript].filter((file) => !staticJavaScript.has(file)),
    ...[...staticJavaScript].filter((file) => !preloadedJavaScript.has(file)),
  ];
  if (unexplained.length > 0) {
    throw new Error(
      `Vite preloads and static imports of ${relative(root)} disagree: ${unexplained.map(relative).join(", ")}`,
    );
  }
  const stylesheets = preloadedFiles.filter((file) => file.endsWith(".css"));

  // Rolldown writes no map for a chunk without source modules, such as its runtime helpers
  // or a pure re-export. The root always has modules, so its map proves maps were written.
  if (!existsSync(`${root}.map`)) {
    throw new Error(`${relative(root)} has no source map; build the production renderer first`);
  }
  const onDemandPackages = new Set(options.onDemandPackages);
  const packageFiles = new Map<string, string[]>(
    options.onDemandPackages.map((name) => [name, []]),
  );
  const closureFiles = new Set(closure.files);
  const violations: OnDemandPackageViolation[] = [];
  for (const chunk of walkFiles(rendererDirectory).filter((file) => file.endsWith(".js"))) {
    for (const [packageName, count] of sourceMapPackages(chunk) ?? []) {
      if (!onDemandPackages.has(packageName)) continue;
      packageFiles.get(packageName)?.push(relative(chunk));
      if (closureFiles.has(chunk)) {
        violations.push({
          packageName,
          file: relative(chunk),
          modules: count,
          chain: closure.chain(chunk).map(relative),
        });
      }
    }
  }

  return {
    root: relative(root),
    javaScript: {
      files: closure.files.length,
      bytes: closure.files.reduce((total, file) => total + readModule(file).bytes, 0),
    },
    css: {
      files: stylesheets.length,
      bytes: stylesheets.reduce((total, file) => total + statSync(file).size, 0),
    },
    onDemandPackageFiles: new Map(
      [...packageFiles].map(([name, files]) => [name, files.sort()] as const),
    ),
    violations,
  };
}

/**
 * Measure the Main application code Electron evaluates before it can open the first window:
 * the bootstrap entry and every application chunk it requires while loading, recursively.
 * Requires inside functions run later, on demand, and stay outside the closure.
 */
export function measureMainPreWindowClosure(mainDirectory: string, entry: string): ByteTotal {
  const directory = path.resolve(mainDirectory);
  const sources = new Map<string, string>();
  const read = (file: string) => {
    const source = sources.get(file) ?? readFileSync(file, "utf8");
    sources.set(file, source);
    return source;
  };
  const closure = staticClosure([path.join(directory, entry)], (file) =>
    eagerRequireSpecifiers(file, read(file)).flatMap((specifier) => {
      const resolved = resolveEmittedSpecifier(file, specifier);
      return resolved ? [resolved] : [];
    }),
  );
  return {
    files: closure.files.length,
    bytes: closure.files.reduce((total, file) => total + Buffer.byteLength(read(file)), 0),
  };
}
