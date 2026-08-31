import type { ThreadSourceKind } from "@nodex/codex-app-server-protocol/v2/ThreadSourceKind";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
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
import { CODEX_AGENT_BACKEND_BINDING } from "../../shared/agent-backend";
import type {
  CodexSidebarSnapshot,
  CodexThreadSummary,
  CodexThreadSummaryWindow,
  CodexThreadSummaryWindowInput,
  CommandPaletteThreadListInput,
  CommandPaletteThreadSearchInput,
  CommandPaletteThreadSearchResult,
  CommandPaletteThreadSummary,
  Project,
  ProjectSession,
} from "../../shared/types";
import { CoreModuleResponseError } from "../core-client/core-client";
import { applyResultCursor } from "../core-client/types";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import {
  appendMissingCodexProjectMoveSources,
  listMissingCodexProjectMoveSources,
  resolveCodexProjectlessThreadWorkspaceMove,
  resolveCodexProjectThreadWorkspaceMove,
} from "../codex/codex-sidebar-thread-move";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { projectCoreWorkspaceThread } from "./CodexThreadDirectoryProjection";
import { CodexThreadExecution } from "./CodexThreadExecution";
import {
  buildCoreWorkspaceTaskThreadSummary,
  hasSidebarThreadSummaryChanged,
  isNonSidebarThreadWithoutParent,
  parseThreadStatus,
  projectCoreWorkspaceProject,
  resolveSidebarProjectIdForCwd,
  resolveSidebarThreadTitle,
} from "./CodexThreadCatalogProjection";

export class CodexThreadCatalogError extends Data.TaggedError("CodexThreadCatalogError")<{
  readonly operation:
    | "list-pinned"
    | "list-project"
    | "list-palette"
    | "search-palette"
    | "set-pinned"
    | "reorder-pinned"
    | "move"
    | "resolve"
    | "ensure-session"
    | "publish";
  readonly cause: unknown;
}> {}

export interface CodexThreadCatalogOptions {
  readonly foldPathCase?: boolean;
}

export class CodexThreadCatalog extends Context.Service<
  CodexThreadCatalog,
  {
    readonly listPinned: Effect.Effect<readonly string[], CodexThreadCatalogError>;
    readonly listProject: (
      projectId: string,
      input?: CodexThreadSummaryWindowInput,
    ) => Effect.Effect<CodexThreadSummaryWindow, CodexThreadCatalogError>;
    readonly listPalette: (
      input: CommandPaletteThreadListInput,
    ) => Effect.Effect<readonly CommandPaletteThreadSummary[], CodexThreadCatalogError>;
    readonly searchPalette: (
      input: CommandPaletteThreadSearchInput,
    ) => Effect.Effect<readonly CommandPaletteThreadSearchResult[], CodexThreadCatalogError>;
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

const CODEX_SIDEBAR_THREAD_SOURCE_KINDS = [] as const satisfies readonly ThreadSourceKind[];
const COMMAND_PALETTE_THREAD_SEARCH_DEFAULT_LIMIT = 50;
const COMMAND_PALETTE_THREAD_SEARCH_MAX_LIMIT = 60;
export const CODEX_PINNED_THREAD_LIST_PAGE_SIZE = 200;
export const CODEX_PINNED_THREAD_LIST_MAX_PAGES = 5;
export const CODEX_PINNED_THREAD_LIST_MAX_RESULTS = 1_000;
export const CODEX_PINNED_THREAD_LIST_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const CODEX_PINNED_THREAD_LIST_MAX_RESULT_BYTES = 256 * 1024;
export const CODEX_PINNED_THREAD_LIST_PAGE_DEADLINE = "3 seconds";
export const CODEX_THREAD_PALETTE_SEARCH_MAX_PAGES = 5;
export const CODEX_THREAD_PALETTE_SEARCH_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const CODEX_THREAD_PALETTE_SEARCH_MAX_RESULT_BYTES = 256 * 1024;
export const CODEX_THREAD_PALETTE_SEARCH_PAGE_DEADLINE = "3 seconds";
type CoreTaskWindow = Extract<
  import("../core-client/types").ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "task_window" }
>["tasks"];

const normalizeSearchLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit)) return COMMAND_PALETTE_THREAD_SEARCH_DEFAULT_LIMIT;
  return Math.min(
    COMMAND_PALETTE_THREAD_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(limit ?? COMMAND_PALETTE_THREAD_SEARCH_DEFAULT_LIMIT)),
  );
};

