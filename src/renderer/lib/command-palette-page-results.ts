import { useEffect, useMemo, useState } from "react";
import { isPriority, PRIORITY_VALUES } from "../../shared/priority";
import { WORKFLOW_STATUS_ORDER } from "../../shared/workflow-status";
import { searchPages } from "./api";
import { invokeRendererQuery as invoke } from "./renderer-command";
import type {
  CommandMenuMode,
  CommandPalettePage,
  CommandPalettePageFilters,
  CommandPalettePageSearchBadge,
  CommandPalettePageSearchDecorations,
  CommandPalettePageSearchPreview,
  CommandPalettePageSearchPreviewSegment,
} from "./command-palette";
import type {
  PageSearchFacets,
  PageSearchFilters,
  PageSearchMatch,
  PageSearchOption,
  PageSearchOptionIdentity,
  PageSearchResult,
  PageSearchTextPart,
  Project,
} from "./types";
import { normalizeSearchText } from "./search-text";
import { useInteractivePageSearch } from "./interactive-page-search";

const DEFAULT_PAGE_SEARCH_LIMIT = 60;
const ROOT_PAGE_SEARCH_LIMIT = 12;
const inFlightPageSearches = new Map<string, Promise<PageSearchResult[]>>();

export type CommandPalettePageSearchStatus = "idle" | "pending" | "success" | "error";

export interface CommandPalettePageSearchBatch {
  query: string;
  scopeKey: string;
  results: readonly PageSearchResult[];
  status: CommandPalettePageSearchStatus;
  error: string | null;
}

export interface CommandPalettePageSearchPlan {
  searchLimit: number;
}

export interface CommandPalettePageFacetBatch {
  facets: PageSearchFacets;
  status: CommandPalettePageSearchStatus;
  error: string | null;
}

export const pageSearchOptionIdentityKey = (option: PageSearchOptionIdentity): string =>
  JSON.stringify([option.dataSourceId, option.propertyId, option.optionId]);

export const parsePageSearchOptionIdentityKey = (
  value: string,
): PageSearchOptionIdentity | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed.some((part) => typeof part !== "string")
    ) {
      return null;
    }
    return {
      dataSourceId: parsed[0] as string,
      propertyId: parsed[1] as string,
      optionId: parsed[2] as string,
    };
  } catch {
    return null;
  }
};

export function normalizeCommandPaletteSearchText(value: string): string {
  return normalizeSearchText(value);
}

export function buildCommandPalettePageSearchScopeKey(projectIds: readonly string[]): string {
  return [...new Set(projectIds)].sort((left, right) => left.localeCompare(right)).join("\n");
}

export function getCommandPalettePageSearchPlan(
  mode: CommandMenuMode,
  query: string,
): CommandPalettePageSearchPlan | null {
  const queryLength = Array.from(normalizeCommandPaletteSearchText(query)).length;
  if (mode === "pages") {
    return { searchLimit: DEFAULT_PAGE_SEARCH_LIMIT };
  }
  if (mode === "root" && queryLength >= 2) {
    return { searchLimit: ROOT_PAGE_SEARCH_LIMIT };
  }
  return null;
}

export function toCorePageSearchFilters(
  filters: CommandPalettePageFilters,
): PageSearchFilters | undefined {
  const statuses =
    filters.statuses.length === WORKFLOW_STATUS_ORDER.length ? undefined : [...filters.statuses];
  const priorities =
    filters.priorities.length === PRIORITY_VALUES.length && filters.includeEmptyPriority
      ? undefined
      : [...filters.priorities];
  const tags = filters.tags.flatMap((tag) => {
    const identity = parsePageSearchOptionIdentityKey(tag);
    return identity ? [identity] : [];
  });
  const hasFilters =
    statuses !== undefined ||
    priorities !== undefined ||
    tags.length > 0 ||
    filters.assignees.length > 0;
  if (!hasFilters) return undefined;
  return {
    statuses,
    priorities,
    includeEmptyPriority: filters.includeEmptyPriority,
    tags,
    tagMode: filters.tagMode,
    assignees: [...filters.assignees],
  };
}

const toSegments = (
  parts: readonly PageSearchTextPart[],
): CommandPalettePageSearchPreviewSegment[] =>
  parts.map((part) => ({
    text: part.text,
    highlight: part.highlighted,
  }));

const highlightedSegments = (
  parts: readonly PageSearchTextPart[],
): CommandPalettePageSearchPreviewSegment[] | null =>
  parts.some((part) => part.highlighted) ? toSegments(parts) : null;

const matchBadge = (
  match: Extract<PageSearchMatch, { source: "property" }>,
  index: number,
): CommandPalettePageSearchBadge => ({
  id: `property:${match.propertyId}:${index}`,
  label: match.propertyName,
  segments: toSegments(match.parts),
});

