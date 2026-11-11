import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, type Reporter } from "vite-plus/test/node";
import { suiteConfig } from "../../config/test-suites.ts";
import { testObservation } from "../../config/vitest-observation.ts";
import { dependencyReader, recordedProjects, type TestEvidence } from "./test-cache-graph.ts";
import { canCacheFile, isCacheSuite } from "./test-cache-policy.ts";

const [suite, directory] = process.argv.slice(2);
if (!suite || !isCacheSuite(suite) || !directory)
  throw new Error("Expected suite and batch directory.");
const root = process.cwd();
const { files, workspace } = JSON.parse(
  await readFile(path.join(directory, "batch.json"), "utf8"),
) as {
  files: string[];
  workspace: string[];
};
const evidence: TestEvidence[] = [];
const cacheDir = path.join(directory, "vite");
let recordedDirectory = cacheDir;
const recorder: Reporter = {
  onInit(context) {
    recordedDirectory = context.viteConfig.cacheDir;
  },
  async onTestRunEnd(modules, errors, reason) {
    if (errors.length > 0 || reason === "interrupted") return;
    const projects = await recordedProjects(recordedDirectory);
    const readDependencies = dependencyReader(root, new Set(workspace));
    for (const module of modules) {
      const file = module.relativeModuleId;
      if (!canCacheFile(suite, file)) {
        evidence.push({ file, passed: module.state() === "passed", reason: "path policy" });
        continue;
      }
      evidence.push(
        await readDependencies(module, projects[module.toTestSpecification().project.name]),
      );
    }
  },
};

const runner = await createVitest(
  {
    config: suiteConfig(suite),
    watch: false,
    allowOnly: false,
    experimental: { recordDependencies: true },
    reporters: [...testObservation(suite).reporters, recorder],
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
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence));
} finally {
  await runner.close();
}
