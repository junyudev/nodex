import type {
  continueTrace as SentryContinueTrace,
  Span,
  startInactiveSpan as SentryStartInactiveSpan,
  withActiveSpan as SentryWithActiveSpan,
} from "@sentry/react";

/** The tracing calls renderer spans use. Diagnostics install the SDK's when they load it. */
export interface RendererTracing {
  readonly continueTrace: typeof SentryContinueTrace;
  readonly startInactiveSpan: typeof SentryStartInactiveSpan;
  readonly withActiveSpan: typeof SentryWithActiveSpan;
}

export type RendererSpan = Span;

const IDLE_CONTEXT: ReturnType<Span["spanContext"]> = {
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  traceFlags: 0,
};

/** A span started before diagnostics load the SDK, or without them. It records nothing. */
class IdleSpan implements Span {
  spanContext() {
    return IDLE_CONTEXT;
  }
  end() {}
  setAttribute() {
    return this;
  }
  setAttributes() {
    return this;
  }
  setStatus() {
    return this;
  }
  updateName() {
    return this;
  }
  isRecording() {
    return false;
  }
  addEvent() {
    return this;
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }
  recordException() {}
}

const IDLE_SPAN: Span = new IdleSpan();

let tracing: RendererTracing | null = null;

/**
 * The Workbench does not load the diagnostics SDK to trace. Spans record once diagnostics are on
 * and their SDK has installed its tracing here; until then every span is idle.
 */
export function installRendererTracing(next: RendererTracing | null): void {
  tracing = next;
}

export const startInactiveSpan = (
  options: Parameters<typeof SentryStartInactiveSpan>[0],
): RendererSpan => tracing?.startInactiveSpan(options) ?? IDLE_SPAN;

export function withActiveSpan<T>(span: RendererSpan, callback: () => T): T {
  return tracing && span !== IDLE_SPAN
    ? tracing.withActiveSpan(span, () => callback())
    : callback();
}

export function continueTrace<T>(
  options: Parameters<typeof SentryContinueTrace>[0],
  callback: () => T,
): T {
  return tracing ? tracing.continueTrace(options, callback) : callback();
}
