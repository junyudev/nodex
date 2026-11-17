import { getIntl, type IntlShape } from "@/lib/i18n";
import type { BoardSummary, Project } from "@/lib/types";
import type { DatabaseContainerDescriptorV2 } from "../../../shared/database-module-v2";
import type { ProjectAppearance } from "../../../shared/project-appearance";
import { normalizeSearchText } from "@/lib/search-text";
import {
  createNfmMoveToSearchIndex,
  type NfmMoveToPageSearchHit,
  type NfmMoveToSearchResult,
} from "@/components/board/editor/nfm-move-to-menu-search";

export type PanelDestinationPickerScope = "all" | "db-only" | "page-only";

export type PanelDestination =
  | {
      kind: "db";
      projectId: string;
      databaseViewId: string;
    }
  | {
      kind: "page";
      projectId: string | null;
      columnId: string | null;
      pageId: string;
      titleSnapshot: string;
    };

export interface PanelDestinationDbRow {
  kind: "db";
  id: string;
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
  databaseName: string;
  viewName: string;
  destination: PanelDestination;
}

export interface PanelDestinationPageRow {
  kind: "page";
  id: string;
  projectId: string | null;
  projectName: string;
  columnId: string | null;
  columnName: string;
  pageId: string;
  pageTitle: string;
  destination: PanelDestination;
}

export type PanelDestinationRow = PanelDestinationDbRow | PanelDestinationPageRow;

export interface PanelDestinationSection {
  key: "db" | "page" | "current-page" | "other-page";
  label: string;
  rows: PanelDestinationRow[];
}

export interface BuildPanelDestinationSectionsInput {
  intl?: IntlShape;
  projects: readonly Project[];
  boardMap: ReadonlyMap<string, BoardSummary>;
  databaseDescriptorMap: ReadonlyMap<string, DatabaseContainerDescriptorV2>;
  query: string;
  searchResult?: NfmMoveToSearchResult | null;
  scope?: PanelDestinationPickerScope;
  pageLimit?: number;
  currentProjectId?: string | null;
}

const DEFAULT_PAGE_LIMIT = 60;

function createDbRow(
  intl: IntlShape,
  project: Project,
  descriptor: DatabaseContainerDescriptorV2,
  view: DatabaseContainerDescriptorV2["views"][number],
): PanelDestinationDbRow {
  return {
    kind: "db",
    id: `panel-db:${project.id}:${view.viewId}`,
    projectId: project.id,
    projectName:
      project.name ||
      intl.formatMessage({
        id: "workbench.panelDestinationPickerModel.untitled",
        defaultMessage: "Untitled",
      }),
    projectAppearance: project.appearance,
    databaseName: descriptor.database.name,
    viewName: view.name,
    destination: {
      kind: "db",
      projectId: project.id,
      databaseViewId: view.viewId,
    },
  };
}

function createPageRowFromSearchHit(
  intl: IntlShape,
  hit: NfmMoveToPageSearchHit,
): PanelDestinationPageRow {
  return {
    kind: "page",
    id: `panel-page:${hit.projectId}:${hit.pageId}`,
    projectId: hit.projectId,
    projectName: hit.projectName,
    columnId: hit.columnId,
    columnName: hit.columnName,
    pageId: hit.pageId,
    pageTitle: hit.pageTitle,
    destination: {
      kind: "page",
      projectId: hit.projectId,
      columnId: hit.columnId,
      pageId: hit.pageId,
      titleSnapshot: hit.pageTitle,
    },
  };
}

function createPageRowFromSummary(
  intl: IntlShape,
  project: Project,
  column: BoardSummary["columns"][number],
  page: BoardSummary["columns"][number]["cards"][number],
): PanelDestinationPageRow {
  const pageTitle =
    page.title ||
    intl.formatMessage({
      id: "workbench.panelDestinationPickerModel.untitled",
      defaultMessage: "Untitled",
    });
  return {
    kind: "page",
    id: `panel-page:${project.id}:${page.id}`,
    projectId: project.id,
    projectName:
      project.name ||
      intl.formatMessage({
        id: "workbench.panelDestinationPickerModel.untitled",
        defaultMessage: "Untitled",
      }),
    columnId: column.id,
    columnName: column.name,
    pageId: page.id,
    pageTitle,
    destination: {
      kind: "page",
      projectId: project.id,
      columnId: column.id,
      pageId: page.id,
      titleSnapshot: page.title || "Untitled",
    },
  };
}

function orderProjectsForPagePicker(
  projects: readonly Project[],
  currentProjectId: string | null | undefined,
): readonly Project[] {
  if (!currentProjectId) return projects;

  const currentProject = projects.find((project) => project.id === currentProjectId);
  if (!currentProject) return projects;

  return [currentProject, ...projects.filter((project) => project.id !== currentProjectId)];
}

function limitPageRowsWithCurrentProjectFirst(
  rows: readonly PanelDestinationPageRow[],
  currentProjectId: string,
  pageLimit: number,
): PanelDestinationPageRow[] {
  const currentProjectRows = rows.filter((row) => row.projectId === currentProjectId);
  const otherProjectRows = rows.filter((row) => row.projectId !== currentProjectId);
  return [...currentProjectRows, ...otherProjectRows].slice(0, pageLimit);
}

