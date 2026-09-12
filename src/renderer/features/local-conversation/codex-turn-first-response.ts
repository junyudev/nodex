import { startInactiveSpan, withActiveSpan } from "@sentry/react";

import type {
  CodexRequestLifecycleEvent,
  CodexRequestTraceContext,
} from "../../../shared/codex-request-lifecycle";
import { logTelemetryEvent } from "../../lib/statsig-telemetry";

export type CodexTurnSubmissionKind = "existing_thread" | "new_thread";

export interface CodexTurnFirstResponseSpan {
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

export interface CodexTurnFirstResponseSpanStartOptions {
  readonly key: string;
  readonly onTerminal: () => void;
  readonly startedAtMs: number;
  readonly traceAttributes: Readonly<Record<string, string>>;
}

export type CodexTurnFirstResponseSpanFactory = (
  name: "turn_first_response_visible",
  attributes: Record<string, string>,
  options: CodexTurnFirstResponseSpanStartOptions,
) => CodexTurnFirstResponseSpan;

interface PendingTurnFirstResponse {
  readonly attributes: Record<string, string>;
  readonly clientUserMessageId: string;
  conversationId: string | null;
  firstDataReceived: boolean;
  firstResponseVisible: boolean;
  newThreadNavigationDispatched: boolean;
  readonly routeThreadId: string | null;
  readonly span: CodexTurnFirstResponseSpan;
  submitPreparation: { end(): void } | null;
  turnCompleted: boolean;
  turnId: string | null;
}

export function codexTurnFirstResponseNow(): number {
  if (typeof performance !== "undefined") return performance.timeOrigin + performance.now();
  return Date.now();
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
 * CodexElectron models performance marks as zero-duration child spans. Sentry's tracing API gives
 * Nodex the same W3C parent/child relationship while keeping the transport context backend-neutral.
 */
export function startCodexTurnFirstResponseSpan(
  _name: "turn_first_response_visible",
  attributes: Record<string, string>,
  options: CodexTurnFirstResponseSpanStartOptions,
): CodexTurnFirstResponseSpan {
  const root = startInactiveSpan({
    name: "desktop.turn_submit",
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
    const atMs = input?.atMs ?? codexTurnFirstResponseNow();
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
    logTelemetryEvent("desktop.turn_submit", codexTurnFirstResponseNow() - options.startedAtMs, {
      outcome,
      reason: reason ?? undefined,
      submissionKind: attributes.submissionKind,
      responseRuntime: attributes.responseRuntime,
      threadKind: attributes.threadKind,
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

export function scheduleCodexAfterFourPaints(callback: () => void): void {
  let remaining = 4;
  const next = () => {
    window.requestAnimationFrame(() => {
      remaining -= 1;
      if (remaining === 0) {
        callback();
        return;
      }
      next();
    });
  };
  next();
}

export class CodexTurnFirstResponseTracker {
  private readonly pendingByClientUserMessageId = new Map<string, PendingTurnFirstResponse>();
  private readonly pendingByTurnId = new Map<string, PendingTurnFirstResponse>();

  constructor(
    private readonly startSpan: CodexTurnFirstResponseSpanFactory = startCodexTurnFirstResponseSpan,
    private readonly scheduleAfterPaint: (
      callback: () => void,
    ) => void = scheduleCodexAfterFourPaints,
  ) {}

  start(
    clientUserMessageId: string,
    submissionKind: CodexTurnSubmissionKind,
    conversationId: string | null,
    routeThreadId: string | null,
    startedAtMs: number,
  ): void {
    const previous = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (previous) {
      this.clear(previous);
      previous.span.abort("superseded");
    }
    const attributes = { submissionKind, responseRuntime: "unknown" };
    let span!: CodexTurnFirstResponseSpan;
    span = this.startSpan("turn_first_response_visible", attributes, {
      key: clientUserMessageId,
      onTerminal: () => {
        const current = this.pendingByClientUserMessageId.get(clientUserMessageId);
        if (current?.span === span) this.clear(current);
      },
      startedAtMs,
      traceAttributes: { "turn.submission_kind": submissionKind },
    });
    if (!span.isRecording()) return;
    this.pendingByClientUserMessageId.set(clientUserMessageId, {
      attributes,
      clientUserMessageId,
      conversationId,
      firstDataReceived: false,
      firstResponseVisible: false,
      newThreadNavigationDispatched: false,
      routeThreadId,
      span,
      submitPreparation: span.measure("turn.submit_preparation", { startedAtMs }),
      turnCompleted: false,
      turnId: null,
    });
  }

  markRequestDispatched(clientUserMessageId: string, method?: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    pending.submitPreparation?.end();
    pending.submitPreparation = null;
    pending.span.mark("request_dispatched", {
      traceAttributes: method ? { "app_server.method": method } : {},
    });
  }

  handleRequestLifecycleEvent(event: CodexRequestLifecycleEvent): void {
    if (
      (event.type !== "started" && event.type !== "completed") ||
      event.clientUserMessageId == null ||
      (event.method !== "thread/start" &&
        event.method !== "thread/startAeon" &&
        event.method !== "turn/start")
    )
      return;
    const pending = this.pendingByClientUserMessageId.get(event.clientUserMessageId);
    if (!pending) return;
    if (event.type === "started") {
      pending.span.mark(
        event.method === "turn/start" ? "turn_request_dispatched" : "thread_request_dispatched",
        {
          atMs: event.startedAtMs,
          traceAttributes: { "app_server.method": event.method },
        },
      );
      return;
    }
    if (event.method === "turn/start") return;
    pending.attributes.responseRuntime = "unknown";
    pending.span.mark("thread_response_received", {
      atMs: event.endedAtMs,
      traceAttributes: { "codex.response_runtime": "unknown" },
    });
  }

  getTrace(clientUserMessageId: string): CodexRequestTraceContext | null | undefined {
    return this.pendingByClientUserMessageId.get(clientUserMessageId)?.span.trace;
  }

  markThreadCreationStarted(clientUserMessageId: string, threadKind: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    pending.attributes.threadKind = threadKind;
    pending.span.mark("thread_creation_started", {
      traceAttributes: { "codex.thread_kind": threadKind },
    });
  }

  markThreadInputsReady(clientUserMessageId: string): void {
    this.pendingByClientUserMessageId.get(clientUserMessageId)?.span.mark("thread_inputs_ready");
  }

  markThreadCreated(clientUserMessageId: string): void {
    this.pendingByClientUserMessageId.get(clientUserMessageId)?.span.mark("thread_created");
  }

  bindConversation(clientUserMessageId: string, conversationId: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (pending) pending.conversationId = conversationId;
  }

  markNewThreadNavigationDispatched(clientUserMessageId: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    pending.newThreadNavigationDispatched = true;
    pending.span.mark("new_thread_navigation_dispatched");
  }

  markNewThreadPageVisible(routeThreadId: string): void {
    for (const pending of this.pendingByClientUserMessageId.values()) {
      if (pending.newThreadNavigationDispatched && pending.routeThreadId === routeThreadId)
        pending.span.mark("new_thread_page_visible");
    }
  }

  markTurnStarted(clientUserMessageId: string, conversationId: string, turnId: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    pending.conversationId = conversationId;
    pending.turnId = turnId;
    this.pendingByTurnId.set(turnId, pending);
    pending.span.mark("turn_started");
  }

  markFirstDataReceived(turnId: string): void {
    const pending = this.pendingByTurnId.get(turnId);
    if (!pending || pending.firstDataReceived) return;
    pending.firstDataReceived = true;
    pending.span.mark("first_data_received");
    if (!pending.firstResponseVisible) return;
    this.clear(pending);
    pending.span.end();
  }

  markFirstResponseVisible(clientUserMessageId: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    if (!pending.firstResponseVisible) {
      if (pending.turnCompleted && !pending.firstDataReceived) return;
      pending.firstResponseVisible = true;
      pending.span.mark("first_response_visible");
      pending.submitPreparation?.end();
      pending.submitPreparation = null;
      if (!pending.span.recordAnalyticsSuccess()) {
        this.clear(pending);
        return;
      }
    }
    if (!pending.firstDataReceived) return;
    this.clear(pending);
    pending.span.end();
  }

  fail(clientUserMessageId: string, reason: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    this.clear(pending);
    pending.span.fail(reason);
  }

  abort(clientUserMessageId: string, reason: string): void {
    const pending = this.pendingByClientUserMessageId.get(clientUserMessageId);
    if (!pending) return;
    this.clear(pending);
    pending.span.abort(reason);
  }

  finishTurn(turnId: string, status: "completed" | "failed" | "interrupted"): void {
    const pending = this.pendingByTurnId.get(turnId);
    if (!pending) return;
    if (status === "failed") {
      this.fail(pending.clientUserMessageId, "turn_failed");
      return;
    }
    if (status === "interrupted") {
      this.abort(pending.clientUserMessageId, "user_interrupted");
      return;
    }
    pending.turnCompleted = true;
    if (pending.firstDataReceived) return;
    this.scheduleAfterPaint(() => {
      const current = this.pendingByTurnId.get(turnId);
      if (current) this.fail(current.clientUserMessageId, "no_visible_response");
    });
  }

  abortConversation(conversationId: string): void {
    for (const pending of [...this.pendingByClientUserMessageId.values()]) {
      if (pending.conversationId === conversationId)
        this.abort(pending.clientUserMessageId, "navigation_away");
    }
  }

  routeChanged(conversationId: string | null): void {
    for (const pending of [...this.pendingByClientUserMessageId.values()]) {
      if (
        conversationId !== null &&
        (pending.routeThreadId === conversationId || pending.conversationId === conversationId)
      )
        continue;
      this.abort(pending.clientUserMessageId, "navigation_away");
    }
  }

  dispose(): void {
    for (const pending of [...this.pendingByClientUserMessageId.values()])
      this.abort(pending.clientUserMessageId, "app_disposed");
  }

  private clear(pending: PendingTurnFirstResponse): void {
    this.pendingByClientUserMessageId.delete(pending.clientUserMessageId);
    if (pending.turnId !== null && this.pendingByTurnId.get(pending.turnId) === pending)
      this.pendingByTurnId.delete(pending.turnId);
  }
}

export const codexTurnFirstResponseTracker = new CodexTurnFirstResponseTracker();
