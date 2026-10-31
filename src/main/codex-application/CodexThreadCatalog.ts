import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  CodexSidebarThreadMoveInputSchema,
  readCodexSidebarThreadContainerLocation,
  type CodexSidebarThreadMoveInput,
  type CodexSidebarThreadMoveResult,
} from "../../shared/codex-sidebar-thread-move";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import { isAgentExecutionThreadId } from "../../shared/agent-runtime-api";
import type {
  CodexSidebarSnapshot,
  CodexThreadSummary,
  CodexThreadSummaryWindow,
  CodexThreadSummaryWindowInput,
  ProjectSession,
} from "../../shared/types";
import { CoreModuleResponseError } from "../core-client/core-client";
import { applyResultCursor } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { projectCoreWorkspaceThread } from "./CodexThreadDirectoryProjection";
import {
  buildCoreWorkspaceTaskThreadSummary,
  hasSidebarThreadSummaryChanged,
  projectCoreWorkspaceProject,
} from "./CodexThreadCatalogProjection";

export class CodexThreadCatalogError extends Data.TaggedError("CodexThreadCatalogError")<{
  readonly operation:
    | "list-pinned"
    | "list-project"
    | "set-pinned"
    | "reorder-pinned"
    | "move"
    | "resolve"
    | "ensure-session"
    | "publish";
  readonly cause: unknown;
}> {}

export class CodexThreadCatalog extends Context.Service<
  CodexThreadCatalog,
  {
    readonly listPinned: Effect.Effect<readonly string[], CodexThreadCatalogError>;
    readonly listProject: (
      projectId: string,
      input?: CodexThreadSummaryWindowInput,
    ) => Effect.Effect<CodexThreadSummaryWindow, CodexThreadCatalogError>;
    readonly resolve: (
      threadId: string,
    ) => Effect.Effect<CodexThreadSummary | null, CodexThreadCatalogError>;
    readonly ensureSession: (
      threadId: string,
    ) => Effect.Effect<ProjectSession | null, CodexThreadCatalogError>;
    readonly setPinned: (
      threadId: string,
      pinned: boolean,
      beforeThreadId?: string | null,
    ) => Effect.Effect<CodexSidebarSnapshot, CodexThreadCatalogError>;
    readonly reorderPinned: (
      orderedThreadIds: readonly string[],
    ) => Effect.Effect<CodexSidebarSnapshot, CodexThreadCatalogError>;
    readonly move: (
      input: CodexSidebarThreadMoveInput,
    ) => Effect.Effect<CodexSidebarThreadMoveResult, CodexThreadCatalogError>;
  }
>()("nodex/main/codex-application/CodexThreadCatalog") {}

export const CODEX_PINNED_THREAD_LIST_PAGE_SIZE = 200;
export const CODEX_PINNED_THREAD_LIST_MAX_PAGES = 5;
export const CODEX_PINNED_THREAD_LIST_MAX_RESULTS = 1_000;
export const CODEX_PINNED_THREAD_LIST_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const CODEX_PINNED_THREAD_LIST_MAX_RESULT_BYTES = 256 * 1024;
export const CODEX_PINNED_THREAD_LIST_PAGE_DEADLINE = "3 seconds";
type CoreTaskWindow = Extract<
  import("../core-client/types").ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "task_window" }
>["tasks"];

const isCoreNotFound = (cause: unknown): boolean =>
  cause instanceof CoreRuntimeError &&
  cause.cause instanceof CoreModuleResponseError &&
  cause.cause.coreError.code === "not_found";

export const make = (): Effect.Effect<
  CodexThreadCatalog["Service"],
  never,
  CodexGateway | CodexSidebarSyncRuntime | CodexThreadDirectory | CoreModules | Scope.Scope
> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const gateway = yield* CodexGateway;
    const sidebar = yield* CodexSidebarSyncRuntime;
    const directory = yield* CodexThreadDirectory;
    const core = yield* CoreModules;
    const mutations = yield* Semaphore.make(1);
    const error = (operation: CodexThreadCatalogError["operation"], cause: unknown) =>
      cause instanceof CodexThreadCatalogError
        ? cause
        : new CodexThreadCatalogError({ operation, cause });
    const runOwned = <A>(
      operation: Effect.Effect<A, CodexThreadCatalogError>,
    ): Effect.Effect<A, CodexThreadCatalogError> =>
      Effect.acquireUseRelease(
        operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
        Fiber.join,
        Fiber.interrupt,
      );
    const runMutation = <A>(operation: Effect.Effect<A, CodexThreadCatalogError>) =>
      runOwned(mutations.withPermit(operation));

    const readProjects = Effect.fn("CodexThreadCatalog.readProjects")(function* () {
      const projects = [];
      let after: string | null = null;
      const cursors = new Set<string>();
      do {
        const response: ProjectWorkspaceReadSnapshot = yield* core.workspace.read({
          kind: "project_window",
          include_archived: false,
          window: { after, first: 200 },
        });
        if (response.value.kind !== "project_window")
          return yield* error("move", new Error("Core returned the wrong Project read"));
        projects.push(...response.value.projects.items.map(projectCoreWorkspaceProject));
        after = response.value.projects.next_cursor ?? null;
        if (after && cursors.has(after))
          return yield* error("move", new Error("Project cursor did not advance"));
        if (after) cursors.add(after);
      } while (after !== null);
      return projects;
    });

    const readTaskWindow = Effect.fn("CodexThreadCatalog.readTaskWindow")(function* (input: {
      readonly projectId: string | null;
      readonly includeArchived?: boolean;
      readonly after?: string | null;
      readonly first?: number;
      readonly pinned?: boolean;
    }) {
      const response = yield* core.workspace.read(
        input.pinned
          ? {
              kind: "sidebar_overview" as const,
              include_archived: input.includeArchived === true,
              pinned_window: { after: input.after ?? null, first: input.first ?? 100 },
            }
          : {
              kind: "task_window" as const,
              project_id: input.projectId,
              include_archived: input.includeArchived === true,
              window: { after: input.after ?? null, first: input.first ?? 100 },
            },
      );
      const tasks =
        response.value.kind === "sidebar_overview"
          ? response.value.pinned_tasks
          : response.value.kind === "task_window"
            ? response.value.tasks
            : null;
      if (!tasks) {
        return yield* error("list-project", new Error("Core returned the wrong Task read"));
      }
      return tasks;
    });

    const readCoreThread = Effect.fn("CodexThreadCatalog.readThread")(function* (threadId: string) {
      const response = yield* core.workspace
        .read({ kind: "thread", thread_id: threadId })
        .pipe(
          Effect.catch((cause) =>
            isCoreNotFound(cause) ? Effect.succeed(null) : Effect.fail(cause),
          ),
        );
      if (response === null) return null;
      if (response.value.kind !== "thread") {
        return yield* error("resolve", new Error("Core returned the wrong Thread read"));
      }
      return response.value.thread;
    });

    const publish = (input: {
      readonly projectIds?: readonly string[];
      readonly projectless?: boolean;
      readonly force?: boolean;
    }): Effect.Effect<CodexSidebarSnapshot, CodexThreadCatalogError> =>
      sidebar
        .changed({
          reason: "session-change",
          changedProjectIds: input.projectIds,
          projectlessChanged: input.projectless,
          forceEmit: input.force,
        })
        .pipe(
          Effect.map((result) => result.snapshot),
          Effect.mapError((cause) => error("publish", cause)),
        );

    const readSnapshot = () =>
      sidebar.sync({ policy: "read", reason: "session-change" }).pipe(
        Effect.map((result) => result.snapshot),
        Effect.mapError((cause) => error("publish", cause)),
      );

    /** An Agent chat is named by its execution root Thread and opened through its Session. */
    const resolveAgentChat = Effect.fn("CodexThreadCatalog.resolveAgentChat")(function* (
      threadId: string,
    ) {
      const found = yield* core.workspace
        .read({ kind: "agent_runtime_session_binding_by_thread", runtime_thread_id: threadId })
        .pipe(Effect.mapError((cause) => error("resolve", cause)));
      if (found.value.kind !== "agent_runtime_session_binding") {
        return yield* error("resolve", new Error("Core returned the wrong binding read"));
      }
      const binding = found.value.binding;
      if (!binding) return null;
      const read = yield* core.workspace
        .read(
          { kind: "session", session_id: binding.session_id },
          undefined,
          binding.project_id ?? null,
        )
        .pipe(Effect.mapError((cause) => error("resolve", cause)));
      if (read.value.kind !== "session") {
        return yield* error("resolve", new Error("Core returned the wrong Session read"));
      }
      const session = read.value.session;
      const summary: CodexThreadSummary = {
        threadId,
        sessionId: session.id,
        projectId: session.project_id ?? null,
        source: null,
        threadName: session.display_title,
        threadPreview: "",
        cwd: null,
        statusType: "notLoaded",
        statusActiveFlags: [],
        archived: session.archived,
        createdAt: Date.parse(session.created_at) || 0,
        updatedAt: Date.parse(session.updated_at) || 0,
        linkedAt: binding.bound_at,
      };
      return summary;
    });

    const resolveThread = Effect.fn("CodexThreadCatalog.resolve")(function* (threadId: string) {
      if (isAgentExecutionThreadId(threadId)) return yield* resolveAgentChat(threadId);
      const before = yield* directory
        .resolve({ threadId, fidelity: "durable" })
        .pipe(Effect.mapError((cause) => error("resolve", cause)));
      const resolved = yield* directory
        .resolve({ threadId, fidelity: "durable", hostId: gateway.localHostId })
        .pipe(Effect.mapError((cause) => error("resolve", cause)));
      const summary = resolved?.summary ?? before?.summary ?? null;
      if (summary && hasSidebarThreadSummaryChanged(before?.summary ?? null, summary)) {
        yield* publish({
          projectIds: summary.projectId ? [summary.projectId] : [],
          projectless: summary.projectId === null,
        });
      }
      return summary;
    });

    const placement = (input: CodexSidebarThreadMoveInput) => {
      if (input.useDefaultOrder) return { kind: "default" as const };
      if (input.beforeThreadId) {
        return { kind: "before" as const, thread_id: input.beforeThreadId };
      }
      if (input.afterThreadId) return { kind: "after" as const, thread_id: input.afterThreadId };
      if (input.insertAtEnd) return { kind: "end" as const };
      return { kind: "start" as const };
    };

    const move = Effect.fn("CodexThreadCatalog.move")(function* (
      rawInput: CodexSidebarThreadMoveInput,
    ) {
      const input = yield* Effect.try({
        try: () => CodexSidebarThreadMoveInputSchema.parse(rawInput),
        catch: (cause) => error("move", cause),
      });
      yield* sidebar
        .ensureSession(input.threadId)
        .pipe(Effect.mapError((cause) => error("move", cause)));
      const currentRaw = yield* readCoreThread(input.threadId);
      if (!currentRaw) return yield* error("move", new Error(`Task not found: ${input.threadId}`));
      const current = projectCoreWorkspaceThread(currentRaw);
      const source = readCodexSidebarThreadContainerLocation(input.sourceContainerId);
      const target = readCodexSidebarThreadContainerLocation(input.targetContainerId);
      if (!source || source.projectId !== current.projectId) {
        return yield* error("move", new Error("Sidebar task source changed during drag"));
      }
      if (source.pinned !== (current.pinnedOrder !== null)) {
        return yield* error("move", new Error("Sidebar task pin lane changed during drag"));
      }
      if (!target) {
        return yield* error(
          "move",
          new Error(`Unsupported sidebar target: ${input.targetContainerId}`),
        );
      }
      const projects = yield* readProjects();
      const sourceProject = current.projectId
        ? (projects.find((project) => project.id === current.projectId) ?? null)
        : null;
      const targetProject = target.projectId
        ? (projects.find((project) => project.id === target.projectId) ?? null)
        : null;
      if (current.projectId && !sourceProject) {
        return yield* error("move", new Error(`Project not found: ${current.projectId}`));
      }
      if (target.projectId && !targetProject) {
        return yield* error("move", new Error(`Project not found: ${target.projectId}`));
      }
      const operationId = createOperationId("thread-catalog.move");
      const applied = yield* core.workspace.apply({
        operationId,
        intent: {
          kind: "move_thread",
          thread_id: input.threadId,
          source:
            current.projectId === null
              ? { kind: "projectless" }
              : { kind: "project", project_id: current.projectId },
          target:
            target.projectId === null
              ? { kind: "projectless" }
              : { kind: "project", project_id: target.projectId },
          placement: placement(input),
          metadata: {},
        },
      });
      if (source.pinned || target.pinned) {
        yield* core.workspace.apply({
          operationId: createOperationId("thread-catalog.pin-after-move"),
          intent: {
            kind: "set_thread_pinned",
            thread_id: input.threadId,
            pinned: target.pinned,
            ...(target.pinned
              ? {
                  placement:
                    input.beforeThreadId === null
                      ? { kind: "end" as const }
                      : { kind: "before" as const, thread_id: input.beforeThreadId },
                }
              : {}),
          },
        });
      }
      const movedRaw = yield* readCoreThread(input.threadId);
      if (!movedRaw) {
        return yield* error("move", new Error("Moved Task disappeared from Core"));
      }
      yield* publish({
        projectIds: [current.projectId, target.projectId].filter(
          (projectId): projectId is string => projectId !== null,
        ),
        projectless: current.projectId === null || target.projectId === null,
      });
      return {
        status: "moved" as const,
        threadId: input.threadId,
        source: { projectId: current.projectId },
        destination: { projectId: target.projectId },
        operationId,
        projectionRevision: applyResultCursor(applied),
      };
    });

    return CodexThreadCatalog.of({
      listPinned: runOwned(
        Effect.gen(function* () {
          const ids: string[] = [];
          const seenThreadIds = new Set<string>();
          const seenCursors = new Set<string>();
          let after: string | null = null;
          let retainedBytes = 0;
          for (let page = 0; page < CODEX_PINNED_THREAD_LIST_MAX_PAGES; page += 1) {
            const loaded = yield* readTaskWindow({
              projectId: null,
              pinned: true,
              after,
              first: CODEX_PINNED_THREAD_LIST_PAGE_SIZE,
            }).pipe(Effect.timeoutOption(CODEX_PINNED_THREAD_LIST_PAGE_DEADLINE));
            if (Option.isNone(loaded)) {
              return yield* error(
                "list-pinned",
                new Error("Pinned Thread list page exceeded its bounded deadline"),
              );
            }
            const tasks: CoreTaskWindow = loaded.value;
            if (
              tasks.items.length > CODEX_PINNED_THREAD_LIST_PAGE_SIZE ||
              cappedApproximateValueBytes(tasks.items, CODEX_PINNED_THREAD_LIST_MAX_PAGE_BYTES) >
                CODEX_PINNED_THREAD_LIST_MAX_PAGE_BYTES
            ) {
              return yield* error(
                "list-pinned",
                new Error("Pinned Thread list page exceeded its bounded admission budget"),
              );
            }
            for (const task of tasks.items) {
              const threadId =
                task.thread?.backend_binding.kind === "codex" ? task.thread.thread_id : null;
              if (!threadId || seenThreadIds.has(threadId)) continue;
              if (ids.length >= CODEX_PINNED_THREAD_LIST_MAX_RESULTS) {
                return yield* error(
                  "list-pinned",
                  new Error("Pinned Thread list exceeded its bounded result budget"),
                );
              }
              const threadIdBytes = cappedApproximateValueBytes(
                threadId,
                CODEX_PINNED_THREAD_LIST_MAX_RESULT_BYTES - retainedBytes,
              );
              if (threadIdBytes > CODEX_PINNED_THREAD_LIST_MAX_RESULT_BYTES - retainedBytes) {
                return yield* error(
                  "list-pinned",
                  new Error("Pinned Thread ids exceeded their bounded retention budget"),
                );
              }
              seenThreadIds.add(threadId);
              ids.push(threadId);
              retainedBytes += threadIdBytes;
            }
            const next = tasks.next_cursor ?? null;
            if (next === null) return ids;
            if (seenCursors.has(next)) {
              return yield* error(
                "list-pinned",
                new Error("Pinned Thread list cursor did not advance"),
              );
            }
            seenCursors.add(next);
            after = next;
          }
          return yield* error(
            "list-pinned",
            new Error("Pinned Thread list exceeded its bounded page budget"),
          );
        }).pipe(Effect.mapError((cause) => error("list-pinned", cause))),
      ),
      listProject: (projectId, input = {}) => {
        const normalized = projectId.trim();
        if (!normalized)
          return Effect.fail(error("list-project", new Error("Project id is required")));
        return runOwned(
          readTaskWindow({
            projectId: normalized,
            includeArchived: input.includeArchived,
            after: input.after,
            first: input.first,
          }).pipe(
            Effect.map((tasks) => ({
              items: tasks.items.flatMap((task) =>
                task.thread &&
                task.thread.backend_binding.kind === "codex" &&
                !task.thread.parent_thread_id
                  ? [buildCoreWorkspaceTaskThreadSummary(task.session, task.thread)]
                  : [],
              ),
              nextCursor: tasks.next_cursor ?? null,
              hasMore: tasks.next_cursor != null,
              projectionRevision: tasks.authority.projection_revision,
            })),
            Effect.mapError((cause) => error("list-project", cause)),
          ),
        );
      },
      resolve: (threadId) => {
        const normalized = threadId.trim();
        return normalized ? runOwned(resolveThread(normalized)) : Effect.succeed(null);
      },
      ensureSession: (threadId) =>
        sidebar
          .ensureSession(threadId)
          .pipe(Effect.mapError((cause) => error("ensure-session", cause))),
      setPinned: (threadId, pinned, beforeThreadId) => {
        const normalized = threadId.trim();
        if (!normalized) return runOwned(readSnapshot());
        return runMutation(
          Effect.gen(function* () {
            const thread = yield* readCoreThread(normalized);
            if (!thread) return yield* readSnapshot();
            if (pinned) yield* sidebar.ensureSession(normalized);
            yield* core.workspace.apply({
              operationId: createOperationId("thread-catalog.pin"),
              intent: {
                kind: "set_thread_pinned",
                thread_id: normalized,
                pinned,
                ...(!pinned || beforeThreadId === undefined
                  ? {}
                  : {
                      placement:
                        beforeThreadId === null
                          ? { kind: "end" as const }
                          : { kind: "before" as const, thread_id: beforeThreadId },
                    }),
              },
            });
            return yield* publish({
              projectIds: thread.project_id ? [thread.project_id] : [],
              projectless: thread.project_id == null,
            });
          }).pipe(Effect.mapError((cause) => error("set-pinned", cause))),
        );
      },
      reorderPinned: (orderedThreadIds) =>
        runMutation(
          core.workspace
            .apply({
              operationId: createOperationId("thread-catalog.reorder-pinned"),
              intent: { kind: "reorder_pinned_threads", thread_ids: [...orderedThreadIds] },
            })
            .pipe(
              Effect.andThen(publish({ force: true })),
              Effect.mapError((cause) => error("reorder-pinned", cause)),
            ),
        ),
      move: (input) =>
        runMutation(move(input).pipe(Effect.mapError((cause) => error("move", cause)))),
    });
  });
