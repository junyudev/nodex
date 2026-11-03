import { hashKey, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { subscribeBoardChanges } from "@/lib/api";
import { applyBoardChangeEventToBoard } from "@/lib/board-summary-events";
import { boardByProjectQueryOptions } from "@/lib/query-options";
import { queryKeys } from "@/lib/query-keys";
import type { BoardSummary, BoardSummarySnapshot, Project } from "@/lib/types";
import { invalidateExactQuery } from "./query-invalidation";
import { useProjectionInvalidationRegistry } from "./projection-invalidation-context";

const BOARD_CHANGE_REFETCH_COALESCE_MS = 50;

interface BoardSummaryQueryResult {
  data?: BoardSummarySnapshot;
  isError: boolean;
  isPending: boolean;
}

/**
 * Fetches boards for every project. Used by Page pickers and @ mention menus.
 */
export function useBoardsForProjects(
  projects: readonly Project[],
  projectsLoading = false,
  projectsError: string | null = null,
) {
  const queryClient = useQueryClient();
  const projectionRegistry = useProjectionInvalidationRegistry();
  const projectAuthorityKey = JSON.stringify(
    projects.map((project) => [project.id, project.libraryId, project.databaseId]),
  );
  const refetchTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const combineBoardResults = useCallback(
    (results: readonly BoardSummaryQueryResult[]) => {
      const boards = new Map<string, BoardSummary>();
      let failedBoardCount = 0;
      results.forEach((result, index) => {
        const project = projects[index];
        if (!project) return;
        if (result.data) {
          boards.set(project.id, result.data.board);
          return;
        }
        if (result.isError) failedBoardCount += 1;
      });

      const loading = projectsLoading || results.some((result) => result.isPending);
      const allBoardsFailed =
        projects.length > 0 && failedBoardCount === projects.length && !loading;

      return {
        projects,
        boards,
        loading,
        error: projectsError ?? (allBoardsFailed ? "Something went wrong" : null),
      };
    },
    [projects, projectsError, projectsLoading],
  );

  const boardsQuery = useQueries({
    queries: projects.map((project) => boardByProjectQueryOptions(project.id)),
    combine: combineBoardResults,
  });
  useEffect(() => {
    const authorities = JSON.parse(projectAuthorityKey) as Array<[string, string, string]>;
    if (authorities.length === 0) return;
    const projectIds = authorities.map(([projectId]) => projectId);
    const currentRegistry = projectionRegistry;
    const currentQueryClient = queryClient;
    const refetchTimers = refetchTimersRef.current;
    const scheduleRefetch = (projectId: string) => {
      if (refetchTimers.has(projectId)) return;
      const timer = setTimeout(() => {
        refetchTimers.delete(projectId);
        void invalidateExactQuery(currentQueryClient, queryKeys.boards.byProject(projectId));
      }, BOARD_CHANGE_REFETCH_COALESCE_MS);
      refetchTimers.set(projectId, timer);
    };
    const unsubscribes: Array<() => void> = [];
    for (const [projectId, libraryId, databaseId] of authorities) {
      unsubscribes.push(
        subscribeBoardChanges(projectId, (event) => {
          let applied = false;
          currentQueryClient.setQueryData<BoardSummarySnapshot | undefined>(
            queryKeys.boards.byProject(projectId),
            (current) => {
              if (
                !current ||
                !event.storeEpoch ||
                event.commitSeq === undefined ||
                event.storeEpoch !== current.storeEpoch ||
                event.commitSeq < current.commitSeq
              )
                return current;
              const next = applyBoardChangeEventToBoard(current.board, event);
              if (!next) return current;
              applied = true;
              return {
                ...current,
                board: next,
                commitSeq: event.commitSeq,
              };
            },
          );
          if (!applied) scheduleRefetch(projectId);
        }),
      );
      unsubscribes.push(
        currentRegistry.register({
          scope: {
            kind: "project",
            libraryId,
            projectId,
          },
          consumerKey: hashKey(queryKeys.boards.byProject(projectId)),
          getDependencies: () => {
            const snapshot = currentQueryClient.getQueryData<BoardSummarySnapshot>(
              queryKeys.boards.byProject(projectId),
            );
            return {
              databaseIds: snapshot ? [snapshot.databaseId] : [databaseId],
              dataSourceIds: snapshot ? [snapshot.dataSourceId] : [],
              viewIds: snapshot ? [snapshot.viewId] : [],
              pageIds:
                snapshot?.board.columns.flatMap((column) => column.cards.map((card) => card.id)) ??
                [],
            };
          },
          getCursor: () => {
            const snapshot = currentQueryClient.getQueryData<BoardSummarySnapshot>(
              queryKeys.boards.byProject(projectId),
            );
            return snapshot
              ? {
                  storeEpoch: snapshot.storeEpoch,
                  commitSeq: snapshot.commitSeq,
                }
              : null;
          },
          invalidate: () =>
            invalidateExactQuery(currentQueryClient, queryKeys.boards.byProject(projectId)),
        }),
      );
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      for (const projectId of projectIds) {
        const timer = refetchTimers.get(projectId);
        if (!timer) continue;
        clearTimeout(timer);
        refetchTimers.delete(projectId);
      }
    };
  }, [projectAuthorityKey, projectionRegistry, queryClient]);

  useEffect(() => {
    const refetchTimers = refetchTimersRef.current;
    return () => {
      for (const timer of refetchTimers.values()) {
        clearTimeout(timer);
      }
      refetchTimers.clear();
    };
  }, []);

  return boardsQuery;
}
