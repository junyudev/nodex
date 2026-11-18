import { getIntl } from "@/lib/i18n";
import { pageSearchReveal } from "./page-search-reveal";
import { isPriority } from "../../shared/priority";
import type {
  CommandMenuMode,
  CommandPalettePage,
  CommandPalettePageSearchBadge,
  CommandPalettePageSearchDecorations,
  CommandPalettePageSearchPreview,
  CommandPalettePageSearchPreviewSegment,
} from "./command-palette";
import type {
  PageSearchCoverage,
  PageSearchMatch,
  PageSearchOptionIdentity,
  PageSearchResult,
  PageSearchTextPart,
  Project,
} from "./types";
import { normalizeSearchText } from "./search-text";

const DEFAULT_PAGE_SEARCH_LIMIT = 60;

export type CommandPalettePageSearchStatus = "idle" | "pending" | "success" | "error";

export interface CommandPalettePageSearchBatch {
  query: string;
  scopeKey: string;
  results: readonly PageSearchResult[];
  truncated?: boolean;
  coverage?: PageSearchCoverage;
  status: CommandPalettePageSearchStatus;
  error: string | null;
}

export interface CommandPalettePageSearchPlan {
  searchLimit: number;
}

export const pageSearchOptionIdentityKey = (option: PageSearchOptionIdentity): string =>
  JSON.stringify([option.dataSourceId, option.propertyId, option.optionId]);

export function normalizeCommandPaletteSearchText(value: string): string {
  return normalizeSearchText(value);
}

export function buildCommandPalettePageSearchScopeKey(
  projectFilterIds?: readonly string[],
): string {
  return projectFilterIds ? JSON.stringify([...new Set(projectFilterIds)].sort()) : "library";
}

export function getCommandPalettePageSearchPlan(
  mode: CommandMenuMode,
  query: string,
): CommandPalettePageSearchPlan | null {
  const queryLength = Array.from(normalizeCommandPaletteSearchText(query)).length;
  if (mode === "pages") {
    return { searchLimit: DEFAULT_PAGE_SEARCH_LIMIT };
  }
  if (mode === "root" && (queryLength === 0 || queryLength >= 2)) {
    return { searchLimit: DEFAULT_PAGE_SEARCH_LIMIT };
  }
  return null;
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
    badges: propertyMatches.map(matchBadge),
  };
  return decorations.pageKeySegments || decorations.titleSegments || decorations.badges.length > 0
    ? decorations
    : null;
};

const searchPreview = (result: PageSearchResult): CommandPalettePageSearchPreview | null => {
  if (!result.excerpt || result.excerptParts.length === 0) return null;
  const hasBodyOrProperty = result.matches.some(
    (match) => match.source === "body" || match.source === "property" || match.source === "context",
  );
  if (!hasBodyOrProperty) return null;
  return { excerpt: result.excerpt, segments: toSegments(result.excerptParts) };
};

export function buildCommandPalettePagesFromSearchResults({
  results,
  projects,
  existingPages = [],
}: {
  results: readonly PageSearchResult[];
  projects: readonly Project[];
  existingPages?: readonly CommandPalettePage[];
}): CommandPalettePage[] {
  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const existingById = new Map(
    existingPages.map((page) => [`${page.projectId}:${page.page.id}`, page] as const),
  );
  return results.flatMap((result) => {
    const project = result.projectId ? projectById.get(result.projectId) : undefined;
    const existing = existingById.get(`${result.projectId}:${result.pageId}`);
    const pageKeyMatch = result.matches.find((match) => match.source === "page_key");
    const priority = result.priority && isPriority(result.priority) ? result.priority : null;
    return [
      {
        kind: "page" as const,
        archived: result.archived,
        id: `${result.projectId}:${result.pageId}`,
        projectId: result.projectId,
        location: result.projectId
          ? (project?.name ?? existing?.location ?? "")
          : result.locationLabel,
        page: {
          id: result.pageId,
          title: result.title,
          pageKey: result.pageKey,
          status: result.status?.optionId ?? null,
          priority,
          tags: result.tags.map(pageSearchOptionIdentityKey),
          assignee: result.assignee,
          owner: result.owner ?? null,
        },
        searchPreview: searchPreview(result),
        reveal: pageSearchReveal(result.matches),
        searchDecorations: searchDecorations(result),
        pageKeyMatch: pageKeyMatch
          ? { matchedPageKey: pageKeyMatch.pageKey, isCurrent: pageKeyMatch.isCurrent }
          : null,
      },
    ];
  });
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
    batch.query !== query.trim() ||
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
  if (batch.query !== query.trim()) return null;
  return batch.scopeKey === scopeKey
    ? (batch.error ??
        getIntl().formatMessage({
          id: "lib.commandPalettePageResults.unavailable",
          defaultMessage: "Page search is unavailable",
        }))
    : null;
}

export function selectCommandPalettePageResults({
  query,
  projects,
  pages = [],
  pageSearchBatch,
  pageSearchScopeKey,
  mergedPageLimit = DEFAULT_PAGE_SEARCH_LIMIT,
}: {
  query: string;
  projects?: readonly Project[];
  pages?: readonly CommandPalettePage[];
  pageSearchBatch?: CommandPalettePageSearchBatch | null;
  pageSearchScopeKey?: string | null;
  mergedPageLimit?: number;
}): CommandPalettePage[] {
  if (
    !pageSearchBatch ||
    pageSearchBatch.status === "idle" ||
    pageSearchBatch.query !== query.trim() ||
    (pageSearchScopeKey && pageSearchBatch.scopeKey !== pageSearchScopeKey)
  ) {
    return [];
  }
  return buildCommandPalettePagesFromSearchResults({
    results: pageSearchBatch.results,
    projects: projects ?? [],
    existingPages: pages,
  }).slice(0, mergedPageLimit);
}
