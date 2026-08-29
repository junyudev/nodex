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
import type { BlockTransferCommandResult } from "../../shared/block-transfer";
import type { PublicBlockTransferIntent } from "../../shared/block-transfer-transport";
import type { ProjectAccessedDocumentDescriptor } from "../../shared/block-documents/contracts";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import {
  moveNfmBlocks,
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

const targetPage = (): ProjectAccessedDocumentDescriptor => ({
  libraryId,
  accessContext: { kind: "project", projectId },
  ownerBlockId: "page-target",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document-target",
  storeEpoch,
  generation: 2,
  headSeq: 9,
  schemaKey: "nodex.block-tree",
  schemaVersion: 1,
  authorization: null,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array() },
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

const committed = (intent: PublicBlockTransferIntent): BlockTransferCommandResult => ({
  ok: true,
  localCommit: noOpLocalCommit(intent.storeEpoch),
  value: {
    operationId: intent.operationId,
    projectId: intent.projectId,
    storeEpoch: intent.storeEpoch,
    mode: intent.mode,
    duplicate: false,
    sourceRootBlockIds: intent.rootBlockIds,
    resultRootBlockIds: intent.rootBlockIds,
    copiedBlockIds: {},
    transformationEvidence: [],
    finalLocations: {},
    finalLocationRevisions: {},
    documentCommits: [],
    affectedDatabaseBlockIds: [],
    fileOwnershipMoves: [],
    commitSeq: 12,
    committedAt: timestamp,
    undoToken: null,
  },
});

const dependencies = (
  transfer: NfmBlockMoveRuntimeDependencies["transfer"],
): NfmBlockMoveRuntimeDependencies => ({
  preparePage: async () => ({ ok: true, value: targetPage() }),
  readDatabase: async () => databaseRead(),
  transfer,
  createOperationId: () => "operation-move",
});

describe("NFM Block move runtime", () => {
  test("moves selected Blocks into a Page with exact source and target heads", async () => {
    const intents: PublicBlockTransferIntent[] = [];

    await moveNfmBlocks(
      request({
        kind: "page",
        projectId,
        pageId: "page-target",
      }),
      dependencies(async (_projectId, intent) => {
        intents.push(intent);
        return committed(intent);
      }),
    );

    expect(intents).toEqual([
      expect.objectContaining({
        operationId: "operation-move",
        projectId,
        source: { kind: "page", pageId: "page-source" },
        target: { kind: "page", pageId: "page-target" },
        rootBlockIds: ["block-a", "block-b"],
        causalDependencies: [
          {
            documentId: "document-source",
            generation: 3,
            expectedHeadSeq: 11,
          },
          {
            documentId: "document-target",
            generation: 2,
            expectedHeadSeq: 9,
          },
        ],
      }),
    ]);
  });

  test("resolves a real Status-grouped View before moving Blocks to a DB status", async () => {
    const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>(async () =>
      databaseRead(),
    );
    const intents: PublicBlockTransferIntent[] = [];

    await moveNfmBlocks(
      request({
        kind: "db-column",
        projectId,
        columnId: "ship",
      }),
      {
        ...dependencies(async (_projectId, intent) => {
          intents.push(intent);
          return committed(intent);
        }),
        readDatabase,
      },
    );

    expect(readDatabase).toHaveBeenCalledWith(projectId, {
      projectId,
      read: { target: { kind: "project_default" }, mode: "database" },
    });
    expect(intents[0]).toMatchObject({
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

  test("preserves structured transfer diagnostics for the picker and logs", async () => {
    await expect(
      moveNfmBlocks(
        request({
          kind: "page",
          projectId,
          pageId: "page-target",
        }),
        dependencies(async () => ({
          ok: false,
          error: {
            code: "target_head_mismatch",
            message: "The destination Page changed. Try again.",
            retryable: true,
            reloadRequired: false,
            operationId: "operation-move",
          },
        })),
      ),
    ).rejects.toMatchObject({
      name: "NfmBlockMoveError",
      code: "block_transfer.target_head_mismatch",
      message: "The destination Page changed. Try again.",
      retryable: true,
      reloadRequired: false,
      operationId: "operation-move",
    });
  });

  test("rejects destinations outside the source Project before any mutation work", async () => {
    const preparePage = vi.fn<NfmBlockMoveRuntimeDependencies["preparePage"]>();
    const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>();
    const transfer = vi.fn<NfmBlockMoveRuntimeDependencies["transfer"]>();

    await expect(
      moveNfmBlocks(
        request({
          kind: "page",
          projectId: "project-other",
          pageId: "page-target",
        }),
        {
          preparePage,
          readDatabase,
          transfer,
          createOperationId: () => "operation-move",
        },
      ),
    ).rejects.toMatchObject({
      code: "destination.cross_project",
      message: "Choose a destination in the current Project.",
    });
    expect(preparePage).not.toHaveBeenCalled();
    expect(readDatabase).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
});
