import * as Sentry from "@sentry/electron/main";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import type { MainSentryAdapter, MainTraceSpanOptions } from "./sentry-main";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

const toSentryTrace = (trace: CodexRequestTraceContext | null | undefined): string | undefined => {
  const match = trace?.traceparent?.match(TRACEPARENT);
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${(Number.parseInt(match[3]!, 16) & 1) === 1 ? "1" : "0"}`;
};

const toSpanLink = (trace: CodexRequestTraceContext) => {
  const match = trace.traceparent?.match(TRACEPARENT);
  if (!match) return null;
  return {
    context: {
      traceId: match[1]!,
      spanId: match[2]!,
      traceFlags: Number.parseInt(match[3]!, 16),
      isRemote: true,
    },
  };
};

const traceFromActiveSpan = (
  fallback: CodexRequestTraceContext | null | undefined,
): CodexRequestTraceContext | null => {
  const span = Sentry.getActiveSpan();
  if (!span) return fallback ?? null;
  const context = span.spanContext();
  const flags = Math.max(0, Math.min(255, context.traceFlags)).toString(16).padStart(2, "0");
  const tracestate = context.traceState?.serialize() || fallback?.tracestate || undefined;
  return {
    traceparent: `00-${context.traceId}-${context.spanId}-${flags}`,
    ...(tracestate ? { tracestate } : {}),
  };
};

const runTraceSpan = <A>(
  options: MainTraceSpanOptions,
  callback: (trace: CodexRequestTraceContext | null) => A,
): A => {
  const run = () =>
    Sentry.startSpanManual(
      {
        name: options.name,
        op: options.op,
        attributes: options.attributes,
        ...(options.startTimeMs === undefined ? {} : { startTime: options.startTimeMs / 1_000 }),
        ...(options.root ? { parentSpan: null, forceTransaction: true } : {}),
        ...(options.links
          ? { links: options.links.flatMap((trace) => toSpanLink(trace) ?? []) }
          : {}),
      },
      (span) => {
        try {
          return callback(traceFromActiveSpan(options.trace));
        } finally {
          span.end(options.endTimeMs === undefined ? undefined : options.endTimeMs / 1_000);
        }
      },
    );
  if (options.root || !options.trace) return run();
  const sentryTrace = toSentryTrace(options.trace);
  if (!sentryTrace) return run();
  return Sentry.continueTrace({ sentryTrace, baggage: undefined }, run);
};

export const electronMainSentryAdapter: MainSentryAdapter = {
  addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
  captureException: (error, hint) =>
    Sentry.captureException(error, hint as Parameters<typeof Sentry.captureException>[1]),
  captureMessage: (message, hint) =>
    Sentry.captureMessage(message, hint as Parameters<typeof Sentry.captureMessage>[1]),
  close: (timeout) => Sentry.close(timeout),
  init: (options) => Sentry.init(options),
  runTraceSpan,
  setTag: (key, value) => Sentry.setTag(key, value),
};
