import { matchesSearchTokens, normalizeSearchText, tokenizeSearchQuery } from "@/lib/search-text";
import type { BoardSummary, Project } from "@/lib/types";
import type { ProjectAppearance } from "../../../../shared/project-appearance";
import { WORKFLOW_STATUS_ORDER } from "../../../../shared/workflow-status";
import { getIntl, type IntlShape } from "@/lib/i18n";
import { formatBoardWorkflowStatus } from "../presentation-messages";

interface NfmMoveToSearchDocument {
  id: string;
  kind: "project" | "column";
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
  columnId: string;
  columnName: string;
}

export interface NfmMoveToPageSearchHit {
  id: string;
  projectId: string | null;
  projectName: string;
  projectAppearance: ProjectAppearance | null;
  columnId: string | null;
  columnName: string;
  pageId: string;
  pageKey: string | null;
  matchedPageKey: string | null;
  matchedPageKeyIsCurrent: boolean | null;
  pageTitle: string;
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
  untitled?: string;
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

export function createNfmMoveToSearchIndex(
  { projects, boardMap, statusOptionsByProjectId, untitled }: CreateNfmMoveToSearchIndexInput,
  intl: IntlShape = getIntl(),
): NfmMoveToSearchIndex {
  untitled ??= intl.formatMessage({
    id: "editor.nfmMoveToMenu.untitled",
    defaultMessage: "Untitled",
  });
  const documents: NfmMoveToSearchDocument[] = [];

  projects.forEach((project) => {
    const projectName = project.name || untitled;
    const projectAppearance = project.appearance;
    documents.push({
      id: `db:${project.id}`,
      kind: "project",
      projectId: project.id,
      projectName,
      projectAppearance,
      columnId: "",
      columnName: "",
    });

    const stageIds =
      statusOptionsByProjectId && !statusOptionsByProjectId.has(project.id)
        ? []
        : WORKFLOW_STATUS_ORDER;
    stageIds.forEach((id) => {
      const column = {
        id,
        name: formatBoardWorkflowStatus(
          intl,
          id,
          statusOptionsByProjectId?.get(project.id) ?? boardMap.get(project.id)?.columns ?? [],
        ),
      };
      documents.push({
        id: `db-column:${project.id}:${column.id}`,
        kind: "column",
        projectId: project.id,
        projectName,
        projectAppearance,
        columnId: column.id,
        columnName: column.name,
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
