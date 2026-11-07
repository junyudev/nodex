import { runWithCleanup } from "./run-with-cleanup";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { dispatchWorkbenchCodexNavigation } from "../features/local-conversation/use-workbench-codex-navigation";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Project,
  ProjectSession,
  ProjectSessionForkInput,
  ProjectSessionForkResult,
  ProjectSessionSummary,
  ProjectSessionSummaryWindow,
  ProjectSessionSummaryWindowInput,
  ProjectSessionPlacement,
} from "../../shared/types";
import type { WorkbenchLocation } from "../../shared/workbench-layout";
import { getWorkbenchSceneReturnLocation } from "../../shared/workbench-layout";
import {
  enforceWorkbenchSessionReviewEligibility,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSceneSnapshot,
} from "../../shared/workbench-scene";
import {
  getCachedProjectSessionDetail,
  prefetchProjectSessionDetail,
  readCurrentProjectSessionDetail,
  preferNewestProjectSessionSummaryWindow,
  projectSessionToSummary,
  readProjectSessionSummaryWindowThrough,
  seedProjectSessionDetail,
  setProjectSessionSummaries,
} from "./project-session-query-cache";
import {
  projectSessionDetailQueryOptions,
  projectSessionSummariesQueryOptions,
} from "./query-options";
import { queryKeys } from "./query-keys";
import {
  presentWorkbenchSession,
  projectSessionSummaryToDomain,
  type WorkbenchSessionPresentation,
  type WorkbenchSessionRenderProjection,
} from "./workbench-session-presentation";
import type { WorkbenchSessionCatalogEntry } from "./workbench-window-state";
import { workspaceSessionCommands } from "./workspace-catalog-commands";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  ensureWorkbenchThreadSession,
  forkWorkbenchSession,
  listWorkbenchSessions,
} from "./workbench-session-runtime";

const PROJECTLESS_SCOPE_KEY = "__projectless__";

/** Where a selected Session appears: its Home scene by default, or in place within Scheduled. */
export interface WorkbenchSessionPlacement {
  readonly scheduledPath: string;
}

export interface WorkbenchSessionCatalogWindowPort {
  readonly location: WorkbenchLocation;
  readonly scenesByOwnerKey: Readonly<Record<string, WorkbenchSceneSnapshot>>;
  readonly setScene: (
    owner: WorkbenchSceneOwner,
    update:
      | WorkbenchSceneSnapshot
      | ((previous: WorkbenchSceneSnapshot | undefined) => WorkbenchSceneSnapshot),
  ) => void;
  readonly selectSession: (session: WorkbenchSessionCatalogEntry) => void;
  readonly presentScheduledSession: (input: {
    readonly path: string;
    readonly session: WorkbenchSessionCatalogEntry;
  }) => void;
  readonly selectProject: (projectId: string | null) => void;
  readonly reconcileMissingSession: (sessionId: string) => void;
}

export interface UseWorkbenchSessionCatalogInput {
  readonly projects: readonly Project[];
  readonly expandedProjectIds: ReadonlySet<string>;
  readonly window: WorkbenchSessionCatalogWindowPort;
}

export type WorkbenchSessionCollectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly refreshing: boolean;
      readonly refreshError: string | null;
    }
  | { readonly kind: "error"; readonly message: string };

export interface WorkbenchSessionCollection {
  readonly presentations: readonly WorkbenchSessionPresentation[];
  readonly projections: readonly WorkbenchSessionRenderProjection[];
  readonly projectionRevision: number | null;
  readonly state: WorkbenchSessionCollectionState;
  readonly hasMore: boolean;
}

export function projectSessionProjectionsByProject(
  collections: Readonly<Record<string, WorkbenchSessionCollection>>,
): Record<string, WorkbenchSessionRenderProjection[]> {
  return Object.fromEntries(
    Object.entries(collections).map(([projectId, collection]) => [
      projectId,
      [...collection.projections],
    ]),
  );
}

