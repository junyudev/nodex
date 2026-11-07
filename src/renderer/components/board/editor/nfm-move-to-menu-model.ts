import type { BoardSummary, Project } from "@/lib/types";
import type { NfmBlockMoveDestination } from "@/lib/nfm-block-move-runtime";
import type { ProjectAppearance } from "../../../../shared/project-appearance";
import {
  WORKFLOW_STATUS_ORDER,
  resolveWorkflowStatusName,
} from "../../../../shared/workflow-status";
import { normalizeSearchText } from "@/lib/search-text";
import {
  createNfmMoveToSearchIndex,
  type NfmMoveToPageSearchHit,
  type NfmMoveToSearchResult,
} from "./nfm-move-to-menu-search";

export type NfmMoveToDestination = NfmBlockMoveDestination;

export type NfmMoveToResultScope = "all" | "db-only" | "page-only";

export interface NfmMoveToDbRow {
  kind: "db";
  id: string;
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
  expanded: boolean;
}

export interface NfmMoveToDbColumnRow {
  kind: "db-column";
  id: string;
  projectId: string;
  columnId: string;
  columnName: string;
  destination: NfmMoveToDestination;
}

export interface NfmMoveToPageRow {
  kind: "page";
  id: string;
  projectId: string;
  projectName: string;
  columnId: string;
  columnName: string;
  pageId: string;
  pageTitle: string;
  destination: NfmMoveToDestination;
}

export type NfmMoveToRow = NfmMoveToDbRow | NfmMoveToDbColumnRow | NfmMoveToPageRow;

export interface NfmMoveToSection {
  key: "db" | "page";
  label: "DB" | "Page";
  rows: NfmMoveToRow[];
}

export interface NfmMoveToSectionsInput {
  projects: readonly Project[];
  statusOptionsByProjectId?: ReadonlyMap<
    string,
    readonly { readonly id: string; readonly name: string }[]
  >;
  pageBoardMap: ReadonlyMap<string, BoardSummary>;
  sourceProjectId: string | null;
  sourcePageId: string | null;
  expandedProjectIds: ReadonlySet<string>;
  query: string;
  searchResult?: NfmMoveToSearchResult | null;
  resultScope?: NfmMoveToResultScope;
  pageLimit?: number;
}

const DEFAULT_PAGE_LIMIT = 60;

function createDbRow(project: Project, expanded: boolean): NfmMoveToDbRow {
  return {
    kind: "db",
    id: `db:${project.id}`,
    projectId: project.id,
    projectName: project.name || "Untitled",
    projectAppearance: project.appearance,
    expanded,
  };
}

function createPageRowFromSearchHit(hit: NfmMoveToPageSearchHit): NfmMoveToPageRow {
  return {
    kind: "page",
    id: hit.id,
    projectId: hit.projectId,
    projectName: hit.projectName,
    columnId: hit.columnId,
    columnName: hit.columnName,
    pageId: hit.pageId,
    pageTitle: hit.pageTitle,
    destination: {
      kind: "page",
      projectId: hit.projectId,
      pageId: hit.pageId,
    },
  };
}

function resolveSearchResult({
  projects,
  pageBoardMap,
  statusOptionsByProjectId,
  sourceProjectId,
  sourcePageId,
  query,
  searchResult,
}: Pick<
  NfmMoveToSectionsInput,
  | "projects"
  | "pageBoardMap"
  | "statusOptionsByProjectId"
  | "sourceProjectId"
  | "sourcePageId"
  | "query"
  | "searchResult"
>): NfmMoveToSearchResult | null {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;
  if (searchResult?.normalizedQuery === normalizedQuery) return searchResult;
  return createNfmMoveToSearchIndex({
    projects,
    boardMap: pageBoardMap,
    statusOptionsByProjectId,
    sourceProjectId,
    sourcePageId,
  }).search(query);
}

export function getDefaultNfmMoveToProjectId(
  projects: readonly Project[],
  sourceProjectId: string | null,
) {
  if (sourceProjectId && projects.some((project) => project.id === sourceProjectId)) {
    return sourceProjectId;
  }
  return projects[0]?.id ?? null;
}

/** Move commands are bound to the source Project's write authority. */
export function getNfmMoveToExecutableProjects(
  projects: readonly Project[],
  sourceProjectId: string | null,
): readonly Project[] {
  if (!sourceProjectId) return [];
  return projects.filter((project) => project.id === sourceProjectId);
}

export function getDefaultNfmMoveToExpandedProjectIds(
  projects: readonly Project[],
  sourceProjectId: string | null,
) {
  const defaultExpandedProjectId = getDefaultNfmMoveToProjectId(projects, sourceProjectId);

  return new Set(defaultExpandedProjectId ? [defaultExpandedProjectId] : []);
}

