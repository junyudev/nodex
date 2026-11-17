import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { presentPageTitle } from "./page-title-projection-store";
import type { NfmMoveToSearchResult } from "@/components/board/editor/nfm-move-to-menu-search";
import { normalizeSearchText } from "@/lib/search-text";
import type { PageSearchResult, Project } from "@/lib/types";
import {
  useInteractivePageSearch,
  type InteractivePageSearchResult,
} from "./interactive-page-search";

const DESTINATION_SEARCH_LIMIT = 60;

export interface ProjectPageDestinationSearchResult extends NfmMoveToSearchResult {
  readonly enrichment: InteractivePageSearchResult["enrichment"];
}

export function buildRemoteDestinationSearchResult(
  {
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
  },
  intl: IntlShape = getIntl(),
): NfmMoveToSearchResult {
  const normalizedQuery = normalizeSearchText(query);

  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  return {
    normalizedQuery,
    matchedProjectIds: new Set(),
    matchedColumnIdsByProjectId: new Map(),
    pageHits: results.flatMap((result) => {
      const project = result.projectId ? projectById.get(result.projectId) : undefined;
      if (result.projectId === sourceProjectId && result.pageId === sourcePageId) {
        return [];
      }
      const pageKeyMatch = result.matches.find((match) => match.source === "page_key");
      return [
        {
          id: `page:${result.projectId}:${result.pageId}`,
          projectId: result.projectId,
          projectName: project?.name || result.locationLabel,
          projectAppearance: project?.appearance ?? null,
          columnId: result.status?.optionId ?? null,
          columnName: result.status?.label ?? result.locationLabel,
          pageId: result.pageId,
          pageKey: result.pageKey ?? null,
          matchedPageKey: pageKeyMatch?.pageKey ?? null,
          matchedPageKeyIsCurrent: pageKeyMatch?.isCurrent ?? null,
          pageTitle: result.title || presentPageTitle("", intl),
        },
      ];
    }),
  };
}

export function useProjectPageDestinationSearch({
  projects,
  query,
  enabled,
  projectId,
  sourceProjectId = null,
  sourcePageId = null,
}: {
  projects: readonly Project[];
  query: string;
  enabled: boolean;
  projectId?: string | null;
  sourceProjectId?: string | null;
  sourcePageId?: string | null;
}): ProjectPageDestinationSearchResult {
  const intl = useIntl();
  const normalizedQuery = normalizeSearchText(query);
  const search = useInteractivePageSearch({
    enabled,
    projectFilterIds: projectId ? [projectId] : undefined,
    preferredProjectId: sourceProjectId,
    query: query.trim(),
    limit: DESTINATION_SEARCH_LIMIT,
    excludePageIds: sourcePageId ? [sourcePageId] : [],
    complete: enabled,
  });

  return {
    ...buildRemoteDestinationSearchResult(
      {
        projects,
        query: normalizedQuery,
        results: search.rows,
        sourceProjectId,
        sourcePageId,
      },
      intl,
    ),
    enrichment: search.enrichment,
  };
}
