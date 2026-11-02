import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { availableParallelism } from "node:os";
import { beforeEach } from "vite-plus/test";
import type { CoreScenarioInput } from "../scenarios/harness/core-scenario-harness";

type Phase = { readonly phase: string; readonly elapsedMs: number; readonly detail?: string };
type Sink = (phase: string, detail?: string) => void;
let currentSink: Sink | undefined;
let scenarioOrdinal = 0;

/** Capture once at operation entry: a late completion must retain its original test owner. */
export const captureCoreProbePhase = (): Sink => currentSink ?? (() => {});

/** Observation only: preserve existing startup/cancellation behavior for the ABBA comparison. */
export const coreProbeScenarioInput = (input: CoreScenarioInput): CoreScenarioInput => {
  const record = captureCoreProbePhase();
  const instance = ++scenarioOrdinal;
  return {
    ...input,
    onProgress: (progress) => {
      try { input.onProgress?.(progress); }
      finally { record(`scenario.${progress.phase}`, `${instance}:${input.scenarioId}:${progress.startupEvent?.kind ?? ""}`); }
    },
  };
};

if (process.env.NODEX_CORE_IO_PROBE === "1") {
  beforeEach(async (context) => {
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    const started = performance.now();
    const cpu = process.cpuUsage();
    const eventLoop = performance.eventLoopUtilization();
    const phases: Phase[] = [];
    let completed = false;
    let latePhases = 0;
    const record: Sink = (phase, detail) => {
      try {
        if (completed) {
          if (latePhases++ >= 4) return;
          console.error(`[core-worker-late-phase] ${JSON.stringify({
            pid: process.pid,
            caseId: context.task.id,
            phase,
            detail,
            elapsedMs: performance.now() - started,
          })}`);
          return;
        }
        phases.push({ phase, elapsedMs: performance.now() - started, detail });
        if (phases.length > 48) phases.shift();
      } catch { /* Advisory observation must not alter the fixture lifecycle. */ }
    };
    currentSink = record;
    const snapshot = (kind: "abort" | "finished") => {
      try {
        const usage = process.cpuUsage(cpu);
        console.error(`[core-worker-observation] ${JSON.stringify({
        version: 1,
        kind,
        round: process.env.NODEX_CORE_IO_PROBE_ROUND,
        at: new Date().toISOString(),
        pid: process.pid,
        availableParallelism: availableParallelism(),
        worker: process.env.VITEST_WORKER_ID,
        case: context.task.name,
        caseId: context.task.id,
        state: context.task.result?.state,
        elapsedMs: performance.now() - started,
        cpuUserUs: usage.user,
        cpuSystemUs: usage.system,
        eventLoop: performance.eventLoopUtilization(eventLoop),
        lagMaxMs: lag.max / 1e6,
        lagP99Ms: lag.percentile(99) / 1e6,
        phases,
        })}`);
      } catch { /* Retain test and cleanup outcomes even if reporting fails. */ }
    };
    const onAbort = () => snapshot("abort");
    context.signal.addEventListener("abort", onAbort, { once: true });
    context.onTestFinished(async () => {
      try {
        // Yield once so a timer blocked by the final synchronous section contributes its lag.
        await new Promise((resolve) => setTimeout(resolve, 1));
        snapshot("finished");
      } finally {
        completed = true;
        lag.disable();
        context.signal.removeEventListener("abort", onAbort);
        if (currentSink === record) currentSink = undefined;
      }
    });
    // Register cleanup before arming the monitor, including a timed-out beforeEach hook.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
