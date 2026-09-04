import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Reporter, TestModule } from "vite-plus/test/node";

/** Store public Vitest diagnostics with their original, non-additive timing semantics. */
export default class TimingReporter implements Reporter {
  constructor(private readonly options: { directory: string; suite: string }) {}

  async onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    await mkdir(this.options.directory, { recursive: true });
    const report = {
      version: 1,
      suite: this.options.suite,
      runtime: process.versions.electron ? "electron" : "node",
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      reason,
      unhandledErrors: errors.length,
      files: modules.map((module) => ({
        path: module.relativeModuleId,
        state: module.state(),
        diagnostics: module.diagnostic(),
        tests: [...module.children.allTests()].map((test) => ({
          name: test.fullName,
          state: test.result().state,
        })),
      })),
    };
    await writeFile(
      path.join(this.options.directory, this.options.suite + "-" + process.pid + ".json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
