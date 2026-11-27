import { TestRunner, type RunnerTestFile, type WorkerGlobalState } from "vite-plus/test";

const workerState = () =>
  (globalThis as typeof globalThis & { __vitest_worker__?: WorkerGlobalState }).__vitest_worker__;

// Vitest can execute the original under a synthetic mock ID (automock) or a query variant.
const moduleFile = (id: string) => id.replace(/^mock:/u, "").split(/[?#]/u, 1)[0];

export default class TestObservationRunner extends TestRunner {
  private modulesBeforeFile: readonly string[] | undefined;

  onBeforeCollect() {
    const worker = workerState();
    const modules = worker?.evaluatedModules?.idToModuleMap;
    this.modulesBeforeFile = modules && [...modules.keys()];
  }

  override onAfterRunFiles(files: RunnerTestFile[]) {
    super.onAfterRunFiles(files);
    if (files.length !== 1) return;
    const file = files[0].filepath;
    const require = process.getBuiltinModule("module")!.createRequire(import.meta.url);
    const recorder = require("./test-observation.mts") as typeof import("./test-observation.mts");
    recorder.endTestObservation(file, this.mockOnlyModuleIds(file));
  }

  private mockOnlyModuleIds(file: string) {
    const worker = workerState();
    const modules = worker?.evaluatedModules?.idToModuleMap;
    const requests = worker?.dependencies;
    if (
      worker?.filepath !== file ||
      worker.ctx.files.length !== 1 ||
      !this.modulesBeforeFile ||
      !modules ||
      !requests ||
      worker.resolvingModules?.size !== 0
    )
      return undefined;

    // A custom environment can load modules with a separate runner before this file.
    if (worker.ctx.environment.name !== "node" && worker.ctx.environment.name !== "jsdom")
      return undefined;

    // The pinned runner adds real requests (including importOriginal) before evaluating them.
    // Its later dependency closure also includes mock placeholders. Only that combination
    // proves a mock target did not execute, even if vi.resetModules invalidated the graph.
    const loadedFiles = new Set([...this.modulesBeforeFile, ...requests].map(moduleFile));
    return [...modules.values()].flatMap(({ id, evaluated, meta }) =>
      evaluated === false &&
      meta &&
      "mockedModule" in meta &&
      meta.mockedModule === true &&
      !loadedFiles.has(moduleFile(id))
        ? [id]
        : [],
    );
  }
}
