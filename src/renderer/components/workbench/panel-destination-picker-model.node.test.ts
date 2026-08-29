import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, DatabasePageSummary, Project } from "@/lib/types";
import type { DatabaseContainerDescriptorV2 } from "../../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../shared/database-identities";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { upgradeDatabaseViewConfigV2 } from "../../../shared/database-view-presentation";
import {
  buildPanelDestinationSections,
  flattenPanelDestinationRows,
  movePanelDestinationFocusedRowId,
  resolvePanelDestinationFocusedRowId,
} from "./panel-destination-picker-model";
import type {
  NfmMoveToPageSearchHit,
  NfmMoveToSearchResult,
} from "@/components/board/editor/nfm-move-to-menu-search";

const TEST_DATE = new Date("2026-01-01T00:00:00.000Z");

function makeProject(id: string, name: string, icon?: "heart" | "plant"): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: icon
      ? { color: "black", marker: { kind: "icon", icon } }
      : { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: TEST_DATE,
    updated: TEST_DATE,
  };
}

function makePage(
  id: string,
  title: string,
  status: DatabasePageSummary["status"],
  order: number,
): DatabasePageSummary {
  return {
    id,
    pageKey: null,
    status,
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    tags: [],
    created: TEST_DATE,
    order,
    revision: 1,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  };
}

const PROJECTS = [
  makeProject("alpha", "Alpha DB", "heart"),
  makeProject("beta", "Beta DB", "plant"),
];

const BOARD_MAP = new Map<string, BoardSummary>([
  [
    "alpha",
    {
      columns: [
        {
          id: "triage",
          name: "Triage",
          cards: [
            makePage("command-palette", "Command palette polish", "triage", 0),
            makePage("notes", "Meeting notes", "triage", 1),
          ],
        },
      ],
    },
  ],
  [
    "beta",
    {
      columns: [
        {
          id: "plan",
          name: "Plan",
          cards: [makePage("runtime", "Runtime polish", "plan", 0)],
        },
      ],
    },
  ],
]);

function makeDescriptor(
  projectId: string,
  views: ReadonlyArray<{ id: string; name: string; primary: boolean }>,
): DatabaseContainerDescriptorV2 {
  const databaseId = parseDatabaseId(`database:${projectId}`);
  const dataSourceId = parseDataSourceId(`data-source:${projectId}`);
  return {
    database: {
      databaseId,
      libraryId: "library:test",
      name: `${projectId} tasks`,
      lifecycle: "active",
      defaultViewId: views.find((view) => view.primary)
        ? parseDatabaseViewId(views.find((view) => view.primary)!.id)
        : null,
      accessRevision: 1,
      metadataRevision: 1,
      createdAt: TEST_DATE.toISOString(),
      updatedAt: TEST_DATE.toISOString(),
    },
    dataSources: [
      {
        dataSourceId,
        libraryId: "library:test",
        homeDatabaseId: databaseId,
        name: "Pages",
        schemaKey: "nodex.page",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "0",
        createdAt: TEST_DATE.toISOString(),
        updatedAt: TEST_DATE.toISOString(),
      },
    ],
    views: views.map((view, index) => ({
      viewId: parseDatabaseViewId(view.id),
      databaseId,
      dataSourceId,
      name: view.name,
      layout: "board",
      config: upgradeDatabaseViewConfigV2({
        schemaKey: "nodex.database-view",
        schemaVersion: 2,
        filter: { kind: "group", operator: "and", children: [] },
        sort: [],
        group: null,
        display: { propertyIds: [], showTitle: true },
      }),
      isDefault: view.primary,
      revision: 1,
      rankKey: String(index),
      lifecycle: "active",
      createdAt: TEST_DATE.toISOString(),
      updatedAt: TEST_DATE.toISOString(),
    })),
  };
}

const DATABASE_DESCRIPTOR_MAP = new Map<string, DatabaseContainerDescriptorV2>([
  [
    "alpha",
    makeDescriptor("alpha", [
      { id: "view-alpha-primary", name: "Alpha DB", primary: true },
      { id: "view-alpha-focused", name: "Focused", primary: false },
    ]),
  ],
  ["beta", makeDescriptor("beta", [{ id: "view-beta-primary", name: "Beta DB", primary: true }])],
]);

function pageHit(
  projectId: "alpha" | "beta",
  pageId: string,
  pageTitle: string,
  columnId: "triage" | "plan",
  columnName: "Triage" | "Plan",
  boardOrder: number,
): NfmMoveToPageSearchHit {
  const project = PROJECTS.find((candidate) => candidate.id === projectId)!;
  return {
    id: `page:${projectId}:${pageId}`,
    projectId,
    projectName: project.name,
    projectAppearance: project.appearance,
    columnId,
    columnName,
    pageId,
    pageKey: null,
    matchedPageKey: null,
    matchedPageKeyIsCurrent: null,
    pageTitle,
    boardOrder,
    score: 10 - boardOrder,
  };
}

