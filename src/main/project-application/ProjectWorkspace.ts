import { randomUUID } from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { AgentExecutionProfile } from "../../shared/agent-runtime";
import {
  PageChatActivitySummaryInputSchema,
  PageChatLinkInputSchema,
  PageChatWindowInputSchema,
  ProjectSessionCreateInputSchema,
  ProjectSessionRenameInputSchema,
  ProjectSessionThreadLinkInputSchema,
  ProjectSessionUpdateInputSchema,
} from "../../shared/schemas/project-sessions";
import type {
  CodexBackgroundProcessRecord,
  CodexPermissionMode,
  Project,
  ProjectActivitySummaryResult,
  PageChatActivitySummaryInput,
  PageChatActivitySummaryResult,
  PageChatLinkInput,
  PageChatWindow,
  PageChatWindowInput,
  ProjectCreateInput,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectSession,
  ProjectSessionCreateInput,
  ProjectSessionPinnedInput,
  ProjectSessionPinnedOrderInput,
  ProjectSessionRenameInput,
  ProjectSessionSummaryWindow,
  ProjectSessionSummaryWindowInput,
  ProjectSessionThreadLink,
  ProjectSessionThreadLinkInput,
  ProjectSessionUnreadInput,
  ProjectSessionUpdateInput,
  ProjectUpdateInput,
  ProjectWindow,
  ProjectWindowInput,
} from "../../shared/types";
import type {
  SidebarSectionArchiveInput,
  SidebarSectionCreateInput,
  SidebarSectionItemPlacement,
  SidebarSectionItemRef,
  SidebarSectionItemWindow,
  SidebarSectionItemWindowInput,
  SidebarSectionMoveItemInput,
  SidebarSectionRenameInput,
  SidebarSectionSessionCreateInput,
  SidebarSectionSummary,
  SidebarSectionWindow,
  SidebarSectionWindowInput,
} from "../../shared/sidebar-sections";
import type { DynamicToolCatalogSelection } from "../codex/dynamic-tool-registry";
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  projectWorkspaceBackgroundProcessFromCore,
  projectWorkspaceExecutionProfilePatchToCore,
  projectWorkspaceProjectFromCore,
  projectWorkspacePageChatActivitySummaryFromCore,
  projectWorkspacePageChatItemFromCore,
  projectWorkspaceSidebarSectionItemFromCore,
  projectWorkspaceSidebarSectionItemRefToCore,
  projectWorkspaceSidebarSectionSummaryFromCore,
  projectWorkspaceSessionFromCore,
  projectWorkspaceSessionThreadFromCore,
  projectWorkspaceTaskFromCore,
  projectWorkspaceThreadFromCore,
  projectWorkspaceThreadLaneToCore,
  projectWorkspaceThreadMoveMetadataToCore,
  projectWorkspaceThreadMovePlacementToCore,
  projectWorkspaceThreadPatchToCore,
  type DesktopAppServerSweepReconcileResult,
  type DesktopInitialProjectCreateInput,
  type DesktopInitialProjectCreateResult,
  type DesktopManagedWorktreeLifecycleSnapshot,
  type DesktopManagedWorktreeWindow,
  type DesktopProjectBootstrap,
  type DesktopProjectWorkspaceExecutionContext,
  type DesktopProjectWorkspaceExecutionLocation,
  type DesktopProjectWorkspaceSidebar,
  type DesktopProjectWorkspaceThread,
  type DesktopProjectWorkspaceThreadMoveInput,
  type DesktopProjectWorkspaceThreadPatch,
} from "../core-client/project-workspace-adapter";
import {
  applyResultCursor,
  type ProjectWorkspaceApplyInput,
  type ProjectWorkspaceApplyResult,
  type ProjectWorkspaceRead,
  type ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";

export type {
  DesktopAppServerSweepReconcileResult,
  DesktopInitialProjectCreateInput,
  DesktopInitialProjectCreateResult,
  DesktopManagedWorktreeLifecycleConsumer,
  DesktopManagedWorktreeLifecycleSnapshot,
  DesktopManagedWorktreeProjectProtection,
  DesktopManagedWorktreeSummary,
  DesktopManagedWorktreeWindow,
  DesktopProjectBootstrap,
  DesktopProjectWorkspaceExecutionContext,
  DesktopProjectWorkspaceExecutionLocation,
  DesktopProjectWorkspaceSidebar,
  DesktopProjectWorkspaceThread,
  DesktopProjectWorkspaceThreadMoveInput,
  DesktopProjectWorkspaceThreadPatch,
} from "../core-client/project-workspace-adapter";

export class ProjectWorkspaceError extends Schema.TaggedError<ProjectWorkspaceError>()(
  "ProjectWorkspaceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type ProjectWorkspaceEffect<A> = Effect.Effect<A, ProjectWorkspaceError>;

export interface ProjectWorkspaceService {
  readonly readProjectBootstrap: ProjectWorkspaceEffect<DesktopProjectBootstrap>;
  /** Available (non-archived) Projects form one fixed 200-item domain collection. */
  readonly listProjects: ProjectWorkspaceEffect<readonly Project[]>;
  readonly listProjectWindow: (input?: ProjectWindowInput) => ProjectWorkspaceEffect<ProjectWindow>;
  readonly readProjectActivitySummaries: (
    projectIds: readonly string[],
  ) => ProjectWorkspaceEffect<ProjectActivitySummaryResult>;
  readonly readPageChatActivitySummaries: (
    input: PageChatActivitySummaryInput,
  ) => ProjectWorkspaceEffect<PageChatActivitySummaryResult>;
  readonly listPageChatWindow: (
    input: PageChatWindowInput,
  ) => ProjectWorkspaceEffect<PageChatWindow>;
  readonly linkPageToProjectSession: (
    sessionId: string,
    input: PageChatLinkInput,
  ) => ProjectWorkspaceEffect<void>;
  readonly unlinkPageFromProjectSession: (
    sessionId: string,
    input: PageChatLinkInput,
  ) => ProjectWorkspaceEffect<void>;
  readonly getProject: (projectId: string) => ProjectWorkspaceEffect<Project | null>;
  readonly readProjectPermissionMode: (
    projectId: string,
  ) => ProjectWorkspaceEffect<CodexPermissionMode | null>;
  readonly readProjectlessPermissionMode: ProjectWorkspaceEffect<CodexPermissionMode | null>;
  readonly setProjectPermissionMode: (
    projectId: string,
    mode: CodexPermissionMode,
  ) => ProjectWorkspaceEffect<CodexPermissionMode>;
  readonly setProjectlessPermissionMode: (
    mode: CodexPermissionMode,
  ) => ProjectWorkspaceEffect<CodexPermissionMode>;
  readonly createInitialProject: (
    input: DesktopInitialProjectCreateInput,
  ) => ProjectWorkspaceEffect<DesktopInitialProjectCreateResult>;
  readonly createProject: (input: ProjectCreateInput) => ProjectWorkspaceEffect<Project>;
  readonly updateProject: (
    projectId: string,
    input: ProjectUpdateInput,
  ) => ProjectWorkspaceEffect<Project | null>;
  readonly reorderProjects: (input: ProjectOrderInput) => ProjectWorkspaceEffect<void>;
  readonly setProjectPinned: (
    projectId: string,
    input: ProjectPinnedInput,
  ) => ProjectWorkspaceEffect<Project | null>;
  readonly setPinnedProjectOrder: (input: ProjectPinnedOrderInput) => ProjectWorkspaceEffect<void>;
  readonly setProjectLifecycle: (
    projectId: string,
    lifecycle: Project["lifecycle"],
  ) => ProjectWorkspaceEffect<Project | null>;
  readonly listSidebarSections: (
    input?: SidebarSectionWindowInput,
  ) => ProjectWorkspaceEffect<SidebarSectionWindow>;
  readonly listSidebarSectionItems: (
    sectionId: string,
    input?: SidebarSectionItemWindowInput,
  ) => ProjectWorkspaceEffect<SidebarSectionItemWindow>;
  readonly readSidebarSectionPlacement: (
    item: SidebarSectionItemRef,
  ) => ProjectWorkspaceEffect<string | null>;
  readonly createSidebarSection: (
    input: SidebarSectionCreateInput,
  ) => ProjectWorkspaceEffect<SidebarSectionSummary>;
  readonly renameSidebarSection: (
    sectionId: string,
    input: SidebarSectionRenameInput,
  ) => ProjectWorkspaceEffect<SidebarSectionSummary>;
  readonly deleteSidebarSection: (
    sectionId: string,
    expectedRevision: number,
  ) => ProjectWorkspaceEffect<void>;
  readonly restoreSidebarSection: (
    sectionId: string,
    expectedRevision: number,
  ) => ProjectWorkspaceEffect<SidebarSectionSummary>;
  readonly moveSidebarSectionItem: (
    input: SidebarSectionMoveItemInput,
  ) => ProjectWorkspaceEffect<void>;
  readonly reorderSidebarSections: (
    orderedSectionIds: readonly string[],
  ) => ProjectWorkspaceEffect<void>;
  readonly reorderSidebarSectionSessions: (
    sectionId: string,
    orderedSessionIds: readonly string[],
  ) => ProjectWorkspaceEffect<void>;
  readonly archiveSidebarSectionSessions: (
    sectionId: string,
    input?: SidebarSectionArchiveInput,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly createSessionInSidebarSection: (
    input: SidebarSectionSessionCreateInput,
  ) => ProjectWorkspaceEffect<ProjectSession>;
  readonly listProjectSessionSummaryWindow: (
    projectId: string | null,
    input?: ProjectSessionSummaryWindowInput,
  ) => ProjectWorkspaceEffect<ProjectSessionSummaryWindow>;
  readonly readSidebarOverview: (
    includeArchived?: boolean,
    input?: ProjectSessionSummaryWindowInput,
  ) => ProjectWorkspaceEffect<ProjectSessionSummaryWindow>;
  readonly getProjectSession: (sessionId: string) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly updateProjectSession: (
    sessionId: string,
    input: ProjectSessionUpdateInput,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly renameProjectSession: (
    sessionId: string,
    input: ProjectSessionRenameInput,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly ensureDefaultDraftProjectSession: (
    projectId: string | null,
  ) => ProjectWorkspaceEffect<ProjectSession>;
  readonly createProjectSession: (
    input: ProjectSessionCreateInput,
  ) => ProjectWorkspaceEffect<ProjectSession>;
  readonly deleteProjectSession: (sessionId: string) => ProjectWorkspaceEffect<boolean>;
  readonly reorderProjectSessions: (
    projectId: string | null,
    orderedSessionIds: readonly string[],
  ) => ProjectWorkspaceEffect<void>;
  readonly setProjectSessionPinned: (
    sessionId: string,
    input: ProjectSessionPinnedInput,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly setPinnedProjectSessionOrder: (
    projectId: string,
    input: ProjectSessionPinnedOrderInput,
  ) => ProjectWorkspaceEffect<void>;
  readonly archiveProjectSession: (
    sessionId: string,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly unarchiveProjectSession: (
    sessionId: string,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly markProjectSessionUnread: (
    sessionId: string,
    input: ProjectSessionUnreadInput,
  ) => ProjectWorkspaceEffect<ProjectSession | null>;
  readonly upsertProjectSessionThreadLink: (
    input: ProjectSessionThreadLinkInput,
  ) => ProjectWorkspaceEffect<ProjectSessionThreadLink>;
  readonly detachProjectSessionThread: (sessionId: string) => ProjectWorkspaceEffect<boolean>;
  readonly getThread: (
    threadId: string,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceThread | null>;
  readonly upsertThread: (
    threadId: string,
    patch: DesktopProjectWorkspaceThreadPatch,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceThread>;
  readonly updateThread: (
    threadId: string,
    patch: DesktopProjectWorkspaceThreadPatch,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceThread | null>;
  readonly setThreadExecutionLocation: (
    threadId: string,
    location: DesktopProjectWorkspaceExecutionLocation,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceThread | null>;
  readonly moveThread: (input: DesktopProjectWorkspaceThreadMoveInput) => ProjectWorkspaceEffect<{
    readonly thread: DesktopProjectWorkspaceThread;
    readonly operationId: string;
    readonly projectionRevision: number;
  }>;
  readonly setThreadUnread: (
    threadId: string,
    unread: boolean,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceThread | null>;
  readonly setThreadArchived: (
    threadId: string,
    archived: boolean,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceSidebar>;
  readonly deleteThread: (threadId: string) => ProjectWorkspaceEffect<{
    readonly deleted: boolean;
    readonly sidebar: DesktopProjectWorkspaceSidebar;
  }>;
  readonly observeAppServerThreadWindow: (
    sweepId: string,
    threadIds: readonly string[],
  ) => ProjectWorkspaceEffect<void>;
  readonly reconcileAppServerThreadSweep: (
    sweepId: string,
    limit?: number,
  ) => ProjectWorkspaceEffect<DesktopAppServerSweepReconcileResult>;
  readonly readThreadExecutionContext: (
    threadId: string,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceExecutionContext | null>;
  readonly replaceThreadDynamicToolCatalogs: (
    threadId: string,
    catalogs: readonly DynamicToolCatalogSelection[],
  ) => ProjectWorkspaceEffect<readonly DynamicToolCatalogSelection[]>;
  readonly mergeThreadWritableRoots: (
    threadId: string,
    roots: readonly string[],
  ) => ProjectWorkspaceEffect<readonly string[]>;
  readonly replaceThreadWritableRoots: (
    threadId: string,
    roots: readonly string[],
  ) => ProjectWorkspaceEffect<readonly string[]>;
  readonly listBackgroundProcesses: (
    threadId?: string | null,
  ) => ProjectWorkspaceEffect<readonly CodexBackgroundProcessRecord[]>;
  readonly listManagedWorktreeWindow: (input?: {
    readonly projectId?: string | null;
    readonly after?: string | null;
    readonly first?: number;
  }) => ProjectWorkspaceEffect<DesktopManagedWorktreeWindow>;
  readonly readManagedWorktreeLifecycleSnapshot: ProjectWorkspaceEffect<DesktopManagedWorktreeLifecycleSnapshot>;
  readonly upsertBackgroundProcess: (
    input: CodexBackgroundProcessRecord,
    options?: { readonly preserveStartedAt?: boolean },
  ) => ProjectWorkspaceEffect<CodexBackgroundProcessRecord>;
  readonly setThreadPinned: (
    threadId: string,
    pinned: boolean,
    beforeThreadId?: string | null,
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceSidebar>;
  readonly reorderPinnedThreads: (
    orderedThreadIds: readonly string[],
  ) => ProjectWorkspaceEffect<DesktopProjectWorkspaceSidebar>;
}

export class ProjectWorkspace extends Context.Service<ProjectWorkspace, ProjectWorkspaceService>()(
  "nodex/main/project-application/ProjectWorkspace",
) {}

const projectWorkspaceError = (operation: string, cause: unknown): ProjectWorkspaceError =>
  cause instanceof ProjectWorkspaceError ? cause : new ProjectWorkspaceError({ operation, cause });

const coreCause = (cause: unknown): unknown => {
  if (cause instanceof ProjectWorkspaceError) return coreCause(cause.cause);
  return typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "CoreRuntimeError"
    ? (cause as CoreRuntimeError).cause
    : cause;
};

const isNotFound = (cause: unknown): boolean => {
  const selected = coreCause(cause);
  return selected instanceof CoreModuleResponseError && selected.coreError.code === "not_found";
};

const expectVariant = <
  Snapshot extends ProjectWorkspaceReadSnapshot,
  Kind extends Snapshot["value"]["kind"],
>(
  snapshot: Snapshot,
  kind: Kind,
): Extract<Snapshot["value"], { kind: Kind }> => {
  if (snapshot.value.kind === kind) {
    return snapshot.value as Extract<Snapshot["value"], { kind: Kind }>;
  }
  throw new Error(`Core returned ${snapshot.value.kind} for Project Workspace ${kind}`);
};

const sidebarSectionItemPlacementToCore = (
  placement: SidebarSectionItemPlacement,
): Extract<
  ProjectWorkspaceApplyInput["intent"],
  { kind: "move_sidebar_section_item" }
>["placement"] => {
  if (placement.kind === "start" || placement.kind === "end") return placement;
  return {
    kind: placement.kind,
    item: projectWorkspaceSidebarSectionItemRefToCore(placement.item),
  };
};

export const make: Effect.Effect<ProjectWorkspaceService, never, CoreModules | Scope.Scope> =
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const ownerScope = yield* Scope.Scope;
    const projectUpdateLanes = yield* RcMap.make({
      lookup: (_projectId: string) => Semaphore.make(1),
    });

    const evaluate = <A>(operation: string, run: () => A): ProjectWorkspaceEffect<A> =>
      Effect.try({
        try: run,
        catch: (cause) => projectWorkspaceError(operation, cause),
      });

    const read = (
      operation: string,
      request: ProjectWorkspaceRead,
    ): ProjectWorkspaceEffect<ProjectWorkspaceReadSnapshot> =>
      core.workspace
        .read(request)
        .pipe(Effect.mapError((cause) => projectWorkspaceError(operation, cause)));

    const applyWithId = (
      operation: string,
      operationId: string,
      intent: ProjectWorkspaceApplyInput["intent"],
    ): ProjectWorkspaceEffect<ProjectWorkspaceApplyResult> =>
      core.workspace
        .apply({ operationId, intent })
        .pipe(Effect.mapError((cause) => projectWorkspaceError(operation, cause)));

    const apply = (operation: string, intent: ProjectWorkspaceApplyInput["intent"]) =>
      applyWithId(operation, createOperationId(`workspace.${operation}`), intent);

    const runOwned = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
        Fiber.join,
        Fiber.interrupt,
      );

    const runSerializedProjectUpdate = <A>(
      projectId: string,
      operation: ProjectWorkspaceEffect<A>,
    ): ProjectWorkspaceEffect<A> =>
      runOwned(
        Effect.scoped(
          Effect.gen(function* () {
            const lane = yield* RcMap.get(projectUpdateLanes, projectId);
            return yield* lane.withPermit(operation);
          }),
        ),
      );

    const readCoreThread = Effect.fn("ProjectWorkspace.readCoreThread")(function* (
      threadId: string,
    ) {
      const snapshot = yield* read("thread.read", { kind: "thread", thread_id: threadId }).pipe(
        Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
      );
      if (snapshot === null) return null;
      return yield* evaluate("thread.read", () => expectVariant(snapshot, "thread").thread);
    });

    const readThreadExecutionContext = Effect.fn("ProjectWorkspace.readThreadExecutionContext")(
      function* (threadId: string) {
        const snapshot = yield* read("thread.execution-context.read", {
          kind: "execution_context",
          thread_id: threadId,
        }).pipe(
          Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
        );
        if (snapshot === null) return null;
        return yield* evaluate("thread.execution-context.read", () => {
          const { context } = expectVariant(snapshot, "execution_context");
          return {
            threadId: context.thread.thread_id,
            projectId: context.thread.project_id ?? null,
            permissionMode: context.permission_mode ?? null,
            dynamicToolCatalogs: context.thread.dynamic_tool_catalogs.map((catalog) => ({
              namespace: catalog.namespace,
              toolsetRevision: catalog.toolset_revision,
            })),
            writableRoots: [...context.thread.writable_roots],
          } satisfies DesktopProjectWorkspaceExecutionContext;
        });
      },
    );

    const getThread = Effect.fn("ProjectWorkspace.getThread")(function* (threadId: string) {
      const thread = yield* readCoreThread(threadId);
      return thread ? projectWorkspaceThreadFromCore(thread) : null;
    });

    const readSessionThread = Effect.fn("ProjectWorkspace.readSessionThread")(function* (
      summary: Extract<ProjectWorkspaceReadSnapshot["value"], { kind: "session" }>["session"],
    ) {
      const threadId = summary.thread_id ?? null;
      if (!threadId) return null;
      const thread = yield* readCoreThread(threadId);
      if (!thread) {
        return yield* projectWorkspaceError(
          "session.thread.read",
          new Error(`Linked Core Thread not found: ${threadId}`),
        );
      }
      return projectWorkspaceSessionThreadFromCore(thread, summary.id, summary.project_id ?? null);
    });

    const readSession = Effect.fn("ProjectWorkspace.readSession")(function* (sessionId: string) {
      const snapshot = yield* read("session.read", {
        kind: "session",
        session_id: sessionId,
      }).pipe(
        Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
      );
      if (snapshot === null) return null;
      const summary = yield* evaluate(
        "session.read",
        () => expectVariant(snapshot, "session").session,
      );
      const thread = yield* readSessionThread(summary);
      return projectWorkspaceSessionFromCore(summary, thread);
    });

    const listProjectSessionSummaryWindow = Effect.fn(
      "ProjectWorkspace.listProjectSessionSummaryWindow",
    )(function* (projectId: string | null, input?: ProjectSessionSummaryWindowInput) {
      const snapshot = yield* read("session.window", {
        kind: "task_window",
        project_id: projectId,
        include_archived: input?.includeArchived ?? false,
        window: { after: input?.after ?? null, first: input?.first },
      });
      return yield* evaluate("session.window", () => {
        const tasks = expectVariant(snapshot, "task_window").tasks;
        return {
          items: tasks.items.map(projectWorkspaceTaskFromCore),
          nextCursor: tasks.next_cursor ?? null,
          hasMore: tasks.next_cursor !== null && tasks.next_cursor !== undefined,
          projectionRevision: tasks.authority.projection_revision,
        } satisfies ProjectSessionSummaryWindow;
      });
    });

    const readSidebarOverview = Effect.fn("ProjectWorkspace.readSidebarOverview")(function* (
      includeArchived = false,
      input?: ProjectSessionSummaryWindowInput,
    ) {
      const snapshot = yield* read("sidebar.overview", {
        kind: "sidebar_overview",
        include_archived: includeArchived,
        pinned_window: { after: input?.after ?? null, first: input?.first ?? 100 },
      });
      return yield* evaluate("sidebar.overview", () => {
        const tasks = expectVariant(snapshot, "sidebar_overview").pinned_tasks;
        return {
          items: tasks.items.map(projectWorkspaceTaskFromCore),
          nextCursor: tasks.next_cursor ?? null,
          hasMore: tasks.next_cursor !== null && tasks.next_cursor !== undefined,
          projectionRevision: tasks.authority.projection_revision,
        } satisfies ProjectSessionSummaryWindow;
      });
    });

    const listSidebarSections = Effect.fn("ProjectWorkspace.listSidebarSections")(function* (
      input: SidebarSectionWindowInput = {},
    ) {
      const snapshot = yield* read("sidebar-section.window", {
        kind: "sidebar_section_window",
        include_deleted: input.includeDeleted ?? false,
        window: { after: input.after ?? null, first: input.first ?? 100 },
      });
      return yield* evaluate("sidebar-section.window", () => {
        const sections = expectVariant(snapshot, "sidebar_section_window").sections;
        return {
          items: sections.items.map(projectWorkspaceSidebarSectionSummaryFromCore),
          nextCursor: sections.next_cursor ?? null,
          hasMore: sections.next_cursor !== null && sections.next_cursor !== undefined,
          projectionRevision: sections.authority.projection_revision,
        } satisfies SidebarSectionWindow;
      });
    });

    const listSidebarSectionItems = Effect.fn("ProjectWorkspace.listSidebarSectionItems")(
      function* (sectionId: string, input: SidebarSectionItemWindowInput = {}) {
        const snapshot = yield* read("sidebar-section.items.window", {
          kind: "sidebar_section_item_window",
          section_id: sectionId,
          include_archived: input.includeArchived ?? false,
          window: { after: input.after ?? null, first: input.first ?? 200 },
        });
        return yield* evaluate("sidebar-section.items.window", () => {
          const items = expectVariant(snapshot, "sidebar_section_item_window").items;
          return {
            items: items.items.map(projectWorkspaceSidebarSectionItemFromCore),
            nextCursor: items.next_cursor ?? null,
            hasMore: items.next_cursor !== null && items.next_cursor !== undefined,
            projectionRevision: items.authority.projection_revision,
          } satisfies SidebarSectionItemWindow;
        });
      },
    );

    const readSidebarSectionPlacement = Effect.fn("ProjectWorkspace.readSidebarSectionPlacement")(
      function* (item: SidebarSectionItemRef) {
        const snapshot = yield* read("sidebar-section.item.placement", {
          kind: "sidebar_section_placement",
          item: projectWorkspaceSidebarSectionItemRefToCore(item),
        });
        return yield* evaluate(
          "sidebar-section.item.placement",
          () => expectVariant(snapshot, "sidebar_section_placement").section_id ?? null,
        );
      },
    );

    const readSidebarSection = Effect.fn("ProjectWorkspace.readSidebarSection")(function* (
      sectionId: string,
      includeDeleted = false,
    ) {
      let after: string | null = null;
      for (let page = 0; page < 500; page += 1) {
        const sections: SidebarSectionWindow = yield* listSidebarSections({
          includeDeleted,
          after,
          first: 200,
        });
        const section = sections.items.find((candidate) => candidate.sectionId === sectionId);
        if (section) return section;
        if (!sections.nextCursor) return null;
        if (sections.nextCursor === after) {
          return yield* projectWorkspaceError(
            "sidebar-section.read",
            new Error("Sidebar Section pagination did not advance"),
          );
        }
        after = sections.nextCursor;
      }
      return yield* projectWorkspaceError(
        "sidebar-section.read",
        new Error("Sidebar Section pagination exceeded its safety bound"),
      );
    });

    const createSidebarSection = Effect.fn("ProjectWorkspace.createSidebarSection")(function* (
      input: SidebarSectionCreateInput,
    ) {
      const sectionId = randomUUID();
      yield* apply("sidebar-section.create", {
        kind: "create_sidebar_section",
        section_id: sectionId,
        name: input.name,
        initial_item: input.initialItem
          ? projectWorkspaceSidebarSectionItemRefToCore(input.initialItem)
          : null,
      });
      const section = yield* readSidebarSection(sectionId);
      if (section) return section;
      return yield* projectWorkspaceError(
        "sidebar-section.create",
        new Error(`Created Sidebar Section not found: ${sectionId}`),
      );
    });

    const renameSidebarSection = Effect.fn("ProjectWorkspace.renameSidebarSection")(function* (
      sectionId: string,
      input: SidebarSectionRenameInput,
    ) {
      yield* apply("sidebar-section.rename", {
        kind: "rename_sidebar_section",
        section_id: sectionId,
        name: input.name,
        expected_revision: input.expectedRevision,
      });
      const section = yield* readSidebarSection(sectionId);
      if (section) return section;
      return yield* projectWorkspaceError(
        "sidebar-section.rename",
        new Error(`Renamed Sidebar Section not found: ${sectionId}`),
      );
    });

    const deleteSidebarSection = Effect.fn("ProjectWorkspace.deleteSidebarSection")(function* (
      sectionId: string,
      expectedRevision: number,
    ) {
      yield* apply("sidebar-section.delete", {
        kind: "delete_sidebar_section",
        section_id: sectionId,
        expected_revision: expectedRevision,
      });
    });

    const restoreSidebarSection = Effect.fn("ProjectWorkspace.restoreSidebarSection")(function* (
      sectionId: string,
      expectedRevision: number,
    ) {
      yield* apply("sidebar-section.restore", {
        kind: "restore_sidebar_section",
        section_id: sectionId,
        expected_revision: expectedRevision,
      });
      const section = yield* readSidebarSection(sectionId);
      if (section) return section;
      return yield* projectWorkspaceError(
        "sidebar-section.restore",
        new Error(`Restored Sidebar Section not found: ${sectionId}`),
      );
    });

    const moveSidebarSectionItem = Effect.fn("ProjectWorkspace.moveSidebarSectionItem")(function* (
      input: SidebarSectionMoveItemInput,
    ) {
      yield* apply("sidebar-section.item.move", {
        kind: "move_sidebar_section_item",
        item: projectWorkspaceSidebarSectionItemRefToCore(input.item),
        section_id: input.sectionId,
        placement: sidebarSectionItemPlacementToCore(input.placement),
      });
    });

    const reorderSidebarSections = Effect.fn("ProjectWorkspace.reorderSidebarSections")(function* (
      orderedSectionIds: readonly string[],
    ) {
      yield* apply("sidebar-section.reorder", {
        kind: "reorder_sidebar_sections",
        section_ids: [...orderedSectionIds],
      });
    });

    const reorderSidebarSectionSessions = Effect.fn(
      "ProjectWorkspace.reorderSidebarSectionSessions",
    )(function* (sectionId: string, orderedSessionIds: readonly string[]) {
      yield* apply("sidebar-section.sessions.reorder", {
        kind: "reorder_sidebar_section_sessions",
        section_id: sectionId,
        session_ids: [...orderedSessionIds],
      });
    });

    const archiveSidebarSectionSessions = Effect.fn(
      "ProjectWorkspace.archiveSidebarSectionSessions",
    )(function* (sectionId: string, input: SidebarSectionArchiveInput = {}) {
      const replacementSessionId = input.createReplacement ? randomUUID() : null;
      yield* apply("sidebar-section.sessions.archive", {
        kind: "archive_sidebar_section_sessions",
        section_id: sectionId,
        replacement_session_id: replacementSessionId,
      });
      if (!replacementSessionId) return null;
      const replacement = yield* readSession(replacementSessionId);
      if (replacement) return replacement;
      return yield* projectWorkspaceError(
        "sidebar-section.sessions.archive",
        new Error(`Replacement Sidebar Section Session not found: ${replacementSessionId}`),
      );
    });

    const createSessionInSidebarSection = Effect.fn(
      "ProjectWorkspace.createSessionInSidebarSection",
    )(function* (input: SidebarSectionSessionCreateInput) {
      const sessionId = randomUUID();
      yield* apply("sidebar-section.session.create", {
        kind: "create_session_in_sidebar_section",
        session_id: sessionId,
        section_id: input.sectionId,
        title: input.title?.trim() || "New chat",
        initial_page_ids: [...(input.initialPageIds ?? [])],
      });
      const session = yield* readSession(sessionId);
      if (session) return session;
      return yield* projectWorkspaceError(
        "sidebar-section.session.create",
        new Error(`Created Sidebar Section Session not found: ${sessionId}`),
      );
    });

    const listProjectWindow = Effect.fn("ProjectWorkspace.listProjectWindow")(function* (
      input: ProjectWindowInput = {},
    ) {
      const snapshot = yield* read("project.window", {
        kind: "project_window",
        include_archived: input.includeArchived ?? false,
        window: { after: input.after ?? null, first: input.first ?? 100 },
      });
      return yield* evaluate("project.window", () => {
        const projects = expectVariant(snapshot, "project_window").projects;
        return {
          items: projects.items.map(projectWorkspaceProjectFromCore),
          nextCursor: projects.next_cursor ?? null,
          hasMore: projects.next_cursor !== null && projects.next_cursor !== undefined,
          projectionRevision: projects.authority.projection_revision,
        } satisfies ProjectWindow;
      });
    });

    const listProjects: ProjectWorkspaceEffect<readonly Project[]> = listProjectWindow({
      includeArchived: false,
      first: 200,
    }).pipe(
      Effect.flatMap((window) =>
        window.nextCursor === null
          ? Effect.succeed([...window.items])
          : Effect.fail(
              projectWorkspaceError(
                "project.list",
                new Error("Available Project collection exceeded its fixed Core bound"),
              ),
            ),
      ),
    );

    const readProjectBootstrap: ProjectWorkspaceEffect<DesktopProjectBootstrap> = read(
      "project.bootstrap.read",
      { kind: "project_bootstrap" },
    ).pipe(
      Effect.flatMap((snapshot) =>
        evaluate("project.bootstrap.read", () => ({
          status: expectVariant(snapshot, "project_bootstrap").bootstrap.status,
        })),
      ),
    );

    const readProjectActivitySummaries = Effect.fn("ProjectWorkspace.readProjectActivitySummaries")(
      function* (projectIds: readonly string[]) {
        const snapshot = yield* read("project.activity.read", {
          kind: "project_activity_summaries",
          project_ids: [...projectIds],
        });
        return yield* evaluate("project.activity.read", () => {
          const value = expectVariant(snapshot, "project_activity_summaries");
          return {
            summaries: value.summaries.map((summary) => ({
              projectId: summary.project_id,
              taskCount: summary.task_count,
              waitingCount: summary.waiting_count,
              unreadCount: summary.unread_count,
              activeCount: summary.active_count,
            })),
            projectionRevision: value.projection_revision,
          } satisfies ProjectActivitySummaryResult;
        });
      },
    );

    const readPageChatActivitySummaries = Effect.fn(
      "ProjectWorkspace.readPageChatActivitySummaries",
    )(function* (input: PageChatActivitySummaryInput) {
      const parsed = yield* evaluate("page-chat.activity.read", () =>
        PageChatActivitySummaryInputSchema.parse(input),
      );
      const snapshot = yield* read("page-chat.activity.read", {
        kind: "page_chat_activity_summaries",
        page_access_project_id: parsed.pageAccessProjectId,
        page_ids: parsed.pageIds,
      });
      return yield* evaluate("page-chat.activity.read", () => {
        const value = expectVariant(snapshot, "page_chat_activity_summaries");
        return {
          summaries: value.summaries.map(projectWorkspacePageChatActivitySummaryFromCore),
          projectionRevision: value.projection_revision,
        } satisfies PageChatActivitySummaryResult;
      });
    });

    const listPageChatWindow = Effect.fn("ProjectWorkspace.listPageChatWindow")(function* (
      input: PageChatWindowInput,
    ) {
      const parsed = yield* evaluate("page-chat.window.read", () =>
        PageChatWindowInputSchema.parse(input),
      );
      const snapshot = yield* read("page-chat.window.read", {
        kind: "page_chat_window",
        page_access_project_id: parsed.pageAccessProjectId,
        page_id: parsed.pageId,
        include_archived: parsed.includeArchived ?? false,
        window: {
          after: parsed.after ?? null,
          first: parsed.first ?? 50,
        },
      });
      return yield* evaluate("page-chat.window.read", () => {
        const chats = expectVariant(snapshot, "page_chat_window").chats;
        return {
          items: chats.items.map(projectWorkspacePageChatItemFromCore),
          nextCursor: chats.next_cursor ?? null,
          hasMore: chats.next_cursor !== null && chats.next_cursor !== undefined,
          projectionRevision: chats.authority.projection_revision,
        } satisfies PageChatWindow;
      });
    });

    const readProjectPermissionMode = Effect.fn("ProjectWorkspace.readProjectPermissionMode")(
      function* (projectId: string) {
        const snapshot = yield* read("project.permission.read", {
          kind: "project_permission_mode",
          project_id: projectId,
        }).pipe(
          Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
        );
        if (snapshot === null) return null;
        return yield* evaluate(
          "project.permission.read",
          () => expectVariant(snapshot, "project_permission_mode").mode ?? null,
        );
      },
    );

    const readProjectlessPermissionMode: ProjectWorkspaceEffect<CodexPermissionMode | null> = read(
      "projectless.permission.read",
      { kind: "projectless_permission_mode" },
    ).pipe(
      Effect.flatMap((snapshot) =>
        evaluate(
          "projectless.permission.read",
          () => expectVariant(snapshot, "projectless_permission_mode").mode ?? null,
        ),
      ),
      Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
    );

    const listBackgroundProcesses = Effect.fn("ProjectWorkspace.listBackgroundProcesses")(
      function* (threadId?: string | null) {
        const snapshot = yield* read("background-process.list", {
          kind: "background_process_window",
          thread_id: threadId?.trim() || null,
          window: { after: null, first: 200 },
        });
        return yield* evaluate("background-process.list", () => {
          const processes = expectVariant(snapshot, "background_process_window").processes;
          if (processes.next_cursor) {
            throw new Error("Background process collection exceeded its fixed Core bound");
          }
          return processes.items.map(projectWorkspaceBackgroundProcessFromCore);
        });
      },
    );

    const listManagedWorktreeWindow = Effect.fn("ProjectWorkspace.listManagedWorktreeWindow")(
      function* (
        input: {
          readonly projectId?: string | null;
          readonly after?: string | null;
          readonly first?: number;
        } = {},
      ) {
        const snapshot = yield* read("managed-worktree.window", {
          kind: "managed_worktree_window",
          project_id: input.projectId ?? null,
          window: { after: input.after ?? null, first: input.first ?? 200 },
        });
        return yield* evaluate("managed-worktree.window", () => {
          const worktrees = expectVariant(snapshot, "managed_worktree_window").worktrees;
          return {
            items: worktrees.items.map((worktree) => ({
              threadId: worktree.thread_id,
              projectId: worktree.project_id,
              sessionId: worktree.session_id ?? null,
              sessionTitle: worktree.session_title ?? null,
              threadName: worktree.thread_name ?? null,
              path: worktree.path,
              linkedAt: worktree.linked_at,
            })),
            nextCursor: worktrees.next_cursor ?? null,
            projectionRevision: worktrees.authority.projection_revision,
          } satisfies DesktopManagedWorktreeWindow;
        });
      },
    );

    const readManagedWorktreeLifecycleSnapshot: ProjectWorkspaceEffect<DesktopManagedWorktreeLifecycleSnapshot> =
      read("managed-worktree.lifecycle.read", {
        kind: "managed_worktree_lifecycle_snapshot",
      }).pipe(
        Effect.flatMap((snapshot) =>
          evaluate("managed-worktree.lifecycle.read", () => {
            const value = expectVariant(snapshot, "managed_worktree_lifecycle_snapshot").snapshot;
            return {
              projectionRevision: value.projection_revision,
              consumers: value.consumers.map((consumer) => ({
                threadId: consumer.thread_id,
                projectId: consumer.project_id ?? null,
                sessionId: consumer.session_id ?? null,
                executionHostId: consumer.execution_host_id,
                cwd: consumer.cwd ?? null,
                managedWorktreePath: consumer.managed_worktree_path,
                runtimeWorkspaceRoots: [...consumer.runtime_workspace_roots],
                archived: consumer.archived,
                pinnedOrder: consumer.pinned_order ?? null,
                statusType: consumer.status.status_type,
                statusActiveFlags: [...consumer.status.active_flags],
                createdAt: consumer.created_at,
                updatedAt: consumer.updated_at,
                linkedAt: consumer.linked_at,
              })),
              projects: value.projects.map((project) => ({
                projectId: project.project_id,
                lifecycle: project.lifecycle,
                sourceRoots: project.sources.map((source) => source.root),
                primaryWorkspaceRoot: project.primary_workspace_root ?? null,
              })),
            } satisfies DesktopManagedWorktreeLifecycleSnapshot;
          }),
        ),
      );

    const mutationSidebarReceipt = (
      threads: readonly DesktopProjectWorkspaceThread[] = [],
    ): DesktopProjectWorkspaceSidebar => ({ threads });

    const getProject = Effect.fn("ProjectWorkspace.getProject")(function* (projectId: string) {
      const snapshot = yield* read("project.read", {
        kind: "project",
        project_id: projectId,
      }).pipe(
        Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
      );
      if (snapshot === null) return null;
      return yield* evaluate("project.read", () =>
        projectWorkspaceProjectFromCore(expectVariant(snapshot, "project").project),
      );
    });

    const service = ProjectWorkspace.of({
      readProjectBootstrap,
      listProjects,
      listProjectWindow,
      listSidebarSections,
      listSidebarSectionItems,
      readSidebarSectionPlacement,
      createSidebarSection,
      renameSidebarSection,
      deleteSidebarSection,
      restoreSidebarSection,
      moveSidebarSectionItem,
      reorderSidebarSections,
      reorderSidebarSectionSessions,
      archiveSidebarSectionSessions,
      createSessionInSidebarSection,
      readProjectActivitySummaries,
      readPageChatActivitySummaries,
      listPageChatWindow,
      getProject,
      readProjectPermissionMode,
      readProjectlessPermissionMode,
      setProjectPermissionMode: Effect.fn("ProjectWorkspace.setProjectPermissionMode")(
        function* (projectId, mode) {
          yield* apply("project.permission.set", {
            kind: "set_project_permission_mode",
            project_id: projectId,
            mode,
          });
          const selected = yield* readProjectPermissionMode(projectId);
          if (selected) return selected;
          return yield* projectWorkspaceError(
            "project.permission.set",
            new Error(`Updated Project permission mode not found: ${projectId}`),
          );
        },
      ),
      setProjectlessPermissionMode: Effect.fn("ProjectWorkspace.setProjectlessPermissionMode")(
        function* (mode) {
          yield* apply("projectless.permission.set", {
            kind: "set_projectless_permission_mode",
            mode,
          });
          const selected = yield* readProjectlessPermissionMode;
          if (selected) return selected;
          return yield* projectWorkspaceError(
            "projectless.permission.set",
            new Error("Updated projectless permission mode not found"),
          );
        },
      ),
      createInitialProject: Effect.fn("ProjectWorkspace.createInitialProject")(function* (input) {
        yield* applyWithId("project.initial.create", input.operationId, {
          kind: "create_initial_project",
          project_id: input.projectId,
          name: input.name ?? "",
          description: input.description ?? "",
          appearance: input.appearance ?? null,
          source_roots: input.sources ?? [],
          ...(input.pageKeyPrefix === undefined ? {} : { page_key_prefix: input.pageKeyPrefix }),
          starter_page: {
            page_id: input.starterPage.pageId,
            document_id: input.starterPage.documentId,
            title_markdown: input.starterPage.titleMarkdown,
            nfm: input.starterPage.nfm,
          },
        });
        const project = yield* getProject(input.projectId);
        if (project) return { project };
        return yield* projectWorkspaceError(
          "project.initial.create",
          new Error(`Created initial Project not found: ${input.projectId}`),
        );
      }),
      createProject: Effect.fn("ProjectWorkspace.createProject")(function* (input) {
        const projectId = randomUUID();
        yield* apply("project.create", {
          kind: "create_project",
          project_id: projectId,
          name: input.name ?? "",
          description: input.description ?? "",
          appearance: input.appearance ?? null,
          source_roots: input.sources ?? [],
          ...(input.pageKeyPrefix === undefined ? {} : { page_key_prefix: input.pageKeyPrefix }),
        });
        const project = yield* getProject(projectId);
        if (project) return project;
        return yield* projectWorkspaceError(
          "project.create",
          new Error(`Created Project not found: ${projectId}`),
        );
      }),
      updateProject: (projectId, input) =>
        runSerializedProjectUpdate(
          projectId,
          Effect.gen(function* () {
            const current = yield* getProject(projectId);
            if (!current) return null;
            yield* apply("project.update", {
              kind: "update_project",
              project_id: projectId,
              expected_binding_revision: input.expectedBindingRevision ?? current.bindingRevision,
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.appearance !== undefined ? { appearance: input.appearance } : {}),
              ...(input.sources !== undefined ? { source_roots: input.sources } : {}),
            });
            return yield* getProject(projectId);
          }),
        ),
      reorderProjects: Effect.fn("ProjectWorkspace.reorderProjects")(function* (input) {
        yield* apply("project.reorder", {
          kind: "reorder_projects",
          project_ids: input.orderedProjectIds,
        });
      }),
      setProjectPinned: Effect.fn("ProjectWorkspace.setProjectPinned")(
        function* (projectId, input) {
          if (!(yield* getProject(projectId))) return null;
          yield* apply("project.pinned.set", {
            kind: "set_project_pinned",
            project_id: projectId,
            pinned: input.pinned,
          });
          return yield* getProject(projectId);
        },
      ),
      setPinnedProjectOrder: Effect.fn("ProjectWorkspace.setPinnedProjectOrder")(function* (input) {
        yield* apply("project.pinned.reorder", {
          kind: "reorder_pinned_projects",
          project_ids: input.orderedProjectIds,
        });
      }),
      setProjectLifecycle: Effect.fn("ProjectWorkspace.setProjectLifecycle")(
        function* (projectId, lifecycle) {
          const current = yield* getProject(projectId);
          if (!current) return null;
          if (current.lifecycle === lifecycle) return current;
          yield* apply("project.lifecycle.set", {
            kind: "set_project_lifecycle",
            project_id: projectId,
            lifecycle,
          });
          return yield* getProject(projectId);
        },
      ),
      listProjectSessionSummaryWindow,
      readSidebarOverview,
      getProjectSession: readSession,
      updateProjectSession: Effect.fn("ProjectWorkspace.updateProjectSession")(
        function* (sessionId, input) {
          const parsed = yield* evaluate("session.update", () =>
            ProjectSessionUpdateInputSchema.parse(input),
          );
          const current = yield* readSession(sessionId);
          if (!current || parsed.noThreadFallbackTitle === undefined) return current;
          yield* apply("session.update", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "set_fallback_title", title: parsed.noThreadFallbackTitle },
          });
          return yield* readSession(sessionId);
        },
      ),
      renameProjectSession: Effect.fn("ProjectWorkspace.renameProjectSession")(
        function* (sessionId, input) {
          const parsed = yield* evaluate("session.rename", () =>
            ProjectSessionRenameInputSchema.parse(input),
          );
          if (!(yield* readSession(sessionId))) return null;
          yield* apply("session.rename", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "rename", title: parsed.title },
          });
          return yield* readSession(sessionId);
        },
      ),
      ensureDefaultDraftProjectSession: Effect.fn(
        "ProjectWorkspace.ensureDefaultDraftProjectSession",
      )(function* (projectId) {
        const applied = yield* apply("session.default.ensure", {
          kind: "ensure_default_draft_session",
          session_id: randomUUID(),
          project_id: projectId,
          title: "New chat",
        });
        const [sessionId, ...unexpectedSessionIds] = applied.outcome.affected_session_ids;
        if (!sessionId || unexpectedSessionIds.length > 0) {
          return yield* projectWorkspaceError(
            "session.default.ensure",
            new Error("Core default-draft ensure did not return exactly one Project Session"),
          );
        }
        const session = yield* readSession(sessionId);
        if (session) return session;
        return yield* projectWorkspaceError(
          "session.default.ensure",
          new Error(`Ensured Project Session not found: ${sessionId}`),
        );
      }),
      createProjectSession: Effect.fn("ProjectWorkspace.createProjectSession")(function* (input) {
        const parsed = yield* evaluate("session.create", () =>
          ProjectSessionCreateInputSchema.parse(input),
        );
        const sessionId = randomUUID();
        yield* apply("session.create", {
          kind: "create_session",
          session_id: sessionId,
          project_id: parsed.projectId,
          title: parsed.noThreadFallbackTitle,
          initial_page_ids: parsed.initialPageIds,
        });
        const session = yield* readSession(sessionId);
        if (session) return session;
        return yield* projectWorkspaceError(
          "session.create",
          new Error(`Created Project Session not found: ${sessionId}`),
        );
      }),
      linkPageToProjectSession: Effect.fn("ProjectWorkspace.linkPageToProjectSession")(
        function* (sessionId, input) {
          const parsed = yield* evaluate("page-chat.link", () => {
            if (sessionId.trim().length === 0) throw new Error("Project Session ID is required");
            return PageChatLinkInputSchema.parse(input);
          });
          yield* apply("page-chat.link", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: {
              kind: "link_page",
              page_id: parsed.pageId,
              page_access_project_id: parsed.pageAccessProjectId,
            },
          });
        },
      ),
      unlinkPageFromProjectSession: Effect.fn("ProjectWorkspace.unlinkPageFromProjectSession")(
        function* (sessionId, input) {
          const parsed = yield* evaluate("page-chat.unlink", () => {
            if (sessionId.trim().length === 0) throw new Error("Project Session ID is required");
            return PageChatLinkInputSchema.parse(input);
          });
          yield* apply("page-chat.unlink", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: {
              kind: "unlink_page",
              page_id: parsed.pageId,
              page_access_project_id: parsed.pageAccessProjectId,
            },
          });
        },
      ),
      deleteProjectSession: Effect.fn("ProjectWorkspace.deleteProjectSession")(
        function* (sessionId) {
          if (!(yield* readSession(sessionId))) return false;
          yield* apply("session.delete", { kind: "delete_session", session_id: sessionId });
          return true;
        },
      ),
      reorderProjectSessions: Effect.fn("ProjectWorkspace.reorderProjectSessions")(
        function* (projectId, orderedSessionIds) {
          yield* apply("session.reorder", {
            kind: "reorder_sessions",
            project_id: projectId,
            session_ids: [...orderedSessionIds],
          });
        },
      ),
      setProjectSessionPinned: Effect.fn("ProjectWorkspace.setProjectSessionPinned")(
        function* (sessionId, input) {
          if (!(yield* readSession(sessionId))) return null;
          yield* apply("session.pinned.set", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "set_pinned", pinned: input.pinned },
          });
          return yield* readSession(sessionId);
        },
      ),
      setPinnedProjectSessionOrder: Effect.fn("ProjectWorkspace.setPinnedProjectSessionOrder")(
        function* (projectId, input) {
          yield* apply("session.pinned.reorder", {
            kind: "reorder_pinned_sessions",
            project_id: projectId,
            session_ids: input.orderedSessionIds,
          });
        },
      ),
      archiveProjectSession: Effect.fn("ProjectWorkspace.archiveProjectSession")(
        function* (sessionId) {
          if (!(yield* readSession(sessionId))) return null;
          yield* apply("session.archive", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "set_archived", archived: true },
          });
          return yield* readSession(sessionId);
        },
      ),
      unarchiveProjectSession: Effect.fn("ProjectWorkspace.unarchiveProjectSession")(
        function* (sessionId) {
          if (!(yield* readSession(sessionId))) return null;
          yield* apply("session.unarchive", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "set_archived", archived: false },
          });
          return yield* readSession(sessionId);
        },
      ),
      markProjectSessionUnread: Effect.fn("ProjectWorkspace.markProjectSessionUnread")(
        function* (sessionId, input) {
          if (!(yield* readSession(sessionId))) return null;
          yield* apply("session.unread.set", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "set_unread", unread: input.unread },
          });
          return yield* readSession(sessionId);
        },
      ),
      upsertProjectSessionThreadLink: Effect.fn("ProjectWorkspace.upsertProjectSessionThreadLink")(
        function* (input) {
          const parsed = yield* evaluate("session.thread.link", () =>
            ProjectSessionThreadLinkInputSchema.parse(input),
          );
          const session = yield* readSession(parsed.sessionId);
          if (!session) {
            return yield* projectWorkspaceError(
              "session.thread.link",
              new Error(`Project session not found: ${parsed.sessionId}`),
            );
          }
          if (session.projectId !== parsed.projectId) {
            return yield* projectWorkspaceError(
              "session.thread.link",
              new Error("Thread project must match the owning session project"),
            );
          }
          const existing = yield* readCoreThread(parsed.threadId);
          const hasForkedFromId = Object.prototype.hasOwnProperty.call(input, "forkedFromId");
          const hasThreadSource = Object.prototype.hasOwnProperty.call(input, "threadSource");
          const hasServiceName = Object.prototype.hasOwnProperty.call(input, "serviceName");
          const hasAgentNickname = Object.prototype.hasOwnProperty.call(input, "agentNickname");
          const hasAgentRole = Object.prototype.hasOwnProperty.call(input, "agentRole");
          const hasAgentPath = Object.prototype.hasOwnProperty.call(input, "agentPath");
          const hasManagedWorktreePath = Object.prototype.hasOwnProperty.call(
            input,
            "managedWorktreePath",
          );
          const hasExecutionProfile = Object.prototype.hasOwnProperty.call(
            input,
            "executionProfile",
          );
          const hasExecutionHostId = Object.prototype.hasOwnProperty.call(input, "executionHostId");
          yield* apply("session.thread.link", {
            kind: "mutate_session",
            session_id: parsed.sessionId,
            intent: {
              kind: "link_thread",
              thread_id: parsed.threadId,
              expected_project_id: parsed.projectId,
              thread_patch: {
                project_id: parsed.projectId,
                ...(hasForkedFromId ? { forked_from_id: parsed.forkedFromId ?? null } : {}),
                ...(parsed.parentThreadId ? { parent_thread_id: parsed.parentThreadId } : {}),
                ...(hasThreadSource ? { thread_source: parsed.threadSource ?? null } : {}),
                ...(hasServiceName ? { service_name: parsed.serviceName ?? null } : {}),
                ...(hasAgentNickname ? { agent_nickname: parsed.agentNickname ?? null } : {}),
                ...(hasAgentRole ? { agent_role: parsed.agentRole ?? null } : {}),
                ...(hasAgentPath ? { agent_path: parsed.agentPath ?? null } : {}),
                ...(parsed.threadName != null ? { thread_name: parsed.threadName } : {}),
                thread_preview: parsed.threadPreview ?? existing?.thread_preview ?? "",
                model_provider:
                  parsed.executionProfile?.providerId ??
                  parsed.modelProvider ??
                  existing?.model_provider ??
                  "",
                ...(hasExecutionProfile
                  ? projectWorkspaceExecutionProfilePatchToCore(
                      parsed.executionProfile as AgentExecutionProfile | null,
                    )
                  : {}),
                ...(parsed.runtimeWorkspaceRoots === undefined
                  ? {
                      ...(hasExecutionHostId ? { execution_host_id: parsed.executionHostId } : {}),
                      ...(parsed.cwd != null ? { cwd: parsed.cwd } : {}),
                      ...(hasManagedWorktreePath
                        ? { managed_worktree_path: parsed.managedWorktreePath ?? null }
                        : {}),
                      ...(parsed.projectlessOutputDirectory != null
                        ? { projectless_output_directory: parsed.projectlessOutputDirectory }
                        : {}),
                      ...(parsed.projectlessWorkspaceBrowserRoot != null
                        ? {
                            projectless_workspace_browser_root:
                              parsed.projectlessWorkspaceBrowserRoot,
                          }
                        : {}),
                    }
                  : {}),
                status: {
                  status_type: parsed.statusType ?? "notLoaded",
                  active_flags: parsed.statusActiveFlags ?? [],
                },
                archived: parsed.archived ?? existing?.archived ?? false,
                ...(!existing && parsed.createdAt !== undefined
                  ? { created_at: parsed.createdAt }
                  : {}),
                ...(parsed.updatedAt !== undefined ? { updated_at: parsed.updatedAt } : {}),
                ...(parsed.recencyAt !== undefined ? { recency_at: parsed.recencyAt } : {}),
              },
              ...(parsed.runtimeWorkspaceRoots === undefined
                ? {}
                : {
                    execution_location: {
                      execution_host_id:
                        parsed.executionHostId ?? existing?.execution_host_id ?? "local",
                      cwd: parsed.cwd ?? null,
                      managed_worktree_path: parsed.managedWorktreePath ?? null,
                      runtime_workspace_roots: [...parsed.runtimeWorkspaceRoots],
                      projectless_output_directory: parsed.projectlessOutputDirectory ?? null,
                      projectless_workspace_browser_root:
                        parsed.projectlessWorkspaceBrowserRoot ?? null,
                    },
                  }),
            },
          });
          const linked = yield* readSession(parsed.sessionId);
          if (linked?.thread) return linked.thread;
          return yield* projectWorkspaceError(
            "session.thread.link",
            new Error("Unable to attach project session thread"),
          );
        },
      ),
      detachProjectSessionThread: Effect.fn("ProjectWorkspace.detachProjectSessionThread")(
        function* (sessionId) {
          const session = yield* readSession(sessionId);
          if (!session?.thread) return false;
          yield* apply("session.thread.detach", {
            kind: "mutate_session",
            session_id: sessionId,
            intent: { kind: "unlink_thread", thread_id: session.thread.threadId },
          });
          return true;
        },
      ),
      getThread,
      upsertThread: Effect.fn("ProjectWorkspace.upsertThread")(function* (threadId, patch) {
        yield* apply("thread.upsert", {
          kind: "upsert_thread",
          thread_id: threadId,
          patch: projectWorkspaceThreadPatchToCore(patch),
        });
        const thread = yield* getThread(threadId);
        if (thread) return thread;
        return yield* projectWorkspaceError(
          "thread.upsert",
          new Error(`Unable to read upserted Codex Thread '${threadId}'`),
        );
      }),
      updateThread: Effect.fn("ProjectWorkspace.updateThread")(function* (threadId, patch) {
        const applied = yield* apply("thread.update", {
          kind: "update_thread",
          thread_id: threadId,
          patch: projectWorkspaceThreadPatchToCore(patch),
        }).pipe(
          Effect.map(() => true),
          Effect.catch((error) => (isNotFound(error) ? Effect.succeed(false) : Effect.fail(error))),
        );
        return applied ? yield* getThread(threadId) : null;
      }),
      setThreadExecutionLocation: Effect.fn("ProjectWorkspace.setThreadExecutionLocation")(
        function* (threadId, location) {
          const applied = yield* apply("thread.execution-location.set", {
            kind: "set_thread_execution_location",
            thread_id: threadId,
            location: {
              execution_host_id: location.executionHostId,
              cwd: location.cwd,
              managed_worktree_path: location.managedWorktreePath,
              runtime_workspace_roots: [...location.runtimeWorkspaceRoots],
              projectless_output_directory: location.projectlessOutputDirectory,
              projectless_workspace_browser_root: location.projectlessWorkspaceBrowserRoot,
            },
          }).pipe(
            Effect.map(() => true),
            Effect.catch((error) =>
              isNotFound(error) ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
          return applied ? yield* getThread(threadId) : null;
        },
      ),
      moveThread: Effect.fn("ProjectWorkspace.moveThread")(function* (input) {
        const operationId = createOperationId("workspace.move-thread");
        const intent = yield* evaluate("thread.move", () => ({
          kind: "move_thread" as const,
          thread_id: input.threadId,
          source: projectWorkspaceThreadLaneToCore(input.sourceProjectId),
          target: projectWorkspaceThreadLaneToCore(input.targetProjectId),
          placement: projectWorkspaceThreadMovePlacementToCore(input),
          metadata: projectWorkspaceThreadMoveMetadataToCore(input.metadata),
          ...(input.runtimeWorkspaceRoots === undefined
            ? {}
            : { runtime_workspace_roots: [...input.runtimeWorkspaceRoots] }),
          ...(input.projectAccessGrant === undefined
            ? {}
            : {
                project_access_grant: {
                  expected_target_binding_revision:
                    input.projectAccessGrant.expectedTargetBindingRevision,
                  missing_source_roots: [...input.projectAccessGrant.missingProjectSources],
                },
              }),
        }));
        const applied = yield* applyWithId("thread.move", operationId, intent);
        const thread = yield* getThread(input.threadId);
        if (!thread) {
          return yield* projectWorkspaceError(
            "thread.move",
            new Error(`Unable to read moved Codex Thread '${input.threadId}'`),
          );
        }
        return { thread, operationId, projectionRevision: applyResultCursor(applied) };
      }),
      setThreadUnread: Effect.fn("ProjectWorkspace.setThreadUnread")(function* (threadId, unread) {
        const applied = yield* apply("thread.unread.set", {
          kind: "set_thread_unread",
          thread_id: threadId,
          unread,
        }).pipe(
          Effect.map(() => true),
          Effect.catch((error) => (isNotFound(error) ? Effect.succeed(false) : Effect.fail(error))),
        );
        return applied ? yield* getThread(threadId) : null;
      }),
      setThreadArchived: Effect.fn("ProjectWorkspace.setThreadArchived")(
        function* (threadId, archived) {
          yield* apply("thread.archived.set", {
            kind: "set_thread_archived",
            thread_id: threadId,
            archived,
          }).pipe(Effect.catch((error) => (isNotFound(error) ? Effect.void : Effect.fail(error))));
          return mutationSidebarReceipt();
        },
      ),
      deleteThread: Effect.fn("ProjectWorkspace.deleteThread")(function* (threadId) {
        const existing = yield* readCoreThread(threadId);
        if (!existing) return { deleted: false, sidebar: mutationSidebarReceipt() };
        yield* apply("thread.delete", { kind: "delete_thread", thread_id: threadId });
        return { deleted: true, sidebar: mutationSidebarReceipt() };
      }),
      observeAppServerThreadWindow: Effect.fn("ProjectWorkspace.observeAppServerThreadWindow")(
        function* (sweepId, threadIds) {
          yield* apply("thread.sweep.observe", {
            kind: "observe_app_server_thread_window",
            sweep_id: sweepId,
            thread_ids: [...threadIds],
          });
        },
      ),
      reconcileAppServerThreadSweep: Effect.fn("ProjectWorkspace.reconcileAppServerThreadSweep")(
        function* (sweepId, limit = 100) {
          const committed = yield* apply("thread.sweep.reconcile", {
            kind: "reconcile_app_server_thread_sweep",
            sweep_id: sweepId,
            limit,
          });
          return {
            threadIds: committed.outcome.affected_thread_ids,
            projectIds: committed.outcome.affected_project_ids,
          };
        },
      ),
      readThreadExecutionContext,
      replaceThreadDynamicToolCatalogs: Effect.fn(
        "ProjectWorkspace.replaceThreadDynamicToolCatalogs",
      )(function* (threadId, catalogs) {
        yield* apply("thread.dynamic-tools.replace", {
          kind: "replace_thread_dynamic_tool_catalogs",
          thread_id: threadId,
          catalogs: catalogs.map((catalog) => ({
            namespace: catalog.namespace,
            toolset_revision: catalog.toolsetRevision,
          })),
        });
        const context = yield* readThreadExecutionContext(threadId);
        if (context) return context.dynamicToolCatalogs;
        return yield* projectWorkspaceError(
          "thread.dynamic-tools.replace",
          new Error(`Updated Core Thread not found: ${threadId}`),
        );
      }),
      mergeThreadWritableRoots: Effect.fn("ProjectWorkspace.mergeThreadWritableRoots")(
        function* (threadId, roots) {
          yield* apply("thread.writable-roots.merge", {
            kind: "merge_thread_writable_roots",
            thread_id: threadId,
            roots: [...roots],
          });
          const context = yield* readThreadExecutionContext(threadId);
          if (context) return context.writableRoots;
          return yield* projectWorkspaceError(
            "thread.writable-roots.merge",
            new Error(`Updated Core Thread not found: ${threadId}`),
          );
        },
      ),
      replaceThreadWritableRoots: Effect.fn("ProjectWorkspace.replaceThreadWritableRoots")(
        function* (threadId, roots) {
          yield* apply("thread.writable-roots.replace", {
            kind: "replace_thread_writable_roots",
            thread_id: threadId,
            roots: [...roots],
          });
          const context = yield* readThreadExecutionContext(threadId);
          if (context) return context.writableRoots;
          return yield* projectWorkspaceError(
            "thread.writable-roots.replace",
            new Error(`Updated Core Thread not found: ${threadId}`),
          );
        },
      ),
      listBackgroundProcesses,
      listManagedWorktreeWindow,
      readManagedWorktreeLifecycleSnapshot,
      upsertBackgroundProcess: Effect.fn("ProjectWorkspace.upsertBackgroundProcess")(function* (
        input,
        options = {},
      ) {
        yield* apply("background-process.upsert", {
          kind: "upsert_background_process",
          process: {
            id: input.id,
            thread_id: input.threadId,
            thread_title: input.threadTitle,
            item_id: input.itemId,
            turn_id: input.turnId,
            command: input.command,
            cwd: input.cwd,
            process_id: input.processId,
            os_pid: input.osPid,
            terminal_session_id: input.terminalSessionId,
            source: input.source,
            started_at_ms: input.startedAtMs,
            updated_at_ms: input.updatedAtMs,
          },
          preserve_started_at: options.preserveStartedAt ?? true,
        });
        const persisted = (yield* listBackgroundProcesses(input.threadId)).find(
          (candidate) => candidate.id === input.id,
        );
        if (persisted) return persisted;
        return yield* projectWorkspaceError(
          "background-process.upsert",
          new Error(`Updated Core background process not found: ${input.id}`),
        );
      }),
      setThreadPinned: Effect.fn("ProjectWorkspace.setThreadPinned")(
        function* (threadId, pinned, beforeThreadId) {
          yield* apply("thread.pinned.set", {
            kind: "set_thread_pinned",
            thread_id: threadId,
            pinned,
            ...(!pinned || beforeThreadId === undefined
              ? {}
              : {
                  placement:
                    beforeThreadId === null
                      ? { kind: "end" as const }
                      : { kind: "before" as const, thread_id: beforeThreadId },
                }),
          }).pipe(Effect.catch((error) => (isNotFound(error) ? Effect.void : Effect.fail(error))));
          const thread = yield* getThread(threadId);
          return mutationSidebarReceipt(thread ? [thread] : []);
        },
      ),
      reorderPinnedThreads: Effect.fn("ProjectWorkspace.reorderPinnedThreads")(
        function* (orderedThreadIds) {
          yield* apply("thread.pinned.reorder", {
            kind: "reorder_pinned_threads",
            thread_ids: [...orderedThreadIds],
          });
          return mutationSidebarReceipt();
        },
      ),
    } satisfies ProjectWorkspaceService);

    return service;
  });

export const live: Layer.Layer<ProjectWorkspace, never, CoreModules> = Layer.effect(
  ProjectWorkspace,
  make,
);
