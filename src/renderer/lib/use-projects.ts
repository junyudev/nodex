import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Project,
  ProjectCreateInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectUpdateInput,
  ProjectWindow,
} from "./types";
import { subscribeProjectChanges } from "./api";
import { projectCatalogStoreFor } from "./project-catalog";
import { projectsListQueryOptions } from "./query-options";
import { queryKeys } from "./query-keys";
import { workspaceProjectCommands } from "./workspace-catalog-commands";

const PROJECTS_LIST_QUERY_KEY = queryKeys.projects.list(false);
const EMPTY_PROJECTS: Project[] = [];

// Module-scope select functions: TanStack Query re-runs `select` only when the
// cached data (or the select reference) changes, so the derived array keeps a
// stable identity across renders. Effects and stores downstream depend on that
// stability; an inline flatMap here previously fed a render loop.
const selectProjects = (data: InfiniteData<ProjectWindow>): Project[] =>
  data.pages.flatMap((window) => window.items);

const selectArchivedProjects = (data: InfiniteData<ProjectWindow>): Project[] =>
  selectProjects(data).filter((project) => project.lifecycle === "archived");

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export function useProjects() {
  const queryClient = useQueryClient();
  const projectCatalog = useMemo(() => projectCatalogStoreFor(queryClient), [queryClient]);
  const projectCatalogSnapshot = useSyncExternalStore(
    projectCatalog.subscribe,
    projectCatalog.getSnapshot,
    projectCatalog.getSnapshot,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const projectsQuery = useInfiniteQuery({
    ...projectsListQueryOptions(),
  });
  const canonicalProjects = useMemo(
    () => (projectsQuery.data ? selectProjects(projectsQuery.data) : EMPTY_PROJECTS),
    [projectsQuery.data],
  );
  const canonicalCatalog = useMemo(() => {
    const data = projectsQuery.data;
    const first = data?.pages[0];
    if (!first) return null;
    const pages = data.pages.filter((page) => page.storeEpoch === first.storeEpoch);
    return {
      storeEpoch: first.storeEpoch,
      projectionRevision: Math.min(...pages.map((page) => page.projectionRevision)),
      projects: pages.flatMap((page) => page.items),
    };
  }, [projectsQuery.data]);
  useLayoutEffect(() => {
    if (!canonicalCatalog) return;
    projectCatalog.publishCanonical(canonicalCatalog);
  }, [canonicalCatalog, projectCatalog]);
  const projects = projectCatalog.projects(canonicalProjects) as Project[];

  const refreshProjects = useCallback(async () => {
    setActionError(null);
    await queryClient.invalidateQueries({
      queryKey: PROJECTS_LIST_QUERY_KEY,
      exact: true,
    });
  }, [queryClient]);

  useEffect(() => {
    return subscribeProjectChanges((event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.all(),
      });
      if (
        event.changeType === "create" ||
        event.changeType === "lifecycle" ||
        event.changeType === "delete"
      ) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.projectActivity.all(),
        });
      }
    });
  }, [queryClient]);

  const { mutateAsync: createProjectRequest } = useMutation({
    mutationFn: workspaceProjectCommands.create,
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
  });

  const { mutateAsync: archiveProjectRequest } = useMutation({
    mutationFn: (projectId: string) =>
      workspaceProjectCommands.setLifecycle(projectId, {
        lifecycle: "archived",
      }),
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async (result) => {
      if (result.kind !== "updated") return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.projects.all(),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectSessions.all() });
    },
  });

  const updateProjectRequest = useCallback(
    async ({ projectId, updates }: { projectId: string; updates: ProjectUpdateInput }) => {
      setActionError(null);
      const outcome = await projectCatalog.updateProject(projectId, updates);
      if (outcome.kind === "acknowledged") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
        return outcome.project;
      }
      if (outcome.kind === "definitive_failure" || outcome.kind === "unknown_outcome") {
        throw new Error(outcome.failure.message);
      }
      throw new Error("The Project update was superseded by a newer authority");
    },
    [projectCatalog, queryClient],
  );

  const { mutateAsync: reorderProjectsRequest } = useMutation({
    mutationFn: workspaceProjectCommands.reorder,
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
  });

  const { mutateAsync: setProjectPinnedRequest } = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: ProjectPinnedInput }) =>
      workspaceProjectCommands.setPinned(projectId, input),
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
  });

  const { mutateAsync: setPinnedProjectOrderRequest } = useMutation({
    mutationFn: workspaceProjectCommands.setPinnedOrder,
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: PROJECTS_LIST_QUERY_KEY,
        exact: true,
      });
    },
  });

  const createProject = useCallback(
    async (input: ProjectCreateInput): Promise<Project | null> => {
      try {
        return await createProjectRequest(input);
      } catch (err) {
        setActionError(getErrorMessage(err));
        return null;
      }
    },
    [createProjectRequest],
  );

  const createProjectOrThrow = useCallback(
    async (input: ProjectCreateInput): Promise<Project> => await createProjectRequest(input),
    [createProjectRequest],
  );

  const archiveProject = useCallback(
    async (projectId: string): Promise<ProjectLifecycleMutationResult> =>
      await archiveProjectRequest(projectId),
    [archiveProjectRequest],
  );

  const updateProject = useCallback(
    async (projectId: string, updates: ProjectUpdateInput): Promise<Project | null> => {
      try {
        return await updateProjectRequest({ projectId, updates });
      } catch (err) {
        setActionError(getErrorMessage(err));
        return null;
      }
    },
    [updateProjectRequest],
  );

  const updateProjectOrThrow = useCallback(
    async (projectId: string, updates: ProjectUpdateInput): Promise<Project | null> =>
      await updateProjectRequest({ projectId, updates }),
    [updateProjectRequest],
  );

  const reorderProjects = useCallback(
    async (input: ProjectOrderInput): Promise<void> => {
      try {
        await reorderProjectsRequest(input);
      } catch (err) {
        setActionError(getErrorMessage(err));
        throw err;
      }
    },
    [reorderProjectsRequest],
  );

  const setProjectPinned = useCallback(
    async (projectId: string, input: ProjectPinnedInput): Promise<Project | null> => {
      try {
        return await setProjectPinnedRequest({ projectId, input });
      } catch (err) {
        setActionError(getErrorMessage(err));
        return null;
      }
    },
    [setProjectPinnedRequest],
  );

  const setPinnedProjectOrder = useCallback(
    async (input: ProjectPinnedOrderInput): Promise<void> => {
      try {
        await setPinnedProjectOrderRequest(input);
      } catch (err) {
        setActionError(getErrorMessage(err));
        throw err;
      }
    },
    [setPinnedProjectOrderRequest],
  );

  const queryError = projectsQuery.error ? getErrorMessage(projectsQuery.error) : null;

  return {
    projects,
    hasMoreProjects: projectsQuery.hasNextPage,
    loadingMoreProjects: projectsQuery.isFetchingNextPage,
    loadMoreProjects: async () => {
      if (!projectsQuery.hasNextPage || projectsQuery.isFetchingNextPage) return;
      await projectsQuery.fetchNextPage();
    },
    loading: projectsQuery.isPending,
    ready: projectsQuery.isSuccess,
    error: actionError ?? queryError,
    refresh: refreshProjects,
    createProject,
    createProjectOrThrow,
    archiveProject,
    updateProject,
    updateProjectOrThrow,
    reorderProjects,
    setProjectPinned,
    setPinnedProjectOrder,
    projectCatalogRenderToken: projectCatalogSnapshot.renderToken,
    markProjectCatalogRendered: projectCatalog.markRendered,
    retryProjectUpdate: projectCatalog.retryProjectUpdate,
  };
}

