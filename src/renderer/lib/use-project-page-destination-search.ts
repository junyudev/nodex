import { useMemo } from "react";
import type { NfmMoveToSearchResult } from "@/components/board/editor/nfm-move-to-menu-search";
import { normalizeSearchText } from "@/lib/search-text";
import type { PageSearchResult, Project } from "@/lib/types";
import {
  useInteractivePageSearch,
  type InteractivePageSearchResult,
} from "./interactive-page-search";
import { WORKFLOW_STATUS_LABELS } from "../../shared/workflow-status";

const DESTINATION_SEARCH_LIMIT = 60;

export interface ProjectPageDestinationSearchResult extends NfmMoveToSearchResult {
  readonly enrichment: InteractivePageSearchResult["enrichment"];
}

function emptyResult(query: string): NfmMoveToSearchResult {
  return {
    normalizedQuery: normalizeSearchText(query),
    matchedProjectIds: new Set(),
    matchedColumnIdsByProjectId: new Map(),
    pageHits: [],
  };
}

export function mergeDestinationSearchResults(
  local: NfmMoveToSearchResult,
  remote: NfmMoveToSearchResult,
): NfmMoveToSearchResult {
  if (local.normalizedQuery !== remote.normalizedQuery) return local;

  const pageHits = new Map(local.pageHits.map((hit) => [hit.id, hit] as const));
  for (const hit of remote.pageHits) {
    const localHit = pageHits.get(hit.id);
    pageHits.set(
      hit.id,
      localHit
        ? {
            ...hit,
            boardOrder: localHit.boardOrder,
            pageKey: hit.pageKey ?? localHit.pageKey,
            score: Math.max(localHit.score, hit.score),
            matchedPageKey: hit.matchedPageKey ?? localHit.matchedPageKey,
            matchedPageKeyIsCurrent:
              hit.matchedPageKeyIsCurrent ?? localHit.matchedPageKeyIsCurrent,
          }
        : hit,
    );
  }
  return {
    normalizedQuery: local.normalizedQuery,
    matchedProjectIds: new Set([...local.matchedProjectIds, ...remote.matchedProjectIds]),
    matchedColumnIdsByProjectId: new Map([
      ...local.matchedColumnIdsByProjectId,
      ...remote.matchedColumnIdsByProjectId,
    ]),
    pageHits: [...pageHits.values()].sort(
      (left, right) => right.score - left.score || left.boardOrder - right.boardOrder,
    ),
  };
}

export function buildRemoteDestinationSearchResult({
  projects,
  query,
  results,
  sourceProjectId = null,
  sourcePageId = null,
}: {
  projects: readonly Project[];
  query: string;
  results: readonly PageSearchResult[];
  sourceProjectId?: string | null;
  sourcePageId?: string | null;
}): NfmMoveToSearchResult {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return emptyResult(query);

  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  return {
    normalizedQuery,
    matchedProjectIds: new Set(),
    matchedColumnIdsByProjectId: new Map(),
    pageHits: results.flatMap((result, index) => {
      if (result.projectId === null) return [];
      const project = projectById.get(result.projectId);
      if (!project) return [];
      if (!result.status) return [];
      if (result.projectId === sourceProjectId && result.pageId === sourcePageId) {
        return [];
      }
      const pageKeyMatch = result.matches.find((match) => match.source === "page_key");
      return [
        {
          id: `page:${result.projectId}:${result.pageId}`,
          projectId: result.projectId,
          projectName: project.name || "Untitled",
          projectAppearance: project.appearance,
          columnId: result.status,
          columnName: WORKFLOW_STATUS_LABELS[result.status],
          pageId: result.pageId,
          pageKey: result.pageKey ?? null,
          matchedPageKey: pageKeyMatch?.pageKey ?? null,
          matchedPageKeyIsCurrent: pageKeyMatch?.isCurrent ?? null,
          pageTitle: result.title || "Untitled",
          boardOrder: index,
          score: results.length - index,
        },
      ];
    }),
  };
}

export function useProjectPageDestinationSearch({
  projects,
  query,
  enabled,
  sourceProjectId = null,
  sourcePageId = null,
}: {
  projects: readonly Project[];
  query: string;
  enabled: boolean;
  sourceProjectId?: string | null;
  sourcePageId?: string | null;
}): ProjectPageDestinationSearchResult {
  const normalizedQuery = normalizeSearchText(query);
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  const search = useInteractivePageSearch({
    projectIds: enabled ? projectIds : [],
    query: normalizedQuery,
    limit: DESTINATION_SEARCH_LIMIT,
    excludePageIds: sourcePageId ? [sourcePageId] : [],
    complete: enabled && normalizedQuery.length > 0,
  });

  return {
    ...buildRemoteDestinationSearchResult({
      projects,
      query: normalizedQuery,
      results: search.rows,
      sourceProjectId,
      sourcePageId,
    }),
    enrichment: search.enrichment,
  };
}