interface WorkbenchSessionSummaryQueryState {
  readonly data: ProjectSessionSummaryWindow | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
}

export interface WorkbenchSessionCatalog {
  readonly activeProject: Project | null;
  readonly activeProjectId: string | null;
  readonly activeSessionId: string | null;
  readonly active: WorkbenchSessionPresentation | null;
  readonly activeProjection: WorkbenchSessionRenderProjection | null;
  readonly collectionsByProject: Readonly<Record<string, WorkbenchSessionCollection>>;
  readonly projectlessCollection: WorkbenchSessionCollection;
  readonly selectedDetailReady: boolean;
  readonly selectedDetailError: string | null;
  readonly resolveScene: (
    session: ProjectSession | ProjectSessionSummary,
  ) => WorkbenchSceneSnapshot;
  readonly resolveDefaultDatabaseViewId: (projectId: string | null) => string | null;
  readonly findById: (sessionId: string) => WorkbenchSessionPresentation | null;
  readonly findByThreadId: (threadId: string) => WorkbenchSessionPresentation | null;
  readonly select: (
    session: ProjectSession | WorkbenchSessionPresentation,
    placement?: WorkbenchSessionPlacement,
  ) => void;
  readonly selectProject: (projectId: string | null) => void;
  readonly refresh: (projectId: string | null) => Promise<readonly WorkbenchSessionPresentation[]>;
  readonly refreshThrough: (
    projectId: string | null,
    projectionRevision: number,
  ) => Promise<ProjectSessionSummaryWindow>;
  readonly retryCollection: (projectId: string | null) => Promise<void>;
  readonly loadMore: (projectId: string | null) => Promise<void>;
  readonly seed: (session: ProjectSession | null | undefined) => void;
  readonly prefetch: (sessionId: string) => Promise<ProjectSession | null>;
  readonly readCurrent: (sessionId: string) => Promise<ProjectSession | null>;
  readonly place: (sessionId: string, placement: ProjectSessionPlacement) => Promise<void>;
  readonly setReminder: (
    session: ProjectSession,
    remindAt: string | null,
  ) => Promise<ProjectSession | null>;
  readonly markUnread: (session: ProjectSession, unread: boolean) => Promise<ProjectSession | null>;
  readonly setPinned: (session: ProjectSession, pinned: boolean) => Promise<ProjectSession | null>;
  readonly rename: (session: ProjectSession, title: string) => Promise<ProjectSession>;
  readonly archive: (session: ProjectSession) => Promise<readonly WorkbenchSessionPresentation[]>;
  readonly unarchive: (session: ProjectSession) => Promise<void>;
  readonly ensureThreadSession: (threadId: string) => Promise<ProjectSession | null>;
  readonly ensureDefaultDraft: (projectId: string | null) => Promise<WorkbenchSessionPresentation>;
  readonly createOrdinarySession: (
    projectId: string | null,
    noThreadFallbackTitle?: string,
    initialPageIds?: readonly string[],
  ) => Promise<WorkbenchSessionPresentation>;
  readonly fork: (
    session: ProjectSession,
    input: ProjectSessionForkInput & {
      readonly browserViewScopeId: string;
      readonly sourceThreadId?: string;
    },
  ) => Promise<ProjectSessionForkResult>;
}

function scopeKey(projectId: string | null): string {
  return projectId ?? PROJECTLESS_SCOPE_KEY;
}

function sessionCollectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Couldn’t load chats";
}

export type WorkbenchSessionCollections = Pick<
  WorkbenchSessionCatalog,
  | "collectionsByProject"
  | "projectlessCollection"
  | "refresh"
  | "refreshThrough"
  | "retryCollection"
  | "loadMore"
>;

