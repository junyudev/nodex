import { describe, expect, test } from "vite-plus/test";
import type { BoardSummary, DatabasePageSummary, Project } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../../shared/block-documents/portable-rich-text";
import {
  buildNfmMoveToSections,
  flattenNfmMoveToRows,
  getDefaultNfmMoveToExpandedProjectIds,
  getInitialNfmMoveToFocusedRowId,
  getNfmMoveToExecutableProjects,
  moveNfmMoveToFocusedRowId,
  resolveNfmMoveToFocusedRowId,
} from "./nfm-move-to-menu-model";
import { createNfmMoveToSearchIndex, type NfmMoveToPageSearchHit } from "./nfm-move-to-menu-search";

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
  overrides: Partial<DatabasePageSummary> = {},
): DatabasePageSummary {
  const effectiveTitle = overrides.title ?? title;
  return {
    id,
    status,
    archived: false,
    title: effectiveTitle,
    richTitle: plainTextToPortableRichText(effectiveTitle),
    tags: [],
    created: TEST_DATE,
    order,
    revision: 1,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
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
            makePage("source-page", "Source", "triage", 0),
            makePage("draft-spec", "Triage spec", "triage", 1),
            makePage("command-palette", "Command palette polish", "triage", 2, {
              pageKey: "LAB-13",
              tags: ["secret-tag"],
              assignee: "alex",
              descriptionPreview: "Hidden body-only OCR pipeline note.",
              descriptionLength: "Hidden body-only OCR pipeline note.".length,
              hasDescription: true,
            }),
          ],
        },
        {
          id: "ship",
          name: "Ship",
          cards: [makePage("ship-plan", "Ship plan", "ship", 0)],
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

function buildSections(
  query = "",
  expandedProjectIds: ReadonlySet<string> = new Set(["alpha"]),
  pageHits: readonly NfmMoveToPageSearchHit[] = [],
) {
  const searchResult = createNfmMoveToSearchIndex({
    projects: PROJECTS,
    boardMap: BOARD_MAP,
    sourceProjectId: "alpha",
    sourcePageId: "source-page",
  }).search(query);
  return buildNfmMoveToSections({
    projects: PROJECTS,
    pageBoardMap: BOARD_MAP,
    sourceProjectId: "alpha",
    sourcePageId: "source-page",
    expandedProjectIds,
    query,
    searchResult: { ...searchResult, pageHits: [...pageHits] },
  });
}

function pageHit(
  projectId: "alpha" | "beta",
  pageId: string,
  pageTitle: string,
  columnId: string,
  columnName: string,
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
    boardOrder: 0,
    score: 1,
  };
}

