import { performance } from "node:perf_hooks";
import { isDevelopmentFeatureEnabled } from "../shared/development-features";
import { getLogger } from "./logging/logger";
import { codexPeerMetrics } from "./platform/node/CodexPeerMetrics";

type DevRuntimeMetricFields = Record<string, unknown>;

const devRuntimeMetricLogger = getLogger({
  subsystem: "diagnostics",
  component: "dev-runtime-metrics",
});

export function isDevRuntimeMetricsEnabled(): boolean {
  return isDevelopmentFeatureEnabled("runtime-metrics");
}

export function getDevRuntimeMetricStart(): number {
  return performance.now();
}

export function getDevRuntimeMetricDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function approximateJsonPayloadBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

export function logDevRuntimeMetric(metric: string, fields: DevRuntimeMetricFields = {}): void {
  if (!isDevRuntimeMetricsEnabled()) return;
  devRuntimeMetricLogger.info("dev runtime metric", {
    metric,
    ...fields,
    ...codexPeerMetrics.snapshot(),
  });
}
