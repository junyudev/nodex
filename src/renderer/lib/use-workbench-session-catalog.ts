import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Project,
  ProjectSession,
  ProjectSessionForkInput,
  ProjectSessionForkResult,
  ProjectSessionSummary,
  ProjectSessionSummaryWindow,
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
import {
  ensureWorkbenchThreadSession,
  forkWorkbenchSession,
  listWorkbenchSessions,
} from "./workbench-session-runtime";

const PROJECTLESS_SCOPE_KEY = "__projectless__";

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
  readonly select: (session: ProjectSession | WorkbenchSessionPresentation) => void;
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
  readonly reorder: (
    projectId: string | null,
    orderedSessionIds: readonly string[],
  ) => Promise<void>;
  readonly markUnread: (session: ProjectSession, unread: boolean) => Promise<ProjectSession | null>;
  readonly setPinned: (session: ProjectSession, pinned: boolean) => Promise<ProjectSession | null>;
  readonly rename: (session: ProjectSession, title: string) => Promise<ProjectSession>;
  readonly archive: (session: ProjectSession) => Promise<readonly WorkbenchSessionPresentation[]>;
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
    queries: projectScopeIds.map(projectSessionSummariesQueryOptions),
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
        session.thread !== null,
      );
    },
    [window.scenesByOwnerKey],
  );

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
  const known = useMemo(
    () => [
      ...Object.values(collectionsByProject).flatMap((collection) => collection.presentations),
      ...projectlessCollection.presentations,
    ],
    [collectionsByProject, projectlessCollection.presentations],
  );
  useEffect(() => {
    for (const presentation of known) {
      if (presentation.domain.thread !== null) continue;
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

  const refresh = useCallback(
    async (projectId: string | null): Promise<readonly WorkbenchSessionPresentation[]> => {
      const result = await listWorkbenchSessions(projectId, { first: 50 });
      const installed = queryClient.setQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries(projectId),
        (current) => preferNewestProjectSessionSummaryWindow(current, result),
      );
      return (installed ?? result).items.map(presentSummary);
    },
    [presentSummary, queryClient],
  );
  const refreshThrough = useCallback(
    async (
      projectId: string | null,
      projectionRevision: number,
    ): Promise<ProjectSessionSummaryWindow> => {
      const queryKey = queryKeys.projectSessions.summaries(projectId);
      const previous = queryClient.getQueryData<ProjectSessionSummaryWindow>(queryKey);
      const canonical = await readProjectSessionSummaryWindowThrough({
        previousItemCount: previous?.items.length ?? 0,
        projectionRevision,
        read: async (after, first) =>
          await listWorkbenchSessions(projectId, after === null ? { first } : { after, first }),
      });
      const installed = queryClient.setQueryData<ProjectSessionSummaryWindow>(queryKey, (current) =>
        preferNewestProjectSessionSummaryWindow(current, canonical),
      );
      return installed ?? canonical;
    },
    [queryClient],
  );
  const retryCollection = useCallback(
    async (projectId: string | null): Promise<void> => {
      await queryClient.refetchQueries({
        queryKey: queryKeys.projectSessions.summaries(projectId),
        exact: true,
      });
    },
    [queryClient],
  );

  const loadMore = useCallback(
    async (projectId: string | null): Promise<void> => {
      const key = scopeKey(projectId);
      if (loadInFlightRef.current.has(key)) return;

      const queryKey = queryKeys.projectSessions.summaries(projectId);
      const current = queryClient.getQueryData<ProjectSessionSummaryWindow>(queryKey);
      if (!current?.nextCursor) return;

      loadInFlightRef.current.add(key);
      try {
        const next = await listWorkbenchSessions(projectId, {
          after: current.nextCursor,
          first: 50,
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
      } finally {
        loadInFlightRef.current.delete(key);
      }
    },
    [queryClient],
  );

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
      },
    ): Promise<ProjectSessionForkResult> => {
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
  const reorder = useCallback(
    async (projectId: string | null, orderedSessionIds: readonly string[]): Promise<void> => {
      await workspaceSessionCommands.reorder(projectId, orderedSessionIds);
      await refresh(projectId);
    },
    [refresh],
  );
  const findByThreadId = useCallback(
    (threadId: string) =>
      known.find((candidate) => candidate.domain.thread?.threadId === threadId) ?? null,
    [known],
  );
  const select = useCallback(
    (session: ProjectSession | WorkbenchSessionPresentation) => {
      const domain = "domain" in session ? session.domain : session;
      window.selectSession({
        id: domain.id,
        projectId: domain.projectId,
      });
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
    reorder,
    markUnread,
    setPinned,
    rename,
    archive,
    ensureThreadSession,
    ensureDefaultDraft,
    createOrdinarySession,
    fork,
  };
}
