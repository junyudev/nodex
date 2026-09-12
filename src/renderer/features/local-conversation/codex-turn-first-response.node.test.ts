import { describe, expect, it, vi } from "vitest";

import type { CodexRequestLifecycleEvent } from "../../../shared/codex-request-lifecycle";
import {
  CodexTurnFirstResponseTracker,
  scheduleCodexAfterFourPaints,
  type CodexTurnFirstResponseSpan,
  type CodexTurnFirstResponseSpanFactory,
} from "./codex-turn-first-response";

function harness() {
  const spans = new Map<string, FakeSpan>();
  const startSpan: CodexTurnFirstResponseSpanFactory = (_name, _attributes, options) => {
    const span = new FakeSpan(options.onTerminal);
    spans.set(options.key, span);
    return span;
  };
  return { spans, tracker: new CodexTurnFirstResponseTracker(startSpan) };
}

class FakeSpan implements CodexTurnFirstResponseSpan {
  readonly trace = {
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  };
  readonly marks: Array<{
    name: string;
    atMs?: number;
    attributes?: Readonly<Record<string, string>>;
  }> = [];
  readonly measures: string[] = [];
  readonly terminals: Array<{ outcome: "success" | "failure" | "aborted"; reason?: string }> = [];
  recording = true;

  constructor(private readonly onTerminal: () => void) {}

  abort(reason: string): void {
    this.terminals.push({ outcome: "aborted", reason });
    this.recording = false;
    this.onTerminal();
  }
  end(): void {
    this.terminals.push({ outcome: "success" });
    this.recording = false;
    this.onTerminal();
  }
  fail(reason: string): void {
    this.terminals.push({ outcome: "failure", reason });
    this.recording = false;
    this.onTerminal();
  }
  isRecording(): boolean {
    return this.recording;
  }
  mark(
    name: string,
    options?: {
      readonly atMs?: number;
      readonly traceAttributes?: Readonly<Record<string, string>>;
    },
  ): void {
    this.marks.push({ name, atMs: options?.atMs, attributes: options?.traceAttributes });
  }
  measure(name: string): { end(): void } {
    this.measures.push(name);
    return { end: vi.fn() };
  }
  recordAnalyticsSuccess(): boolean {
    return this.recording;
  }
}

describe("CodexTurnFirstResponseTracker", () => {
  it("supersedes an existing submission with the same client identity", () => {
    const { tracker, spans } = harness();
    tracker.start("client-1", "existing_thread", "thread-1", "thread-1", 100);
    const first = spans.get("client-1")!;
    tracker.start("client-1", "existing_thread", "thread-1", "thread-1", 110);
    expect(first.terminals).toEqual([{ outcome: "aborted", reason: "superseded" }]);
  });

  it("records request dispatch and thread response lifecycle marks at supplied timestamps", () => {
    const { tracker, spans } = harness();
    tracker.start("client-1", "new_thread", null, null, 100);
    const span = spans.get("client-1")!;
    tracker.markRequestDispatched("client-1", "thread/start");
    tracker.handleRequestLifecycleEvent({
      type: "started",
      hostId: "local",
      id: "request-1",
      method: "thread/start",
      params: {},
      conversationId: null,
      priority: "critical",
      source: "user",
      queueWaitMs: 0,
      startedAtMs: 120,
      timeoutMs: 30_000,
      clientUserMessageId: "client-1",
    });
    tracker.handleRequestLifecycleEvent({
      type: "completed",
      hostId: "local",
      id: "request-1",
      method: "thread/start",
      priority: "critical",
      source: "user",
      timeoutMs: 30_000,
      durationMs: 30,
      queueWaitMs: 0,
      requestDurationMs: 30,
      queuedRequestCountAtEnqueue: 0,
      peakInFlightRequestCount: 1,
      peakBackgroundInFlightRequestCount: 0,
      coalescedRequestCount: 0,
      endedAtMs: 150,
      result: {},
      clientUserMessageId: "client-1",
    } satisfies CodexRequestLifecycleEvent);

    expect(span.marks).toEqual([
      {
        name: "request_dispatched",
        atMs: undefined,
        attributes: { "app_server.method": "thread/start" },
      },
      {
        name: "thread_request_dispatched",
        atMs: 120,
        attributes: { "app_server.method": "thread/start" },
      },
      {
        name: "thread_response_received",
        atMs: 150,
        attributes: { "codex.response_runtime": "unknown" },
      },
    ]);
  });

  it("ends only after first data and first visible response have both happened", () => {
    const { tracker, spans } = harness();
    tracker.start("client-1", "existing_thread", "thread-1", "thread-1", 100);
    const span = spans.get("client-1")!;
    tracker.markTurnStarted("client-1", "thread-1", "turn-1");
    tracker.markFirstDataReceived("turn-1");
    expect(span.terminals).toEqual([]);
    tracker.markFirstResponseVisible("client-1");
    expect(span.terminals).toEqual([{ outcome: "success" }]);
  });

  it("defers completed turns without first data and fails after the paint boundary", () => {
    const callbacks: Array<() => void> = [];
    const spans = new Map<string, FakeSpan>();
    const tracker = new CodexTurnFirstResponseTracker(
      (_name, _attributes, options) => {
        const span = new FakeSpan(options.onTerminal);
        spans.set(options.key, span);
        return span;
      },
      (callback) => callbacks.push(callback),
    );
    tracker.start("client-1", "existing_thread", "thread-1", "thread-1", 100);
    const span = spans.get("client-1")!;
    tracker.markTurnStarted("client-1", "thread-1", "turn-1");
    tracker.finishTurn("turn-1", "completed");
    tracker.markFirstResponseVisible("client-1");
    expect(span.marks.some((mark) => mark.name === "first_response_visible")).toBe(false);
    callbacks[0]!();
    expect(span.terminals).toEqual([{ outcome: "failure", reason: "no_visible_response" }]);
  });

  it("aborts submissions that no longer match the active route", () => {
    const { tracker, spans } = harness();
    tracker.start("client-1", "existing_thread", "thread-1", "thread-1", 100);
    tracker.start("client-2", "existing_thread", "thread-2", "thread-2", 100);
    tracker.routeChanged("thread-1");
    expect(spans.get("client-1")!.terminals).toEqual([]);
    expect(spans.get("client-2")!.terminals).toEqual([
      { outcome: "aborted", reason: "navigation_away" },
    ]);
  });
});

describe("scheduleCodexAfterFourPaints", () => {
  it("waits for four animation frames", () => {
    const originalWindow = globalThis.window;
    const callbacks: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
      },
    });
    try {
      const complete = vi.fn();
      scheduleCodexAfterFourPaints(complete);
      for (let index = 0; index < 3; index += 1) {
        callbacks.shift()!(index);
        expect(complete).not.toHaveBeenCalled();
      }
      callbacks.shift()!(4);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
});
