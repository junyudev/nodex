import type {
  CodexRequestLifecycleEvent,
  CodexRequestLifecyclePerformanceEvent,
  CodexRequestLifecycleTerminalEvent,
} from "../../../shared/codex-request-lifecycle";
import {
  isRendererTelemetryActive,
  logTelemetryEvent,
  type TelemetryMetadata,
} from "../../lib/statsig-telemetry";

const LATE_RESPONSE_WAIT_MS = 30_000;
const MAX_PENDING_TIMEOUTS = 100;

interface PendingTimeout {
  readonly event: CodexRequestLifecycleTerminalEvent;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

export interface CodexRequestAnalyticsOptions {
  readonly isEnabled?: () => boolean;
  readonly emit?: (
    eventName: string,
    value?: string | number,
    metadata?: TelemetryMetadata,
  ) => boolean;
}

function hostKind(hostId: string): string {
  if (hostId === "local") return "local";
  if (hostId === "durable") return "durable";
  if (hostId.startsWith("remote-control:")) return "remote-control";
  if (hostId.startsWith("remote-wsl:")) return "wsl";
  if (hostId.startsWith("remote-ssh")) return "ssh";
  return "remote";
}

function errorCode(error: unknown): number | undefined {
  if (error instanceof Error || typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const value = error.code;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < -2_147_483_648 ||
    value > 2_147_483_647
  )
    return undefined;
  return value;
}

function failureReason(event: CodexRequestLifecyclePerformanceEvent): string | undefined {
  if (event.type === "completed") return undefined;
  if (event.type === "background-queue-full") return event.type;
  if (event.type === "timed-out") return "timeout";
  if (event.error instanceof Error && event.error.name === "AbortError") return "canceled";
  if (typeof event.error === "object" && event.error !== null) {
    const value = event.error as { code?: unknown; reason?: unknown };
    if (typeof value.reason === "string" && value.reason) return value.reason;
    if (typeof value.code === "string" && value.code) return value.code;
    if (typeof value.code === "number") return String(value.code);
  }
  return "failed";
}

function traceParts(traceparent: string | null | undefined): {
  readonly traceId?: string;
  readonly spanId?: string;
} {
  if (!traceparent) return {};
  return {
    traceId: traceparent.slice(3, 35) || undefined,
    spanId: traceparent.slice(36, 52) || undefined,
  };
}

function metricsFor(event: CodexRequestLifecyclePerformanceEvent): TelemetryMetadata {
  const metrics = event.hostMetrics;
  const aborted =
    event.type === "failed" && event.error instanceof Error && event.error.name === "AbortError";
  const outcome = event.type === "completed" ? "success" : aborted ? "aborted" : "failure";
  return {
    durationMs: event.durationMs,
    endedAtMs: event.endedAtMs,
    outcome,
    reason: failureReason(event),
    ...traceParts(event.trace?.traceparent),
    method: event.method,
    source: event.source,
    hostKind: metrics?.hostKind ?? hostKind(event.hostId),
    transportKind: metrics?.transportKind,
    priority: event.priority,
    queueDurationMs: event.queueWaitMs,
    hostReadyWaitDurationMs: metrics?.hostReadyWaitDurationMs,
    hostRoundTripDurationMs: metrics?.hostRoundTripDurationMs,
    requestBytes: metrics?.requestBytes,
    responseBytes: metrics?.responseBytes,
    timeoutMs: event.timeoutMs,
    queuedRequestCountAtEnqueue: event.queuedRequestCountAtEnqueue,
    peakInFlightRequestCount: event.peakInFlightRequestCount,
    peakBackgroundInFlightRequestCount: event.peakBackgroundInFlightRequestCount,
    clientBusyPeriodPeakHostPendingRequestCount:
      metrics?.clientBusyPeriodPeakHostPendingRequestCount,
    incomingQueueDepth: metrics?.incomingQueueDepth,
    coalescedRequestCount: event.coalescedRequestCount,
    reconnectAttemptAtEnqueue: metrics?.reconnectAttemptAtEnqueue,
    errorCode: event.type === "failed" ? errorCode(event.error) : undefined,
    requestDurationMs: event.requestDurationMs,
    responseReceiveDurationMs: metrics?.responseReceiveDurationMs,
    largeInboundMessageOverlapMs: metrics?.largeInboundMessageOverlapMs,
    largeInboundBytesReceivedWhilePending: metrics?.largeInboundBytesReceivedWhilePending,
    largeInboundCompletedMessageBytesWhilePending:
      metrics?.largeInboundCompletedMessageBytesWhilePending,
    largeInboundMessageThresholdBytesWhilePending:
      metrics?.largeInboundMessageThresholdBytesWhilePending,
    serverNotificationDeliveryLagMs: metrics?.serverNotificationDeliveryLagMs,
    serverNotificationClockSkewBaselineMs: metrics?.serverNotificationClockSkewBaselineMs,
  };
}

export class CodexRequestAnalytics implements Disposable {
  private readonly pendingTimeouts = new Map<string | number, PendingTimeout>();
  private readonly isEnabled: () => boolean;
  private readonly emit: NonNullable<CodexRequestAnalyticsOptions["emit"]>;

  constructor(options: CodexRequestAnalyticsOptions = {}) {
    this.isEnabled = options.isEnabled ?? isRendererTelemetryActive;
    this.emit = options.emit ?? logTelemetryEvent;
  }

  handle(event: CodexRequestLifecycleEvent): void {
    if (event.type === "started") return;
    if (event.type === "late-response") {
      const pending = this.pendingTimeouts.get(event.id);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      this.pendingTimeouts.delete(event.id);
      this.record({ ...pending.event, hostMetrics: event.hostMetrics });
      return;
    }
    if (event.type === "background-queue-full") {
      this.record(event);
      return;
    }
    if (event.type !== "timed-out") {
      this.record(event);
      return;
    }
    if (!this.isEnabled()) return;
    if (this.pendingTimeouts.size >= MAX_PENDING_TIMEOUTS) {
      const oldest = this.pendingTimeouts.entries().next().value;
      if (oldest) {
        const [id, pending] = oldest;
        clearTimeout(pending.timeoutId);
        this.pendingTimeouts.delete(id);
        this.record(pending.event);
      }
    }
    const timeoutId = setTimeout(() => {
      this.pendingTimeouts.delete(event.id);
      this.record(event);
    }, LATE_RESPONSE_WAIT_MS);
    this.pendingTimeouts.set(event.id, { event, timeoutId });
  }

  private record(event: CodexRequestLifecyclePerformanceEvent): void {
    if (!this.isEnabled()) return;
    this.emit("app_server_request", undefined, metricsFor(event));
  }

  [Symbol.dispose](): void {
    for (const pending of this.pendingTimeouts.values()) clearTimeout(pending.timeoutId);
    this.pendingTimeouts.clear();
  }
}