const isCoreNotFound = (cause: unknown): boolean =>
  cause instanceof CoreRuntimeError &&
  cause.cause instanceof CoreModuleResponseError &&
  cause.cause.coreError.code === "not_found";

export const make = (
  options: CodexThreadCatalogOptions = {},
): Effect.Effect<
  CodexThreadCatalog["Service"],
  never,
  | CodexGateway
  | CodexInternalThreadRegistry
  | CodexSidebarSyncRuntime
  | CodexThreadDirectory
  | CodexThreadExecution
  | CoreModules
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const gateway = yield* CodexGateway;
    const internalThreads = yield* CodexInternalThreadRegistry;
    const sidebar = yield* CodexSidebarSyncRuntime;
    const directory = yield* CodexThreadDirectory;
    const execution = yield* CodexThreadExecution;
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
      const response = yield* core.workspace.read({
        kind: "project_window",
        include_archived: false,
        window: { after: null, first: 200 },
      });
      if (response.value.kind !== "project_window") {
        return yield* error("list-palette", new Error("Core returned the wrong Project read"));
      }
      if (response.value.projects.next_cursor) {
        return yield* error(
          "list-palette",
          new Error("Available Project collection exceeded its Core bound"),
        );
      }
      return response.value.projects.items.map(projectCoreWorkspaceProject);
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

    const listPalette = Effect.fn("CodexThreadCatalog.listPalette")(function* (
      input: CommandPaletteThreadListInput,
    ) {
      if (input.scope !== "sidebar") return [];
      const projects = yield* readProjects();
      const projectNames = new Map(projects.map((project) => [project.id, project.name] as const));
      const summaries: CommandPaletteThreadSummary[] = [];
      const seen = new Set<string>();
      const add = (tasks: CoreTaskWindow): void => {
        for (const task of tasks.items) {
          if (summaries.length >= 100 || !task.thread || task.thread.parent_thread_id) continue;
          if (task.thread.backend_binding.kind !== "codex") continue;
          if (task.session.archived || task.thread.archived || seen.has(task.thread.thread_id)) {
            continue;
          }
          seen.add(task.thread.thread_id);
          summaries.push({
            backendBinding: CODEX_AGENT_BACKEND_BINDING,
            threadId: task.thread.thread_id,
            sessionId: task.session.id,
            projectId: task.session.project_id ?? null,
            projectName: task.session.project_id
              ? (projectNames.get(task.session.project_id) ?? null)
              : null,
            title: task.session.display_title,
            preview: task.thread.thread_preview,
            cwd: task.thread.cwd ?? null,
            gitBranch: null,
            projectless: task.session.project_id == null,
            pinned: task.session.pinned,
            pinnedOrder: task.session.pinned_order ?? null,
            statusType: task.thread.status.status_type,
            statusActiveFlags: [...task.thread.status.active_flags],
            createdAt: task.thread.created_at,
            updatedAt: task.thread.recency_at,
          });
        }
      };
      add(yield* readTaskWindow({ projectId: null, pinned: true, first: 100 }));
      if (summaries.length < 100) {
        add(yield* readTaskWindow({ projectId: null, first: 100 - summaries.length }));
      }
      for (const project of projects) {
        if (summaries.length >= 100) break;
        add(
          yield* readTaskWindow({
            projectId: project.id,
            first: 100 - summaries.length,
          }),
        );
      }
      return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 100);
    });

    const resolveThread = Effect.fn("CodexThreadCatalog.resolve")(function* (threadId: string) {
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
      if (
        input.projectAccessGrant &&
        input.projectAccessGrant.targetProjectId !== target.projectId
      ) {
        return yield* error("move", new Error("Project access grant does not match its target"));
      }
      if (input.projectAccessGrant && target.projectId === current.projectId) {
        return yield* error(
          "move",
          new Error("Project access grant requires a cross-Project move"),
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
      const missingSources = listMissingCodexProjectMoveSources(sourceProject, targetProject);
      let targetForMove: Project | null = targetProject;
      let projectAccessGrant:
        | {
            readonly expected_target_binding_revision: number;
            readonly missing_source_roots: readonly string[];
          }
        | undefined;
      if (missingSources.length > 0) {
        if (!targetProject || !target.projectId) {
          return yield* error("move", new Error("Target Project is unavailable"));
        }
        const grant = input.projectAccessGrant;
        const matches =
          grant?.targetProjectId === target.projectId &&
          grant.expectedBindingRevision === targetProject.bindingRevision &&
          grant.missingProjectSources.length === missingSources.length &&
          grant.missingProjectSources.every((root, index) => root === missingSources[index]);
        if (!matches) {
          return {
            status: "confirmation-required" as const,
            reason: "target-project-needs-source-access" as const,
            threadId: input.threadId,
            targetProjectId: target.projectId,
            targetBindingRevision: targetProject.bindingRevision,
            missingProjectSources: missingSources,
            targetProjectName: targetProject.name,
          };
        }
        targetForMove = appendMissingCodexProjectMoveSources(targetProject, missingSources);
        projectAccessGrant = {
          expected_target_binding_revision: targetProject.bindingRevision,
          missing_source_roots: missingSources,
        };
      }

      const currentWorkspace = {
        cwd: current.cwd,
        managedWorktreePath: current.managedWorktreePath,
        projectlessOutputDirectory: current.projectlessOutputDirectory,
        projectlessWorkspaceBrowserRoot: current.projectlessWorkspaceBrowserRoot,
      };
      const workspaceMove =
        current.projectId === target.projectId
          ? {
              next: currentWorkspace,
              runtimeWorkspaceRoots: [...currentRaw.writable_roots],
            }
          : targetForMove
            ? yield* Effect.tryPromise({
                try: () =>
                  resolveCodexProjectThreadWorkspaceMove({
                    current: currentWorkspace,
                    targetProject: targetForMove,
                    threadTitle: current.threadName ?? current.threadPreview ?? input.threadId,
                    createProjectlessWorkspace: (workspaceInput) =>
                      createCodexProjectlessWorkspace(workspaceInput),
                  }),
                catch: (cause) => error("move", cause),
              })
            : resolveCodexProjectlessThreadWorkspaceMove({
                current: currentWorkspace,
                persistedRuntimeWorkspaceRoots: currentRaw.writable_roots,
              });
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
          metadata:
            current.projectId === target.projectId
              ? {}
              : {
                  cwd: workspaceMove.next.cwd,
                  managed_worktree_path: workspaceMove.next.managedWorktreePath,
                  projectless_output_directory: workspaceMove.next.projectlessOutputDirectory,
                  projectless_workspace_browser_root:
                    workspaceMove.next.projectlessWorkspaceBrowserRoot,
                },
          ...(current.projectId === target.projectId
            ? {}
            : { runtime_workspace_roots: workspaceMove.runtimeWorkspaceRoots }),
          ...(projectAccessGrant ? { project_access_grant: projectAccessGrant } : {}),
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
      if (current.projectId !== target.projectId && workspaceMove.next.cwd) {
        yield* execution
          .relocate({
            threadId: input.threadId,
            loaded: current.statusType !== "notLoaded",
            location: {
              hostId: movedRaw.execution_host_id,
              cwd: workspaceMove.next.cwd,
              workspaceRoots: workspaceMove.runtimeWorkspaceRoots,
              managedWorktreePath: workspaceMove.next.managedWorktreePath,
              projectId: target.projectId,
              projectlessOutputDirectory: workspaceMove.next.projectlessOutputDirectory,
              projectlessWorkspaceBrowserRoot: workspaceMove.next.projectlessWorkspaceBrowserRoot,
            },
          })
          .pipe(Effect.mapError((cause) => error("move", cause)));
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
      listPalette: (input) =>
        runOwned(listPalette(input).pipe(Effect.mapError((cause) => error("list-palette", cause)))),
      searchPalette: (input) => {
        const query = input.query.trim();
        if (!query) return Effect.succeed([]);
        return runOwned(
          Effect.gen(function* () {
            const [local, projects] = yield* Effect.all(
              [listPalette({ scope: "sidebar" }), readProjects()] as const,
              { concurrency: "unbounded" },
            );
            const localById = new Map(local.map((thread) => [thread.threadId, thread] as const));
            const projectNames = new Map(
              projects.map((project) => [project.id, project.name] as const),
            );
            const results: CommandPaletteThreadSearchResult[] = [];
            const seen = new Set<string>();
            const seenCursors = new Set<string>();
            let cursor: string | null = null;
            let retainedBytes = 0;
            const limit = normalizeSearchLimit(input.limit);
            const connection = yield* gateway.connection(gateway.localHostId);
            if (connection.kind !== "ready") {
              return yield* error(
                "search-palette",
                new Error("Codex app-server is unavailable for Thread search"),
              );
            }
            const generationFence = codexGatewayGenerationFence(connection);
            for (let page = 0; page < CODEX_THREAD_PALETTE_SEARCH_MAX_PAGES; page += 1) {
              if (cursor) {
                if (seenCursors.has(cursor)) {
                  return yield* error(
                    "search-palette",
                    new Error("Thread search cursor did not advance"),
                  );
                }
                seenCursors.add(cursor);
              }
              const requestedLimit = limit - results.length;
              const loaded = yield* gateway
                .requestLocal(
                  "thread/search",
                  {
                    cursor,
                    limit: requestedLimit,
                    sortKey: "updated_at",
                    sortDirection: "desc",
                    sourceKinds: [...CODEX_SIDEBAR_THREAD_SOURCE_KINDS],
                    archived: false,
                    searchTerm: query,
                  },
                  {
                    ...generationFence,
                    priority: "interactive",
                    source: "thread_catalog",
                    timeoutMs: 3_000,
                  },
                )
                .pipe(Effect.timeoutOption(CODEX_THREAD_PALETTE_SEARCH_PAGE_DEADLINE));
              if (Option.isNone(loaded)) {
                return yield* error(
                  "search-palette",
                  new Error("Thread search page exceeded its bounded deadline"),
                );
              }
              const response: ClientRequestResponsesByMethod["thread/search"] = loaded.value;
              if (
                response.data.length > requestedLimit ||
                cappedApproximateValueBytes(
                  response.data,
                  CODEX_THREAD_PALETTE_SEARCH_MAX_PAGE_BYTES,
                ) > CODEX_THREAD_PALETTE_SEARCH_MAX_PAGE_BYTES
              ) {
                return yield* error(
                  "search-palette",
                  new Error("Thread search page exceeded its bounded admission budget"),
                );
              }
              for (const item of response.data) {
                const thread = item.thread;
                if (
                  thread.ephemeral ||
                  thread.parentThreadId ||
                  internalThreads.shouldSuppress(thread.id) ||
                  isNonSidebarThreadWithoutParent(thread as unknown as Record<string, unknown>) ||
                  seen.has(thread.id)
                ) {
                  continue;
                }
                seen.add(thread.id);
                const persisted = localById.get(thread.id);
                const inferred = resolveSidebarProjectIdForCwd(
                  thread.cwd,
                  projects,
                  options.foldPathCase === true,
                );
                const projectId = persisted?.projectId ?? inferred;
                const status = parseThreadStatus(thread.status);
                const result: CommandPaletteThreadSearchResult = {
                  thread: {
                    backendBinding: CODEX_AGENT_BACKEND_BINDING,
                    threadId: thread.id,
                    sessionId: persisted?.sessionId ?? null,
                    projectId,
                    projectName: projectId
                      ? (projectNames.get(projectId) ?? persisted?.projectName ?? null)
                      : null,
                    title: resolveSidebarThreadTitle({
                      threadName: thread.name,
                      threadPreview: thread.preview,
                    }),
                    preview: thread.preview,
                    cwd: thread.cwd,
                    gitBranch: thread.gitInfo?.branch ?? null,
                    projectless: projectId === null,
                    pinned: persisted?.pinned ?? false,
                    pinnedOrder: persisted?.pinnedOrder ?? null,
                    statusType: persisted?.statusType ?? status.statusType,
                    statusActiveFlags: persisted?.statusActiveFlags ?? status.statusActiveFlags,
                    createdAt: Number(thread.createdAt) * 1_000,
                    updatedAt: Number(thread.recencyAt ?? thread.updatedAt) * 1_000,
                  },
                  snippet: item.snippet,
                };
                const resultBytes = cappedApproximateValueBytes(
                  result,
                  CODEX_THREAD_PALETTE_SEARCH_MAX_RESULT_BYTES - retainedBytes,
                );
                if (resultBytes > CODEX_THREAD_PALETTE_SEARCH_MAX_RESULT_BYTES - retainedBytes) {
                  return yield* error(
                    "search-palette",
                    new Error("Thread search results exceeded their bounded retention budget"),
                  );
                }
                results.push(result);
                retainedBytes += resultBytes;
                if (results.length >= limit) break;
              }
              cursor = response.nextCursor ?? null;
              if (cursor === null || results.length >= limit) return results;
            }
            return yield* error(
              "search-palette",
              new Error("Thread search exceeded its bounded page budget"),
            );
          }).pipe(Effect.mapError((cause) => error("search-palette", cause))),
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
