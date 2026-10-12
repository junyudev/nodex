import type { CodexRequestTraceContext } from "../../../shared/codex-request-lifecycle";
import {
  codexPerformanceNow,
  startCodexPerformanceSpan,
  type CodexPerformanceSpan,
} from "../../lib/codex-performance-span";

type NavigationAttributes = {
  threadKind: string;
  threadState: string;
  view?: Readonly<Record<string, string>>;
};
export type CodexThreadNavigationSpanFactory = (
  attributes: NavigationAttributes,
  onTerminal: () => void,
) => CodexPerformanceSpan;
interface PendingNavigation {
  readonly threadId: string;
  readonly attributes: NavigationAttributes;
  readonly span: CodexPerformanceSpan;
  navigationWait: { end(): void } | null;
  renderWait: { end(): void } | null;
}

/** A selected Thread owns one navigation measurement, independently of message submission. */
export class CodexThreadNavigation {
  private pending: PendingNavigation | null = null;
  private visibleView: { threadId: string; attributes: Readonly<Record<string, string>> } | null =
    null;

  constructor(
    private readonly startSpan: CodexThreadNavigationSpanFactory = (attributes, onTerminal) =>
      startCodexPerformanceSpan(
        "desktop.thread_navigation",
        () => ({
          threadKind: attributes.threadKind,
          threadState: attributes.threadState,
          ...Object.fromEntries(
            Object.entries(attributes.view ?? {}).map(([key, value]) => [`view.${key}`, value]),
          ),
        }),
        {
          onTerminal,
          startedAtMs: codexPerformanceNow(),
          traceAttributes: {
            "thread.kind": attributes.threadKind,
            "thread.state": attributes.threadState,
          },
        },
      ),
  ) {}

  start(
    threadId: string,
    threadState: string,
    threadKind = "local",
    mark = "navigation_dispatched",
  ): void {
    if (this.pending?.threadId === threadId) return;
    this.finishPending("superseded");
    const attributes: NavigationAttributes = {
      threadKind,
      threadState,
      view:
        mark === "route_entered" && this.visibleView?.threadId === threadId
          ? this.visibleView.attributes
          : undefined,
    };
    const span = this.startSpan(attributes, () => {
      if (this.pending?.span === span) this.pending = null;
    });
    if (!span.isRecording()) return;
    span.mark(mark);
    this.pending = {
      threadId,
      attributes,
      span,
      navigationWait: span.measure("thread.navigation_wait"),
      renderWait: null,
    };
  }

  hydrationStarted(threadId: string): void {
    const pending = this.forThread(threadId);
    if (!pending) return;
    pending.navigationWait?.end();
    pending.navigationWait = null;
    pending.span.mark("hydration_started");
  }
  hydrationFinished(threadId: string): void {
    const pending = this.forThread(threadId);
    if (!pending || pending.renderWait !== null) return;
    pending.renderWait = pending.span.measure("thread.render_wait");
    pending.span.mark("hydration_finished");
  }
  historyReady(threadId: string): void {
    this.forThread(threadId)?.span.mark("history_ready");
  }
  complete(threadId: string): void {
    const pending = this.forThread(threadId);
    if (!pending) return;
    this.pending = null;
    pending.span.mark("content_visible");
    pending.navigationWait?.end();
    pending.renderWait?.end();
    pending.span.end();
  }
  hydrationFailed(threadId: string, error: unknown): void {
    const pending = this.forThread(threadId);
    if (!pending) return;
    this.pending = null;
    pending.navigationWait?.end();
    pending.renderWait?.end();
    if (error instanceof DOMException && error.name === "AbortError")
      pending.span.abort("hydration_canceled");
    else pending.span.fail("hydration_failed");
  }
  viewEntered(threadId: string, attributes: Readonly<Record<string, string>>): () => void {
    const view = { threadId, attributes };
    this.visibleView = view;
    const pending = this.forThread(threadId);
    if (pending) pending.attributes.view = attributes;
    return () => {
      if (this.visibleView === view) this.visibleView = null;
    };
  }
  isPending(threadId: string): boolean {
    return this.pending?.threadId === threadId;
  }
  getTrace(threadId: string): CodexRequestTraceContext | null {
    return this.forThread(threadId)?.span.trace ?? null;
  }
  routeChanged(threadId: string | null): void {
    if (this.pending && this.pending.threadId !== threadId) this.finishPending("navigation_away");
  }
  abort(threadId: string): void {
    if (this.isPending(threadId)) this.finishPending("navigation_away");
  }
  dispose(): void {
    this.visibleView = null;
    this.finishPending("app_disposed");
  }
  private forThread(threadId: string): PendingNavigation | null {
    return this.pending?.threadId === threadId ? this.pending : null;
  }
  private finishPending(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.navigationWait?.end();
    pending.renderWait?.end();
    pending.span.abort(reason);
  }
}

export const codexThreadNavigation = new CodexThreadNavigation();
