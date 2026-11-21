import type { RuntimeWorkReading } from "../../../shared/diagnostics/runtime-work";
import {
  codexPerformanceNow,
  startCodexPerformanceSpan,
  type CodexPerformanceSpan,
} from "../../lib/codex-performance-span";
import { nextRendererRuntimeWorkId, rendererRuntimeWork } from "../../lib/runtime-work";

export const RUNTIME_NAVIGATION_MARK = "nodex.runtime.navigation";

/**
 * `cold`: the window's first Runtime conversation; `warm`: a later one that still reads its
 * snapshot; `cache`: the conversation's current projection was already resident here.
 */
export type RuntimeNavigationCohort = "cold" | "warm" | "cache";

export type RuntimeNavigationStage =
  | "navigation_dispatched"
  | "route_entered"
  | "control_requested"
  | "control_received"
  | "snapshot_requested"
  | "snapshot_received"
  | "projection_installed"
  | "content_committed"
  | "empty_committed";

export type RuntimeNavigationTerminal =
  | { readonly outcome: "success"; readonly reason: "content_visible" | "empty_visible" }
  | {
      readonly outcome: "aborted";
      readonly reason: "navigation_away" | "superseded" | "reentered" | "app_disposed";
    }
  | { readonly outcome: "failure"; readonly reason: "snapshot_failed" };

/** One finished navigation; stage times are milliseconds after dispatch. */
export interface RuntimeNavigationRecord {
  readonly attempt: number;
  readonly workId: string;
  readonly cohort: RuntimeNavigationCohort;
  readonly provider: string;
  readonly stages: Readonly<Partial<Record<RuntimeNavigationStage, number>>>;
  readonly outcome: RuntimeNavigationTerminal["outcome"];
  readonly reason: RuntimeNavigationTerminal["reason"];
  readonly durationMs: number;
  /** This window's counted work for the navigation, when runtime metrics are on. */
  readonly work: RuntimeWorkReading | null;
}

export interface RuntimeConversationTarget {
  readonly sessionId: string;
  readonly threadId: string;
}

interface Pending {
  readonly target: RuntimeConversationTarget;
  readonly attempt: number;
  readonly workId: string;
  readonly startedAtMs: number;
  readonly cohort: RuntimeNavigationCohort;
  readonly span: CodexPerformanceSpan;
  readonly stages: Partial<Record<RuntimeNavigationStage, number>>;
  provider: string;
  surfaces: number;
  leaving: ReturnType<typeof setTimeout> | null;
}

export interface RuntimeConversationNavigationOptions {
  readonly now?: () => number;
  /** Whether finished navigations are recorded in this window. */
  readonly recordsLocally?: () => boolean;
  readonly report?: (record: RuntimeNavigationRecord) => void;
  readonly startSpan?: (
    attributes: Readonly<Record<string, string>>,
    startedAtMs: number,
    onTerminal: () => void,
  ) => CodexPerformanceSpan;
}

const sameTarget = (left: RuntimeConversationTarget, right: RuntimeConversationTarget) =>
  left.sessionId === right.sessionId && left.threadId === right.threadId;

/** A finished navigation is one Performance measure, its stages and work in the detail. */
const reportToTimeline = (record: RuntimeNavigationRecord) => {
  const end = performance.now();
  performance.measure(RUNTIME_NAVIGATION_MARK, {
    start: Math.max(0, end - record.durationMs),
    end,
    detail: record,
  });
};

/**
 * One selected Runtime conversation owns one navigation measurement, from dispatch through its
 * snapshot and installed projection to the first painted content. It records locally without
 * trace sampling and reports nothing anywhere when neither local metrics nor tracing records.
 */
export class RuntimeConversationNavigation {
  #pending: Pending | null = null;
  #attempts = 0;
  #navigated = false;
  readonly #now: () => number;
  readonly #recordsLocally: () => boolean;
  readonly #report: (record: RuntimeNavigationRecord) => void;
  readonly #startSpan: NonNullable<RuntimeConversationNavigationOptions["startSpan"]>;

  constructor(options: RuntimeConversationNavigationOptions = {}) {
    this.#now = options.now ?? codexPerformanceNow;
    this.#recordsLocally = options.recordsLocally ?? (() => rendererRuntimeWork() !== null);
    this.#report = options.report ?? reportToTimeline;
    this.#startSpan =
      options.startSpan ??
      ((attributes, startedAtMs, onTerminal) =>
        startCodexPerformanceSpan("desktop.runtime_conversation_navigation", () => {}, {
          onTerminal,
          startedAtMs,
          traceAttributes: attributes,
        }));
  }

