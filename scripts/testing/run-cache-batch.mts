import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, type Reporter, type TestProject, type Vitest } from "vite-plus/test/node";
import { suiteConfig } from "../../config/test-suites.ts";
import { testObservation } from "../../config/vitest-observation.ts";
import { dependencyReader, type TestEvidence } from "./test-cache-graph.ts";
import { canCacheFile, isCacheSuite, type CacheSuite } from "./test-cache-policy.ts";

// The pinned Vitest expands the persisted dependency manifest with plugin graph
// edges. Capture each worker's report before that expansion so a lazy import
// cannot be mistaken for a watched file or inherited from another test.
function captureWorkerDependencies(cache: Vitest["cache"]) {
  const files = new Map<TestProject, Map<string, readonly string[]>>();
  const globalSetup = new Map<TestProject, readonly string[]>();
  const recorder = (
    cache as typeof cache & {
      _dependencies?: {
        record(project: TestProject, file: string, ids: readonly string[]): void;
        recordGlobalSetup(project: TestProject, ids: readonly string[]): void;
      };
    }
  )._dependencies;
  if (typeof recorder?.record === "function" && typeof recorder.recordGlobalSetup === "function") {
    recorder.record = (project, file, ids) => {
      let projectFiles = files.get(project);
      if (!projectFiles) files.set(project, (projectFiles = new Map()));
      projectFiles.set(file, ids);
    };
    recorder.recordGlobalSetup = (project, ids) => {
      globalSetup.set(project, ids);
    };
  }
  return { files, globalSetup };
}

export async function runCacheBatch(
  suite: CacheSuite,
  root: string,
  directory: string,
  {
    config,
    reporters,
  }: {
    config: string;
    reporters: readonly (string | Reporter | [string, Record<string, unknown>])[];
  },
) {
  const { files, workspace } = JSON.parse(
    await readFile(path.join(directory, "batch.json"), "utf8"),
  ) as {
    files: string[];
    workspace: string[];
  };
  const evidence: TestEvidence[] = [];
  const cacheDir = path.join(directory, "vite");
  let dependencies: ReturnType<typeof captureWorkerDependencies> | undefined;
  const recorder: Reporter = {
    onInit(context) {
      dependencies = captureWorkerDependencies(context.cache);
    },
    async onTestRunEnd(modules, errors, reason) {
      if (errors.length > 0 || reason === "interrupted") return;
      const inputs = new Set(workspace);
      const readDependencies = dependencyReader(root, inputs);
      const readRendererJsdomDependencies = dependencyReader(root, inputs, true);
      for (const module of modules) {
        const file = module.relativeModuleId;
        const {
          environmentSetupDuration,
          prepareDuration,
          setupDuration,
          collectDuration,
          duration,
        } = module.diagnostic();
        const durationMs =
          environmentSetupDuration + prepareDuration + setupDuration + collectDuration + duration;
        if (!canCacheFile(suite, file)) {
          evidence.push({
            file,
            passed: module.state() === "passed",
            reason: "path policy",
            durationMs,
          });
          continue;
        }
        const project = module.toTestSpecification().project;
        const read =
          suite === "renderer" &&
          project.config.environment === "jsdom" &&
          !("Worker" in globalThis || "AudioWorkletNode" in globalThis)
            ? readRendererJsdomDependencies
            : readDependencies;
        evidence.push({
          ...(await read(
            module,
            dependencies?.files.get(project)?.get(module.moduleId),
            dependencies?.globalSetup.get(project),
          )),
          durationMs,
        });
      }
    },
  };

  const runner = await createVitest(
    {
      config,
      root,
      watch: false,
      allowOnly: false,
      // Persisted transforms can retain a previous resolution or glob expansion
      // even when the importer bytes are unchanged.
      fsModuleCache: false,
      experimental: { recordDependencies: true },
      reporters: [...reporters, recorder],
    },
    { cacheDir },
  );
  try {
    const selected = new Set(files.map((file) => path.resolve(root, file)));
    await runner.standalone();
    const specifications = (await runner.globTestSpecifications()).filter((spec) =>
      selected.has(spec.moduleId),
    );
    if (specifications.length !== selected.size)
      throw new Error("Test selection changed during cache lookup.");
    await runner.runTestSpecifications(specifications);
    return evidence;
  } finally {
    await runner.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [suite, directory] = process.argv.slice(2);
  if (!suite || !isCacheSuite(suite) || !directory)
    throw new Error("Expected suite and batch directory.");
  const evidence = await runCacheBatch(suite, process.cwd(), directory, {
    config: suiteConfig(suite),
    reporters: testObservation(suite).reporters,
  });
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence));
}