export function buildNfmMoveToSections({
  projects,
  pageBoardMap,
  statusOptionsByProjectId,
  sourceProjectId,
  sourcePageId,
  expandedProjectIds,
  query,
  searchResult,
  resultScope = "all",
  pageLimit = DEFAULT_PAGE_LIMIT,
}: NfmMoveToSectionsInput): NfmMoveToSection[] {
  const normalizedQuery = normalizeSearchText(query);
  const resolvedSearchResult = resolveSearchResult({
    projects,
    pageBoardMap,
    statusOptionsByProjectId,
    sourceProjectId,
    sourcePageId,
    query,
    searchResult,
  });
  const dbRows: NfmMoveToRow[] = [];
  const pageRows: NfmMoveToRow[] = [];

  for (const project of resultScope === "page-only" ? [] : projects) {
    const projectMatchesQuery = resolvedSearchResult?.matchedProjectIds.has(project.id) ?? false;
    const matchedColumnIds = resolvedSearchResult?.matchedColumnIdsByProjectId.get(project.id);
    const visibleColumnRows: NfmMoveToDbColumnRow[] = [];
    const queryForcesExpanded = Boolean(normalizedQuery);

    const stageIds =
      statusOptionsByProjectId && !statusOptionsByProjectId.has(project.id)
        ? []
        : WORKFLOW_STATUS_ORDER;
    for (const columnId of stageIds) {
      const column = {
        id: columnId,
        name: resolveWorkflowStatusName(
          columnId,
          statusOptionsByProjectId?.get(project.id) ?? pageBoardMap.get(project.id)?.columns ?? [],
        ),
      };
      const columnMatchesQuery = matchedColumnIds?.has(column.id) ?? false;
      const shouldShowColumn = !normalizedQuery || projectMatchesQuery || columnMatchesQuery;
      if (shouldShowColumn) {
        visibleColumnRows.push({
          kind: "db-column",
          id: `db-column:${project.id}:${column.id}`,
          projectId: project.id,
          columnId: column.id,
          columnName: column.name,
          destination: {
            kind: "db-column",
            projectId: project.id,
            columnId: column.id,
          },
        });
      }
    }

    const showDbRow = !normalizedQuery || projectMatchesQuery || visibleColumnRows.length > 0;
    if (!showDbRow) continue;

    const expanded = queryForcesExpanded || expandedProjectIds.has(project.id);
    dbRows.push(createDbRow(project, expanded));
    if (expanded) dbRows.push(...visibleColumnRows);
  }

  const defaultPageProjectId = getDefaultNfmMoveToProjectId(projects, sourceProjectId);
  const defaultPageProject = projects.find((project) => project.id === defaultPageProjectId);
  const defaultPageBoard = defaultPageProjectId
    ? pageBoardMap.get(defaultPageProjectId)
    : undefined;
  if (resultScope !== "db-only" && !normalizedQuery && defaultPageProject && defaultPageBoard) {
    for (const column of defaultPageBoard.columns) {
      for (const page of column.cards) {
        if (defaultPageProject.id === sourceProjectId && page.id === sourcePageId) continue;
        if (pageRows.length >= pageLimit) break;

        pageRows.push({
          kind: "page",
          id: `page:${defaultPageProject.id}:${page.id}`,
          projectId: defaultPageProject.id,
          projectName: defaultPageProject.name || "Untitled",
          columnId: column.id,
          columnName: column.name,
          pageId: page.id,
          pageTitle: page.title || "Untitled",
          destination: {
            kind: "page",
            projectId: defaultPageProject.id,
            pageId: page.id,
          },
        });
      }
      if (pageRows.length >= pageLimit) break;
    }
  }

  if (resultScope !== "db-only" && normalizedQuery && resolvedSearchResult) {
    pageRows.push(
      ...resolvedSearchResult.pageHits.slice(0, pageLimit).map(createPageRowFromSearchHit),
    );
  }

  const dbSection = { key: "db", label: "DB", rows: dbRows } satisfies NfmMoveToSection;
  if (resultScope === "db-only") return [dbSection];

  const pageSection = { key: "page", label: "Page", rows: pageRows } satisfies NfmMoveToSection;
  if (resultScope === "page-only") return [pageSection];

  return [dbSection, pageSection];
}

export function flattenNfmMoveToRows(sections: readonly NfmMoveToSection[]): NfmMoveToRow[] {
  return sections.flatMap((section) => section.rows);
}

export function getInitialNfmMoveToFocusedRowId(query: string, rows: readonly NfmMoveToRow[]) {
  if (!normalizeSearchText(query)) return null;
  return rows[0]?.id ?? null;
}

export function resolveNfmMoveToFocusedRowId(
  focusedRowId: string | null,
  query: string,
  rows: readonly NfmMoveToRow[],
) {
  if (focusedRowId && rows.some((row) => row.id === focusedRowId)) {
    return focusedRowId;
  }

  return getInitialNfmMoveToFocusedRowId(query, rows);
}

export function moveNfmMoveToFocus(
  currentIndex: number,
  direction: 1 | -1,
  rows: readonly NfmMoveToRow[],
) {
  if (rows.length === 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : rows.length - 1;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0) return rows.length - 1;
  if (nextIndex >= rows.length) return 0;
  return nextIndex;
}

export function moveNfmMoveToFocusedRowId(
  focusedRowId: string | null,
  direction: 1 | -1,
  rows: readonly NfmMoveToRow[],
) {
  if (rows.length === 0) return null;

  const currentIndex = focusedRowId ? rows.findIndex((row) => row.id === focusedRowId) : -1;
  const nextIndex = moveNfmMoveToFocus(currentIndex, direction, rows);
  return rows[nextIndex]?.id ?? null;
}
