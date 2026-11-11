import type { Reporter, TestSpecification, Vitest } from "vite-plus/test/node";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { acquireMachineBudget, machineBudgetCapacity, type BudgetLease } from "./machine-budget.ts";

export interface VitestRunShape {
  readonly files: number;
  readonly maxWorkers: number;
  readonly browser: boolean;
  readonly stress: boolean;
  readonly capacity: number;
}

/** Cores a run keeps busy: one per worker it can actually start. */
export function vitestRunWeight(run: VitestRunShape): number {
  // Vitest resolves a serial suite to one worker.
  const workers = Math.min(run.maxWorkers, run.files);
  // A browser worker is a Chromium page plus the Vite server that feeds it.
  const weight = run.browser ? workers * 2 : workers;
  // Stress files measure scale and timing, so they keep half the computer to themselves.
  return run.stress ? Math.max(weight, Math.ceil(run.capacity / 2)) : weight;
}

/**
 * Holds this run's share of the computer from just before its first worker starts until the run
 * ends. Living in the Vitest config, it covers every way a suite is started.
 */
export default class MachineBudgetReporter implements Reporter {
  private vitest: Vitest | undefined;
  private lease: BudgetLease | undefined;

  constructor(private readonly options: { suite: string }) {}

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  async onTestRunStart(specifications: readonly TestSpecification[]) {
    this.lease?.release();
    this.lease = undefined;
    const capacity = machineBudgetCapacity(process.env);
    const config = this.vitest?.config;
    if (capacity === null || !config || specifications.length === 0) return;
    const files = specifications.length;
    this.lease = await acquireMachineBudget(
      {
        label: `${this.options.suite} tests (${files} ${files === 1 ? "file" : "files"})`,
        weight: vitestRunWeight({
          files,
          maxWorkers: config.maxWorkers,
          browser: config.browser.enabled,
          stress: resolveVitestTestTier() === "stress",
          capacity,
        }),
      },
      { env: process.env, cwd: config.root, capacity },
    );
  }

  onTestRunEnd() {
    this.lease?.release();
    this.lease = undefined;
  }
}