describe("markdown move-to menu model", () => {
  test("exposes only destinations inside the source Project authority", () => {
    expect(getNfmMoveToExecutableProjects(PROJECTS, "alpha").map((project) => project.id)).toEqual([
      "alpha",
    ]);
    expect(getNfmMoveToExecutableProjects(PROJECTS, null)).toEqual([]);
  });

  test("keeps DB before Page and expands the source project by default", () => {
    const sections = buildSections();
    const rows = flattenNfmMoveToRows(sections);

    expect(sections.map((section) => section.label).join(",")).toBe("DB,Page");
    expect(rows.map((row) => row.id).join(",")).toBe(
      "db:alpha,db-column:alpha:triage,db-column:alpha:plan,db-column:alpha:build,db-column:alpha:review,db-column:alpha:ship,db:beta,page:alpha:draft-spec,page:alpha:command-palette,page:alpha:ship-plan",
    );
    expect(rows[0]?.kind).toBe("db");
    const firstRow = rows[0];
    if (!firstRow || firstRow.kind !== "db") throw new Error("First row is not a DB row.");
    expect(firstRow.expanded).toBe(true);
  });

  test("creates the default expansion set from the source project when possible", () => {
    const expanded = getDefaultNfmMoveToExpandedProjectIds(PROJECTS, "beta");

    expect(expanded.has("beta")).toBe(true);
    expect(expanded.has("alpha")).toBe(false);
  });

  test("keeps Page results independent from DB disclosure state", () => {
    const pageRowIds = (expandedProjectIds: ReadonlySet<string>) =>
      buildSections("", expandedProjectIds)
        .find((section) => section.key === "page")
        ?.rows.map((row) => row.id);

    const expectedPageRowIds = [
      "page:alpha:draft-spec",
      "page:alpha:command-palette",
      "page:alpha:ship-plan",
    ];
    expect(pageRowIds(new Set())).toEqual(expectedPageRowIds);
    expect(pageRowIds(new Set(["alpha"]))).toEqual(expectedPageRowIds);
    expect(pageRowIds(new Set(["beta"]))).toEqual(expectedPageRowIds);
  });

  test("builds DB status destinations without loading Project boards", () => {
    const rows = flattenNfmMoveToRows(
      buildNfmMoveToSections({
        projects: PROJECTS,
        pageBoardMap: new Map(),
        sourceProjectId: "alpha",
        sourcePageId: "source-page",
        expandedProjectIds: new Set(["beta"]),
        query: "",
      }),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "db:alpha",
      "db:beta",
      "db-column:beta:triage",
      "db-column:beta:plan",
      "db-column:beta:build",
      "db-column:beta:review",
      "db-column:beta:ship",
    ]);
  });

  test("filters DB, column, and page rows while excluding the source page", () => {
    const runtime = pageHit("beta", "runtime", "Runtime polish", "plan", "Plan");
    const ship = pageHit("alpha", "ship-plan", "Ship plan", "ship", "Ship");
    const pageRows = flattenNfmMoveToRows(buildSections("runtime", undefined, [runtime]));
    const columnRows = flattenNfmMoveToRows(buildSections("ship", undefined, [ship]));
    const projectRows = flattenNfmMoveToRows(buildSections("beta", undefined, [runtime]));
    const sourceRows = flattenNfmMoveToRows(buildSections("source"));

    expect(pageRows.map((row) => row.id).join(",")).toBe("page:beta:runtime");
    expect(columnRows.map((row) => row.id).join(",")).toBe(
      "db:alpha,db-column:alpha:ship,db:beta,db-column:beta:ship,page:alpha:ship-plan",
    );
    expect(projectRows.map((row) => row.id).join(",")).toBe(
      "db:beta,db-column:beta:triage,db-column:beta:plan,db-column:beta:build,db-column:beta:review,db-column:beta:ship,page:beta:runtime",
    );
    expect(sourceRows.map((row) => row.id).join(",")).toBe("");
  });

  test("can restrict results to DB destinations for Page in", () => {
    const pageTitleSections = buildNfmMoveToSections({
      projects: PROJECTS,
      pageBoardMap: BOARD_MAP,
      sourceProjectId: "alpha",
      sourcePageId: "source-page",
      expandedProjectIds: new Set(["alpha"]),
      query: "runtime",
      resultScope: "db-only",
    });
    const dbSections = buildNfmMoveToSections({
      projects: PROJECTS,
      pageBoardMap: BOARD_MAP,
      sourceProjectId: "alpha",
      sourcePageId: "source-page",
      expandedProjectIds: new Set(["alpha"]),
      query: "beta",
      resultScope: "db-only",
    });
    const pageTitleRows = flattenNfmMoveToRows(pageTitleSections);
    const dbRows = flattenNfmMoveToRows(dbSections);

    expect(pageTitleSections.map((section) => section.label).join(",")).toBe("DB");
    expect(pageTitleRows.map((row) => row.id).join(",")).toBe("");
    expect(dbRows.map((row) => row.id).join(",")).toBe(
      "db:beta,db-column:beta:triage,db-column:beta:plan,db-column:beta:build,db-column:beta:review,db-column:beta:ship",
    );
  });

  test("can restrict results to Page destinations for inline Page creation", () => {
    const sections = buildNfmMoveToSections({
      projects: PROJECTS,
      pageBoardMap: BOARD_MAP,
      sourceProjectId: "alpha",
      sourcePageId: "source-page",
      expandedProjectIds: new Set(["alpha"]),
      query: "runtime",
      searchResult: {
        normalizedQuery: "runtime",
        matchedProjectIds: new Set(),
        matchedColumnIdsByProjectId: new Map(),
        pageHits: [pageHit("beta", "runtime", "Runtime polish", "plan", "Plan")],
      },
      resultScope: "page-only",
    });

    expect(sections.map((section) => section.label)).toEqual(["Page"]);
    expect(flattenNfmMoveToRows(sections).map((row) => row.id)).toEqual(["page:beta:runtime"]);
  });

  test("renders shared-kernel Page hits without inspecting loaded Board metadata", () => {
    const commandPalette = pageHit(
      "alpha",
      "command-palette",
      "Command palette polish",
      "triage",
      "Triage",
    );
    const fuzzyRows = flattenNfmMoveToRows(
      buildSections("commnd pal", undefined, [commandPalette]),
    );
    const descriptionRows = flattenNfmMoveToRows(buildSections("ocr pipeline"));
    const tagRows = flattenNfmMoveToRows(buildSections("secret-tag"));
    const assigneeRows = flattenNfmMoveToRows(buildSections("alex"));

    expect(fuzzyRows.map((row) => row.id).join(",")).toBe("page:alpha:command-palette");
    expect(descriptionRows.map((row) => row.id).join(",")).toBe("");
    expect(tagRows.map((row) => row.id).join(",")).toBe("");
    expect(assigneeRows.map((row) => row.id).join(",")).toBe("");
  });

  test("does not duplicate Page-key policy in the renderer Move model", () => {
    const commandPalette = {
      ...pageHit("alpha", "command-palette", "Command palette polish", "triage", "Triage"),
      pageKey: "LAB-13",
      matchedPageKey: "LAB-13",
      matchedPageKeyIsCurrent: true,
    };
    const kernelRows = flattenNfmMoveToRows(buildSections("#lab-13", undefined, [commandPalette]));
    const localRows = flattenNfmMoveToRows(buildSections("#lab-13"));

    expect(kernelRows.map((row) => row.id)).toEqual(["page:alpha:command-palette"]);
    expect(localRows).toEqual([]);
  });

  test("uses query focus reset and wrapping row-id navigation", () => {
    const rows = flattenNfmMoveToRows(buildSections());

    expect(getInitialNfmMoveToFocusedRowId("", rows) === null).toBe(true);
    expect(getInitialNfmMoveToFocusedRowId("ship", rows)).toBe("db:alpha");
    expect(resolveNfmMoveToFocusedRowId("missing", "ship", rows)).toBe("db:alpha");
    expect(moveNfmMoveToFocusedRowId(null, 1, rows)).toBe("db:alpha");
    expect(moveNfmMoveToFocusedRowId("db:alpha", -1, rows)).toBe(rows[rows.length - 1]?.id);
    expect(moveNfmMoveToFocusedRowId(rows[rows.length - 1]?.id ?? null, 1, rows)).toBe("db:alpha");
  });
});
