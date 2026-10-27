import type { LoggerEvent, PluginOptions } from "babel-plugin-react-compiler";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import type { Plugin, TransformResult } from "vite";

const compilerPackage: { readonly version: string } = createRequire(import.meta.url)(
  "babel-plugin-react-compiler/package.json",
);

/** Compile application source, keeping fixtures and dependencies outside this boundary. */
export function isRendererCompilerSource(filename: string, root = process.cwd()): boolean {
  const source = relative(resolve(root, "src/renderer"), filename.split("?")[0]).replaceAll(
    "\\",
    "/",
  );
  if (source.startsWith("../") || source === ".." || source.startsWith("/")) return false;
  if (!/\.[cm]?[jt]sx?$/.test(source)) return false;
  if (/(?:^|\/)(?:test|tests|fixtures|__tests__|__fixtures__)(?:\/|$)/.test(source)) return false;
  return !/\.(?:test|spec|stories|test-fixtures|fixture)\./.test(source);
}

/** The public compiler logger includes class instances; persist only their diagnostic fields. */
export function projectCompilerEvent(event: LoggerEvent) {
  switch (event.kind) {
    case "CompileSuccess":
      return {
        kind: event.kind,
        fnLoc: event.fnLoc,
        fnName: event.fnName,
        memoSlots: event.memoSlots,
        memoBlocks: event.memoBlocks,
        memoValues: event.memoValues,
        prunedMemoBlocks: event.prunedMemoBlocks,
        prunedMemoValues: event.prunedMemoValues,
      };
    case "CompileError":
    case "CompileDiagnostic":
      return {
        kind: event.kind,
        fnLoc: event.fnLoc,
        reason: event.detail.reason,
        description: event.detail.description,
        category: event.detail.category,
        loc: event.kind === "CompileError" ? event.detail.primaryLocation() : event.detail.loc,
      };
    case "CompileSkip":
      return { kind: event.kind, fnLoc: event.fnLoc, reason: event.reason, loc: event.loc };
    case "PipelineError":
      return { kind: event.kind, fnLoc: event.fnLoc, reason: event.data };
    case "Timing":
      return {
        kind: event.kind,
        name: event.measurement.name,
        duration: event.measurement.duration,
      };
    case "AutoDepsDecorations":
    case "AutoDepsEligible":
      return { kind: event.kind, fnLoc: event.fnLoc };
  }
}

type CompilerFileCoverage = {
  sourceSha256: string;
  transform: "client" | "ssr";
  cache?: "hit" | "miss";
  events: Array<ReturnType<typeof projectCompilerEvent>>;
};