/** Independent paging windows for general chat pickers and built-in sidebar lanes. */
export function useWorkbenchSessionCollections({
  projects,
  expandedProjectIds,
  activeProjectId,
  resolveScene,
  placementScope,
  order = "activity",
}: {
  projects: readonly Project[];
  expandedProjectIds: ReadonlySet<string>;
  activeProjectId: string | null;
  resolveScene: WorkbenchSessionCatalog["resolveScene"];
  placementScope: NonNullable<ProjectSessionSummaryWindowInput["placementScope"]>;
  order?: NonNullable<ProjectSessionSummaryWindowInput["order"]>;
}): WorkbenchSessionCollections {
  const queryClient = useQueryClient();
  const projectScopeIds = useMemo(
    () => [
      ...projects
        .filter((project) => expandedProjectIds.has(project.id) || project.id === activeProjectId)
        .map((project) => project.id),
      null,
    ],
    [activeProjectId, expandedProjectIds, projects],
  );

  const summaryState = useQueries({
    queries: projectScopeIds.map((projectId) =>
      projectSessionSummariesQueryOptions(projectId, placementScope, order),
    ),
    combine: (results) => ({
      queriesByScope: Object.fromEntries(
        results.map((result, index) => [
          scopeKey(projectScopeIds[index] ?? null),
          {
            data: result.data,
            error: result.error,
            isFetching: result.isFetching,
          },
        ]),
      ) as Record<string, WorkbenchSessionSummaryQueryState>,
    }),
  });
  const loadInFlightRef = useRef<Set<string>>(new Set());

  const presentSummary = useCallback(
    (summary: ProjectSessionSummary): WorkbenchSessionPresentation => {
      const detail = getCachedProjectSessionDetail(queryClient, summary.id);
      const domain = projectSessionSummaryToDomain(summary, detail ?? undefined);
      return {
        domain,
        scene: resolveScene(domain),
      };
    },
    [queryClient, resolveScene],
  );

  const buildCollection = useCallback(
    (query: WorkbenchSessionSummaryQueryState | undefined): WorkbenchSessionCollection => {
      const presentations = (query?.data?.items ?? []).map(presentSummary);
      const projections = presentations.map(presentWorkbenchSession);

      if (!query) {
        return {
          presentations,
          projections,
          projectionRevision: null,
          state: { kind: "idle" },
          hasMore: false,
        };
      }

      if (query.data !== undefined) {
        return {
          presentations,
          projections,
          projectionRevision: query.data.projectionRevision,
          state: {
            kind: "ready",
            refreshing: query.isFetching,
            refreshError: query.error ? sessionCollectionErrorMessage(query.error) : null,
          },
          hasMore: query.data.hasMore,
        };
      }

      if (query.error) {
        return {
          presentations,
          projections,
          projectionRevision: null,
          state: {
            kind: "error",
            message: sessionCollectionErrorMessage(query.error),
          },
          hasMore: false,
        };
      }

      return {
        presentations,
        projections,
        projectionRevision: null,
        state: { kind: "loading" },
        hasMore: false,
      };
    },
    [presentSummary],
  );
  const collectionsByProject = useMemo<Record<string, WorkbenchSessionCollection>>(
    () =>
      Object.fromEntries(
        projects.map((project) => [
          project.id,
          buildCollection(summaryState.queriesByScope[project.id]),
        ]),
      ),
    [buildCollection, projects, summaryState.queriesByScope],
  );
  const projectlessCollection = useMemo(
    () => buildCollection(summaryState.queriesByScope[PROJECTLESS_SCOPE_KEY]),
    [buildCollection, summaryState.queriesByScope],
  );
  const refresh = useCallback(
    async (projectId: string | null): Promise<readonly WorkbenchSessionPresentation[]> => {
      const result = await listWorkbenchSessions(projectId, { first: 50, placementScope, order });
      const installed = queryClient.setQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries(projectId, placementScope, order),
        (current) => preferNewestProjectSessionSummaryWindow(current, result),
      );
      return (installed ?? result).items.map(presentSummary);
    },
    [order, placementScope, presentSummary, queryClient],
  );
  const refreshThrough = useCallback(
    async (
      projectId: string | null,
      projectionRevision: number,
    ): Promise<ProjectSessionSummaryWindow> => {
      const queryKey = queryKeys.projectSessions.summaries(projectId, placementScope, order);
      const previous = queryClient.getQueryData<ProjectSessionSummaryWindow>(queryKey);
      const canonical = await readProjectSessionSummaryWindowThrough({
        previousItemCount: previous?.items.length ?? 0,
        projectionRevision,
        read: async (after, first) =>
          await listWorkbenchSessions(projectId, {
            first,
            placementScope,
            order,
            ...(after === null ? {} : { after }),
          }),
      });
      const installed = queryClient.setQueryData<ProjectSessionSummaryWindow>(queryKey, (current) =>
        preferNewestProjectSessionSummaryWindow(current, canonical),
      );
      return installed ?? canonical;
    },
    [order, placementScope, queryClient],
  );
  const retryCollection = useCallback(
    async (projectId: string | null): Promise<void> => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.projectSessions.summaries(projectId, placementScope, order),
        exact: true,
      });
    },
    [order, placementScope, queryClient],
  );

  const loadMore = useCallback(
    async (projectId: string | null): Promise<void> => {
      const key = `${scopeKey(projectId)}:${placementScope}:${order}`;
      if (loadInFlightRef.current.has(key)) return;

      const queryKey = queryKeys.projectSessions.summaries(projectId, placementScope, order);
      const current = queryClient.getQueryData<ProjectSessionSummaryWindow>(queryKey);
      if (!current?.nextCursor) return;

      loadInFlightRef.current.add(key);
      await runWithCleanup(
        async () => {
          const next = await listWorkbenchSessions(projectId, {
            after: current.nextCursor,
            first: 50,
            placementScope,
            order,
          });
          queryClient.setQueryData<ProjectSessionSummaryWindow>(queryKey, (latest) => {
            if (!latest || latest.nextCursor !== current.nextCursor) {
              return latest;
            }
            if (
              latest.projectionRevision !== current.projectionRevision ||
              next.projectionRevision !== current.projectionRevision
            ) {
              return latest;
            }
            const knownIds = new Set(latest.items.map((item) => item.id));
            return {
              ...next,
              items: [...latest.items, ...next.items.filter((item) => !knownIds.has(item.id))],
            };
          });
        },
        {
          cleanup: () => {
            loadInFlightRef.current.delete(key);
          },
        },
      );
    },
    [order, placementScope, queryClient],
  );

  return {
    collectionsByProject,
    projectlessCollection,
    refresh,
    refreshThrough,
    retryCollection,
    loadMore,
  };
}

