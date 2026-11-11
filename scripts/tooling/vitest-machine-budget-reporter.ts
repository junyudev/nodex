import type { Reporter, TestSpecification, Vitest } from "vite-plus/test/node";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import {
  acquireMachineBudget,
  machineBudgetCapacity,
  type BudgetLease,
  type BudgetRequest,
} from "./machine-budget.ts";

export interface VitestRunShape {
  readonly files: number;
  readonly maxWorkers: number;
  readonly runtime: "node" | "dom" | "browser";
  readonly stress: boolean;
  readonly cores: number;
}

/** Peak resident memory of one worker, from sampled runs of each suite. */
const WORKER_MEMORY_GIB = { node: 0.5, dom: 1, browser: 2 } as const;

/** What a run keeps busy: one core per worker it can actually start, plus their memory. */
export function vitestRunClaim(run: VitestRunShape): Pick<BudgetRequest, "weight" | "memoryGiB"> {
  // Vitest resolves a serial suite to one worker.
  const workers = Math.min(run.maxWorkers, run.files);
  // A browser worker is a Chromium page plus the Vite server that feeds it.
  const weight = run.runtime === "browser" ? workers * 2 : workers;
  return {
    // Stress files measure scale and timing, so they keep half the computer to themselves.
    weight: run.stress ? Math.max(weight, Math.ceil(run.cores / 2)) : weight,
    // One more worker's worth for the Vitest process and its transform cache.
    memoryGiB: (workers + 1) * WORKER_MEMORY_GIB[run.runtime],
  };
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
        ...vitestRunClaim({
          files,
          maxWorkers: config.maxWorkers,
          runtime: config.browser.enabled
            ? "browser"
            : config.environment === "node"
              ? "node"
              : "dom",
          stress: resolveVitestTestTier() === "stress",
          cores: capacity.cores,
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
