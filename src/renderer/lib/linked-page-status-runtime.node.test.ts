import { describe, expect, test, vi } from "vite-plus/test";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { LibraryPageDetail } from "../../shared/page-detail";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import {
  loadLinkedPageStatusOptions,
  updateLinkedPageStatus,
  type LinkedPageStatusRuntimeDependencies,
} from "./linked-page-status-runtime";

const DATA_SOURCE_ID = parseDataSourceId("source:1");
const STATUS_PROPERTY_ID = parseDataSourcePropertyId("status");

function makeStatusProperty(): DataSourcePropertyRecordV2 {
  return {
    propertyId: STATUS_PROPERTY_ID,
    dataSourceId: DATA_SOURCE_ID,
    name: "Status",
    schema: { kind: "select" },
    capabilities: {
      filterOperators: [],
      sortable: true,
      groupable: true,
    } as unknown as DataSourcePropertyRecordV2["capabilities"],
    systemRole: "status",
    nonEmptyValueCount: 1,
    referencedViewIds: [],
    managementPolicy: {
      canRename: false,
      canReorder: true,
      canChangeType: false,
      canDuplicate: false,
      canDelete: false,
      canRestore: false,
      canPermanentlyDelete: false,
      canManageOptions: true,
      allowedTypes: ["select"],
      blockedReasons: [],
    },
    valueType: "select",
    config: {},
    optionCount: 3,
    rankKey: "a0",
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as DataSourcePropertyRecordV2;
}

function makeMemberDetail(statusValue = "doing", valueRevision = 4): LibraryPageDetail {
  const statusProperty = makeStatusProperty();
  return {
    libraryId: "library:1",
    storeEpoch: "epoch:1",
    commitSeq: 12,
    page: { pageId: "page:1" } as LibraryPageDetail["page"],
    document: { readiness: "ready", schemaKey: "nfm", schemaVersion: 1 },
    intrinsicProperties: [],
    dataSourceContext: {
      kind: "member",
      pageKey: "LAB-1",
      membership: {
        membershipId: "membership:1",
        dataSourceId: DATA_SOURCE_ID,
        revision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      database: { databaseId: "db:1" } as Extract<
        LibraryPageDetail["dataSourceContext"],
        { readonly kind: "member" }
      >["database"],
      dataSource: { dataSourceId: DATA_SOURCE_ID } as Extract<
        LibraryPageDetail["dataSourceContext"],
        { readonly kind: "member" }
      >["dataSource"],
      properties: [statusProperty],
      pageLayout: { dataSourceId: DATA_SOURCE_ID, revision: 1, entries: [] },
      values: {
        status: {
          propertyId: STATUS_PROPERTY_ID,
          valueType: "select",
          value: statusValue,
          revision: valueRevision,
        },
      },
    },
  };
}

function makeDeps(
  overrides: Partial<LinkedPageStatusRuntimeDependencies> = {},
): LinkedPageStatusRuntimeDependencies {
  return {
    readDetail: vi.fn(async () => makeMemberDetail()),
    readOptionWindow: vi.fn(async () => ({
      options: [
        { id: "triage", name: "Triage" },
        { id: "doing", name: "In Progress" },
        { id: "done", name: "Done" },
      ],
      nextCursor: null,
      projectionRevision: 5,
    })),
    commitPropertyEdit: vi.fn(async () => ({ status: "updated" as const, didMutate: true })),
    createOperationId: () => "op-1",
    ...overrides,
  };
}

describe("linked-page-status-runtime", () => {
  test("loads paginated Status options from the Page's Data Source", async () => {
    const readOptionWindow = vi
      .fn<LinkedPageStatusRuntimeDependencies["readOptionWindow"]>()
      .mockResolvedValueOnce({
        options: [{ id: "triage", name: "Triage" }],
        nextCursor: "cursor-1",
        projectionRevision: 5,
      })
      .mockResolvedValueOnce({
        options: [
          { id: "doing", name: "In Progress" },
          { id: "done", name: "Done" },
        ],
        nextCursor: null,
        projectionRevision: 5,
      });

    const options = await loadLinkedPageStatusOptions("page:1", makeDeps({ readOptionWindow }));

    expect(options).toEqual([
      { id: "triage", name: "Triage" },
      { id: "doing", name: "In Progress" },
      { id: "done", name: "Done" },
    ]);
    expect(readOptionWindow).toHaveBeenCalledTimes(2);
    expect(readOptionWindow.mock.calls[0]?.[1]).toBeNull();
    expect(readOptionWindow.mock.calls[1]?.[1]).toBe("cursor-1");
  });

  test("restarts pagination cleanly when projection revision advances mid-read", async () => {
    const readOptionWindow = vi
      .fn<LinkedPageStatusRuntimeDependencies["readOptionWindow"]>()
      .mockResolvedValueOnce({
        options: [{ id: "triage", name: "Triage" }],
        nextCursor: "cursor-1",
        projectionRevision: 5,
      })
      .mockResolvedValueOnce({
        options: [{ id: "done", name: "Done" }],
        nextCursor: null,
        projectionRevision: 6,
      })
      .mockResolvedValueOnce({
        options: [
          { id: "triage", name: "Triage" },
          { id: "done", name: "Done" },
        ],
        nextCursor: null,
        projectionRevision: 6,
      });

    const options = await loadLinkedPageStatusOptions("page:1", makeDeps({ readOptionWindow }));

    expect(options).toEqual([
      { id: "triage", name: "Triage" },
      { id: "done", name: "Done" },
    ]);
    expect(readOptionWindow).toHaveBeenCalledTimes(3);
  });

  test("rejects repeated option pagination cursors", async () => {
    const readOptionWindow = vi
      .fn<LinkedPageStatusRuntimeDependencies["readOptionWindow"]>()
      .mockResolvedValue({
        options: [{ id: "triage", name: "Triage" }],
        nextCursor: "loop-cursor",
        projectionRevision: 5,
      });

    await expect(
      loadLinkedPageStatusOptions("page:1", makeDeps({ readOptionWindow })),
    ).rejects.toThrow("repeated cursor");
  });

  test("commits a Status update with the observed value revision", async () => {
    const commitPropertyEdit = vi.fn<LinkedPageStatusRuntimeDependencies["commitPropertyEdit"]>(
      async () => ({ status: "updated", didMutate: true }),
    );

    const result = await updateLinkedPageStatus(
      { pageId: "page:1", statusOptionId: "done" },
      makeDeps({ readDetail: async () => makeMemberDetail("doing", 9), commitPropertyEdit }),
    );

    expect(result).toEqual({ status: "updated", didMutate: true });
    expect(commitPropertyEdit).toHaveBeenCalledWith({
      pageId: "page:1",
      propertyId: "status",
      operationId: "op-1",
      expectedValueRevision: 9,
      value: "done",
    });
  });

  test("skips committing when the Page already has the requested Status", async () => {
    const commitPropertyEdit = vi.fn<LinkedPageStatusRuntimeDependencies["commitPropertyEdit"]>();

    const result = await updateLinkedPageStatus(
      { pageId: "page:1", statusOptionId: "doing" },
      makeDeps({ commitPropertyEdit }),
    );

    expect(result).toEqual({ status: "updated", didMutate: false });
    expect(commitPropertyEdit).not.toHaveBeenCalled();
  });

  test("returns not_found when the Page detail is absent", async () => {
    const result = await updateLinkedPageStatus(
      { pageId: "page:missing", statusOptionId: "done" },
      makeDeps({ readDetail: async () => null }),
    );
    expect(result).toEqual({ status: "not_found" });
  });
});
