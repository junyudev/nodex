import { matchesSearchTokens, normalizeSearchText, tokenizeSearchQuery } from "@/lib/search-text";
import type { BoardSummary, Project } from "@/lib/types";
import type { ProjectAppearance } from "../../../../shared/project-appearance";
import {
  WORKFLOW_STATUS_ORDER,
  resolveWorkflowStatusName,
} from "../../../../shared/workflow-status";

interface NfmMoveToSearchDocument {
  id: string;
  kind: "project" | "column";
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
  columnId: string;
  columnName: string;
  boardOrder: number;
}

export interface NfmMoveToPageSearchHit {
  id: string;
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
  columnId: string;
  columnName: string;
  pageId: string;
  pageKey: string | null;
  matchedPageKey: string | null;
  matchedPageKeyIsCurrent: boolean | null;
  pageTitle: string;
  boardOrder: number;
  score: number;
}

export interface NfmMoveToSearchResult {
  normalizedQuery: string;
  matchedProjectIds: ReadonlySet<string>;
  matchedColumnIdsByProjectId: ReadonlyMap<string, ReadonlySet<string>>;
  pageHits: NfmMoveToPageSearchHit[];
}

export interface NfmMoveToSearchIndex {
  search: (query: string) => NfmMoveToSearchResult;
}

export interface CreateNfmMoveToSearchIndexInput {
  projects: readonly Project[];
  statusOptionsByProjectId?: ReadonlyMap<
    string,
    readonly { readonly id: string; readonly name: string }[]
  >;
  boardMap: ReadonlyMap<string, BoardSummary>;
  sourceProjectId: string | null;
  sourcePageId: string | null;
}

function createEmptySearchResult(query: string): NfmMoveToSearchResult {
  return {
    normalizedQuery: normalizeSearchText(query),
    matchedProjectIds: new Set<string>(),
    matchedColumnIdsByProjectId: new Map<string, ReadonlySet<string>>(),
    pageHits: [],
  };
}

function addColumnMatch(
  columnIdsByProjectId: Map<string, Set<string>>,
  projectId: string,
  columnId: string,
) {
  const existing = columnIdsByProjectId.get(projectId);
  if (existing) {
    existing.add(columnId);
    return;
  }

  columnIdsByProjectId.set(projectId, new Set([columnId]));
}

export function createNfmMoveToSearchIndex({
  projects,
  boardMap,
  statusOptionsByProjectId,
}: CreateNfmMoveToSearchIndexInput): NfmMoveToSearchIndex {
  const documents: NfmMoveToSearchDocument[] = [];

  projects.forEach((project, projectIndex) => {
    const projectName = project.name || "Untitled";
    const projectAppearance = project.appearance;
    documents.push({
      id: `db:${project.id}`,
      kind: "project",
      projectId: project.id,
      projectName,
      projectAppearance,
      columnId: "",
      columnName: "",
      boardOrder: projectIndex * 1_000_000,
    });

    const stageIds =
      statusOptionsByProjectId && !statusOptionsByProjectId.has(project.id)
        ? []
        : WORKFLOW_STATUS_ORDER;
    stageIds.forEach((id, columnIndex) => {
      const column = {
        id,
        name: resolveWorkflowStatusName(
          id,
          statusOptionsByProjectId?.get(project.id) ?? boardMap.get(project.id)?.columns ?? [],
        ),
      };
      const columnOrder = projectIndex * 1_000_000 + columnIndex * 10_000;
      documents.push({
        id: `db-column:${project.id}:${column.id}`,
        kind: "column",
        projectId: project.id,
        projectName,
        projectAppearance,
        columnId: column.id,
        columnName: column.name,
        boardOrder: columnOrder,
      });
    });
  });

  return {
    search(query) {
      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) return createEmptySearchResult(query);
      const tokens = tokenizeSearchQuery(normalizedQuery);

      const matchedProjectIds = new Set<string>();
      const matchedColumnIdsByProjectId = new Map<string, Set<string>>();
      for (const document of documents) {
        const text = normalizeSearchText(
          document.kind === "project" ? document.projectName : document.columnName,
        );
        if (!matchesSearchTokens(text, tokens)) continue;

        if (document.kind === "project") {
          matchedProjectIds.add(document.projectId);
          continue;
        }

        if (document.kind === "column") {
          addColumnMatch(matchedColumnIdsByProjectId, document.projectId, document.columnId);
          continue;
        }
      }

      return {
        normalizedQuery,
        matchedProjectIds,
        matchedColumnIdsByProjectId,
        pageHits: [],
      };
    },
  };
}
