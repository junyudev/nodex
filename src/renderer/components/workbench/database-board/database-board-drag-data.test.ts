import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../../shared/database-identities";
import type {
  DatabaseViewRenderModel,
  DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import { buildDatabaseViewPageDragData } from "../database-view-page-drag";

const timestamp = "2026-08-17T00:00:00.000Z";
const databaseId = parseDatabaseId("database-board");
const dataSourceId = parseDataSourceId("source-board");

const row = (
  pageId: string,
  groupKey: string,
  status: "build" | "review",
): DatabaseViewRenderRow => ({
  pageId,
  pageKey: null,
  taskParentValueRevision: 1,
  groupKey,
  subgroupKey: null,
  title: pageId,
  preview: `${pageId} preview`,
  plainText: `${pageId} body`,
  status,
  tags: [],
  documentGeneration: 1,
  documentHeadSeq: 1,
  metadataRevision: 1,
  createdAt: new Date(timestamp),
});

const rows = [row("page-a", "p1-high", "build"), row("page-b", "p3-low", "review")];
const model = {
  routingContext: { kind: "project", projectId: "project-1" },
  libraryId: "library-1",
  databaseViewId: parseDatabaseViewId("view-board"),
  databaseId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Pages",
  viewName: "Priority",
  storeEpoch: "epoch-1",
  commitSeq: 1,
  columns: [],
  query: {
    rows: rows.map((candidate, index) => ({
      pageKey: candidate.pageKey,
      membership: {
        membershipId: `membership-${candidate.pageId}`,
        dataSourceId,
        revision: 1,
        createdAt: timestamp,
      },
      page: {
        pageId: candidate.pageId,
        libraryId: "library-1",
        parent: { kind: "data_source", dataSourceId },
        lifecycle: "active",
        parentRevision: 1,
        metadataRevision: 1,
        documentId: `document-${candidate.pageId}`,
        documentGeneration: 1,
        documentHeadSeq: 1,
        title: candidate.title,
        richTitle: plainTextToPortableRichText(candidate.title),
        preview: candidate.preview,
        plainText: candidate.plainText,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      values: {},
      position: { rankKey: String(index), revision: 1, order: index },
      effectiveGroupKey: candidate.groupKey,
      effectiveSubgroupKey: null,
      taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
    })),
  },
} as unknown as DatabaseViewRenderModel;

describe("database Board card drag data", () => {
  test("keeps Page transfer identity independent from the active grouping", () => {
    const payload = buildDatabaseViewPageDragData({
      model,
      row: rows[0]!,
      allRows: rows,
      selectedPageIds: new Set(["page-a", "page-b"]),
      instanceId: Symbol("board"),
    });

    expect(payload).not.toBeNull();
    expect(payload?.projectId).toBe("project-1");
    expect(payload?.dataSourceId).toBe(dataSourceId);
    expect(payload?.dragItems.map((item) => item.card.id)).toEqual(["page-a", "page-b"]);
    expect(payload?.dragItems.map((item) => item.columnName)).toEqual(["p1-high", "p3-low"]);
    expect(payload?.sourcePage.richTitle).toEqual(plainTextToPortableRichText("page-a"));
  });

  test("does not expose a Project-bound editor transfer from Library context", () => {
    expect(
      buildDatabaseViewPageDragData({
        model: { ...model, routingContext: { kind: "library" } },
        row: rows[0]!,
        allRows: rows,
        selectedPageIds: new Set(),
        instanceId: Symbol("library-board"),
      }),
    ).toBeNull();
  });
});
