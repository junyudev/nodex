import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, type Reporter, type TestProject, type Vitest } from "vite-plus/test/node";
import { parseTestSuite, suiteConfig } from "../../config/test-suites.ts";
import { testObservation } from "../../config/vitest-observation.ts";
import { dependencyReader, fullyPassed } from "./test-cache-graph.ts";
import type { TestEvidence } from "./test-cache-evidence.ts";
import { identifyVitestTransformCaches } from "./test-observation-transform-cache.ts";
import type { TestObservation } from "./test-observation.mts";
import { relativeInput } from "./test-cache-policy.ts";
import { portablePath } from "./test-cache-inputs.ts";
import { prioritizeTests, runSelectedTestFiles } from "./cache-test-order.ts";

async function readObservations(directory: string | undefined) {
  const observations = new Map<string, TestObservation | undefined>();
  if (!directory) return observations;
  const files = await readdir(directory).catch(() => []);
  const parsed = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(await readFile(path.join(directory, file), "utf8")) as TestObservation,
      ),
  );
  for (const observation of parsed) {
    observations.set(
      observation.file,
      observation.version === 2 && !observations.has(observation.file) ? observation : undefined,
    );
  }
  return observations;
}

function withObservation(
  root: string,
  entry: TestEvidence,
  observation: TestObservation | undefined,
): TestEvidence {
  if (!observation) return { ...entry, reason: entry.reason ?? "missing runtime observation" };
  const exclusions = Object.entries(observation.unobservable).map(([reason, details]) => ({
    reason,
    input: details[0],
  }));
  if (exclusions.length) return { ...entry, exclusions };
  if (!entry.deps || !entry.local) return entry;
  if (!observation.reads.every(portablePath)) return { ...entry, reason: "invalid observed path" };
  return {
    ...entry,
    deps: [...new Set([...entry.deps, ...observation.reads])].sort(),
    broadTopology: entry.broadTopology || observation.nativeResolution,
    local: {
      ...entry.local,
      observed: [...observation.pathEvidence, ...observation.listings],
      ...(observation.missingModuleCandidates.length
        ? {
            // CJS can search directories above the checkout and in the user's
            // global package locations. Reuse the proof only from this checkout.
            missingModules: { root, candidates: observation.missingModuleCandidates },
          }
        : {}),
    },
  };
}

// The pinned Vitest expands the persisted dependency manifest with plugin graph
// edges. Capture each worker's report before that expansion so a lazy import
// cannot be mistaken for a watched file or inherited from another test.
function captureWorkerDependencies(cache: Vitest["cache"]) {
  const files = new Map<TestProject, Map<string, readonly string[]>>();
  const recorder = (
    cache as typeof cache & {
      _dependencies?: {
        record(project: TestProject, file: string, ids: readonly string[]): void;
      };
    }
  )._dependencies;
  if (typeof recorder?.record === "function") {
    recorder.record = (project, file, ids) => {
      let projectFiles = files.get(project);
      if (!projectFiles) files.set(project, (projectFiles = new Map()));
      projectFiles.set(file, ids);
    };
  }
  return files;
}

export async function runCacheBatch(
  root: string,
  directory: string,
  {
    config,
    reporters,
    observe = true,
  }: {
    config: string;
    observe?: boolean;
    reporters: readonly (string | Reporter | [string, Record<string, unknown>])[];
  },
) {
  const {
    files,
    workspace,
    priority = [],
  } = JSON.parse(await readFile(path.join(directory, "batch.json"), "utf8")) as {
    files: string[];
    workspace: string[];
    priority?: string[];
  };
  const evidence: TestEvidence[] = [];
  const cacheDir = path.join(directory, "vite");
  let dependencies: ReturnType<typeof captureWorkerDependencies> | undefined;
  const recorder: Reporter = {
    onInit(context) {
      if (observe) identifyVitestTransformCaches(context);
      dependencies = captureWorkerDependencies(context.cache);
    },
    async onTestRunEnd(modules, errors, reason) {
      if (errors.length > 0 || reason === "interrupted") return;
      const inputs = new Set(workspace);
      const readDependencies = dependencyReader(root, inputs);
      const earlyObservations = observe
        ? await readObservations(process.env.NODEX_TEST_OBSERVATIONS)
        : undefined;
      for (const module of modules) {
        const file = relativeInput(root, module.moduleId) ?? module.relativeModuleId;
        const {
          environmentSetupDuration,
          prepareDuration,
          setupDuration,
          collectDuration,
          duration,
        } = module.diagnostic();
        const durationMs =
          environmentSetupDuration + prepareDuration + setupDuration + collectDuration + duration;
        const observation = earlyObservations?.get(file);
        if (observation && Object.keys(observation.unobservable).length) {
          evidence.push({ file, passed: fullyPassed(module), durationMs });
          continue;
        }
        const project = module.toTestSpecification().project;
        evidence.push({
          ...(await readDependencies(module, dependencies?.get(project)?.get(module.moduleId))),
          durationMs,
        });
      }
    },
  };

  const runner = await createVitest(
    {
      config,
      watch: false,
      allowOnly: false,
      // Share disk-backed transforms across isolated workers in this batch only.
      // An older batch can have different resolution or glob inputs.
      fsModuleCache: true,
      fsModuleCachePath: path.join(directory, "transforms-" + randomUUID()),
      experimental: { recordDependencies: true },
      ...(priority.length ? { sequence: { sequencer: prioritizeTests(root, priority) } } : {}),
      reporters: [...reporters, recorder],
    },
    { cacheDir },
  );
  try {
    await runSelectedTestFiles(runner, root, files);
  } finally {
    await runner.close();
  }
  if (!observe) return evidence;
  const observations = await readObservations(process.env.NODEX_TEST_OBSERVATIONS);
  return evidence.map((entry) => withObservation(root, entry, observations.get(entry.file)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [name, directory] = process.argv.slice(2);
  if (!name || !directory) throw new Error("Expected suite and batch directory.");
  const suite = parseTestSuite(name);
  const evidence = await runCacheBatch(process.cwd(), directory, {
    config: suiteConfig(suite),
    reporters: testObservation(suite).reporters,
  });
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence));
}