const searchDecorations = (
  result: PageSearchResult,
): CommandPalettePageSearchDecorations | null => {
  const pageKey = result.matches.find((match) => match.source === "page_key");
  const propertyMatches = result.matches.filter(
    (match): match is Extract<PageSearchMatch, { source: "property" }> =>
      match.source === "property",
  );
  const decorations: CommandPalettePageSearchDecorations = {
    pageKeySegments: pageKey ? highlightedSegments(pageKey.parts) : null,
    titleSegments: highlightedSegments(result.titleParts),
    projectNameSegments: null,
    columnNameSegments: null,
    badges: propertyMatches.map(matchBadge),
  };
  return decorations.pageKeySegments || decorations.titleSegments || decorations.badges.length > 0
    ? decorations
    : null;
};

const searchPreview = (result: PageSearchResult): CommandPalettePageSearchPreview | null => {
  if (!result.excerpt || result.excerptParts.length === 0) return null;
  const hasBodyOrProperty = result.matches.some(
    (match) => match.source === "body" || match.source === "property",
  );
  if (!hasBodyOrProperty) return null;
  return { excerpt: result.excerpt, segments: toSegments(result.excerptParts) };
};

export function buildCommandPalettePagesFromSearchResults({
  results,
  projects,
  activeProjectId,
  recentPageIds,
  existingPages = [],
}: {
  results: readonly PageSearchResult[];
  projects: readonly Project[];
  activeProjectId: string | null;
  recentPageIds: readonly string[];
  existingPages?: readonly CommandPalettePage[];
}): CommandPalettePage[] {
  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const existingById = new Map(
    existingPages.map((page) => [`${page.projectId}:${page.page.id}`, page] as const),
  );
  const recentIndex = new Map(recentPageIds.map((pageId, index) => [pageId, index] as const));
  return results.flatMap((result, index) => {
    const project = projectById.get(result.projectId);
    const existing = existingById.get(`${result.projectId}:${result.pageId}`);
    if (!project && !existing) return [];
    const pageKeyMatch = result.matches.find((match) => match.source === "page_key");
    const priority = result.priority && isPriority(result.priority) ? result.priority : null;
    return [
      {
        kind: "page" as const,
        id: `${result.projectId}:${result.pageId}`,
        projectId: result.projectId,
        projectName: project?.name ?? existing?.projectName ?? "Untitled",
        projectAppearance: project?.appearance ?? existing!.projectAppearance,
        columnName: result.locationLabel || existing?.columnName || "Pages",
        page: {
          id: result.pageId,
          title: result.title,
          pageKey: result.pageKey,
          status: result.status,
          priority,
          tags: result.tags.map(pageSearchOptionIdentityKey),
          assignee: result.assignee,
        },
        tagLabels: result.tags.map((tag) => tag.label),
        inActiveProject: result.projectId === activeProjectId,
        recentIndex: recentIndex.get(result.pageId) ?? null,
        boardIndex: index,
        searchPreview: searchPreview(result),
        searchDecorations: searchDecorations(result),
        pageKeyMatch: pageKeyMatch
          ? { matchedPageKey: pageKeyMatch.pageKey, isCurrent: pageKeyMatch.isCurrent }
          : null,
      },
    ];
  });
}

export async function searchCommandPalettePages({
  projectIds,
  query,
  filters,
  preferredProjectId,
  recentPageIds = [],
  limit = DEFAULT_PAGE_SEARCH_LIMIT,
}: {
  projectIds: readonly string[];
  query: string;
  filters?: PageSearchFilters;
  preferredProjectId?: string | null;
  recentPageIds?: readonly string[];
  limit?: number;
}): Promise<PageSearchResult[]> {
  const scopedProjectIds = [...new Set(projectIds)];
  if (scopedProjectIds.length === 0) return [];
  const request = {
    projectIds: scopedProjectIds,
    query: query.trimStart(),
    filters,
    preferredProjectId: preferredProjectId ?? undefined,
    recentPageIds: [...recentPageIds],
    limit: Math.max(1, Math.floor(limit)),
  };
  const requestKey = JSON.stringify(request);
  const existing = inFlightPageSearches.get(requestKey);
  if (existing) return await existing;
  const pending = searchPages(request).then((snapshot) => snapshot.results);
  inFlightPageSearches.set(requestKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightPageSearches.get(requestKey) === pending) {
      inFlightPageSearches.delete(requestKey);
    }
  }
}

