import { describe, expect, test } from "vite-plus/test";

import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import type {
  BlockPropertyMutationCommandResultV2,
  BlockPropertyMutationRequestV2,
  LibraryBlockPropertyMutationCommandResultV2,
  LibraryBlockPropertyMutationRequestV2,
} from "../../shared/block-property-mutations-v2";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DataSourcePropertyRecordV2,
  LibraryDatabaseApplyResultV2,
  LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import {
  type LibraryModuleApplyRequest,
  type LibraryModuleApplyResult,
} from "../../shared/library-module";
import type { LibraryPageDetail, PageDetail } from "../../shared/page-detail";
import { authorizedReadStampFixture } from "../../shared/testing/authorized-read-stamp-fixture";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import {
  commitLibraryPageDetailMetadataPatch,
  commitLibraryPageDetailPropertyEdit,
  commitPageDetailMetadataPatch,
  commitPageDetailMetadataPatchWithReceipt,
  commitPageDetailPropertyEdit,
  type LibraryPageDetailMetadataRuntimeDependencies,
  type PageDetailMetadataRuntimeDependencies,
} from "./page-detail-metadata-runtime";

const timestamp = "2026-07-16T00:00:00.000Z";
const databaseId = parseDatabaseId("019f714b-0000-7000-8000-000000000021");
const dataSourceId = parseDataSourceId("019f714b-0000-7000-8000-000000000022");
const viewId = parseDatabaseViewId("019f714b-0000-7000-8000-000000000023");
const priorityPropertyId = parseDataSourcePropertyId("priority");
const tagsPropertyId = parseDataSourcePropertyId("tags");
const confidencePropertyId = parseDataSourcePropertyId("p_C0nf1d3n");
const uiOptionId = "o_AAAAAAAA";
const backendOptionId = "o_BBBBBBBB";

