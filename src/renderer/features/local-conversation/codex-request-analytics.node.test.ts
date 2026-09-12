import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRequestMetrics } from "@nodex/effect-codex-app-server/protocol";
import type {
  CodexRequestLifecyclePerformanceEvent,
  CodexRequestLifecycleTerminalEvent,
} from "../../../shared/codex-request-lifecycle";
import type { TelemetryMetadata } from "../../lib/statsig-telemetry";
import { CodexRequestAnalytics } from "./codex-request-analytics";

const TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

function hostMetrics(
  overrides: Partial<CodexAppServerRequestMetrics> = {},
): CodexAppServerRequestMetrics {
  return {
    transportKind: "websocket",
    hostKind: "remote-control",
    incomingQueueDepth: 4,
    hostReadyWaitDurationMs: 5,
    hostRoundTripDurationMs: 6,
    requestBytes: 7,
    responseBytes: 8,
    responseReceiveDurationMs: 9,
    clientBusyPeriodPeakHostPendingRequestCount: 10,
    reconnectAttemptAtEnqueue: 2,
    largeInboundMessageOverlapMs: 11,
    largeInboundBytesReceivedWhilePending: 12,
    largeInboundCompletedMessageBytesWhilePending: 13,
    largeInboundMessageThresholdBytesWhilePending: 14,
    serverNotificationDeliveryLagMs: 15,
    serverNotificationClockSkewBaselineMs: 16,
    ...overrides,
  };
}

function completed(
  id: string,
  overrides: Partial<Extract<CodexRequestLifecycleTerminalEvent, { type: "completed" }>> = {},
): Extract<CodexRequestLifecycleTerminalEvent, { type: "completed" }> {
  return {
    type: "completed",
    hostId: "remote-control:env",
    id,
    method: "thread/read",
    priority: "background",
    source: "history",
    timeoutMs: 30_000,
    durationMs: 120,
    queueWaitMs: 20,
    requestDurationMs: 100,
    queuedRequestCountAtEnqueue: 3,
    peakInFlightRequestCount: 5,
    peakBackgroundInFlightRequestCount: 2,
    coalescedRequestCount: 1,
    trace: { traceparent: TRACEPARENT },
    hostMetrics: hostMetrics(),
    endedAtMs: 1_000,
    result: { privatePayload: "must-not-leak" },
    ...overrides,
  };
}

function timedOut(id: string): CodexRequestLifecycleTerminalEvent {
  const { result: _result, ...base } = completed(id);
  return {
    ...base,
    type: "timed-out",
    error: { privateError: "must-not-leak" },
  };
}

function analyticsEmitter() {
  return vi.fn<
    (eventName: string, value?: string | number, metadata?: TelemetryMetadata) => boolean
  >(() => true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex request analytics", () => {
  it("emits terminal request metrics without raw request payloads", () => {
    const emit = analyticsEmitter();
    const analytics = new CodexRequestAnalytics({ isEnabled: () => true, emit });

    analytics.handle(completed("completed"));

    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, value, metadata] = emit.mock.calls[0]!;
    expect(eventName).toBe("app_server_request");
    expect(value).toBeUndefined();
    expect(metadata).toMatchObject({
      durationMs: 120,
      endedAtMs: 1_000,
      outcome: "success",
      method: "thread/read",
      source: "history",
      hostKind: "remote-control",
      transportKind: "websocket",
      priority: "background",
      queueDurationMs: 20,
      hostReadyWaitDurationMs: 5,
      hostRoundTripDurationMs: 6,
      requestBytes: 7,
      responseBytes: 8,
      timeoutMs: 30_000,
      queuedRequestCountAtEnqueue: 3,
      peakInFlightRequestCount: 5,
      peakBackgroundInFlightRequestCount: 2,
      clientBusyPeriodPeakHostPendingRequestCount: 10,
      incomingQueueDepth: 4,
      coalescedRequestCount: 1,
      reconnectAttemptAtEnqueue: 2,
      requestDurationMs: 100,
      responseReceiveDurationMs: 9,
      largeInboundMessageOverlapMs: 11,
      largeInboundBytesReceivedWhilePending: 12,
      largeInboundCompletedMessageBytesWhilePending: 13,
      largeInboundMessageThresholdBytesWhilePending: 14,
      serverNotificationDeliveryLagMs: 15,
      serverNotificationClockSkewBaselineMs: 16,
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-leak");
    analytics[Symbol.dispose]();
  });

  it("holds timeouts for a late response and substitutes its physical host metrics", () => {
    vi.useFakeTimers();
    const emit = analyticsEmitter();
    const analytics = new CodexRequestAnalytics({ isEnabled: () => true, emit });

    analytics.handle(timedOut("late"));
    expect(emit).not.toHaveBeenCalled();

    analytics.handle({
      type: "late-response",
      hostId: "remote-control:env",
      id: "late",
      hostMetrics: hostMetrics({ responseBytes: 4_096, hostRoundTripDurationMs: 800 }),
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[2]).toMatchObject({
      outcome: "failure",
      reason: "timeout",
      responseBytes: 4_096,
      hostRoundTripDurationMs: 800,
    });
    vi.advanceTimersByTime(30_000);
    expect(emit).toHaveBeenCalledTimes(1);
    analytics[Symbol.dispose]();
  });

  it("flushes a held timeout after 30 seconds", () => {
    vi.useFakeTimers();
    const emit = analyticsEmitter();
    const analytics = new CodexRequestAnalytics({ isEnabled: () => true, emit });

    analytics.handle(timedOut("timeout"));
    vi.advanceTimersByTime(29_999);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[2]).toMatchObject({ outcome: "failure", reason: "timeout" });
    analytics[Symbol.dispose]();
  });

  it("flushes the oldest timeout when the pending late-response window reaches 100", () => {
    vi.useFakeTimers();
    const emit = analyticsEmitter();
    const analytics = new CodexRequestAnalytics({ isEnabled: () => true, emit });

    for (let index = 0; index < 101; index += 1) analytics.handle(timedOut(`timeout-${index}`));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[2]).toMatchObject({ reason: "timeout" });
    analytics[Symbol.dispose]();
  });

  it("records renderer queue saturation immediately", () => {
    const emit = analyticsEmitter();
    const analytics = new CodexRequestAnalytics({ isEnabled: () => true, emit });
    const event: CodexRequestLifecyclePerformanceEvent = {
      type: "background-queue-full",
      hostId: "local",
      method: "config/read",
      priority: "background",
      source: "config",
      timeoutMs: 0,
      durationMs: 0,
      queueWaitMs: 0,
      requestDurationMs: 0,
      queuedRequestCountAtEnqueue: 128,
      peakInFlightRequestCount: 5,
      peakBackgroundInFlightRequestCount: 3,
      coalescedRequestCount: 0,
      endedAtMs: 2_000,
    };

    analytics.handle(event);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[2]).toMatchObject({
      outcome: "failure",
      reason: "background-queue-full",
      queuedRequestCountAtEnqueue: 128,
    });
    analytics[Symbol.dispose]();
  });
});