export function isCommandPalettePageSearchPending({
  batch,
  enabled,
  query,
  scopeKey,
}: {
  batch: CommandPalettePageSearchBatch | null | undefined;
  enabled: boolean;
  query: string;
  scopeKey: string;
}): boolean {
  if (!enabled || scopeKey.length === 0) return false;
  return (
    !batch ||
    batch.scopeKey !== scopeKey ||
    batch.query !== normalizeCommandPaletteSearchText(query) ||
    batch.status === "idle" ||
    batch.status === "pending"
  );
}

export function getCommandPalettePageSearchError({
  batch,
  query,
  scopeKey,
}: {
  batch: CommandPalettePageSearchBatch | null | undefined;
  query: string;
  scopeKey: string;
}): string | null {
  if (!batch || batch.status !== "error") return null;
  if (batch.query !== normalizeCommandPaletteSearchText(query)) return null;
  return batch.scopeKey === scopeKey ? (batch.error ?? "Page search is unavailable") : null;
}

export function selectCommandPalettePageResults({
  query,
  projects,
  activeProjectId,
  recentPageIds,
  pages = [],
  pageSearchBatch,
  pageSearchScopeKey,
  mergedPageLimit = DEFAULT_PAGE_SEARCH_LIMIT,
}: {
  query: string;
  projects?: readonly Project[];
  activeProjectId?: string | null;
  recentPageIds?: readonly string[];
  pages?: readonly CommandPalettePage[];
  pageSearchBatch?: CommandPalettePageSearchBatch | null;
  pageSearchScopeKey?: string | null;
  mergedPageLimit?: number;
}): CommandPalettePage[] {
  if (
    !pageSearchBatch ||
    (pageSearchBatch.status !== "success" && pageSearchBatch.status !== "pending") ||
    pageSearchBatch.query !== normalizeCommandPaletteSearchText(query) ||
    (pageSearchScopeKey && pageSearchBatch.scopeKey !== pageSearchScopeKey)
  ) {
    return [];
  }
  return buildCommandPalettePagesFromSearchResults({
    results: pageSearchBatch.results,
    projects: projects ?? [],
    activeProjectId: activeProjectId ?? null,
    recentPageIds: recentPageIds ?? [],
    existingPages: pages,
  }).slice(0, mergedPageLimit);
}

export function useCommandPalettePageSearch({
  enabled,
  query,
  projectIds,
  filters,
  preferredProjectId,
  recentPageIds,
  limit = DEFAULT_PAGE_SEARCH_LIMIT,
}: {
  enabled: boolean;
  query: string;
  projectIds: readonly string[];
  filters?: PageSearchFilters;
  preferredProjectId?: string | null;
  recentPageIds?: readonly string[];
  limit?: number;
}): CommandPalettePageSearchBatch {
  const scopeKey = useMemo(() => buildCommandPalettePageSearchScopeKey(projectIds), [projectIds]);
  const search = useInteractivePageSearch({
    projectIds: enabled ? projectIds : [],
    query: normalizeCommandPaletteSearchText(query),
    filters,
    preferredProjectId,
    recentPageIds,
    limit,
    complete: enabled,
  });
  if (!enabled || !scopeKey) {
    return { query: "", scopeKey: "", results: [], status: "idle", error: null };
  }
  return {
    query: normalizeCommandPaletteSearchText(query),
    scopeKey,
    results: search.rows,
    status:
      search.enrichment === "loading"
        ? "pending"
        : search.enrichment === "unavailable"
          ? "error"
          : "success",
    error: search.enrichment === "unavailable" ? "Full Page search is unavailable" : null,
  };
}

export function useCommandPalettePageSearchFacets({
  enabled,
  projectIds,
}: {
  enabled: boolean;
  projectIds: readonly string[];
}): CommandPalettePageFacetBatch {
  const scopeKey = useMemo(() => buildCommandPalettePageSearchScopeKey(projectIds), [projectIds]);
  const [batch, setBatch] = useState<CommandPalettePageFacetBatch>({
    facets: { tags: [], assignees: [] },
    status: "idle",
    error: null,
  });
  useEffect(() => {
    if (!enabled || !scopeKey) {
      setBatch({ facets: { tags: [], assignees: [] }, status: "idle", error: null });
      return;
    }
    let cancelled = false;
    setBatch((current) => ({ ...current, status: "pending", error: null }));
    void invoke("pages:search-facets", scopeKey.split("\n"))
      .then((facets) => {
        if (!cancelled) setBatch({ facets, status: "success", error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBatch({
            facets: { tags: [], assignees: [] },
            status: "error",
            error: error instanceof Error ? error.message : "Page filters are unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, scopeKey]);
  return batch;
}

export const pageSearchFacetOptions = (
  facets: PageSearchFacets,
): Array<{ id: string; label: string; option: PageSearchOption }> =>
  facets.tags.map((option) => ({
    id: pageSearchOptionIdentityKey(option),
    label: option.label,
    option,
  }));