  /**
   * A route selected this conversation. Selecting the conversation that is already pending
   * re-enters it: the earlier attempt ends and measurement starts again from here.
   */
  dispatch(
    target: RuntimeConversationTarget,
    input: { readonly resident: boolean; readonly provider?: string },
  ): void {
    if (this.#pending && sameTarget(this.#pending.target, target))
      this.#finish(this.#pending, { outcome: "aborted", reason: "reentered" });
    this.#begin(target, input.resident, input.provider ?? "unknown", "navigation_dispatched");
  }

  /**
   * The conversation surface mounted. It joins a pending navigation of the same conversation or
   * starts one; when every surface has left, the navigation ends unless one returns at once.
   */
  enter(
    target: RuntimeConversationTarget,
    input: { readonly resident: boolean; readonly provider: string },
  ): () => void {
    if (!this.#pending || !sameTarget(this.#pending.target, target))
      this.#begin(target, input.resident, input.provider, "route_entered");
    const pending = this.#pending;
    if (!pending || !sameTarget(pending.target, target)) return () => {};
    if (pending.provider === "unknown") pending.provider = input.provider;
    pending.surfaces += 1;
    if (pending.leaving !== null) clearTimeout(pending.leaving);
    pending.leaving = null;
    this.#mark(pending, "route_entered");
    let left = false;
    return () => {
      if (left) return;
      left = true;
      pending.surfaces -= 1;
      if (pending.surfaces > 0 || this.#pending !== pending) return;
      // A remount of the same surface returns before the next task; leaving is final only then.
      pending.leaving = setTimeout(() => {
        pending.leaving = null;
        if (this.#pending === pending && pending.surfaces === 0)
          this.#finish(pending, { outcome: "aborted", reason: "navigation_away" });
      }, 0);
    };
  }

  /** The window left for another route; null leaves every conversation. */
  routeChanged(target: RuntimeConversationTarget | null): void {
    const pending = this.#pending;
    if (pending && (target === null || !sameTarget(pending.target, target)))
      this.#finish(pending, { outcome: "aborted", reason: "navigation_away" });
  }

  /** The work identity a pending navigation's reads carry, so every boundary counts under it. */
  workId(target: RuntimeConversationTarget): string | null {
    return this.#for(target)?.workId ?? null;
  }

  mark(target: RuntimeConversationTarget, stage: RuntimeNavigationStage): void {
    const pending = this.#for(target);
    if (pending) this.#mark(pending, stage);
  }

  failed(target: RuntimeConversationTarget): void {
    const pending = this.#for(target);
    if (pending) this.#finish(pending, { outcome: "failure", reason: "snapshot_failed" });
  }

  /** The surface committed the current projection: some content, or a conversation with none. */
  committed(target: RuntimeConversationTarget, empty: boolean): void {
    this.mark(target, empty ? "empty_committed" : "content_committed");
  }

  /** The committed projection has painted. */
  visible(target: RuntimeConversationTarget): void {
    const pending = this.#for(target);
    if (!pending) return;
    const empty = pending.stages.content_committed === undefined;
    if (empty && pending.stages.empty_committed === undefined) return;
    this.#finish(pending, {
      outcome: "success",
      reason: empty ? "empty_visible" : "content_visible",
    });
  }

  isPending(target: RuntimeConversationTarget): boolean {
    return this.#for(target) !== null;
  }

  dispose(): void {
    if (this.#pending) this.#finish(this.#pending, { outcome: "aborted", reason: "app_disposed" });
  }

  #for(target: RuntimeConversationTarget): Pending | null {
    return this.#pending && sameTarget(this.#pending.target, target) ? this.#pending : null;
  }

  #begin(
    target: RuntimeConversationTarget,
    resident: boolean,
    provider: string,
    stage: "navigation_dispatched" | "route_entered",
  ): void {
    if (this.#pending) this.#finish(this.#pending, { outcome: "aborted", reason: "superseded" });
    const cohort: RuntimeNavigationCohort = resident ? "cache" : this.#navigated ? "warm" : "cold";
    this.#navigated = true;
    const startedAtMs = this.#now();
    const span = this.#startSpan({ cohort, provider }, startedAtMs, () => {});
    if (!span.isRecording() && !this.#recordsLocally()) {
      span.abort("unrecorded");
      return;
    }
    const attempt = ++this.#attempts;
    this.#pending = {
      target,
      attempt,
      workId: `nav-${attempt}`,
      startedAtMs,
      cohort,
      span,
      stages: {},
      provider,
      surfaces: 0,
      leaving: null,
    };
    this.#mark(this.#pending, "navigation_dispatched");
    if (stage === "route_entered") this.#mark(this.#pending, stage);
  }

  #mark(pending: Pending, stage: RuntimeNavigationStage): void {
    if (pending.stages[stage] !== undefined) return;
    const atMs = this.#now();
    pending.stages[stage] = Math.round((atMs - pending.startedAtMs) * 10) / 10;
    pending.span.mark(stage, { atMs });
  }

  #finish(pending: Pending, terminal: RuntimeNavigationTerminal): void {
    if (this.#pending !== pending) return;
    this.#pending = null;
    if (pending.leaving !== null) clearTimeout(pending.leaving);
    if (terminal.outcome === "success") pending.span.end();
    else if (terminal.outcome === "failure") pending.span.fail(terminal.reason);
    else pending.span.abort(terminal.reason);
    if (!this.#recordsLocally()) return;
    this.#report({
      attempt: pending.attempt,
      workId: pending.workId,
      cohort: pending.cohort,
      provider: pending.provider,
      stages: { ...pending.stages },
      outcome: terminal.outcome,
      reason: terminal.reason,
      durationMs: Math.round((this.#now() - pending.startedAtMs) * 10) / 10,
      work: rendererRuntimeWork()?.read(pending.workId) ?? null,
    });
  }
}

export const runtimeConversationNavigation = new RuntimeConversationNavigation();

/** A read outside any navigation still correlates its own boundaries. */
export const runtimeReadWorkId = (target: RuntimeConversationTarget): string =>
  runtimeConversationNavigation.workId(target) ?? nextRendererRuntimeWorkId();
