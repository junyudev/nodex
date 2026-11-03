import type { NodePath, PluginObj, types as t } from "@babel/core";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "vite";
import {
  createRendererCompilerBabelPlugin,
  createRendererCompilerOptions,
  isRendererCompilerSource,
  rendererCompilerSourceRoot,
} from "../../config/renderer-react-compiler";
import {
  compareBaseline,
  finishRatchet,
  followBaselineRenames,
  parseRatchetArguments,
  readBaseline,
  type CountBaseline,
} from "./count-ratchet";

const baselinePath = "scripts/ci/react-compiler-baseline.json";
const functionKey = (loc: t.SourceLocation | null | undefined) =>
  loc ? `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}` : "<module>";

function functionName(fn: NodePath<t.Function>): string {
  if ((fn.isFunctionDeclaration() || fn.isFunctionExpression()) && fn.node.id)
    return fn.node.id.name;
  const owner = fn.findParent(
    (parent) =>
      parent.isVariableDeclarator() || parent.isExportDefaultDeclaration() || parent.isFunction(),
  );
  if (owner?.isVariableDeclarator() && owner.node.id.type === "Identifier")
    return owner.node.id.name;
  if (owner?.isExportDefaultDeclaration()) return "default";
  return "<anonymous>";
}

type FailureEvent = Extract<
  LoggerEvent,
  {
    kind: "CompileError" | "PipelineError";
  }
>;

interface UncompiledFunction {
  readonly file: string;
  readonly name: string;
  readonly events: readonly FailureEvent[];
}

/** Run the production client Babel hook, without Vite bundling or the development transform cache. */
export async function collectRendererCompilerFailures(root = process.cwd()) {
  const filenames = readdirSync(rendererCompilerSourceRoot(root), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(entry.parentPath, entry.name))
    .filter((filename) => isRendererCompilerSource(filename, root))
    .sort();
  let events: LoggerEvent[] = [];
  const names = new Map<string, string>();
  // Error events have a function location but no name. Observe the original AST before compilation.
  const observer: PluginObj = {
    visitor: {},
    pre(file) {
      file.path.traverse({
        Function(fn) {
          names.set(functionKey(fn.node.loc), functionName(fn));
        },
      });
    },
  };
  const options = createRendererCompilerOptions(root, {
    logEvent(filename, event) {
      if (filename && isRendererCompilerSource(filename, root)) events.push(event);
    },
  });
  const plugin = await createRendererCompilerBabelPlugin(root, options, [() => observer]);
  const config = await resolveConfig(
    { root, configFile: false, logLevel: "silent", plugins: [plugin] },
    "build",
    "production",
  );
  const hook = plugin.transform;
  if (!plugin.applyToEnvironment || !hook)
    throw new Error("Missing renderer compiler Babel hooks.");
  const environment = { name: "client", config: config.environments.client };
  await Reflect.apply(plugin.applyToEnvironment, {}, [environment]);
  const context = {
    environment,
    error(error: unknown): never {
      throw new Error("Renderer compiler transform failed.", { cause: error });
    },
  };
  const failures: UncompiledFunction[] = [];
  const counts: CountBaseline = {};
  let compiled = 0;
  for (const filename of filenames) {
    events = [];
    names.clear();
    try {
      await Reflect.apply(typeof hook === "function" ? hook : hook.handler, context, [
        readFileSync(filename, "utf8"),
        filename,
        { ssr: false },
      ]);
    } catch (error) {
      throw new Error(
        `Cannot check React Compiler coverage for ${path.relative(root, filename)}.`,
        { cause: error },
      );
    }
    const successes = new Set(
      events
        .filter((event) => event.kind === "CompileSuccess")
        .map((event) => functionKey(event.fnLoc)),
    );
    compiled += successes.size;
    const grouped = new Map<string, FailureEvent[]>();
    for (const event of events) {
      if (event.kind !== "CompileError" && event.kind !== "PipelineError") continue;
      const key = functionKey(event.fnLoc);
      // The compiler can log diagnostics before a successful retry. Count only actual bailouts.
      if (successes.has(key)) continue;
      const previous = grouped.get(key) ?? [];
      previous.push(event);
      grouped.set(key, previous);
    }
    if (grouped.size === 0) continue;
    const file = path.relative(root, filename).split(path.sep).join("/");
    counts[file] = { uncompiled: grouped.size };
    for (const [key, diagnostics] of grouped)
      failures.push({ file, name: names.get(key) ?? key, events: diagnostics });
  }
  return { counts, failures, compiled, files: filenames.length };
}

function printFailure({ file, name, events }: UncompiledFunction): void {
  for (const event of events) {
    const loc = event.kind === "CompileError" ? event.detail.primaryLocation() : event.fnLoc;
    const start = loc && typeof loc === "object" ? loc.start : event.fnLoc?.start;
    const category = event.kind === "CompileError" ? event.detail.category : "PipelineError";
    const reason = event.kind === "CompileError" ? event.detail.reason : event.data;
    console.error(
      `${file}:${start?.line ?? 1}:${(start?.column ?? 0) + 1} React Compiler ${category} (${name}): ${reason}`,
    );
    if (event.kind === "CompileError" && event.detail.description)
      console.error(`  ${event.detail.description}`);
  }
}

async function main(): Promise<number> {
  const options = parseRatchetArguments(process.argv.slice(2), "react-compiler-ratchet.ts");
  const baseline = followBaselineRenames(readBaseline(baselinePath, options));
  const { counts, failures, compiled, files } = await collectRendererCompilerFailures();
  const comparison = compareBaseline(counts, baseline);
  for (const failure of failures) {
    if (options.all || comparison.regressions.some(({ file }) => file === failure.file))
      printFailure(failure);
  }
  console.log(`React Compiler checked ${files} renderer sources: ${compiled} compiled functions.`);
  return finishRatchet({
    counts,
    comparison,
    options,
    baselinePath,
    unit: "uncompiled functions",
    forbiddenMessage:
      "New uncompiled renderer functions are forbidden. Move unsupported syntax into plain helpers or fix the compiler diagnostic.",
    updateCommand: "vp run react-compiler:baseline",
    updatedLabel: "React Compiler baseline updated",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
