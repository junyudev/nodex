import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  createRuntimeWorkLedger,
  type RuntimeWorkLedger,
} from "../../shared/diagnostics/runtime-work";
import type { CoreModules } from "../core-runtime/CoreModules";
import {
  approximateJsonPayloadBytes,
  isDevRuntimeMetricsEnabled,
  logDevRuntimeMetric,
} from "../dev-runtime-metrics";

/** One log line per navigation or stream batch: a work reports after this much quiet. */
const RUNTIME_WORK_SETTLE_MS = 1_000;

/**
 * Main's Runtime conversation work tallies. Present only with development runtime metrics, so
 * every counting site is a single null check otherwise; tests provide their own ledger.
 */
export const AgentRuntimeWorkLedger = Context.Reference<RuntimeWorkLedger | null>(
  "nodex/main/agent-runtime/AgentRuntimeWorkLedger",
  {
    defaultValue: () =>
      isDevRuntimeMetricsEnabled()
        ? createRuntimeWorkLedger({
            settleMs: RUNTIME_WORK_SETTLE_MS,
            onSettled: (work, metrics) =>
              logDevRuntimeMetric("agent-runtime.work", { work, metrics }),
          })
        : null,
  },
);

/**
 * The work a window request belongs to, as `w<window>-<work id>`. Runtime requests, Core reads
 * and the observation a request opens are counted under it.
 */
export const AgentRuntimeWorkId = Context.Reference<string | null>(
  "nodex/main/agent-runtime/AgentRuntimeWorkId",
  { defaultValue: () => null },
);

export const windowRuntimeWorkId = (windowId: number, workId: string) => `w${windowId}-${workId}`;

/** Counts each Workspace read with its response size under the current work. */
export function countingCoreReads(
  core: CoreModules["Service"],
  ledger: RuntimeWorkLedger,
): CoreModules["Service"] {
  return {
    ...core,
    workspace: {
      ...core.workspace,
      read: (read, options, projectId) =>
        Effect.flatMap(AgentRuntimeWorkId, (work) =>
          work === null
            ? core.workspace.read(read, options, projectId)
            : core.workspace
                .read(read, options, projectId)
                .pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() =>
                      ledger.record(
                        work,
                        `core.read:${read.kind}`,
                        Exit.isSuccess(exit) ? (approximateJsonPayloadBytes(exit.value) ?? 0) : 0,
                      ),
                    ),
                  ),
                ),
        ),
    },
  };
}
