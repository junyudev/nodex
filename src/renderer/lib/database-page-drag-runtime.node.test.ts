import { describe, expect, test } from "vite-plus/test";

import {
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabaseModuleReadSnapshotV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  commitDatabasePageDrag,
  DatabasePageDragMutationError,
  type DatabasePageDragRuntimeDependencies,
} from "./database-page-drag-runtime";

const timestamp = "2026-07-16T00:00:00.000Z";

const snapshot = (): DatabaseModuleReadSnapshotV2 => ({
  projectId: "project-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  commitSeq: 1,
  authorization: null,
  value: {
    kind: "query",
    value: {
      database: {
        databaseId: parseDatabaseId("database-1"),
        libraryId: "library-1",
        name: "Work",
        lifecycle: "active",
        defaultViewId: parseDatabaseViewId("view-1"),
        accessRevision: 1,
        metadataRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      dataSource: {
        dataSourceId: parseDataSourceId("source-1"),
        libraryId: "library-1",
        homeDatabaseId: parseDatabaseId("database-1"),
        name: "Pages",
        schemaKey: "nodex.pages",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "a",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      view: {
        viewId: parseDatabaseViewId("view-1"),
        databaseId: parseDatabaseId("database-1"),
        dataSourceId: parseDataSourceId("source-1"),
        name: "Board",
        layout: "board",
        config: upgradeDatabaseViewConfigV2({
          schemaKey: "nodex.database-view",
          schemaVersion: 2,
          filter: { kind: "group", operator: "and", children: [] },
          sort: [
            {
              field: { kind: "manual" },
              direction: "asc",
              nulls: "last",
            },
          ],
          group: { propertyId: "status" },
          display: { propertyIds: [], showTitle: true },
        }),
        isDefault: true,
        revision: 1,
        rankKey: "a",
        lifecycle: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      properties: [
        {
          propertyId: parseDataSourcePropertyId("status"),
          dataSourceId: parseDataSourceId("source-1"),
          name: "Status",
          ...testPropertySemantics("select"),
          valueType: "select",
          config: {},
          rankKey: "a",
          lifecycle: "active",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      rows: [
        {
          pageKey: null,
          page: {
            pageId: "page-1",
            libraryId: "library-1",
            parent: { kind: "data_source", dataSourceId: parseDataSourceId("source-1") },
            lifecycle: "active",
            parentRevision: 1,
            metadataRevision: 1,
            documentId: "document:page-1",
            documentGeneration: 1,
            documentHeadSeq: 1,
            title: "Page",
            richTitle: [],
            preview: "",
            plainText: "",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          membership: {
            membershipId: "membership-1",
            dataSourceId: parseDataSourceId("source-1"),
            revision: 1,
            createdAt: timestamp,
          },
          values: {
            status: {
              propertyId: parseDataSourcePropertyId("status"),
              valueType: "select",
              value: "triage",
              revision: 2,
            },
          },
          taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
          position: { rankKey: "a", revision: 3 },
          effectiveGroupKey: "triage",
          effectiveSubgroupKey: null,
        },
      ],
    },
  },
});

const committed = (
  request: DatabaseApplyV2,
): Extract<DatabaseApplyResultV2, { readonly ok: true }> => ({
  ok: true,
  localCommit: noOpLocalCommit(request.storeEpoch),
  value: {
    operationId: request.operationId,
    projectId: request.projectId,
    libraryId: "library-1",
    storeEpoch: request.storeEpoch,
    duplicate: true,
    operationKinds: request.operations.map((operation) => operation.kind),
    operationOutcomes: [],
    affectedDatabaseIds: [parseDatabaseId("database-1")],
    affectedDataSourceIds: [parseDataSourceId("source-1")],
    affectedPageIds: ["page-1"],
    affectedViewIds: [parseDatabaseViewId("view-1")],
    committedRevisions: {},
    commitSeq: 2,
    committedAt: timestamp,
  },
});

describe("Database Page drag runtime", () => {
  test("retains the exact Page apply request across a lost response retry", async () => {
    const requests: DatabaseApplyV2[] = [];
    const dependencies: DatabasePageDragRuntimeDependencies = {
      apply: async (_projectId, request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("response lost");
        return committed(request);
      },
    };

    const receipt = await commitDatabasePageDrag({
      projectId: "project-1",
      operationId: "drag-1",
      snapshot: snapshot(),
      move: {
        pageId: "page-1",
        fromStatus: "triage",
        toStatus: "ship",
      },
      dependencies,
    });
    expect(receipt).toEqual(committed(requests[1] as DatabaseApplyV2).value);
    expect(receipt.commitSeq).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]?.actor).toEqual({ kind: "renderer_page_drag" });
    expect(requests[0]?.operations.map((operation) => operation.kind)).toEqual([
      "edit_property_values",
      "position_page",
    ]);
  });

  test("surfaces a typed revision conflict without issuing an unbounded refresh", async () => {
    let applies = 0;
    const dependencies: DatabasePageDragRuntimeDependencies = {
      apply: async () => {
        applies += 1;
        return {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "Page changed",
            retryable: false,
          },
        };
      },
    };

    await expect(
      commitDatabasePageDrag({
        projectId: "project-1",
        operationId: "drag-stale",
        snapshot: snapshot(),
        move: {
          pageId: "page-1",
          fromStatus: "triage",
          toStatus: "ship",
        },
        dependencies,
      }),
    ).rejects.toBeInstanceOf(DatabasePageDragMutationError);
    expect(applies).toBe(1);
  });
});