export function useRemovedProjects(open: boolean) {
  const queryClient = useQueryClient();
  const projectsQuery = useInfiniteQuery({
    ...projectsListQueryOptions({ includeArchived: true }),
    select: selectArchivedProjects,
    enabled: open,
  });

  useEffect(
    () =>
      subscribeProjectChanges(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
      }),
    [queryClient],
  );

  const { mutateAsync: restoreProject, isPending: restoring } = useMutation({
    mutationFn: (projectId: string) =>
      workspaceProjectCommands.setLifecycle(projectId, {
        lifecycle: "active",
      }),
    onSuccess: async (result) => {
      if (result.kind !== "updated") return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectSessions.all() });
    },
  });

  return {
    projects: projectsQuery.data ?? EMPTY_PROJECTS,
    hasMoreProjects: projectsQuery.hasNextPage,
    loadingMoreProjects: projectsQuery.isFetchingNextPage,
    loadMoreProjects: async () => {
      if (!projectsQuery.hasNextPage || projectsQuery.isFetchingNextPage) return;
      await projectsQuery.fetchNextPage();
    },
    loading: projectsQuery.isPending && open,
    error: projectsQuery.error ? getErrorMessage(projectsQuery.error) : null,
    retry: projectsQuery.refetch,
    restoreProject,
    restoring,
  };
}
