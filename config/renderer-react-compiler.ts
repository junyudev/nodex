import type { LoggerEvent, PluginOptions } from "babel-plugin-react-compiler";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import type { Plugin } from "vite";

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
  events: Array<ReturnType<typeof projectCompilerEvent>>;
};

/** Observe the same Vite pipeline that serves and builds the renderer; never transform twice. */
export function createRendererCompilerIntegration(root = process.cwd()) {
  const files = new Map<string, CompilerFileCoverage>();
  const ssrFiles = new Map<string, CompilerFileCoverage>();
  let command: "build" | "serve" = "serve";
  let mode = "development";
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
    // The React plugin cannot infer this dependency from per-file Babel options.
    config: () => ({ optimizeDeps: { include: ["react/compiler-runtime"] } }),
    configResolved(config) {
      command = config.command;
      mode = config.mode;
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
  return { options, coverage };
}
