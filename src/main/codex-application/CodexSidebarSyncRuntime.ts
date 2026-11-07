import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type {
  CodexSidebarRefreshPolicy,
  CodexSidebarRefreshReason,
  CodexSidebarSnapshot,
  CodexSidebarSyncResult,
  ProjectSession,
} from "../../shared/types";
import { CODEX_AGENT_BACKEND_BINDING } from "../../shared/agent-backend";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import { CoreModules } from "../core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { readCodexLinkedRootSession } from "./CodexLinkedRootSession";
import { projectCoreWorkspaceTask } from "./CodexThreadCatalogProjection";

const CODEX_SIDEBAR_SYNC_PAGE_SIZE = 200;

const archivedRuntimeChatItem = (
  task: ReturnType<typeof projectCoreWorkspaceTask>,
): CodexSidebarSnapshot["items"][number] => ({
  key: `local:session:${task.id}`,
  kind: "local",
  backendBinding: CODEX_AGENT_BACKEND_BINDING,
  runtimeBound: true,
  runLocation: { kind: "local-checkout" },
  hostId: "local",
  threadId: task.executionRef?.threadId ?? task.id,
  parentThreadId: null,
  sessionId: task.id,
  projectId: task.projectId,
  title: task.displayTitle,
  preview: "",
  cwd: null,
  updatedAt: Date.parse(task.updatedAt),
  recencyAt: task.activityAt,
  createdAt: Date.parse(task.createdAt),
  pinned: task.pinned,
  pinnedOrder: task.pinnedOrder,
  unread: task.unread,
  remindAt: task.remindAt,
  archived: task.archived,
  statusType: "idle",
  statusActiveFlags: [],
  projectless: task.projectId === null,
  disabled: false,
});

export interface CodexSidebarSyncInput {
  readonly includeArchived?: boolean;
  readonly policy?: CodexSidebarRefreshPolicy;
  readonly reason?: CodexSidebarRefreshReason;
}

export interface CodexSidebarSyncNotification {
  readonly notificationMethod: string;
  readonly threadId: string;
}

export interface CodexSidebarCatalogChange {
  readonly reason: CodexSidebarRefreshReason;
  readonly changedProjectIds?: readonly string[];
  readonly projectlessChanged?: boolean;
  readonly materializedSessionIds?: readonly string[];
  readonly failedThreadIds?: readonly string[];
  readonly forceEmit?: boolean;
}

export class CodexSidebarSyncError extends Data.TaggedError("CodexSidebarSyncError")<{
  readonly cause: unknown;
}> {}

export interface CodexSidebarSyncRuntimeOptions {
  readonly maxPages?: number;
  readonly maxResults?: number;
  readonly maxPageBytes?: number;
  readonly maxBytes?: number;
  readonly readDeadline?: Duration.Input;
}

export class CodexSidebarSyncRuntime extends Context.Service<
  CodexSidebarSyncRuntime,
  {
    readonly sync: (
      input?: CodexSidebarSyncInput,
    ) => Effect.Effect<CodexSidebarSyncResult, CodexSidebarSyncError>;
    readonly changed: (
      input: CodexSidebarCatalogChange,
    ) => Effect.Effect<CodexSidebarSyncResult, CodexSidebarSyncError>;
    readonly ensureSession: (
      threadId: string,
    ) => Effect.Effect<ProjectSession | null, CodexSidebarSyncError>;
    readonly invalidate: () => void;
    readonly scheduleNotification: (request: CodexSidebarSyncNotification) => void;
  }
>()("nodex/main/codex-application/CodexSidebarSyncRuntime") {}