const property = (
  key: string,
  valueType: DataSourcePropertyRecordV2["valueType"],
): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(key),
  dataSourceId,
  name: key,
  ...testPropertySemantics(valueType, valueType === "multi_select" ? 2 : 0),
  valueType,
  config:
    valueType === "multi_select"
      ? {
          options: [
            { id: uiOptionId, name: "ui" },
            { id: backendOptionId, name: "backend" },
          ],
        }
      : {},
  rankKey: key,
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const detail = (member = true): PageDetail => {
  const properties = [
    property("status", "select"),
    property("priority", "select"),
    property("estimate", "select"),
    property("tags", "multi_select"),
    property("due_date", "date"),
    property("scheduled_start", "datetime"),
    property("scheduled_end", "datetime"),
    property("assignee", "text"),
    property("p_C0nf1d3n", "number"),
  ];
  return {
    projectId: "project-1",
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 4,
    authorization: authorizedReadStampFixture({
      deliveryAddress: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-1",
      },
      subject: { kind: "page", page_id: "page-1" },
      commitSeq: 4,
    }),
    page: {
      pageId: "page-1",
      libraryId: "library-1",
      parent: member
        ? { kind: "data_source", dataSourceId }
        : { kind: "library", libraryId: "library-1" },
      lifecycle: "active",
      parentRevision: 1,
      metadataRevision: 2,
      documentId: "document-1",
      documentGeneration: 1,
      documentHeadSeq: 1,
      title: "Page",
      richTitle: plainTextToPortableRichText("Page"),
      preview: "",
      plainText: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    document: {
      readiness: "ready",
      schemaKey: "nodex.page",
      schemaVersion: 3,
    },
    intrinsicProperties: [
      {
        key: "run.baseBranch",
        valueType: "null",
        value: null,
        revision: 3,
      },
    ],
    dataSourceContext: member
      ? {
          kind: "member",
          pageKey: null,
          membership: {
            membershipId: "membership-1",
            dataSourceId,
            revision: 2,
            createdAt: timestamp,
          },
          database: {
            databaseId,
            libraryId: "library-1",
            name: "Database",
            lifecycle: "active",
            defaultViewId: viewId,
            accessRevision: 1,
            metadataRevision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          dataSource: {
            dataSourceId,
            libraryId: "library-1",
            homeDatabaseId: databaseId,
            name: "Pages",
            schemaKey: "nodex.data-source",
            schemaRevision: 1,
            lifecycle: "active",
            rankKey: "a0",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          properties,
          pageLayout: {
            dataSourceId,
            revision: 1,
            entries: properties.map((property, index) => ({
              propertyId: property.propertyId,
              visibility: "always_show" as const,
              rankKey: `a${index}`,
            })),
          },
          values: {
            priority: {
              propertyId: priorityPropertyId,
              valueType: "select",
              value: "p2-medium",
              revision: 7,
            },
            tags: {
              propertyId: tagsPropertyId,
              valueType: "multi_select",
              value: [uiOptionId],
              revision: 4,
            },
            p_C0nf1d3n: {
              propertyId: confidencePropertyId,
              valueType: "number",
              value: 0.5,
              revision: 2,
            },
          },
        }
      : { kind: "standalone" },
  };
};

const libraryDetail = (member = true): LibraryPageDetail => {
  const { projectId: _privateProjectId, ...value } = detail(member);
  void _privateProjectId;
  return { ...value, accessContext: { kind: "library" } };
};

const mutationSuccess = (
  request: BlockPropertyMutationRequestV2,
): BlockPropertyMutationCommandResultV2 => ({
  ok: true,
  localCommit: noOpLocalCommit(request.storeEpoch),
  value: {
    mutationId: request.mutationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    duplicate: false,
    fields: [],
    blockMetadataRevisions: { "page-1": 3 },
    commitSeq: 5,
    committedAt: timestamp,
  },
});

const metadataSuccess = (
  request: LibraryModuleApplyRequest,
): Extract<LibraryModuleApplyResult, { readonly ok: true }> => ({
  ok: true,
  localCommit: noOpLocalCommit(request.storeEpoch),
  value: {
    operationId: request.operationId,
    profileId: "profile-1",
    storeEpoch: request.storeEpoch,
    libraryId: "library-1",
    operationKind: request.operation.kind,
    duplicate: false,
    didMutate: true,
    createdTarget: null,
    canvasMutation: null,
    structuralEdit: null,
    affectedParentKeys: [],
    affectedPageIds: ["page-1"],
    affectedDatabaseIds: [databaseId],
    affectedViewIds: [],
    committedRevisions: {},
    commitSeq: 5,
    committedAt: timestamp,
  },
});

const dependencies = (
  input: {
    readonly detail?: PageDetail;
    readonly requests?: BlockPropertyMutationRequestV2[];
    readonly refreshes?: string[];
    readonly results?: BlockPropertyMutationCommandResultV2[];
    readonly databaseRequests?: DatabaseApplyV2[];
    readonly databaseResults?: DatabaseApplyResultV2[];
    readonly metadataRequests?: LibraryModuleApplyRequest[];
    readonly metadataResults?: LibraryModuleApplyResult[];
    readonly refreshDetail?: PageDetailMetadataRuntimeDependencies["refreshDetail"];
  } = {},
): PageDetailMetadataRuntimeDependencies => ({
  readDetail: async () => input.detail ?? detail(),
  mutateProperties: async (_projectId, request) => {
    input.requests?.push(request);
    return input.results?.shift() ?? mutationSuccess(request);
  },
  applyDatabase: async (_projectId, request) => {
    input.databaseRequests?.push(request);
    return (
      input.databaseResults?.shift() ?? {
        ok: true,
        localCommit: noOpLocalCommit(request.storeEpoch),
        value: {
          operationId: request.operationId,
          projectId: request.projectId,
          libraryId: "library-1",
          storeEpoch: request.storeEpoch,
          duplicate: false,
          operationKinds: request.operations.map((operation) => operation.kind),
          operationOutcomes: [],
          affectedDatabaseIds: [databaseId],
          affectedDataSourceIds: [dataSourceId],
          affectedPageIds: ["page-1"],
          affectedViewIds: [],
          committedRevisions: {},
          commitSeq: 5,
          committedAt: timestamp,
        },
      }
    );
  },
  applyMetadataProperties: async (_projectId, request) => {
    input.metadataRequests?.push(request);
    return input.metadataResults?.shift() ?? metadataSuccess(request);
  },
  refreshDetail:
    input.refreshDetail ??
    (async (_projectId, pageId) => {
      input.refreshes?.push(pageId);
    }),
});

const libraryDependencies = (input: {
  readonly requests: LibraryBlockPropertyMutationRequestV2[];
  readonly databaseRequests?: LibraryDatabaseApplyV2[];
  readonly metadataRequests?: LibraryModuleApplyRequest[];
  readonly metadataResults?: LibraryModuleApplyResult[];
  readonly refreshes?: string[];
}): LibraryPageDetailMetadataRuntimeDependencies => ({
  readDetail: async () => libraryDetail(),
  mutateProperties: async (request) => {
    input.requests.push(request);
    return {
      ok: true,
      localCommit: noOpLocalCommit(request.storeEpoch),
      value: {
        mutationId: request.mutationId,
        accessContext: { kind: "library" },
        storeEpoch: request.storeEpoch,
        duplicate: false,
        fields: [],
        blockMetadataRevisions: { "page-1": 3 },
        commitSeq: 5,
        committedAt: timestamp,
      },
    } satisfies LibraryBlockPropertyMutationCommandResultV2;
  },
  applyDatabase: async (request): Promise<LibraryDatabaseApplyResultV2> => {
    input.databaseRequests?.push(request);
    return {
      ok: true,
      localCommit: noOpLocalCommit(request.storeEpoch),
      value: {
        operationId: request.operationId,
        accessContext: { kind: "library" },
        libraryId: "library-1",
        storeEpoch: request.storeEpoch,
        duplicate: false,
        operationKinds: request.operations.map((operation) => operation.kind),
        operationOutcomes: [],
        affectedDatabaseIds: [databaseId],
        affectedDataSourceIds: [dataSourceId],
        affectedPageIds: ["page-1"],
        affectedViewIds: [],
        committedRevisions: {},
        commitSeq: 5,
        committedAt: timestamp,
      },
    };
  },
  applyMetadataProperties: async (request) => {
    input.metadataRequests?.push(request);
    return input.metadataResults?.shift() ?? metadataSuccess(request);
  },
  refreshDetail: async (pageId) => {
    input.refreshes?.push(pageId);
  },
});

describe("Page Detail metadata runtime", () => {
  test.each([
    ["Data Source", { priority: "p1-high" }, 5],
    ["intrinsic", { runInBaseBranch: "main" }, 5],
    ["atomic mixed", { priority: "p1-high", runInBaseBranch: "main" }, 5],
    ["semantic no-op", { priority: "p2-medium" }, 4],
  ] as const)("preserves the %s commit cursor", async (_kind, patch, commitSeq) => {
    const result = await commitPageDetailMetadataPatchWithReceipt({
      projectId: "project-1",
      pageId: "page-1",
      operationId: `receipt-${commitSeq}`,
      patch,
      dependencies: dependencies(),
    });

    expect(result).toMatchObject({
      result: { status: "updated" },
      commitCursor: { storeEpoch: "epoch-1", commitSeq },
    });
  });

  test("does not reclassify a durable metadata commit when detail refresh fails", async () => {
    const result = await commitPageDetailMetadataPatchWithReceipt({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "receipt-refresh-failure",
      patch: { priority: "p1-high" },
      dependencies: dependencies({
        refreshDetail: async () => {
          throw new Error("detail projection unavailable");
        },
      }),
    });

    expect(result).toEqual({
      result: { status: "updated", didMutate: true },
      commitCursor: { storeEpoch: "epoch-1", commitSeq: 5 },
    });
  });

  test("writes through Library scope without renderer-authored Project or actor fields", async () => {
    const requests: LibraryBlockPropertyMutationRequestV2[] = [];
    const databaseRequests: LibraryDatabaseApplyV2[] = [];
    const refreshes: string[] = [];
    const result = await commitLibraryPageDetailMetadataPatch({
      pageId: "page-1",
      operationId: "library-set-priority",
      clientSessionId: "library-window",
      patch: { priority: "p1-high" },
      dependencies: libraryDependencies({ requests, databaseRequests, refreshes }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(0);
    expect(databaseRequests).toHaveLength(1);
    expect(databaseRequests[0]).toMatchObject({
      operationId: "library-set-priority",
      operations: [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId: "page-1",
              dataSourceId,
              propertyId: "priority",
              edit: {
                kind: "replace",
                expectedValueRevision: 7,
                value: { kind: "select", optionId: "p1-high" },
              },
            },
          ],
        },
      ],
    });
    expect("projectId" in databaseRequests[0]!).toBe(false);
    expect("actor" in databaseRequests[0]!).toBe(false);
    expect("clientSessionId" in databaseRequests[0]!).toBe(false);
    expect(refreshes).toEqual(["page-1"]);
  });

  test("rejects execution metadata without an explicit Project context", async () => {
    const requests: LibraryBlockPropertyMutationRequestV2[] = [];

    await expect(
      commitLibraryPageDetailMetadataPatch({
        pageId: "page-1",
        operationId: "library-set-run-target",
        patch: { runInTarget: "newWorktree" },
        dependencies: libraryDependencies({ requests }),
      }),
    ).rejects.toThrow("require an explicit Project context");

    expect(requests).toHaveLength(0);
  });

  test("writes Data Source values with the Page Detail value revision", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const databaseRequests: DatabaseApplyV2[] = [];
    const refreshes: string[] = [];

    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "set-priority",
      clientSessionId: "page-stage-metadata",
      patch: { priority: "p1-high" },
      dependencies: dependencies({ requests, databaseRequests, refreshes }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(0);
    expect(databaseRequests).toHaveLength(1);
    expect(databaseRequests[0]).toMatchObject({
      operationId: "set-priority",
      projectId: "project-1",
      storeEpoch: "epoch-1",
      operations: [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId: "page-1",
              dataSourceId,
              propertyId: "priority",
              edit: {
                kind: "replace",
                expectedValueRevision: 7,
                value: { kind: "select", optionId: "p1-high" },
              },
            },
          ],
        },
      ],
    });
    expect("clientSessionId" in databaseRequests[0]!).toBe(false);
    expect(refreshes).toEqual(["page-1"]);
  });

  test("keeps the value revision seen by the editor instead of overwriting newer authority", async () => {
    const databaseRequests: DatabaseApplyV2[] = [];
    const result = await commitPageDetailPropertyEdit({
      projectId: "project-1",
      pageId: "page-1",
      propertyId: "p_C0nf1d3n",
      operationId: "set-confidence",
      clientSessionId: "page-stage-1",
      edit: { kind: "replace", value: 0.82, expectedValueRevision: 1 },
      dependencies: dependencies({ databaseRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(databaseRequests[0]).toMatchObject({
      operationId: "set-confidence",
      actor: { kind: "page_stage" },
      operations: [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId: "page-1",
              dataSourceId,
              propertyId: "p_C0nf1d3n",
              edit: {
                kind: "replace",
                expectedValueRevision: 1,
                value: { kind: "number", value: 0.82 },
              },
            },
          ],
        },
      ],
    });
    expect("clientSessionId" in databaseRequests[0]!).toBe(false);
  });

  test("keeps renderer session identity out of direct Library Database applies", async () => {
    const requests: LibraryBlockPropertyMutationRequestV2[] = [];
    const databaseRequests: LibraryDatabaseApplyV2[] = [];
    const result = await commitLibraryPageDetailPropertyEdit({
      pageId: "page-1",
      propertyId: "p_C0nf1d3n",
      operationId: "library-set-confidence",
      clientSessionId: "library-page-stage",
      edit: { kind: "replace", value: 0.82, expectedValueRevision: 1 },
      dependencies: libraryDependencies({ requests, databaseRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(databaseRequests).toHaveLength(1);
    expect("clientSessionId" in databaseRequests[0]!).toBe(false);
  });

  test("creates and selects a custom option through one ordered Database apply", async () => {
    const databaseRequests: DatabaseApplyV2[] = [];
    const result = await commitPageDetailPropertyEdit({
      projectId: "project-1",
      pageId: "page-1",
      propertyId: "tags",
      operationId: "create-tag",
      edit: {
        kind: "create_option_and_select",
        optionId: "o_CCCCCCCC",
        name: "research",
        color: "blue",
        expectedPropertyRevision: 1,
        expectedValueRevision: 6,
      },
      dependencies: dependencies({ databaseRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(databaseRequests[0]?.operations).toMatchObject([
      {
        kind: "put_option",
        propertyId: "tags",
        optionId: "o_CCCCCCCC",
        expectedPropertyRevision: 1,
      },
      {
        kind: "edit_property_values",
        edits: [
          {
            edit: {
              kind: "patch_set",
              delta: { addOptionIds: ["o_CCCCCCCC"], removeOptionIds: [] },
            },
          },
        ],
      },
    ]);
  });

  test("compiles a multi-select interaction as an explicit delta against fresh authority", async () => {
    const databaseRequests: DatabaseApplyV2[] = [];
    const result = await commitPageDetailPropertyEdit({
      projectId: "project-1",
      pageId: "page-1",
      propertyId: "tags",
      operationId: "add-tag",
      edit: {
        kind: "patch_multi_select",
        addOptionIds: [backendOptionId],
        removeOptionIds: [],
      },
      dependencies: dependencies({ databaseRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(databaseRequests[0]?.operations).toEqual([
      {
        kind: "edit_property_values",
        edits: [
          {
            pageId: "page-1",
            dataSourceId,
            propertyId: "tags",
            edit: {
              kind: "patch_set",
              delta: {
                kind: "multi_select",
                addOptionIds: [backendOptionId],
                removeOptionIds: [],
              },
            },
          },
        ],
      },
    ]);
  });

  test("writes Page intrinsic fields without inventing Data Source coordinates", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const refreshes: string[] = [];

    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "set-base-branch",
      patch: { runInBaseBranch: "main" },
      dependencies: dependencies({
        detail: detail(false),
        requests,
        refreshes,
      }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      mutationId: "set-base-branch",
      fields: [
        {
          scope: "intrinsic",
          blockId: "page-1",
          propertyKey: "run.baseBranch",
          expectedRevision: 3,
          value: "main",
        },
      ],
    });
    expect(refreshes).toEqual(["page-1"]);
  });

  test("returns a conflict and refreshes after a stale Data Source value", async () => {
    const refreshes: string[] = [];
    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "stale-priority",
      patch: { priority: "p1-high" },
      dependencies: dependencies({
        refreshes,
        databaseResults: [
          {
            ok: false,
            error: {
              code: "revision_conflict",
              message: "stale value",
              retryable: false,
              operationId: "stale-priority",
            },
          },
        ],
      }),
    });

    expect(result).toEqual({ status: "conflict" });
    expect(refreshes).toEqual(["page-1"]);
  });

  test("rejects a Data Source field on a standalone Page", async () => {
    await expect(
      commitPageDetailMetadataPatch({
        projectId: "project-1",
        pageId: "page-1",
        operationId: "standalone-priority",
        patch: { priority: "p1-high" },
        dependencies: dependencies({ detail: detail(false) }),
      }),
    ).rejects.toThrow("This Page has no Data Source properties");
  });

  test("does not write an already represented value", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const refreshes: string[] = [];
    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "same-priority",
      patch: { priority: "p2-medium" },
      dependencies: dependencies({ requests, refreshes }),
    });

    expect(result).toEqual({ status: "updated", didMutate: false });
    expect(requests).toHaveLength(0);
    expect(refreshes).toEqual(["page-1"]);
  });

  test("commits Data Source and intrinsic fields through one atomic Library operation", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const databaseRequests: DatabaseApplyV2[] = [];
    const metadataRequests: LibraryModuleApplyRequest[] = [];
    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "atomic-metadata",
      patch: { priority: "p1-high", runInBaseBranch: "main" },
      dependencies: dependencies({ requests, databaseRequests, metadataRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(0);
    expect(databaseRequests).toHaveLength(0);
    expect(metadataRequests).toHaveLength(1);
    expect(metadataRequests[0]?.operation).toMatchObject({
      kind: "apply_page_metadata_properties",
      databaseOperations: [expect.objectContaining({ kind: "edit_property_values" })],
      intrinsicFields: [
        expect.objectContaining({ scope: "intrinsic", propertyKey: "run.baseBranch" }),
      ],
    });
  });

  test("commits source-scoped tag option IDs without display-name inference", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const databaseRequests: DatabaseApplyV2[] = [];
    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "set-tags",
      patch: { tags: [backendOptionId] },
      dependencies: dependencies({ requests, databaseRequests }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(0);
    expect(databaseRequests[0]?.operations).toEqual([
      {
        kind: "edit_property_values",
        edits: [
          expect.objectContaining({
            propertyId: "tags",
            edit: {
              kind: "patch_set",
              delta: {
                kind: "multi_select",
                addOptionIds: [backendOptionId],
                removeOptionIds: [uiOptionId],
              },
            },
          }),
        ],
      },
    ]);
  });

  test("rejects tag display names at the Property identity boundary", async () => {
    await expect(
      commitPageDetailMetadataPatch({
        projectId: "project-1",
        pageId: "page-1",
        operationId: "reject-tag-name",
        patch: { tags: ["backend"] },
        dependencies: dependencies({ requests: [], databaseRequests: [] }),
      }),
    ).rejects.toThrow("requires canonical option IDs");
  });

  test("retries the exact v2 request once after a retryable outage", async () => {
    const requests: BlockPropertyMutationRequestV2[] = [];
    const databaseRequests: DatabaseApplyV2[] = [];
    const result = await commitPageDetailMetadataPatch({
      projectId: "project-1",
      pageId: "page-1",
      operationId: "retry-priority",
      patch: { priority: "p1-high" },
      dependencies: dependencies({
        requests,
        databaseRequests,
        databaseResults: [
          {
            ok: false,
            error: {
              code: "unknown",
              message: "worker unavailable",
              retryable: true,
              operationId: "retry-priority",
            },
          },
        ],
      }),
    });

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(requests).toHaveLength(0);
    expect(databaseRequests).toHaveLength(2);
    expect(databaseRequests[1]).toEqual(databaseRequests[0]);
  });
});
