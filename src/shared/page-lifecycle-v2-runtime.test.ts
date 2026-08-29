import { describe, expect, test } from "vite-plus/test";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "./database-identities";
import type {
  PageLifecycleMutationReceiptV2,
  PageLifecycleMutationRequestV2,
} from "./page-lifecycle-v2";
import {
  compilePageLifecycleRequestV2,
  executePageLifecycleIntentV2,
  PageLifecycleRuntimeErrorV2,
  type PageLifecycleOwnedBlockAuthorityV2,
  type PageLifecyclePreflightSnapshotV2,
} from "./page-lifecycle-v2-runtime";
import { testPropertyManagement } from "./testing/database-property-record";
import { upgradeDatabaseViewConfigV2 } from "./database-view-presentation";
import type { DatabasePage } from "./types";

const databaseId = parseDatabaseId("database-1");
const dataSourceId = parseDataSourceId("source-1");
const viewId = parseDatabaseViewId("view-1");

const authority = (
  lifecycle: "active" | "archived" | "deleted" = "active",
): PageLifecycleOwnedBlockAuthorityV2 => ({
  pageId: "page-1",
  lifecycle,
  parent: { kind: "library", libraryId: "library-1" },
  libraryRankKey: lifecycle === "deleted" ? null : "m",
  metadataRevision: 7,
  parentRevision: 9,
  document: {
    documentId: "document-1",
    generation: 1,
    headSeq: 3,
    readiness: "ready",
    authority: "ydoc_primary",
    schemaKey: "page",
    schemaVersion: 1,
  },
  membership: null,
  restoreEvidence:
    lifecycle === "deleted"
      ? {
          deleteOperationId: "delete-1",
          previousLifecycle: "active",
          membership: {
            membershipId: "membership-1",
            databaseId,
            dataSourceId,
            status: "triage",
            position: { viewId },
          },
          nestedParent: null,
        }
      : null,
});