function createPageSections(
  intl: IntlShape,
  rows: readonly PanelDestinationPageRow[],
  currentProjectId: string | null | undefined,
  groupCurrentProject: boolean,
): PanelDestinationSection[] {
  if (!groupCurrentProject || !currentProjectId) {
    return [
      {
        key: "page",
        label: intl.formatMessage({
          id: "workbench.panelDestinationPickerModel.page",
          defaultMessage: "Page",
        }),
        rows: [...rows],
      },
    ];
  }

  const currentProjectRows = rows.filter((row) => row.projectId === currentProjectId);
  const otherProjectRows = rows.filter((row) => row.projectId !== currentProjectId);
  return [
    ...(currentProjectRows.length > 0
      ? [
          {
            key: "current-page",
            label: intl.formatMessage({
              id: "workbench.panelDestinationPickerModel.currentProject",
              defaultMessage: "Current project",
            }),
            rows: currentProjectRows,
          } as const,
        ]
      : []),
    ...(otherProjectRows.length > 0
      ? [
          {
            key: "other-page",
            label: intl.formatMessage({
              id: "workbench.panelDestinationPickerModel.otherProjects",
              defaultMessage: "Other projects",
            }),
            rows: otherProjectRows,
          } as const,
        ]
      : []),
  ];
}

function resolveSearchResult({
  projects,
  boardMap,
  query,
  searchResult,
}: Pick<BuildPanelDestinationSectionsInput, "projects" | "boardMap" | "query" | "searchResult">) {
  const normalizedQuery = normalizeSearchText(query);
  if (searchResult?.normalizedQuery === normalizedQuery) return searchResult;
  if (!normalizedQuery) return null;

  return createNfmMoveToSearchIndex({
    projects,
    boardMap,
    sourceProjectId: null,
    sourcePageId: null,
  }).search(query);
}

export function buildPanelDestinationSections({
  intl = getIntl(),
  projects,
  boardMap,
  databaseDescriptorMap,
  query,
  searchResult,
  scope = "all",
  pageLimit = DEFAULT_PAGE_LIMIT,
  currentProjectId = null,
}: BuildPanelDestinationSectionsInput): PanelDestinationSection[] {
  const normalizedQuery = normalizeSearchText(query);
  const resolvedSearchResult = resolveSearchResult({
    projects,
    boardMap,
    query,
    searchResult,
  });
  const includeDb = scope === "all" || scope === "db-only";
  const includePages = scope === "all" || scope === "page-only";
  const groupCurrentProjectPages = scope === "page-only" && currentProjectId !== null;
  const dbRows: PanelDestinationDbRow[] = [];
  const pageRows: PanelDestinationPageRow[] = [];

  if (includeDb) {
    for (const project of projects) {
      const descriptor = databaseDescriptorMap.get(project.id);
      if (!descriptor) continue;
      for (const view of descriptor.views) {
        if (view.lifecycle !== "active") continue;
        const searchable = normalizeSearchText(
          `${project.name} ${descriptor.database.name} ${view.name}`,
        );
        if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
        dbRows.push(createDbRow(intl, project, descriptor, view));
      }
    }
  }

  if (includePages) {
    if (resolvedSearchResult && (normalizedQuery || resolvedSearchResult.pageHits.length > 0)) {
      pageRows.push(
        ...(groupCurrentProjectPages && currentProjectId
          ? limitPageRowsWithCurrentProjectFirst(
              resolvedSearchResult.pageHits.map((hit) => createPageRowFromSearchHit(intl, hit)),
              currentProjectId,
              pageLimit,
            )
          : resolvedSearchResult.pageHits
              .slice(0, pageLimit)
              .map((hit) => createPageRowFromSearchHit(intl, hit))),
      );
    } else {
      for (const project of orderProjectsForPagePicker(
        projects,
        groupCurrentProjectPages ? currentProjectId : null,
      )) {
        const board = boardMap.get(project.id);
        for (const column of board?.columns ?? []) {
          for (const page of column.cards) {
            if (pageRows.length >= pageLimit) break;
            pageRows.push(createPageRowFromSummary(intl, project, column, page));
          }
          if (pageRows.length >= pageLimit) break;
        }
        if (pageRows.length >= pageLimit) break;
      }
    }
  }

  const sections: PanelDestinationSection[] = [];
  if (includeDb)
    sections.push({
      key: "db",
      label: intl.formatMessage({
        id: "workbench.panelDestinationPickerModel.databaseBadge",
        defaultMessage: "DB",
      }),
      rows: dbRows,
    });
  if (includePages) {
    sections.push(
      ...createPageSections(intl, pageRows, currentProjectId, groupCurrentProjectPages),
    );
  }
  return sections;
}

export function flattenPanelDestinationRows(
  sections: readonly PanelDestinationSection[],
): PanelDestinationRow[] {
  return sections.flatMap((section) => section.rows);
}

export function resolvePanelDestinationFocusedRowId(
  focusedRowId: string | null,
  query: string,
  rows: readonly PanelDestinationRow[],
) {
  if (focusedRowId && rows.some((row) => row.id === focusedRowId)) {
    return focusedRowId;
  }

  if (!normalizeSearchText(query)) return null;
  return rows[0]?.id ?? null;
}

export function movePanelDestinationFocusedRowId(
  focusedRowId: string | null,
  direction: 1 | -1,
  rows: readonly PanelDestinationRow[],
) {
  if (rows.length === 0) return null;

  const currentIndex = focusedRowId ? rows.findIndex((row) => row.id === focusedRowId) : -1;
  if (currentIndex < 0) {
    return direction > 0 ? (rows[0]?.id ?? null) : (rows[rows.length - 1]?.id ?? null);
  }

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0) return rows[rows.length - 1]?.id ?? null;
  if (nextIndex >= rows.length) return rows[0]?.id ?? null;
  return rows[nextIndex]?.id ?? null;
}
