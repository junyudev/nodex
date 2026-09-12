import { describe, expect, it } from "vitest";
import {
  createCodexAppServerReceiveMetrics,
  type CodexAppServerInboundProgress,
} from "./transport-metrics.ts";

describe("physical receive metrics", () => {
  it("counts inclusive large-message thresholds and only their receive durations", () => {
    const receiver = createCodexAppServerReceiveMetrics({ transportKind: "stdio" });
    const before = receiver.snapshot();
    const sizes = [16_383, 16_384, 262_143, 262_144, 1_048_575, 1_048_576];
    for (const bytes of sizes)
      receiver.observeIncoming({}, bytes, { receiveStartedAtMs: 10, receivedAtMs: 17 });
    expect(receiver.snapshot()).toEqual({
      counts: [5, 3, 1],
      bytes: sizes.slice(1).reduce((sum, size) => sum + size, 0),
      receiveDurationMs: 35,
    });
    expect(before).toEqual({ counts: [0, 0, 0], bytes: 0, receiveDurationMs: 0 });
  });

  it("subtracts the current response and stops attribution at physical receipt", () => {
    const active: CodexAppServerInboundProgress = { startedAtMs: 10, bytesReceived: 8192 };
    const receiver = createCodexAppServerReceiveMetrics({
      transportKind: "stdio",
      getInboundMessageProgress: () => active,
    });
    const observation = receiver.startRequest(20);
    active.bytesReceived = 256 * 1024;
    active.receivedAtMs = 40;
    receiver.observeIncoming({ method: "bulk" }, active.bytesReceived, {
      receiveStartedAtMs: 10,
      receivedAtMs: 40,
    });
    const receipt = receiver.observeIncoming({ id: "read", result: {} }, 16 * 1024, {
      receiveStartedAtMs: 40,
      receivedAtMs: 50,
    });
    receiver.observeIncoming({ method: "later" }, 1024 * 1024, {
      receiveStartedAtMs: 50,
      receivedAtMs: 90,
    });
    expect(
      receiver.finishRequest({
        startedAtMs: 20,
        completedAtMs: 100,
        requestBytes: 80,
        responseBytes: 16 * 1024,
        receipt,
        observation,
      }),
    ).toEqual({
      transportKind: "stdio",
      incomingQueueDepth: 0,
      requestBytes: 80,
      responseBytes: 16 * 1024,
      hostRoundTripDurationMs: 80,
      responseReceiveDurationMs: 10,
      largeInboundCompletedMessageBytesWhilePending: 256 * 1024,
      largeInboundMessageThresholdBytesWhilePending: 256 * 1024,
      largeInboundMessageOverlapMs: 20,
      largeInboundBytesReceivedWhilePending: 256 * 1024 - 8192,
    });
  });

  it("does not attribute the request's own large response as competing traffic", () => {
    const receiver = createCodexAppServerReceiveMetrics({ transportKind: "stdio" });
    const observation = receiver.startRequest(10);
    const receipt = receiver.observeIncoming({ id: 1 }, 1024 * 1024, {
      receiveStartedAtMs: 15,
      receivedAtMs: 25,
    });
    const metrics = receiver.finishRequest({
      startedAtMs: 10,
      completedAtMs: 30,
      requestBytes: 1,
      responseBytes: 1024 * 1024,
      receipt,
      observation,
    });
    expect(metrics.responseReceiveDurationMs).toBe(10);
    expect(metrics.largeInboundCompletedMessageBytesWhilePending).toBe(0);
    expect(metrics.largeInboundMessageThresholdBytesWhilePending).toBeUndefined();
    expect(metrics.largeInboundMessageOverlapMs).toBeUndefined();
  });

  it("admits stdio observations during backlog and omits busy WebSocket or background attribution", () => {
    let depth = 1;
    const websocket = createCodexAppServerReceiveMetrics({
      transportKind: "websocket",
      getIncomingQueueDepth: () => depth,
    });
    const stdio = createCodexAppServerReceiveMetrics({
      transportKind: "stdio",
      getIncomingQueueDepth: () => depth,
    });
    expect(websocket.startRequest(10)).toBeUndefined();
    expect(stdio.startRequest(10)).toBeDefined();
    expect(stdio.startRequest(10, false)).toBeUndefined();
    depth = 0;
    const observation = websocket.startRequest(20);
    websocket.observeIncoming({ method: "bulk" }, 262_144, { receivedAtMs: 30 });
    const receipt = websocket.observeIncoming({ id: 1 }, 100, { receivedAtMs: 40 });
    const metrics = websocket.finishRequest({
      startedAtMs: 20,
      completedAtMs: 50,
      requestBytes: 10,
      responseBytes: 100,
      receipt,
      observation,
    });
    expect(metrics.largeInboundMessageThresholdBytesWhilePending).toBe(262_144);
    expect(metrics.largeInboundCompletedMessageBytesWhilePending).toBe(262_144);
    expect(metrics.responseReceiveDurationMs).toBeUndefined();
    expect(metrics.largeInboundMessageOverlapMs).toBeUndefined();
    expect(metrics.largeInboundBytesReceivedWhilePending).toBeUndefined();
  });

  it("consumes the latest notification lag once and retains the minimum signed clock skew", () => {
    const receiver = createCodexAppServerReceiveMetrics({ transportKind: "websocket" });
    receiver.observeIncoming({ method: "first", emittedAtMs: 100 }, 40, { receivedAtMs: 90 });
    receiver.observeIncoming({ method: "second", emitted_at_ms: 100 }, 40, { receivedAtMs: 140 });
    for (const emittedAtMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "120", null])
      receiver.observeIncoming({ method: "invalid", emittedAtMs, emitted_at_ms: 100 }, 40, {
        receivedAtMs: 160,
      });
    receiver.observeIncoming({ method: "request", id: 1, emittedAtMs: 1 }, 40, {
      receivedAtMs: 160,
    });
    const receipt = receiver.observeIncoming({ id: 2, result: {} }, 40, { receivedAtMs: 160 });
    const input = {
      startedAtMs: 10,
      completedAtMs: 170,
      requestBytes: 1,
      responseBytes: 40,
      receipt,
    };
    const first = receiver.finishRequest(input);
    expect(first.serverNotificationDeliveryLagMs).toBe(40);
    expect(first.serverNotificationClockSkewBaselineMs).toBe(-10);
    expect(receiver.finishRequest(input).serverNotificationDeliveryLagMs).toBeUndefined();
    expect(receiver.finishRequest(input).serverNotificationClockSkewBaselineMs).toBeUndefined();
    receiver.observeIncoming({ method: "third", emittedAtMs: 200 }, 40, { receivedAtMs: 195 });
    expect(receiver.finishRequest(input).serverNotificationClockSkewBaselineMs).toBe(-10);
  });

  it("keeps concurrent request observations independent", () => {
    const receiver = createCodexAppServerReceiveMetrics({ transportKind: "stdio" });
    const first = receiver.startRequest(0);
    receiver.observeIncoming({ method: "bulk" }, 16_384, {
      receiveStartedAtMs: 1,
      receivedAtMs: 4,
    });
    const second = receiver.startRequest(5);
    const receipt = receiver.observeIncoming({ id: 1 }, 262_144, {
      receiveStartedAtMs: 6,
      receivedAtMs: 8,
    });
    const common = {
      startedAtMs: 0,
      completedAtMs: 10,
      requestBytes: 1,
      responseBytes: 262_144,
      receipt,
    };
    expect(
      receiver.finishRequest({ ...common, observation: first })
        .largeInboundCompletedMessageBytesWhilePending,
    ).toBe(16_384);
    expect(
      receiver.finishRequest({ ...common, observation: second })
        .largeInboundCompletedMessageBytesWhilePending,
    ).toBe(0);
  });
});