export function useWorkbenchSessionCatalog({
  projects,
  expandedProjectIds,
  window,
}: UseWorkbenchSessionCatalogInput): WorkbenchSessionCatalog {
  const queryClient = useQueryClient();
  const sceneLocation = getWorkbenchSceneReturnLocation(window.location);
  const activeProjectId =
    sceneLocation.kind === "project"
      ? sceneLocation.projectId
      : sceneLocation.kind === "session"
        ? sceneLocation.projectContextId
        : null;
  const activeSessionId = sceneLocation.kind === "session" ? sceneLocation.sessionId : null;
  const resolveProjectDefaultDatabaseViewId = useCallback(
    (projectId: string | null): string | null =>
      projectId === null
        ? null
        : (projects.find((project) => project.id === projectId)?.defaultDatabaseViewId ?? null),
    [projects],
  );
  const resolveScene = useCallback(
    (session: ProjectSession | ProjectSessionSummary): WorkbenchSceneSnapshot => {
      const owner = { kind: "session", sessionId: session.id } as const;
      const persisted =
        window.scenesByOwnerKey[
          makeWorkbenchSceneKey({
            kind: "session",
            sessionId: session.id,
          })
        ];
      return enforceWorkbenchSessionReviewEligibility(
        persisted ?? materializeInitialWorkbenchScene(owner),
        Boolean(session.executionRef || session.thread),
      );
    },
    [window.scenesByOwnerKey],
  );

  const {
    collectionsByProject,
    projectlessCollection,
    refresh,
    refreshThrough,
    retryCollection,
    loadMore,
  } = useWorkbenchSessionCollections({
    projects,
    expandedProjectIds,
    activeProjectId,
    resolveScene,
    placementScope: "all",
  });
  const known = useMemo(
    () => [
      ...Object.values(collectionsByProject).flatMap((collection) => collection.presentations),
      ...projectlessCollection.presentations,
    ],
    [collectionsByProject, projectlessCollection.presentations],
  );
  useEffect(() => {
    for (const presentation of known) {
      if (presentation.domain.executionRef || presentation.domain.thread) continue;
      const owner = { kind: "session", sessionId: presentation.domain.id } as const;
      const persisted = window.scenesByOwnerKey[makeWorkbenchSceneKey(owner)];
      if (!persisted) continue;
      const eligible = enforceWorkbenchSessionReviewEligibility(persisted, false);
      if (eligible === persisted) continue;
      window.setScene(owner, eligible);
    }
  }, [known, window]);
  const selectedSummaryPresentation = activeSessionId
    ? (known.find((candidate) => candidate.domain.id === activeSessionId) ?? null)
    : null;
  const selectedDetailQuery = useQuery({
    ...projectSessionDetailQueryOptions(activeSessionId ?? ""),
    enabled: activeSessionId !== null,
  });
  const active = useMemo<WorkbenchSessionPresentation | null>(() => {
    const detail = selectedDetailQuery.data;
    if (detail === null) return null;
    if (detail === undefined) return selectedSummaryPresentation;
    return {
      domain: selectedSummaryPresentation
        ? projectSessionSummaryToDomain(selectedSummaryPresentation.domain, detail)
        : detail,
      scene: resolveScene(detail),
    };
  }, [resolveScene, selectedDetailQuery.data, selectedSummaryPresentation]);

  useEffect(() => {
    if (!activeSessionId || selectedDetailQuery.data !== null) return;
    window.reconcileMissingSession(activeSessionId);
  }, [activeSessionId, selectedDetailQuery.data, window]);

  useEffect(() => {
    if (!active) return;
    const owner = {
      kind: "session",
      sessionId: active.domain.id,
    } as const;
    const sceneKey = makeWorkbenchSceneKey(owner);
    if (window.scenesByOwnerKey[sceneKey]) return;
    window.setScene(owner, materializeInitialWorkbenchScene(owner));
  }, [active, window]);

  const seed = useCallback(
    (session: ProjectSession | null | undefined) => {
      seedProjectSessionDetail(queryClient, session);
    },
    [queryClient],
  );
  const prefetch = useCallback(
    async (sessionId: string) => await prefetchProjectSessionDetail(queryClient, sessionId),
    [queryClient],
  );
  const setReminder = useCallback(
    async (session: ProjectSession, remindAt: string | null): Promise<ProjectSession | null> => {
      const updated = await workspaceSessionCommands.setReminder(session.id, { remindAt });
      seedProjectSessionDetail(queryClient, updated);
      return updated;
    },
    [queryClient],
  );
  const markUnread = useCallback(
    async (session: ProjectSession, unread: boolean): Promise<ProjectSession | null> => {
      const updated = await workspaceSessionCommands.markUnread(session.id, { unread });
      seedProjectSessionDetail(queryClient, updated);
      return updated;
    },
    [queryClient],
  );
  const setPinned = useCallback(
    async (session: ProjectSession, pinned: boolean): Promise<ProjectSession | null> => {
      if (session.projectId === null) return null;
      const projectId = session.projectId;
      const previousWindow = queryClient.getQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries(projectId),
      );
      const previousSummaries = previousWindow?.items ?? [];
      const nextPinnedOrder = pinned
        ? Math.max(-1, ...previousSummaries.map((candidate) => candidate.pinnedOrder ?? -1)) + 1
        : null;
      const optimistic = {
        ...session,
        pinned,
        pinnedOrder: nextPinnedOrder,
      };
      const optimisticDetail = seedProjectSessionDetail(queryClient, optimistic);
      const optimisticWindow = setProjectSessionSummaries(
        queryClient,
        projectId,
        previousSummaries.map((candidate) =>
          candidate.id === session.id ? projectSessionToSummary(optimistic) : candidate,
        ),
      );

      try {
        const updated = await workspaceSessionCommands.setPinned(session.id, { pinned });
        seedProjectSessionDetail(queryClient, updated);
        await refresh(projectId);
        return updated;
      } catch (error) {
        queryClient.setQueryData<ProjectSession | null | undefined>(
          queryKeys.projectSessions.detail(session.id),
          (current) => (current === optimisticDetail ? session : current),
        );
        if (previousWindow) {
          queryClient.setQueryData<ProjectSessionSummaryWindow>(
            queryKeys.projectSessions.summaries(projectId),
            (current) => (current === optimisticWindow ? previousWindow : current),
          );
        }
        throw error;
      }
    },
    [queryClient, refresh],
  );
  const rename = useCallback(
    async (session: ProjectSession, title: string): Promise<ProjectSession> => {
      const updated = await workspaceSessionCommands.rename(session.id, { title });
      seedProjectSessionDetail(queryClient, updated);
      await refresh(updated.projectId);
      return updated;
    },
    [queryClient, refresh],
  );
  const archive = useCallback(
    async (session: ProjectSession): Promise<readonly WorkbenchSessionPresentation[]> => {
      await workspaceSessionCommands.archive(session.id);
      queryClient.removeQueries({
        queryKey: queryKeys.projectSessions.detail(session.id),
        exact: true,
      });
      return await refresh(session.projectId);
    },
    [queryClient, refresh],
  );
  const unarchive = useCallback(
    async (session: ProjectSession): Promise<void> => {
      await workspaceSessionCommands.unarchive(session.id);
      await refresh(session.projectId);
    },
    [refresh],
  );
  const ensureThreadSession = useCallback(
    async (threadId: string): Promise<ProjectSession | null> => {
      const ensured = await ensureWorkbenchThreadSession(threadId);
      if (!ensured) return null;
      seedProjectSessionDetail(queryClient, ensured);
      await refresh(ensured.projectId);
      return ensured;
    },
    [queryClient, refresh],
  );
  const ensureDefaultDraft = useCallback(
    async (projectId: string | null): Promise<WorkbenchSessionPresentation> => {
      const domain = await workspaceSessionCommands.ensureDefaultDraft(projectId);
      seedProjectSessionDetail(queryClient, domain);
      await refresh(projectId);
      return {
        domain,
        scene: resolveScene(domain),
      };
    },
    [queryClient, refresh, resolveScene],
  );
  const createOrdinarySession = useCallback(
    async (
      projectId: string | null,
      noThreadFallbackTitle = "New chat",
      initialPageIds: readonly string[] = [],
    ): Promise<WorkbenchSessionPresentation> => {
      const domain = await workspaceSessionCommands.create({
        projectId,
        noThreadFallbackTitle,
        initialPageIds: [...initialPageIds],
      });
      seedProjectSessionDetail(queryClient, domain);
      await refresh(projectId);
      return {
        domain,
        scene: resolveScene(domain),
      };
    },
    [queryClient, refresh, resolveScene],
  );
  const fork = useCallback(
    async (
      session: ProjectSession,
      input: ProjectSessionForkInput & {
        readonly browserViewScopeId: string;
        readonly sourceThreadId?: string;
      },
    ): Promise<ProjectSessionForkResult> => {
      if (session.executionRef) {
        const result = await agentRuntimeRuntime.fork({
          source: {
            sessionId: session.id,
            threadId: input.sourceThreadId ?? session.executionRef.threadId,
          },
          sessionId: createUuidV7(),
          requestId: createUuidV7(),
          acceptedAt: Date.now(),
          environment: input.target === "newWorktree" ? "worktree" : "same-directory",
          runInEnvironmentPath: input.localEnvironmentConfigPath,
          sourceRunId: input.turnId,
        });
        const forked = await readCurrentProjectSessionDetail(result.sessionId);
        if (forked?.executionRef?.threadId !== result.threadId)
          throw new Error("Fork execution binding changed");
        seedProjectSessionDetail(queryClient, forked);
        await refresh(result.projectId);
        return {
          session: forked,
          threadId: result.threadId,
          ...(input.message
            ? { composerIntent: { prompt: input.message, focusNonce: Date.now() } }
            : {}),
        };
      }
      if (session.thread && (session.thread.executionHostId ?? "local") === "local")
        throw new Error(
          "This imported conversation has no execution owner. Open a new chat to continue.",
        );
      const result = await forkWorkbenchSession(
        session.id,
        {
          target: input.target,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.collaborationMode === undefined
            ? {}
            : { collaborationMode: input.collaborationMode }),
          ...(input.target === "newWorktree"
            ? {
                localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
              }
            : {}),
        },
        {
          browserViewScopeId: input.browserViewScopeId,
          scene: resolveScene(session),
        },
      );
      if ("pendingWorktreeId" in result) return result;
      seedProjectSessionDetail(queryClient, result.session);
      await refresh(result.session.projectId);
      return result;
    },
    [queryClient, refresh, resolveScene],
  );
  const findById = useCallback(
    (sessionId: string) => known.find((candidate) => candidate.domain.id === sessionId) ?? null,
    [known],
  );
  const place = useCallback(
    async (sessionId: string, placement: ProjectSessionPlacement): Promise<void> => {
      await workspaceSessionCommands.place(sessionId, placement);
      await refresh(
        known.find((session) => session.domain.id === sessionId)?.domain.projectId ?? null,
      );
    },
    [known, refresh],
  );
  const findByThreadId = useCallback(
    (threadId: string) =>
      known.find((candidate) => candidate.domain.thread?.threadId === threadId) ?? null,
    [known],
  );
  const select = useCallback(
    (
      session: ProjectSession | WorkbenchSessionPresentation,
      placement?: WorkbenchSessionPlacement,
    ) => {
      const domain = "domain" in session ? session.domain : session;
      if (window.location.kind !== "session" || window.location.sessionId !== domain.id)
        dispatchWorkbenchCodexNavigation(domain.thread);
      const entry = { id: domain.id, projectId: domain.projectId };
      if (placement) {
        window.presentScheduledSession({ path: placement.scheduledPath, session: entry });
        return;
      }
      window.selectSession(entry);
    },
    [window],
  );
  const selectProject = useCallback(
    (projectId: string | null) => window.selectProject(projectId),
    [window],
  );

  const activeProjection = useMemo(
    () => (active ? presentWorkbenchSession(active) : null),
    [active],
  );
  const selectedDetailQueryError = selectedDetailQuery.error;
  const selectedDetailError =
    selectedDetailQueryError instanceof Error
      ? selectedDetailQueryError.message
      : selectedDetailQueryError
        ? "Unable to load the selected session"
        : null;
  const selectedDetailReady = activeSessionId === null || !selectedDetailQuery.isPending;

  return {
    activeProject: projects.find((project) => project.id === activeProjectId) ?? null,
    activeProjectId,
    activeSessionId,
    active,
    activeProjection,
    collectionsByProject,
    projectlessCollection,
    selectedDetailReady,
    selectedDetailError,
    resolveScene,
    resolveDefaultDatabaseViewId: resolveProjectDefaultDatabaseViewId,
    findById,
    findByThreadId,
    select,
    selectProject,
    refresh,
    refreshThrough,
    retryCollection,
    loadMore,
    seed,
    prefetch,
    readCurrent: readCurrentProjectSessionDetail,
    place,
    markUnread,
    setReminder,
    setPinned,
    rename,
    archive,
    unarchive,
    ensureThreadSession,
    ensureDefaultDraft,
    createOrdinarySession,
    fork,
  };
}
