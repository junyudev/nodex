import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { isDevRuntimeMetricsEnabled, logDevRuntimeMetric } from "../dev-runtime-metrics";
import {
  ElectronProcesses,
  live as electronProcessesLive,
  type ElectronProcessKind,
} from "../platform/electron/ElectronProcesses";
import { ProcessTelemetry } from "../platform/node/ProcessTelemetry";
import { processRoles } from "../process-telemetry/process-roles";
import { coreHealth, eventLoopHealth, processGroupsFor, processHealth } from "./runtime-health";
import { MainStreamBursts } from "./stream-bursts";

type HealthResponse = components["schemas"]["HealthResponse"];
type Trigger = "interval" | "burst";

const REPORT_EVERY = "1 minute";
/** A burst is read over this short window, so its CPU and delay describe the burst itself. */
const BURST_WINDOW = "1 second";
const DELAY_RESOLUTION_MS = 10;

/**
 * With development runtime metrics on, logs one `runtime.health` reading a minute, and one more
 * when a Runtime stream bursts: Main's event-loop delay, CPU and memory for each
 * of Nodex's processes and the work they run, Core's queue waits, and restarts. Otherwise it
 * installs nothing.
 */
const monitor = Effect.gen(function* () {
  if (!isDevRuntimeMetricsEnabled()) return;
  const telemetry = yield* ProcessTelemetry;
  const electron = yield* ElectronProcesses;
  const core = yield* CoreSessionAccess;
  const bursts = yield* MainStreamBursts;
  const run = yield* FiberSet.makeRuntime<never, void, never>();

  const gone: Record<ElectronProcessKind, number> = { renderer: 0, gpu: 0, utility: 0, other: 0 };
  yield* electron.onGone((kind) => {
    gone[kind] += 1;
  });
  const corePids = new Set<number>();
  const histograms = new Set<ReturnType<typeof monitorEventLoopDelay>>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const histogram of histograms) histogram.disable();
    }),
  );
  const readCore = core
    .use("health", (client) => client.health())
    .pipe(Effect.option, Effect.map(Option.getOrNull));
  const sampleProcesses = (baseline: Trigger, corePid: number | null) =>
    Effect.gen(function* () {
      const family = processGroupsFor({
        mainPid: process.pid,
        corePid,
        agentRuntimePids: processRoles.pids("agent-runtime"),
        electron: yield* electron.list,
      });
      return yield* telemetry
        .sample({ baseline, maxAgeMs: 0, groups: family })
        .pipe(Effect.option, Effect.map(Option.getOrNull));
    });

  /** Measures from now until `finish`; `before` is Core's health at the start. */
  const open = (trigger: Trigger, before: HealthResponse | null) => {
    const delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
    delay.enable();
    histograms.add(delay);
    const startedAt = performance.now();
    return Effect.gen(function* () {
      delay.disable();
      histograms.delete(delay);
      const loop = eventLoopHealth(delay, DELAY_RESOLUTION_MS);
      const after = yield* readCore;
      if (after) corePids.add(after.pid);
      const processes = yield* sampleProcesses(trigger, after?.pid ?? null);
      logDevRuntimeMetric("runtime.health", {
        trigger,
        windowMs: Math.round(performance.now() - startedAt),
        eventLoop: loop,
        mainHeapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        processes: processes ? processHealth(processes.groups) : null,
        core: after
          ? coreHealth(after.metrics, before?.pid === after.pid ? before.metrics : null)
          : null,
        restarts: {
          core: Math.max(0, corePids.size - 1),
          agentRuntime: Math.max(0, processRoles.starts("agent-runtime") - 1),
          ...gone,
        },
      });
      return after;
    });
  };

  let bursting = false;
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      bursts?.onBurst(() => {
        if (bursting) return;
        bursting = true;
        run(
          Effect.gen(function* () {
            const before = yield* readCore;
            yield* sampleProcesses("burst", before?.pid ?? null);
            const finish = open("burst", before);
            yield* Effect.sleep(BURST_WINDOW);
            yield* finish;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                bursting = false;
              }),
            ),
          ),
        );
      }),
    ),
    (release) => Effect.sync(() => release?.()),
  );

  yield* Effect.gen(function* () {
    let before = yield* readCore;
    yield* sampleProcesses("interval", before?.pid ?? null);
    while (true) {
      const finish = open("interval", before);
      yield* Effect.sleep(REPORT_EVERY);
      before = yield* finish;
    }
  }).pipe(Effect.forkScoped);
});

export const live = Layer.effectDiscard(monitor).pipe(Layer.provide(electronProcessesLive));
