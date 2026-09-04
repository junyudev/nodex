import { describe, expect, test, vi } from "vite-plus/test";
import {
  type DatabaseContainerDescriptorV2,
  type DatabaseModuleReadResultV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  prepareNfmBlockPromotion,
  type NfmBlockMoveRequest,
  type NfmBlockMoveRuntimeDependencies,
} from "./nfm-block-move-runtime";

const timestamp = "2026-08-14T00:00:00.000Z";
const projectId = "project-alpha";
const storeEpoch = "epoch-alpha";
const libraryId = "library-alpha";
const databaseId = parseDatabaseId("database-alpha");
const dataSourceId = parseDataSourceId("source-alpha");
const defaultViewId = parseDatabaseViewId("view-default");
const statusViewId = parseDatabaseViewId("view-status");

const viewConfig = (groupPropertyId: string | null) =>
  upgradeDatabaseViewConfigV2({
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
    group: groupPropertyId ? { propertyId: groupPropertyId } : null,
    display: { propertyIds: [], showTitle: true },
  });

const descriptor = (): DatabaseContainerDescriptorV2 => ({
  database: {
    databaseId,
    libraryId,
    name: "Tasks",
    lifecycle: "active",
    defaultViewId,
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  dataSources: [
    {
      dataSourceId,
      libraryId,
      homeDatabaseId: databaseId,
      name: "Pages",
      schemaKey: "nodex.pages",
      schemaRevision: 1,
      lifecycle: "active",
      rankKey: "a",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  views: [
    {
      viewId: defaultViewId,
      databaseId,
      dataSourceId,
      name: "Default",
      layout: "list",
      config: viewConfig(null),
      isDefault: true,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      viewId: statusViewId,
      databaseId,
      dataSourceId,
      name: "Workflow",
      layout: "board",
      config: viewConfig("status"),
      isDefault: false,
      revision: 1,
      rankKey: "b",
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
});

const databaseRead = (): DatabaseModuleReadResultV2 => ({
  ok: true,
  value: {
    projectId,
    libraryId,
    storeEpoch,
    commitSeq: 7,
    authorization: null,
    value: { kind: "database", value: descriptor() },
  },
});

const request = (destination: NfmBlockMoveRequest["destination"]): NfmBlockMoveRequest => ({
  projectId,
  storeEpoch,
  sourcePageId: "page-source",
  sourceDocumentId: "document-source",
  sourceDocumentGeneration: 3,
  rootBlockIds: ["block-a", "block-b"],
  sourceHead: {
    documentId: "document-source",
    storeEpoch,
    generation: 3,
    expectedHeadSeq: 11,
  },
  destination,
});

const dependencies = (): NfmBlockMoveRuntimeDependencies => ({
  readDatabase: async () => databaseRead(),
  createOperationId: () => "operation-move",
});

describe("NFM Block move runtime", () => {
  test("resolves a real Status-grouped View before moving Blocks to a DB status", async () => {
    const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>(async () =>
      databaseRead(),
    );
    const intent = await prepareNfmBlockPromotion(
      request({
        kind: "db-column",
        projectId,
        columnId: "ship",
      }),
      {
        ...dependencies(),
        readDatabase,
      },
    );

    expect(readDatabase).toHaveBeenCalledWith(projectId, {
      projectId,
      read: { target: { kind: "project_default" }, mode: "database" },
    });
    expect(intent).toMatchObject({
      target: {
        kind: "data_source",
        dataSourceId,
        placement: {
          kind: "direct",
          viewId: statusViewId,
          preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
          groupKey: "ship",
        },
      },
      causalDependencies: [
        {
          documentId: "document-source",
          generation: 3,
          expectedHeadSeq: 11,
        },
      ],
    });
  });

  test("rejects a source fence from another generation before compiling a request", async () => {
    const input = request({ kind: "db-column", projectId, columnId: "ship" });
    await expect(
      prepareNfmBlockPromotion(
        { ...input, sourceHead: { ...input.sourceHead, generation: 4 } },
        dependencies(),
      ),
    ).rejects.toMatchObject({
      name: "NfmBlockMoveError",
      code: "source.changed",
      reloadRequired: true,
      operationId: "operation-move",
    });
  });

  test("rejects destinations outside the source Project before any mutation work", async () => {
    const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>();

    await expect(
      prepareNfmBlockPromotion(
        request({
          kind: "db-column",
          projectId: "project-other",
          columnId: "ship",
        }),
        {
          readDatabase,
          createOperationId: () => "operation-move",
        },
      ),
    ).rejects.toMatchObject({
      code: "destination.cross_project",
      message: "Choose a destination in the current Project.",
    });
    expect(readDatabase).not.toHaveBeenCalled();
  });
});
