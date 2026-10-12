import { startInactiveSpan, withActiveSpan } from "@sentry/react";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import { logTelemetryEvent } from "./statsig-telemetry";

export function codexPerformanceNow(): number {
  if (typeof performance !== "undefined") return performance.timeOrigin + performance.now();
  return Date.now();
}

export interface CodexPerformanceSpan {
  readonly trace: CodexRequestTraceContext | null;
  abort(reason: string): void;
  end(): void;
  fail(reason: string): void;
  isRecording(): boolean;
  mark(
    name: string,
    options?: {
      readonly atMs?: number;
      readonly traceAttributes?: Readonly<Record<string, string>>;
    },
  ): void;
  measure(
    name: string,
    options?: {
      readonly startedAtMs?: number;
      readonly attributes?: Readonly<Record<string, string>>;
    },
  ): { end(): void };
  recordAnalyticsSuccess(): boolean;
}

export interface CodexPerformanceSpanStartOptions {
  readonly onTerminal: () => void;
  readonly startedAtMs: number;
  readonly traceAttributes: Readonly<Record<string, string>>;
}

function spanTraceContext(
  span: ReturnType<typeof startInactiveSpan>,
): CodexRequestTraceContext | null {
  if (!span.isRecording()) return null;
  const context = span.spanContext();
  const traceFlags = (context.traceFlags & 1).toString(16).padStart(2, "0");
  const tracestate = context.traceState?.serialize();
  return {
    traceparent: `00-${context.traceId}-${context.spanId}-${traceFlags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

/**
 * Performance marks are zero-duration child spans. The Sentry Adapter preserves their W3C
 * parent/child relationship while keeping request trace context transport-neutral.
 */
export function startCodexPerformanceSpan(
  name: string,
  analyticsAttributes:
    | Readonly<Record<string, string | undefined>>
    | (() => Readonly<Record<string, string | undefined>>),
  options: CodexPerformanceSpanStartOptions,
): CodexPerformanceSpan {
  const root = startInactiveSpan({
    name,
    startTime: new Date(options.startedAtMs),
    attributes: options.traceAttributes,
  });
  let terminal = false;
  let analyticsRecorded = false;
  const marks: Record<string, number> = {};

  const mark = (
    name: string,
    input?: {
      readonly atMs?: number;
      readonly traceAttributes?: Readonly<Record<string, string>>;
    },
  ) => {
    if (terminal || marks[name] !== undefined) return;
    const atMs = input?.atMs ?? codexPerformanceNow();
    marks[name] = Math.round(Math.max(0, atMs - options.startedAtMs) * 10) / 10;
    withActiveSpan(root, () => {
      const child = startInactiveSpan({
        name,
        startTime: new Date(atMs),
        attributes: input?.traceAttributes,
      });
      child.end(new Date(atMs));
    });
  };

  const emitAnalytics = (outcome: "success" | "failure" | "aborted", reason: string | null) => {
    if (analyticsRecorded) return;
    analyticsRecorded = true;
    logTelemetryEvent(name, codexPerformanceNow() - options.startedAtMs, {
      outcome,
      reason: reason ?? undefined,
      ...(typeof analyticsAttributes === "function" ? analyticsAttributes() : analyticsAttributes),
      ...Object.fromEntries(Object.entries(marks).map(([key, value]) => [`mark.${key}`, value])),
    });
  };

  const finish = (outcome: "success" | "failure" | "aborted", reason: string | null) => {
    if (terminal) return;
    terminal = true;
    root.setAttribute("codex.outcome", outcome);
    if (reason !== null) root.setAttribute("codex.reason", reason);
    if (outcome === "failure") {
      root.setAttribute("error.category", reason === "timeout" ? "timeout" : "operation");
      root.setAttribute("error.type", "operation_failed");
      root.setStatus({ code: 2 });
    }
    emitAnalytics(outcome, reason);
    root.end();
    options.onTerminal();
  };

  return {
    get trace() {
      return spanTraceContext(root);
    },
    abort: (reason) => finish("aborted", reason),
    end: () => finish("success", null),
    fail: (reason) => finish("failure", reason),
    isRecording: () => !terminal && root.isRecording(),
    mark,
    measure: (name, input) => {
      if (terminal) return { end: () => {} };
      const child = withActiveSpan(root, () =>
        startInactiveSpan({
          name,
          startTime: input?.startedAtMs === undefined ? undefined : new Date(input.startedAtMs),
          attributes: input?.attributes,
        }),
      );
      let ended = false;
      return {
        end: () => {
          if (ended) return;
          ended = true;
          child.end();
        },
      };
    },
    recordAnalyticsSuccess: () => {
      if (terminal) return false;
      emitAnalytics("success", null);
      return root.isRecording();
    },
  };
}