/** Include the entire toolchain and owning configuration in the development cache identity. */
function compilerConfigurationIdentity(root: string): string {
  const hash = createHash("sha256").update(process.version).update(compilerPackage.version);
  for (const path of [
    "pnpm-lock.yaml",
    "config/renderer-react-compiler.ts",
    "config/renderer-vite-shared.ts",
  ]) {
    hash.update(path);
    try {
      hash.update(readFileSync(resolve(root, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return hash.digest("hex");
}

interface CachedCompilerTransform {
  readonly identity: string;
  readonly result: TransformResult;
  readonly events: CompilerFileCoverage["events"];
}

/** Observe the same Vite pipeline that serves and builds the renderer; never transform twice. */
export function createRendererCompilerIntegration(root = process.cwd()) {
  const files = new Map<string, CompilerFileCoverage>();
  const ssrFiles = new Map<string, CompilerFileCoverage>();
  let command: "build" | "serve" = "serve";
  let mode = "development";
  let cacheEnabled = false;
  let cacheIdentity = "";
  const cacheDirectory = resolve(root, ".generated/react-compiler/cache");
  const sourceKey = (filename: string) =>
    relative(root, filename.split("?")[0]).replaceAll("\\", "/");
  const options = {
    compilationMode: "infer",
    target: "19",
    noEmit: false,
    sources: (filename) => isRendererCompilerSource(filename, root),
    logger: {
      logEvent(filename, event) {
        if (!filename || !isRendererCompilerSource(filename, root)) return;
        files.get(sourceKey(filename))?.events.push(projectCompilerEvent(event));
      },
    },
  } satisfies PluginOptions;

  const coverage: Plugin = {
    name: "nodex:renderer-compiler-coverage",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
      mode = config.mode;
      cacheEnabled = command === "serve";
      cacheIdentity = `${compilerConfigurationIdentity(root)}:${mode}:${config.isProduction}`;
    },
    transform(code, id, transformOptions) {
      if (!isRendererCompilerSource(id, root)) return;
      const ssr = transformOptions?.ssr === true;
      (ssr ? ssrFiles : files).set(sourceKey(id), {
        sourceSha256: createHash("sha256").update(code).digest("hex"),
        transform: ssr ? "ssr" : "client",
        events: [],
      });
    },
    closeBundle() {
      if (files.size === 0 && ssrFiles.size === 0) return;
      const orderedFiles = Object.fromEntries(
        [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      const counts: Partial<Record<LoggerEvent["kind"], number>> = {};
      for (const file of files.values()) {
        for (const event of file.events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
      }
      const directory = resolve(root, ".generated/react-compiler");
      mkdirSync(directory, { recursive: true });
      const report =
        JSON.stringify(
          {
            compilerVersion: compilerPackage.version,
            target: options.target,
            compilationMode: options.compilationMode,
            noEmit: options.noEmit,
            command,
            mode,
            processId: process.pid,
            counts,
            files: orderedFiles,
            ssrFiles: Object.fromEntries(
              [...ssrFiles.entries()].sort(([a], [b]) => a.localeCompare(b)),
            ),
          },
          null,
          2,
        ) + "\n";
      const name = `${command}-${mode.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
      writeFileSync(resolve(directory, `${name}.json`), report);
      // Concurrent test servers may share a mode; retain each process's actual coverage.
      writeFileSync(resolve(directory, `${name}-${process.pid}.json`), report);
    },
  };

  /** Cache only Babel's compiler pass; Vite still performs native JSX, Refresh and import analysis. */
  function cacheTransform(plugin: Plugin): Plugin {
    if (!plugin.transform) return plugin;
    const transformHook = plugin.transform;
    const transform = typeof transformHook === "function" ? transformHook : transformHook.handler;
    const handler: typeof transform = async function (code, id, transformOptions) {
      const file = files.get(sourceKey(id));
      if (!cacheEnabled || transformOptions?.ssr || !file || !isRendererCompilerSource(id, root))
        return transform.call(this, code, id, transformOptions);

      const identity = createHash("sha256")
        .update(cacheIdentity)
        .update(id)
        .update(code)
        .digest("hex");
      const path = resolve(cacheDirectory, `${createHash("sha256").update(id).digest("hex")}.json`);
      try {
        const cached = JSON.parse(await readFile(path, "utf8")) as CachedCompilerTransform;
        if (
          cached.identity === identity &&
          cached.result &&
          typeof cached.result === "object" &&
          "code" in cached.result &&
          typeof cached.result.code === "string" &&
          Array.isArray(cached.events)
        ) {
          file.cache = "hit";
          file.events = cached.events;
          return cached.result;
        }
      } catch {
        // A missing or interrupted local cache must never prevent source compilation.
      }

      file.cache = "miss";
      const result = await transform.call(this, code, id, transformOptions);
      if (!result) return result;
      try {
        await mkdir(cacheDirectory, { recursive: true });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify({ identity, result, events: file.events }));
        await rename(temporaryPath, path);
      } catch {
        // Compilation remains authoritative when the development cache is unavailable.
      }
      return result;
    };
    // Babel updates this hook's native filter when Vite resolves its configuration.
    // Keep the hook object so caching cannot detach that filter update.
    if (typeof transformHook === "function") plugin.transform = handler;
    else transformHook.handler = handler;
    return plugin;
  }

  return { options, coverage, cacheTransform };
}