const preflight = (
  page: PageLifecycleOwnedBlockAuthorityV2 | null,
): PageLifecyclePreflightSnapshotV2 => ({
  projectId: "project-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  commitSeq: 21,
  value: {
    reservedBlockType: null,
    page,
    tagsProperty: {
      propertyId: "tags",
      dataSourceId,
      valueType: "multi_select",
      lifecycle: "active",
      revision: 7,
      config: {
        options: [{ id: "o_AAAAAAAA", name: "Release" }],
      },
    },
    defaultView: {
      database: {
        databaseId,
        libraryId: "library-1",
        name: "Pages",
        lifecycle: "active",
        defaultViewId: viewId,
        accessRevision: 1,
        metadataRevision: 1,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      dataSource: {
        dataSourceId,
        libraryId: "library-1",
        homeDatabaseId: databaseId,
        name: "Pages",
        schemaKey: "nodex.pages",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "m",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      view: {
        viewId,
        databaseId,
        dataSourceId,
        name: "Board",
        layout: "board",
        config: upgradeDatabaseViewConfigV2({
          schemaKey: "nodex.database-view",
          schemaVersion: 2,
          filter: { kind: "group", operator: "and", children: [] },
          sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
          group: null,
          display: { propertyIds: [], showTitle: true },
        }),
        isDefault: true,
        revision: 4,
        rankKey: "m",
        lifecycle: "active",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      properties: [
        {
          propertyId: parseDataSourcePropertyId("tags"),
          dataSourceId,
          name: "Tags",
          schema: { kind: "multi_select" },
          capabilities: {
            filterOperators: [
              "multi_select_contains",
              "multi_select_does_not_contain",
              "multi_select_contains_all",
              "is_empty",
              "is_not_empty",
            ],
            sortable: true,
            groupable: true,
          },
          ...testPropertyManagement(),
          valueType: "multi_select",
          config: { options: [{ id: "o_AAAAAAAA", name: "Release" }] },
          optionCount: 1,
          rankKey: "m",
          lifecycle: "active",
          revision: 7,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      rows: [
        {
          page: { pageId: "draft-first" },
          effectiveGroupKey: "triage",
        },
      ] as unknown as PageLifecyclePreflightSnapshotV2["value"]["defaultView"]["rows"],
    },
  },
});

const receipt = (
  lifecycle: "active" | "archived" | "deleted" = "active",
): PageLifecycleMutationReceiptV2 => ({
  operationId: "operation-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  operationKind: lifecycle === "deleted" ? "delete_page" : "create_page",
  pageId: "page-1",
  duplicate: false,
  metadataRevision: 1,
  parentRevision: 1,
  lifecycle,
  documentId: "document-1",
  documentGeneration: 1,
  documentHeadSeq: 1,
  databaseId,
  dataSourceId,
  membershipId: "membership-1",
  viewId,
  libraryRankKey: "m",
  viewRankKey: "m",
  createdBlockIds: ["body-1"],
  createdTagOptionIds: [],
  commitSeq: 22,
  committedAt: "2026-07-18T00:00:00.000Z",
});

const canonicalPage = (archived = false): DatabasePage => ({
  id: "page-1",
  pageKey: null,
  status: "triage",
  archived,
  title: "Page",
  richTitle: [{ type: "text", text: "Page", styles: {} }],
  description: "",
  tags: [],
  created: new Date("2026-07-18T00:00:00.000Z"),
  order: 0,
});

describe("Page lifecycle v2 runtime", () => {
  test("compiles preallocated option identities and semantic View placement without reading row anchors", () => {
    const request = compilePageLifecycleRequestV2({
      intent: {
        kind: "create",
        projectId: "project-1",
        operationId: "operation-1",
        pageId: "page-1",
        status: "triage",
        input: {
          title: "Page",
          tagOptions: [
            { optionId: "o_AAAAAAAA", name: "Release" },
            { optionId: "o_BBBBBBBB", name: " 新标签 " },
          ],
        },
        placement: "top",
      },
      preflight: preflight(null),
    });
    expect(request.operation.kind).toBe("create_page");
    if (request.operation.kind !== "create_page") return;
    expect(request.operation.dataSourceId).toBe(dataSourceId);
    expect(request.operation.viewPlacement).toEqual({ kind: "start" });
    expect(request.operation.tagOptionIds).toContain("o_AAAAAAAA");
    expect(request.operation.newTagOptions).toHaveLength(1);
    expect(request.operation.newTagOptions[0]?.name).toBe("新标签");
    expect(request.operation.newTagOptions[0]?.optionId).toBe("o_BBBBBBBB");

    const endRequest = compilePageLifecycleRequestV2({
      intent: {
        kind: "create",
        projectId: "project-1",
        operationId: "operation-end",
        pageId: "page-end",
        status: "triage",
        input: { title: "End" },
        placement: "bottom",
      },
      preflight: preflight(null),
    });
    const beforeRequest = compilePageLifecycleRequestV2({
      intent: {
        kind: "create",
        projectId: "project-1",
        operationId: "operation-before",
        pageId: "page-before",
        status: "triage",
        input: { title: "Before" },
        placement: { beforePageId: "page-anchor" },
      },
      preflight: preflight(null),
    });
    expect(endRequest.operation).toMatchObject({
      kind: "create_page",
      viewPlacement: { kind: "end" },
    });
    expect(beforeRequest.operation).toMatchObject({
      kind: "create_page",
      viewPlacement: { kind: "before", pageId: "page-anchor" },
    });
  });

  test("compiles delete evidence and revision fences for restore", () => {
    const request = compilePageLifecycleRequestV2({
      intent: {
        kind: "restore",
        projectId: "project-1",
        operationId: "restore-1",
        pageId: "page-1",
        beforeBlockId: "library-anchor",
        beforeViewPageId: "view-anchor",
      },
      preflight: preflight(authority("deleted")),
    });
    expect(request.operation).toMatchObject({
      kind: "restore_page",
      deleteOperationId: "delete-1",
      expectedMetadataRevision: 7,
      expectedParentRevision: 9,
      beforeBlockId: "library-anchor",
      membership: {
        dataSourceId,
        position: { viewId, beforeViewPageId: "view-anchor" },
      },
    });
  });

  test("fences nested Page deletion and restore with the host Document head", () => {
    const nestedActive = {
      ...authority(),
      parent: { kind: "page", pageId: "host-page-1" } as const,
      libraryRankKey: null,
    } satisfies PageLifecycleOwnedBlockAuthorityV2;
    const nestedDeleted = {
      ...authority("deleted"),
      parent: { kind: "page", pageId: "host-page-1" } as const,
      libraryRankKey: null,
      restoreEvidence: {
        ...authority("deleted").restoreEvidence!,
        nestedParent: {
          documentId: "host-document-1",
          parentBlockId: "host-toggle-1",
          beforeBlockId: "host-sibling-1",
        },
      },
    } satisfies PageLifecycleOwnedBlockAuthorityV2;
    const hostHead = {
      documentId: "host-document-1",
      generation: 4,
      expectedHeadSeq: 18,
    } as const;

    const deleteRequest = compilePageLifecycleRequestV2({
      intent: {
        kind: "delete",
        projectId: "project-1",
        operationId: "delete-nested-1",
        pageId: "page-1",
        parentDocumentHead: hostHead,
      },
      preflight: preflight(nestedActive),
    });
    expect(deleteRequest.operation).toMatchObject({
      kind: "delete_page",
      parentDocumentHead: hostHead,
    });

    expect(() =>
      compilePageLifecycleRequestV2({
        intent: {
          kind: "delete",
          projectId: "project-1",
          operationId: "delete-nested-missing-head",
          pageId: "page-1",
        },
        preflight: preflight(nestedActive),
      }),
    ).toThrowError(
      new PageLifecycleRuntimeErrorV2(
        "page_parent_invalid",
        "Nested Page page-1 requires the host Page Document head",
      ),
    );

    const restoreRequest = compilePageLifecycleRequestV2({
      intent: {
        kind: "restore",
        projectId: "project-1",
        operationId: "restore-nested-1",
        pageId: "page-1",
        parentDocumentHead: hostHead,
      },
      preflight: preflight(nestedDeleted),
    });
    expect(restoreRequest.operation).toMatchObject({
      kind: "restore_page",
      parentDocumentHead: hostHead,
    });
  });

  test("retries a lost response with the exact same v2 request", async () => {
    const requests: PageLifecycleMutationRequestV2[] = [];
    const canonicalReadFloors: Array<{ storeEpoch: string; commitSeq: number }> = [];
    const result = await executePageLifecycleIntentV2(
      {
        kind: "create",
        projectId: "project-1",
        operationId: "operation-1",
        pageId: "page-1",
        status: "triage",
        input: { title: "Page" },
      },
      {
        readPreflight: async () => ({ ok: true, value: preflight(null) }),
        mutate: async (_projectId, request) => {
          requests.push(request);
          if (requests.length === 1) throw new Error("response lost");
          return {
            ok: true,
            value: receipt(),
            localCommit: {
              status: "no_op",
              observed: { store_epoch: request.storeEpoch, commit_head: 3 },
            },
          };
        },
        readBoardProjection: async (_projectId, _pageId, minimumCommitCursor) => {
          canonicalReadFloors.push(minimumCommitCursor);
          return canonicalPage();
        },
      },
    );
    expect(requests).toHaveLength(2);
    expect(requests[0] === requests[1]).toBe(true);
    expect(canonicalReadFloors).toEqual([
      {
        storeEpoch: "epoch-1",
        commitSeq: 22,
      },
    ]);
    expect(result.boardProjection?.id).toBe("page-1");
  });

  test("keeps the durable receipt when the best-effort projection read stays stale", async () => {
    let readAttempts = 0;
    const result = await executePageLifecycleIntentV2(
      {
        kind: "create",
        projectId: "project-1",
        operationId: "operation-1",
        pageId: "page-1",
        status: "triage",
        input: { title: "Page" },
      },
      {
        readPreflight: async () => ({ ok: true, value: preflight(null) }),
        mutate: async () => ({
          ok: true,
          value: receipt(),
          localCommit: {
            status: "no_op",
            observed: { store_epoch: "epoch-1", commit_head: 22 },
          },
        }),
        readBoardProjection: async () => {
          readAttempts += 1;
          throw new Error("projection still catching up");
        },
        waitBeforeCanonicalReadRetry: async () => undefined,
      },
    );

    expect(result.receipt.commitSeq).toBe(22);
    expect(result.boardProjection).toBeNull();
    expect(readAttempts).toBe(3);
  });
});