function searchResult(
  query: string,
  pageHits: readonly NfmMoveToPageSearchHit[],
): NfmMoveToSearchResult {
  return {
    normalizedQuery: query,
    matchedProjectIds: new Set(),
    matchedColumnIdsByProjectId: new Map(),
    pageHits: [...pageHits],
  };
}

const COMMAND_PALETTE_HIT = pageHit(
  "alpha",
  "command-palette",
  "Command palette polish",
  "triage",
  "Triage",
  0,
);
const RUNTIME_HIT = pageHit("beta", "runtime", "Runtime polish", "plan", "Plan", 1);

describe("panel destination picker model", () => {
  test("keeps Database Views before Pages for the combined panel picker", () => {
    const sections = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "",
    });
    const rows = flattenPanelDestinationRows(sections);

    expect(sections.map((section) => section.label).join(",")).toBe("DB,Page");
    expect(rows.map((row) => row.id).join(",")).toBe(
      "panel-db:alpha:view-alpha-primary,panel-db:alpha:view-alpha-focused,panel-db:beta:view-beta-primary,panel-page:alpha:command-palette,panel-page:alpha:notes,panel-page:beta:runtime",
    );
  });

  test("supports Database-only and Page-only scopes", () => {
    const dbOnly = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "",
      scope: "db-only",
    });
    const cardOnly = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "",
      scope: "page-only",
    });

    expect(dbOnly.map((section) => section.label).join(",")).toBe("DB");
    expect(
      flattenPanelDestinationRows(dbOnly)
        .map((row) => row.kind)
        .join(","),
    ).toBe("db,db,db");
    expect(cardOnly.map((section) => section.label).join(",")).toBe("Page");
    expect(
      flattenPanelDestinationRows(cardOnly)
        .map((row) => row.kind)
        .join(","),
    ).toBe("page,page,page");
  });

  test("groups Page-only rows with the current project first", () => {
    const sections = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "",
      scope: "page-only",
      currentProjectId: "beta",
    });
    const rows = flattenPanelDestinationRows(sections);

    expect(sections.map((section) => section.label).join(",")).toBe(
      "Current project,Other projects",
    );
    expect(rows.map((row) => row.id).join(",")).toBe(
      "panel-page:beta:runtime,panel-page:alpha:command-palette,panel-page:alpha:notes",
    );
  });

  test("keeps search ranking inside current-project Page groups", () => {
    const sections = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "polish",
      searchResult: searchResult("polish", [COMMAND_PALETTE_HIT, RUNTIME_HIT]),
      scope: "page-only",
      currentProjectId: "beta",
    });
    const rows = flattenPanelDestinationRows(sections);

    expect(sections.map((section) => section.label).join(",")).toBe(
      "Current project,Other projects",
    );
    expect(rows.map((row) => row.id).join(",")).toBe(
      "panel-page:beta:runtime,panel-page:alpha:command-palette",
    );
  });

  test("omits the current-project group when it has no page matches", () => {
    const sections = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "runtime",
      searchResult: searchResult("runtime", [RUNTIME_HIT]),
      scope: "page-only",
      currentProjectId: "alpha",
    });
    const rows = flattenPanelDestinationRows(sections);

    expect(sections.map((section) => section.label).join(",")).toBe("Other projects");
    expect(rows.map((row) => row.id).join(",")).toBe("panel-page:beta:runtime");
  });

  test("renders Page rows ranked by the shared search kernel", () => {
    const sections = buildPanelDestinationSections({
      projects: PROJECTS,
      boardMap: BOARD_MAP,
      databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
      query: "commnd pal",
      searchResult: searchResult("commnd pal", [COMMAND_PALETTE_HIT]),
      scope: "page-only",
    });
    const rows = flattenPanelDestinationRows(sections);

    expect(rows.map((row) => row.id).join(",")).toBe("panel-page:alpha:command-palette");
  });

  test("resets query focus to the first visible row and wraps arrow movement", () => {
    const rows = flattenPanelDestinationRows(
      buildPanelDestinationSections({
        projects: PROJECTS,
        boardMap: BOARD_MAP,
        databaseDescriptorMap: DATABASE_DESCRIPTOR_MAP,
        query: "beta",
        searchResult: searchResult("beta", [RUNTIME_HIT]),
      }),
    );
    const initial = resolvePanelDestinationFocusedRowId(null, "beta", rows);

    expect(initial).toBe("panel-db:beta:view-beta-primary");
    expect(movePanelDestinationFocusedRowId(initial, 1, rows)).toBe("panel-page:beta:runtime");
    expect(movePanelDestinationFocusedRowId("panel-page:beta:runtime", 1, rows)).toBe(
      "panel-db:beta:view-beta-primary",
    );
  });
});
