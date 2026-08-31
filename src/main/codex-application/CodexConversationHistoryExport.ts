import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalHydrationContext,
  type CreateCodexCanonicalHydratedConversationStateOptions,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexConversationHistoryExportNextResult,
  CodexConversationHistoryExportStartResult,
  CodexConversationSnapshot,
  CodexConversationTurn,
} from "../../shared/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { projectCodexConversationSnapshot } from "./CodexConversationSnapshotProjection";
import { CODEX_HISTORY_ITEM_PAGE_SIZE, CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export const CODEX_HISTORY_EXPORT_MAX_ACTIVE_JOBS = 16;
export const CODEX_HISTORY_EXPORT_IDLE_TTL_MS = 2 * 60 * 1_000;
export const CODEX_HISTORY_EXPORT_MAX_TURN_ITEMS = 10_000;
export const CODEX_HISTORY_EXPORT_MAX_TURN_BYTES = 8 * 1024 * 1_024;

type ExportMode = "paginated" | "resident";

interface ExportJobBase {
  readonly jobId: string;
  readonly consumerId: string;
  readonly threadId: string;
  readonly mode: ExportMode;
  readonly capability: CodexAppServerCapabilitySnapshot | null;
  readonly baseSnapshot: CodexConversationSnapshot;
  readonly hydration: CodexCanonicalHydrationContext;
  completedTurnCount: number;
  lastTouchedAtMs: number;
  busy: boolean;
}

interface PaginatedExportJob extends ExportJobBase {
  readonly mode: "paginated";
  readonly capability: CodexAppServerCapabilitySnapshot;
  turnCursor: string | null;
}

interface ResidentExportJob extends ExportJobBase {
  readonly mode: "resident";
  readonly capability: null;
  readonly residentTurns: readonly CodexConversationTurn[];
  residentIndex: number;
}

type ExportJob = PaginatedExportJob | ResidentExportJob;

export class CodexConversationHistoryExportError extends Data.TaggedError(
  "CodexConversationHistoryExportError",
)<{
  readonly reason:
    | "cancelled"
    | "concurrent-next"
    | "cursor-stalled"
    | "history-unavailable"
    | "invalid-job"
    | "page-size-exceeded"
    | "stale-generation"
    | "turn-too-large"
    | "unsupported-history";
  readonly threadId: string | null;
  readonly jobId: string | null;
  readonly cause: unknown;
}> {}

export class CodexConversationHistoryExport extends Context.Service<
  CodexConversationHistoryExport,
  {
    readonly start: (input: {
      readonly consumerId: string;
      readonly threadId: string;
    }) => Effect.Effect<
      CodexConversationHistoryExportStartResult,
      CodexConversationHistoryExportError
    >;
    readonly next: (input: {
      readonly consumerId: string;
      readonly jobId: string;
    }) => Effect.Effect<
      CodexConversationHistoryExportNextResult,
      CodexConversationHistoryExportError
    >;
    readonly cancel: (input: {
      readonly consumerId: string;
      readonly jobId: string;
    }) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-application/CodexConversationHistoryExport") {}

const exportError = (
  reason: CodexConversationHistoryExportError["reason"],
  input: {
    readonly threadId?: string | null;
    readonly jobId?: string | null;
    readonly cause: unknown;
  },
) =>
  new CodexConversationHistoryExportError({
    reason,
    threadId: input.threadId ?? null,
    jobId: input.jobId ?? null,
    cause: input.cause,
  });

const approximateValueBytes = (
  value: unknown,
  limit = CODEX_HISTORY_EXPORT_MAX_TURN_BYTES,
): number => cappedApproximateValueBytes(value, limit);

const assertTurnBudget = (
  threadId: string,
  jobId: string,
  items: readonly ThreadItem[],
  bytes: number,
): Effect.Effect<void, CodexConversationHistoryExportError> => {
  if (
    items.length <= CODEX_HISTORY_EXPORT_MAX_TURN_ITEMS &&
    bytes <= CODEX_HISTORY_EXPORT_MAX_TURN_BYTES
  ) {
    return Effect.void;
  }
  return Effect.fail(
    exportError("turn-too-large", {
      threadId,
      jobId,
      cause: new Error(
        `Turn export exceeds the bounded ${CODEX_HISTORY_EXPORT_MAX_TURN_ITEMS}-item / ${CODEX_HISTORY_EXPORT_MAX_TURN_BYTES}-byte working set`,
      ),
    }),
  );
};

const hydrationOptions = (
  context: CodexCanonicalHydrationContext,
): CreateCodexCanonicalHydratedConversationStateOptions => {
  const settings = context.latestThreadSettings;
  const permissions = context.currentPermissions;
  return {
    model: settings?.model ?? context.latestModel ?? context.model,
    reasoningEffort: (settings?.effort ??
      context.latestReasoningEffort ??
      context.reasoningEffort) as CreateCodexCanonicalHydratedConversationStateOptions["reasoningEffort"],
    cwd: settings?.cwd ?? context.cwd ?? "/",
    approvalPolicy: settings?.approvalPolicy ?? permissions.approvalPolicy,
    approvalsReviewer: settings?.approvalsReviewer ?? permissions.approvalsReviewer,
    sandboxPolicy: settings?.sandboxPolicy ?? permissions.sandboxPolicy,
    activePermissionProfile:
      settings?.activePermissionProfile ?? permissions.activePermissionProfile,
    runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
    pendingRequests: [],
    hasUnreadTurn: false,
  };
};

const projectExportTurn = (input: {
  readonly snapshot: CodexConversationSnapshot;
  readonly hydration: CodexCanonicalHydrationContext;
  readonly turn: Turn;
}): CodexConversationTurn => {
  const canonical = input.snapshot.canonicalState;
  if (!canonical) {
    throw new Error(`Thread '${input.snapshot.threadId}' has no canonical export context`);
  }
  const pageState = createCodexCanonicalHydratedConversationState(
    { ...canonical.protocol, turns: [input.turn] },
    hydrationOptions(input.hydration),
  );
  const projected = projectCodexConversationSnapshot({
    conversation: {
      ...input.snapshot,
      turns: [],
      requests: [],
      canonicalRequests: [],
      canonicalState: null,
    },
    before: null,
    after: pageState,
    observedAtMs: Date.now(),
  });
  const turn = projected.turns[0];
  if (!turn) throw new Error(`Thread '${input.snapshot.threadId}' export page was empty`);
  return turn;
};

export const make: Effect.Effect<
  CodexConversationHistoryExport["Service"],
  never,
  CodexAppServerCapabilities | CodexHistoryPageAdapter | ConversationEntityMap | Scope.Scope
> = Effect.gen(function* () {
  const capabilities = yield* CodexAppServerCapabilities;
  const historyPages = yield* CodexHistoryPageAdapter;
  const conversations = yield* ConversationEntityMap;
  const startAdmission = yield* Semaphore.make(1);
  const jobs = new Map<string, ExportJob>();
  let nextJobSequence = 1;

  const removeExpiredJobs = (now: number): void => {
    for (const [jobId, job] of jobs) {
      if (!job.busy && now - job.lastTouchedAtMs >= CODEX_HISTORY_EXPORT_IDLE_TTL_MS) {
        jobs.delete(jobId);
      }
    }
  };

  const cancelMatchingJob = (consumerId: string, threadId: string): void => {
    for (const [jobId, job] of jobs) {
      if (job.consumerId === consumerId && job.threadId === threadId) jobs.delete(jobId);
    }
  };

  const makeRoomForJob = (): void => {
    if (jobs.size < CODEX_HISTORY_EXPORT_MAX_ACTIVE_JOBS) return;
    const oldest = [...jobs.values()]
      .filter((job) => !job.busy)
      .sort((left, right) => left.lastTouchedAtMs - right.lastTouchedAtMs)[0];
    if (oldest) jobs.delete(oldest.jobId);
  };

  const isCurrentJob = (job: ExportJob): boolean => jobs.get(job.jobId) === job;

  const failIfCancelled = (job: ExportJob) =>
    isCurrentJob(job)
      ? Effect.void
      : Effect.fail(
          exportError("cancelled", {
            threadId: job.threadId,
            jobId: job.jobId,
            cause: new Error("History export was cancelled"),
          }),
        );

  const failIfStale = (job: PaginatedExportJob) =>
    capabilities.isCurrent(job.capability).pipe(
      Effect.mapError((cause) =>
        exportError("stale-generation", {
          threadId: job.threadId,
          jobId: job.jobId,
          cause,
        }),
      ),
      Effect.flatMap((current) =>
        current
          ? Effect.void
          : Effect.fail(
              exportError("stale-generation", {
                threadId: job.threadId,
                jobId: job.jobId,
                cause: new Error("Codex host generation changed during history export"),
              }),
            ),
      ),
    );

  const fenced = <A, E>(
    job: PaginatedExportJob,
    operation: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CodexConversationHistoryExportError> =>
    failIfCancelled(job).pipe(
      Effect.andThen(failIfStale(job)),
      Effect.andThen(Effect.suspend(operation)),
      Effect.tap(() => failIfCancelled(job)),
      Effect.tap(() => failIfStale(job)),
    );

  const hydrateCompleteTurn = Effect.fn("CodexConversationHistoryExport.hydrateCompleteTurn")(
    function* (job: PaginatedExportJob, initialTurn: Turn, initialCursor: string | null) {
      let cursor = initialCursor;
      let items = [...initialTurn.items];
      let bytes = approximateValueBytes({ ...initialTurn, items: [] });
      for (const item of items) {
        if (bytes > CODEX_HISTORY_EXPORT_MAX_TURN_BYTES) break;
        bytes += approximateValueBytes(item, CODEX_HISTORY_EXPORT_MAX_TURN_BYTES - bytes);
      }
      yield* assertTurnBudget(job.threadId, job.jobId, items, bytes);
      const seenItemIds = new Set(items.map((item) => item.id));
      const seenCursors = new Set<string>();

      while (cursor !== null) {
        if (seenCursors.has(cursor)) {
          return yield* exportError("cursor-stalled", {
            threadId: job.threadId,
            jobId: job.jobId,
            cause: new Error(`Repeated item cursor for turn '${initialTurn.id}'`),
          });
        }
        seenCursors.add(cursor);
        const remainingItemBudget = CODEX_HISTORY_EXPORT_MAX_TURN_ITEMS - items.length;
        if (remainingItemBudget <= 0) {
          return yield* exportError("turn-too-large", {
            threadId: job.threadId,
            jobId: job.jobId,
            cause: new Error(
              `Turn '${initialTurn.id}' has more than ${CODEX_HISTORY_EXPORT_MAX_TURN_ITEMS} items`,
            ),
          });
        }
        const physicalLimit = Math.min(CODEX_HISTORY_ITEM_PAGE_SIZE, remainingItemBudget);
        const page = yield* fenced(job, () =>
          historyPages.loadTurnItemsPage({
            capability: job.capability,
            threadId: job.threadId,
            turnId: initialTurn.id,
            cursor,
            limit: physicalLimit,
            purpose: "export",
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof CodexConversationHistoryExportError
              ? cause
              : exportError("history-unavailable", {
                  threadId: job.threadId,
                  jobId: job.jobId,
                  cause,
                }),
          ),
        );
        if (page.items.length > physicalLimit) {
          return yield* exportError("page-size-exceeded", {
            threadId: job.threadId,
            jobId: job.jobId,
            cause: new Error(
              `Item page for turn '${initialTurn.id}' returned ${page.items.length} entries for limit ${physicalLimit}`,
            ),
          });
        }
        const unique = page.items.filter((item) => {
          if (seenItemIds.has(item.id)) return false;
          seenItemIds.add(item.id);
          return true;
        });
        if (unique.length === 0 && page.nextCursor !== null) {
          return yield* exportError("cursor-stalled", {
            threadId: job.threadId,
            jobId: job.jobId,
            cause: new Error(
              `Item cursor '${cursor}' made no unique progress for turn '${initialTurn.id}'`,
            ),
          });
        }
        for (const item of unique) {
          if (bytes > CODEX_HISTORY_EXPORT_MAX_TURN_BYTES) break;
          bytes += approximateValueBytes(item, CODEX_HISTORY_EXPORT_MAX_TURN_BYTES - bytes);
        }
        items = [...unique, ...items];
        yield* assertTurnBudget(job.threadId, job.jobId, items, bytes);
        cursor = page.nextCursor;
      }

      return { ...initialTurn, items, itemsView: "full" } satisfies Turn;
    },
  );

  const nextPaginated = Effect.fn("CodexConversationHistoryExport.nextPaginated")(function* (
    job: PaginatedExportJob,
  ) {
    const page = yield* fenced(job, () =>
      historyPages.loadTurnPage({
        capability: job.capability,
        threadId: job.threadId,
        cursor: job.turnCursor,
        initialItemsCursor: null,
        limit: 1,
        sortDirection: "asc",
        itemBudget: 100,
        purpose: "export",
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof CodexConversationHistoryExportError
          ? cause
          : exportError("history-unavailable", {
              threadId: job.threadId,
              jobId: job.jobId,
              cause,
            }),
      ),
    );
    const turn = page.turns[0];
    if (!turn) {
      if (page.nextCursor !== null) {
        return yield* exportError("history-unavailable", {
          threadId: job.threadId,
          jobId: job.jobId,
          cause: new Error("Turn export cursor advanced without returning a turn"),
        });
      }
      jobs.delete(job.jobId);
      return {
        jobId: job.jobId,
        turn: null,
        completedTurnCount: job.completedTurnCount,
        totalTurnCount: null,
        done: true,
      } satisfies CodexConversationHistoryExportNextResult;
    }
    const pagination = page.itemsPaginationByTurnId[turn.id];
    if (!pagination) {
      return yield* exportError("history-unavailable", {
        threadId: job.threadId,
        jobId: job.jobId,
        cause: new Error(`Missing item pagination for turn '${turn.id}'`),
      });
    }
    const completeTurn = yield* hydrateCompleteTurn(job, turn, pagination.olderCursor);
    const projected = yield* Effect.try({
      try: () =>
        projectExportTurn({
          snapshot: job.baseSnapshot,
          hydration: job.hydration,
          turn: completeTurn,
        }),
      catch: (cause) =>
        exportError("history-unavailable", {
          threadId: job.threadId,
          jobId: job.jobId,
          cause,
        }),
    });
    if (approximateValueBytes(projected) > CODEX_HISTORY_EXPORT_MAX_TURN_BYTES) {
      return yield* exportError("turn-too-large", {
        threadId: job.threadId,
        jobId: job.jobId,
        cause: new Error("Projected export Turn exceeds its bounded working set"),
      });
    }
    job.turnCursor = page.nextCursor;
    job.completedTurnCount += 1;
    const done = page.nextCursor === null;
    if (done) jobs.delete(job.jobId);
    return {
      jobId: job.jobId,
      turn: projected,
      completedTurnCount: job.completedTurnCount,
      totalTurnCount: null,
      done,
    } satisfies CodexConversationHistoryExportNextResult;
  });

  const nextResident = (job: ResidentExportJob): CodexConversationHistoryExportNextResult => {
    const turn = job.residentTurns[job.residentIndex] ?? null;
    if (turn) {
      job.residentIndex += 1;
      job.completedTurnCount += 1;
    }
    const done = job.residentIndex >= job.residentTurns.length;
    if (done) jobs.delete(job.jobId);
    return {
      jobId: job.jobId,
      turn,
      completedTurnCount: job.completedTurnCount,
      totalTurnCount: job.residentTurns.length,
      done,
    };
  };

  const start = Effect.fn("CodexConversationHistoryExport.start")(function* (input: {
    readonly consumerId: string;
    readonly threadId: string;
  }) {
    return yield* startAdmission.withPermits(1)(
      Effect.gen(function* () {
        const now = Date.now();
        removeExpiredJobs(now);
        cancelMatchingJob(input.consumerId, input.threadId);
        makeRoomForJob();
        if (jobs.size >= CODEX_HISTORY_EXPORT_MAX_ACTIVE_JOBS) {
          return yield* exportError("history-unavailable", {
            threadId: input.threadId,
            cause: new Error("Too many history export jobs are active"),
          });
        }
        const aggregate = conversations.current(input.threadId);
        const snapshot = aggregate?.readSnapshot() ?? null;
        const canonical = aggregate?.readCanonicalState() ?? null;
        const hydration = canonical?.sidecar.hydrationContext ?? null;
        if (!snapshot || !canonical || !hydration) {
          return yield* exportError("history-unavailable", {
            threadId: input.threadId,
            cause: new Error("Thread must be resumed before exporting its history"),
          });
        }

        const jobId = `history-export:${now}:${nextJobSequence++}`;
        const isPaginated = canonical.protocol.historyMode === "paginated";
        if (isPaginated) {
          const capability = yield* capabilities
            .forThread(input.threadId)
            .pipe(
              Effect.mapError((cause) =>
                exportError("history-unavailable", { threadId: input.threadId, jobId, cause }),
              ),
            );
          if (!capability.flags.paginatedHistory) {
            return yield* exportError("unsupported-history", {
              threadId: input.threadId,
              jobId,
              cause: new Error("This Codex host cannot stream paginated history"),
            });
          }
          jobs.set(jobId, {
            jobId,
            consumerId: input.consumerId,
            threadId: input.threadId,
            mode: "paginated",
            capability,
            baseSnapshot: snapshot,
            hydration,
            turnCursor: null,
            completedTurnCount: 0,
            lastTouchedAtMs: now,
            busy: false,
          });
          return {
            jobId,
            mode: "paginated",
            completedTurnCount: 0,
            totalTurnCount: null,
          } satisfies CodexConversationHistoryExportStartResult;
        }

        const hasPartialItems = Object.values(snapshot.turnItemsPaginationById ?? {}).some(
          (pagination) => !pagination.hasLoadedOldest,
        );
        if (snapshot.turnPagination?.hasLoadedOldest === false || hasPartialItems) {
          return yield* exportError("unsupported-history", {
            threadId: input.threadId,
            jobId,
            cause: new Error("Legacy history is not fully resident and cannot be exported safely"),
          });
        }
        jobs.set(jobId, {
          jobId,
          consumerId: input.consumerId,
          threadId: input.threadId,
          mode: "resident",
          capability: null,
          baseSnapshot: snapshot,
          hydration,
          residentTurns: snapshot.turns,
          residentIndex: 0,
          completedTurnCount: 0,
          lastTouchedAtMs: now,
          busy: false,
        });
        return {
          jobId,
          mode: "resident",
          completedTurnCount: 0,
          totalTurnCount: snapshot.turns.length,
        } satisfies CodexConversationHistoryExportStartResult;
      }),
    );
  });

  const next = Effect.fn("CodexConversationHistoryExport.next")(function* (input: {
    readonly consumerId: string;
    readonly jobId: string;
  }) {
    removeExpiredJobs(Date.now());
    const job = jobs.get(input.jobId);
    if (!job || job.consumerId !== input.consumerId) {
      return yield* exportError("invalid-job", {
        jobId: input.jobId,
        cause: new Error("History export job is unavailable"),
      });
    }
    if (job.busy) {
      return yield* exportError("concurrent-next", {
        threadId: job.threadId,
        jobId: job.jobId,
        cause: new Error("Only one history export page may be requested at a time"),
      });
    }
    job.busy = true;
    job.lastTouchedAtMs = Date.now();
    return yield* (
      job.mode === "paginated" ? nextPaginated(job) : Effect.sync(() => nextResident(job))
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (isCurrentJob(job)) {
            job.busy = false;
            job.lastTouchedAtMs = Date.now();
          }
        }),
      ),
    );
  });

  const cancel = (input: { readonly consumerId: string; readonly jobId: string }) =>
    Effect.sync(() => {
      const job = jobs.get(input.jobId);
      if (!job || job.consumerId !== input.consumerId) return false;
      jobs.delete(input.jobId);
      return true;
    });

  yield* Effect.addFinalizer(() => Effect.sync(() => jobs.clear()));
  return CodexConversationHistoryExport.of({ start, next, cancel });
});
