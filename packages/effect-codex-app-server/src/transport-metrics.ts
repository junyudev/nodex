export interface CodexAppServerInboundProgress {
  readonly startedAtMs: number;
  bytesReceived: number;
  receivedAtMs?: number;
}

export interface CodexAppServerReceiveTiming {
  readonly receiveStartedAtMs?: number;
  readonly receivedAtMs: number;
}

export interface CodexAppServerInboundSnapshot {
  readonly counts: readonly [number, number, number];
  readonly bytes: number;
  readonly receiveDurationMs: number;
}

export interface CodexAppServerMessageReceipt {
  readonly snapshot: CodexAppServerInboundSnapshot;
  readonly timing: CodexAppServerReceiveTiming;
}

export interface CodexAppServerRequestObservation {
  readonly startedAtMs: number;
  readonly snapshot: CodexAppServerInboundSnapshot;
  readonly activeMessage: CodexAppServerInboundProgress | null;
  readonly activeMessageBytes: number;
}

export interface CodexAppServerRequestMetrics {
  readonly transportKind: "stdio" | "websocket";
  readonly hostKind?: string;
  readonly clientBusyPeriodPeakHostPendingRequestCount?: number;
  readonly hostReadyWaitDurationMs?: number;
  readonly reconnectAttemptAtEnqueue?: number;
  readonly incomingQueueDepth: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly hostRoundTripDurationMs?: number;
  readonly responseReceiveDurationMs?: number;
  readonly serverNotificationDeliveryLagMs?: number;
  readonly serverNotificationClockSkewBaselineMs?: number;
  readonly largeInboundCompletedMessageBytesWhilePending?: number;
  readonly largeInboundMessageThresholdBytesWhilePending?: number;
  readonly largeInboundMessageOverlapMs?: number;
  readonly largeInboundBytesReceivedWhilePending?: number;
}

export interface CodexAppServerHostConcurrency {
  peakPendingRequestCount: number;
}

/** Counters and clock skew belong to the host, independently of a physical connection. */
export interface CodexAppServerReceiveMetricsState {
  counts: [number, number, number];
  bytes: number;
  receiveDurationMs: number;
  latestNotificationDeliveryLagMs?: number;
  notificationClockSkewBaselineMs?: number;
  pendingClientRequests: number;
  pendingInternalRequests: number;
  busyPeriod: CodexAppServerHostConcurrency | null;
}

export const createCodexAppServerReceiveMetricsState = (): CodexAppServerReceiveMetricsState => ({
  counts: [0, 0, 0],
  bytes: 0,
  receiveDurationMs: 0,
  pendingClientRequests: 0,
  pendingInternalRequests: 0,
  busyPeriod: null,
});

export function beginCodexClientRequest(
  state: CodexAppServerReceiveMetricsState,
): CodexAppServerHostConcurrency {
  if (state.pendingClientRequests === 0 || state.busyPeriod === null)
    state.busyPeriod = { peakPendingRequestCount: 0 };
  state.pendingClientRequests += 1;
  state.busyPeriod.peakPendingRequestCount = Math.max(
    state.busyPeriod.peakPendingRequestCount,
    state.pendingClientRequests + state.pendingInternalRequests,
  );
  return state.busyPeriod;
}

/** The scheduler owns this logical request; the physical writer fills only its transport fields. */
export interface CodexAppServerRequestTrace {
  onDispatched?: () => void;
  onResponse?: (receipt: CodexAppServerMessageReceipt) => void;
  onWireTrace?: (trace: import("./protocol.ts").CodexAppServerW3cTraceContext) => void;
  startedAtMs?: number;
  completedAtMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  receipt?: CodexAppServerMessageReceipt;
  observation?: CodexAppServerRequestObservation;
  receiver?: CodexAppServerReceiveMetrics;
}

const thresholds = [16 * 1024, 256 * 1024, 1024 * 1024] as const;