/** Catalog reads project existing Core ownership; provider history never materializes Sessions implicitly. */
export const make = (options: CodexSidebarSyncRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const executionHosts = yield* ExecutionHostRuntime;
    const events = yield* CodexApplicationEventHub;
    const notifications = yield* DatabaseNotifierRuntime;
    const sweepMaxPages = options.maxPages ?? 10;
    const sweepMaxResults = options.maxResults ?? 1000;
    const sweepMaxPageBytes = options.maxPageBytes ?? 2 * 1024 * 1024;
    const sweepMaxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    const sweepPageDeadline = options.readDeadline ?? "5 seconds";
    let invalidationRevision = 0;
    const cache = new Map<boolean, { revision: number; snapshot: CodexSidebarSnapshot }>();
    const fail = (cause: unknown) => new CodexSidebarSyncError({ cause });
    /**
     * The sidebar's pinned lane, or every archived chat, most recent first. The pinned lane is all
     * or nothing because the sidebar reconciles against it; a long archive stops at its budget.
     */
    const readTasks = Effect.fn("CodexSidebarSync.readTasks")(function* (archived: boolean) {
      const tasks = [] as Array<ReturnType<typeof projectCoreWorkspaceTask>>;
      let projectionRevision = 0;
      let after: string | null = null;
      const seenCursors = new Set<string>();
      let retainedBytes = 0;
      const overBudget = (message: string) =>
        archived ? Effect.succeed({ tasks, projectionRevision }) : fail(new Error(message));
      for (let page = 0; page < sweepMaxPages; page += 1) {
        const taskWindow = { after, first: CODEX_SIDEBAR_SYNC_PAGE_SIZE };
        const loaded = yield* core.workspace
          .read(
            archived
              ? { kind: "session_window", archived: true, window: taskWindow }
              : { kind: "sidebar_overview", include_archived: false, pinned_window: taskWindow },
          )
          .pipe(Effect.timeoutOption(sweepPageDeadline));
        if (Option.isNone(loaded)) {
          return yield* fail(new Error("Sidebar read exceeded its bounded deadline"));
        }
        const response: import("../core-client/types").ProjectWorkspaceReadSnapshot = loaded.value;
        const value = response.value;
        const read =
          value.kind === "session_window"
            ? { ...value.sessions, items: value.sessions.items.map((item) => item.task) }
            : value.kind === "sidebar_overview"
              ? value.pinned_tasks
              : null;
        if (!read) return yield* fail(new Error("Core returned the wrong sidebar read variant"));
        const pageTasks = read.items;
        const pageBytes = cappedApproximateValueBytes(pageTasks, sweepMaxPageBytes);
        if (
          pageTasks.length > CODEX_SIDEBAR_SYNC_PAGE_SIZE ||
          pageBytes > sweepMaxPageBytes ||
          tasks.length > sweepMaxResults - pageTasks.length ||
          retainedBytes > sweepMaxBytes - pageBytes
        ) {
          return yield* overBudget("Sidebar read exceeded its bounded admission budget");
        }
        projectionRevision = Math.max(projectionRevision, read.authority.projection_revision);
        for (const task of pageTasks) tasks.push(projectCoreWorkspaceTask(task));
        retainedBytes += pageBytes;
        const next = read.next_cursor ?? null;
        if (next === null) return { tasks, projectionRevision };
        if (seenCursors.has(next)) {
          return yield* fail(new Error("Sidebar cursor did not advance"));
        }
        seenCursors.add(next);
        after = next;
      }
      return yield* overBudget("Sidebar read exceeded its bounded page budget");
    });

    const buildSnapshot = Effect.fn("CodexSidebarSync.buildSnapshot")(function* (
      includeArchived: boolean,
    ) {
      const [{ tasks, projectionRevision }, hosts, generatedAt] = yield* Effect.all(
        [readTasks(includeArchived), executionHosts.hosts(), Clock.currentTimeMillis] as const,
        { concurrency: "unbounded" },
      );
      const hostNames = new Map(hosts.map((host) => [host.hostId, host.displayName] as const));
      const projectAssignments: Record<string, string> = {};
      const projectlessThreadIds: string[] = [];
      const items = tasks.flatMap((task) => {
        const thread = task.thread;
        if (thread?.parentThreadId) return [];
        if (!thread) {
          // A Runtime-bound chat has no native Thread row. The live sidebar builds its row from the
          // Session, but nothing else can list it once it is archived.
          return includeArchived && task.executionRef ? [archivedRuntimeChatItem(task)] : [];
        }
        const hostId = thread.executionHostId || "local";
        const isLocalHost = hostId === "local";
        const managedWorktreePath = thread.managedWorktreePath ?? null;
        const projectId = task.projectId ?? thread.projectId;
        if (projectId) projectAssignments[thread.threadId] = projectId;
        else projectlessThreadIds.push(thread.threadId);
        return [
          {
            key: `${isLocalHost ? "local" : "remote"}:${thread.threadId}`,
            kind: isLocalHost ? ("local" as const) : ("remote" as const),
            backendBinding: thread.backendBinding,
            runLocation: managedWorktreePath
              ? isLocalHost
                ? ({ kind: "local-worktree", path: managedWorktreePath, phase: "ready" } as const)
                : ({
                    kind: "remote-worktree",
                    hostId,
                    hostDisplayName: hostNames.get(hostId) ?? hostId,
                    path: managedWorktreePath,
                    phase: "ready",
                  } as const)
              : isLocalHost
                ? ({ kind: "local-checkout" } as const)
                : ({
                    kind: "remote-checkout",
                    hostId,
                    hostDisplayName: hostNames.get(hostId) ?? hostId,
                  } as const),
            hostId,
            threadId: thread.threadId,
            parentThreadId: thread.parentThreadId ?? null,
            sessionId: task.id,
            projectId,
            title: task.displayTitle,
            preview: thread.threadPreview,
            cwd: thread.cwd ?? null,
            updatedAt: thread.updatedAt,
            recencyAt: task.activityAt,
            createdAt: thread.createdAt,
            pinned: task.pinned,
            pinnedOrder: task.pinnedOrder,
            unread: task.unread,
            remindAt: task.remindAt,
            archived: task.archived || thread.archived,
            statusType: thread.statusType,
            statusActiveFlags: [...thread.statusActiveFlags],
            projectless: projectId === null,
            disabled: false,
          },
        ];
      });
      return {
        items,
        pinnedThreadIds: items.filter((item) => item.pinned).map((item) => item.threadId),
        projectAssignments,
        projectlessThreadIds,
        revision: projectionRevision,
        generatedAt,
      } satisfies CodexSidebarSnapshot;
    });

    const project = (input: CodexSidebarSyncInput = {}, change?: CodexSidebarCatalogChange) =>
      Effect.gen(function* () {
        const includeArchived = input.includeArchived === true;
        const revisionAtStart = invalidationRevision;
        const current = cache.get(includeArchived);
        const snapshot =
          current?.revision === invalidationRevision && input.policy !== "force"
            ? current.snapshot
            : yield* buildSnapshot(includeArchived);
        cache.set(includeArchived, { revision: revisionAtStart, snapshot });
        const result: CodexSidebarSyncResult = {
          snapshot,
          source: "core",
          refreshed: false,
          refreshedAt: snapshot.generatedAt,
          changedProjectIds: [...(change?.changedProjectIds ?? [])],
          projectlessChanged: change?.projectlessChanged ?? false,
          materializedSessionIds: [...(change?.materializedSessionIds ?? [])],
          failedThreadIds: [...(change?.failedThreadIds ?? [])],
        };
        if (change)
          events.publish({
            kind: "hostMessage",
            value: { type: "sidebarSyncUpdated", hostId: "local", result, reason: change.reason },
          });
        return result;
      }).pipe(Effect.mapError(fail));
    const invalidate = () => {
      invalidationRevision++;
    };
    yield* notifications.projectSessionInvalidations.pipe(
      Stream.runForEach(() => Effect.sync(invalidate)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => cache.clear()));
    return CodexSidebarSyncRuntime.of({
      sync: project,
      changed: (input) =>
        Effect.sync(invalidate).pipe(Effect.andThen(project({ reason: input.reason }, input))),
      ensureSession: (threadId) =>
        readCodexLinkedRootSession(core, { hostId: "local", threadId }).pipe(Effect.mapError(fail)),
      invalidate,
      scheduleNotification: () => invalidate(),
    });
  });
