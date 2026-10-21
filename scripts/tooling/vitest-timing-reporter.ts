import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Reporter, TestModule } from "vite-plus/test/node";

/** Enforce settled React interactions and optionally retain public Vitest diagnostics. */
export default class TimingReporter implements Reporter {
  private readonly reactActWarnings: string[] = [];

  onTestRunStart() {
    this.reactActWarnings.length = 0;
  }

  onUserConsoleLog(log: Parameters<NonNullable<Reporter["onUserConsoleLog"]>>[0]) {
    if (
      /not wrapped in act\(|not configured to support act\(|overlapping act\(\) calls|act\(async \(\) => \.\.\.\) without await|`act` call was not awaited/u.test(
        log.content,
      )
    ) {
      this.reactActWarnings.push(log.content);
    }
  }

  constructor(private readonly options: { directory?: string; suite: string }) {}

  async onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string) {
    await this.writeReport(modules, errors, reason);
    if (this.reactActWarnings.length) {
      // The usual cause of this one: Testing Library turns act off while a findBy*/waitFor polls.
      const hint = this.reactActWarnings.some((warning) =>
        /not configured to support act\(/u.test(warning),
      )
        ? " An awaited findBy* or waitFor inside act(...) runs with act turned off; find the element first, then act."
        : "";
      throw new Error(
        `React act warnings invalidate this test run; fix the interaction boundary.${hint}`,
      );
    }
  }

  private async writeReport(
    modules: readonly TestModule[],
    errors: readonly unknown[],
    reason: string,
  ) {
    const { directory } = this.options;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const files = modules.map((module) => ({
      path: module.relativeModuleId,
      state: module.state(),
      diagnostics: module.diagnostic(),
      tests: [...module.children.allTests()].map((test) => ({
        name: test.fullName,
        state: test.result().state,
      })),
    }));
    const states = files.flatMap((file) => file.tests.map((test) => test.state));
    const slowestFiles = [...files]
      .sort((a, b) => b.diagnostics.duration - a.diagnostics.duration)
      .slice(0, 10)
      .map((file) => ({ path: file.path, testBodyMs: file.diagnostics.duration }));
    const report = {
      version: 2,
      suite: this.options.suite,
      runtime: process.versions.electron ? "electron" : "node",
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      reason,
      unhandledErrors: errors.length,
      reactActWarnings: this.reactActWarnings,
      files,
      summary: {
        collectedFiles: files.length,
        passed: states.filter((state) => state === "passed").length,
        failed: states.filter((state) => state === "failed").length,
        skipped: states.filter((state) => state === "skipped").length,
        pending: states.filter((state) => state === "pending").length,
        slowestFiles,
      },
    };
    await writeFile(
      path.join(directory, this.options.suite + "-" + process.pid + ".json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