export function createCodexAppServerReceiveMetrics(options: {
  readonly transportKind: "stdio" | "websocket";
  readonly hostKind?: string;
  readonly state?: CodexAppServerReceiveMetricsState;
  readonly getInboundMessageProgress?: () => CodexAppServerInboundProgress | null;
  readonly getIncomingQueueDepth?: () => number;
}) {
  const state = options.state ?? createCodexAppServerReceiveMetricsState();
  const queueDepth = () => options.getIncomingQueueDepth?.() ?? 0;

  const snapshot = (): CodexAppServerInboundSnapshot => ({
    counts: [...state.counts],
    bytes: state.bytes,
    receiveDurationMs: state.receiveDurationMs,
  });

  const observeIncoming = (
    message: unknown,
    messageBytes: number,
    timing: CodexAppServerReceiveTiming,
  ): CodexAppServerMessageReceipt => {
    if (options.hostKind === "remote-control") return { snapshot: snapshot(), timing };
    if (messageBytes >= thresholds[0]) {
      for (const [index, threshold] of thresholds.entries()) {
        if (messageBytes >= threshold) state.counts[index]! += 1;
      }
      state.bytes += messageBytes;
      if (timing.receiveStartedAtMs !== undefined)
        state.receiveDurationMs += timing.receivedAtMs - timing.receiveStartedAtMs;
    }
    if (
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      !("id" in message)
    ) {
      const emittedAtMs =
        "emittedAtMs" in message
          ? message.emittedAtMs
          : "emitted_at_ms" in message
            ? message.emitted_at_ms
            : undefined;
      if (typeof emittedAtMs === "number" && Number.isSafeInteger(emittedAtMs) && emittedAtMs > 0) {
        state.latestNotificationDeliveryLagMs = timing.receivedAtMs - emittedAtMs;
        state.notificationClockSkewBaselineMs = Math.min(
          state.notificationClockSkewBaselineMs ?? state.latestNotificationDeliveryLagMs,
          state.latestNotificationDeliveryLagMs,
        );
      }
    }
    return { snapshot: snapshot(), timing };
  };

  const startRequest = (
    startedAtMs: number,
    observe = true,
  ): CodexAppServerRequestObservation | undefined => {
    if (
      !observe ||
      options.hostKind === "remote-control" ||
      (options.transportKind !== "stdio" && queueDepth() !== 0)
    )
      return;
    const activeMessage = options.getInboundMessageProgress?.() ?? null;
    return {
      startedAtMs,
      snapshot: snapshot(),
      activeMessage,
      activeMessageBytes: activeMessage?.bytesReceived ?? 0,
    };
  };

  const finishRequest = (input: {
    readonly startedAtMs?: number;
    readonly completedAtMs: number;
    readonly queuedAtMs?: number;
    readonly hostRequestConcurrency?: CodexAppServerHostConcurrency;
    readonly reconnectAttemptAtEnqueue?: number;
    readonly requestBytes?: number;
    readonly responseBytes?: number;
    readonly receipt?: CodexAppServerMessageReceipt;
    readonly observation?: CodexAppServerRequestObservation;
  }): CodexAppServerRequestMetrics => {
    const lag = state.latestNotificationDeliveryLagMs;
    state.latestNotificationDeliveryLagMs = undefined;
    const ownBytes =
      input.receipt && input.responseBytes !== undefined && input.responseBytes >= thresholds[0]
        ? input.responseBytes
        : 0;
    const responseReceiveDurationMs =
      options.hostKind !== "remote-control" &&
      ownBytes > 0 &&
      input.receipt?.timing.receiveStartedAtMs !== undefined
        ? input.receipt.timing.receivedAtMs - input.receipt.timing.receiveStartedAtMs
        : undefined;
    const metrics: CodexAppServerRequestMetrics = {
      transportKind: options.transportKind,
      ...(options.hostKind === undefined ? {} : { hostKind: options.hostKind }),
      ...(input.queuedAtMs === undefined
        ? {}
        : {
            hostReadyWaitDurationMs: (input.startedAtMs ?? input.completedAtMs) - input.queuedAtMs,
          }),
      ...(input.hostRequestConcurrency === undefined
        ? {}
        : {
            clientBusyPeriodPeakHostPendingRequestCount:
              input.hostRequestConcurrency.peakPendingRequestCount,
          }),
      ...(input.reconnectAttemptAtEnqueue === undefined
        ? {}
        : {
            reconnectAttemptAtEnqueue: input.reconnectAttemptAtEnqueue,
          }),
      incomingQueueDepth: queueDepth(),
      requestBytes: input.requestBytes,
      responseBytes: input.responseBytes,
      hostRoundTripDurationMs:
        input.startedAtMs === undefined ? undefined : input.completedAtMs - input.startedAtMs,
      ...(responseReceiveDurationMs === undefined ? {} : { responseReceiveDurationMs }),
      ...(lag === undefined
        ? {}
        : {
            serverNotificationDeliveryLagMs: lag,
            serverNotificationClockSkewBaselineMs: state.notificationClockSkewBaselineMs,
          }),
    };
    const observation = input.observation;
    if (!observation) return metrics;
    const completed = input.receipt?.snapshot ?? snapshot();
    if (completed.counts[0] - observation.snapshot.counts[0] - Number(ownBytes > 0) <= 0)
      return { ...metrics, largeInboundCompletedMessageBytesWhilePending: 0 };
    const threshold = thresholds.findLast(
      (threshold, index) =>
        completed.counts[index]! -
          observation.snapshot.counts[index]! -
          Number(ownBytes >= threshold) >
        0,
    );
    const completedBytes = completed.bytes - observation.snapshot.bytes - ownBytes;
    const competing = {
      ...metrics,
      largeInboundCompletedMessageBytesWhilePending: completedBytes,
      largeInboundMessageThresholdBytesWhilePending: threshold,
    };
    if (options.transportKind !== "stdio") return competing;
    let overlap =
      completed.receiveDurationMs -
      observation.snapshot.receiveDurationMs -
      (responseReceiveDurationMs ?? 0);
    let receivedBytes = completedBytes;
    const active = observation.activeMessage;
    if (active?.receivedAtMs !== undefined && active.bytesReceived >= thresholds[0]) {
      overlap -= Math.max(
        0,
        Math.min(observation.startedAtMs, active.receivedAtMs) - active.startedAtMs,
      );
      receivedBytes -= observation.activeMessageBytes;
    }
    return {
      ...competing,
      largeInboundMessageOverlapMs: Math.max(0, overlap),
      largeInboundBytesReceivedWhilePending: Math.max(0, receivedBytes),
    };
  };

  return {
    state,
    beginInternalRequest: () => {
      state.pendingInternalRequests += 1;
      if (state.busyPeriod)
        state.busyPeriod.peakPendingRequestCount = Math.max(
          state.busyPeriod.peakPendingRequestCount,
          state.pendingClientRequests + state.pendingInternalRequests,
        );
    },
    endInternalRequest: () => {
      state.pendingInternalRequests = Math.max(0, state.pendingInternalRequests - 1);
    },
    snapshot,
    observeIncoming,
    startRequest,
    finishRequest,
  };
}

export type CodexAppServerReceiveMetrics = ReturnType<typeof createCodexAppServerReceiveMetrics>;
