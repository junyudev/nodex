import { TestRunner, type RunnerTestFile } from "vite-plus/test";

export default class TestObservationRunner extends TestRunner {
  override onAfterRunFiles(files: RunnerTestFile[]) {
    super.onAfterRunFiles(files);
    if (files.length !== 1) return;
    const require = process.getBuiltinModule("module")!.createRequire(import.meta.url);
    const recorder = require("./test-observation.mts") as typeof import("./test-observation.mts");
    recorder.endTestObservation(files[0].filepath);
  }
}
