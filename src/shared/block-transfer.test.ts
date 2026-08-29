import { describe, expect, test } from "vite-plus/test";
import {
  BlockTransferContractError,
  canonicalizeBlockTransferIntent,
  canonicalizeBlockTransferLogicalIntent,
  blockTransferIntentFromRequest,
  parseBlockTransferIntent,
  parseBlockTransferRequest,
  type BlockTransferRequest,
} from "./block-transfer";

const request = (): BlockTransferRequest => ({
  operationId: "transfer-1",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  clientSessionId: "window-1",
  actor: { kind: "test", nested: { b: 2, a: 1 } },
  mode: "move",
  rootBlockIds: ["card-1"],
  expectedLocationRevisions: { "card-1": 3 },
  source: {
    kind: "data_source",
    dataSourceId: "data-source-a",
    memberships: {
      "card-1": { membershipId: "membership-a", revision: 4 },
    },
  },
  target: {
    kind: "document",
    documentId: "document-b",
    generation: 1,
    expectedHeadSeq: 8,
    beforeBlockId: "paragraph-b",
  },
});

describe("BlockTransfer contract", () => {
  test("round-trips an exclusive Database-to-Document parent move", () => {
    expect(parseBlockTransferRequest(request())).toEqual(request());
  });

  test("excludes transport attempt identity from canonical intent", () => {
    const first = request();
    const second = { ...first, clientSessionId: "window-after-reconnect" };
    expect(canonicalizeBlockTransferIntent(first)).toBe(canonicalizeBlockTransferIntent(second));
  });

  test("keeps freshness evidence out of the public logical intent", () => {
    const logical = blockTransferIntentFromRequest(request());
    const fencedLogical = {
      ...logical,
      causalDependencies: [
        {
          documentId: "fence-document",
          generation: 1,
          expectedHeadSeq: 8,
        },
      ],
    };
    expect(parseBlockTransferIntent(fencedLogical)).toEqual(fencedLogical);
    expect(logical.source).toEqual({
      kind: "data_source",
      dataSourceId: "data-source-a",
    });
    expect(logical.target).toEqual({
      kind: "document",
      documentId: "document-b",
      beforeBlockId: "paragraph-b",
    });
    expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain("expectedHeadSeq");
    expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain("revision");
    expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain("fence-document");
  });

  test("preserves bounded sorted Property inference for a direct View placement", () => {
    const logical = blockTransferIntentFromRequest(request());
    const inferred = {
      ...logical,
      target: {
        kind: "data_source" as const,
        dataSourceId: "data-source-b",
        placement: {
          kind: "direct" as const,
          viewId: "view-b",
          preferencesOverride: {
            rulesOverride: {
              sorts: [
                {
                  field: { kind: "property" as const, propertyId: "priority" },
                  direction: "asc" as const,
                  nulls: "last" as const,
                },
              ],
            },
            presentationOverride: {},
          },
          groupKey: "ship",
          beforePageId: "card-2",
          sortedPropertyValues: [{ propertyId: "priority", value: "p3-low" }],
        },
      },
    };
    expect(parseBlockTransferIntent(inferred)).toEqual(inferred);
    expect(() =>
      parseBlockTransferIntent({
        ...inferred,
        target: {
          ...inferred.target,
          placement: {
            ...inferred.target.placement,
            sortedPropertyValues: [
              { propertyId: "priority", value: "p3-low" },
              { propertyId: "priority", value: "p2-medium" },
            ],
          },
        },
      }),
    ).toThrow(/cannot repeat a Property/);
  });

  test("rejects incomplete revision evidence and same-parent reorder seams", () => {
    expect(() =>
      parseBlockTransferRequest({
        ...request(),
        expectedLocationRevisions: {},
      }),
    ).toThrow(BlockTransferContractError);
    expect(() =>
      parseBlockTransferRequest({
        ...request(),
        source: {
          kind: "document",
          documentId: "document-b",
          generation: 1,
          expectedHeadSeq: 8,
        },
      }),
    ).toThrow(/reorder within one Document/);
    expect(() =>
      parseBlockTransferRequest({
        ...request(),
        source: {
          kind: "data_source",
          dataSourceId: "data-source-b",
          memberships: {
            "card-1": { membershipId: "membership-b", revision: 1 },
          },
        },
        target: {
          kind: "data_source",
          dataSourceId: "data-source-b",
          viewId: "view-b",
          groupKey: null,
        },
      }),
    ).toThrow(/reorder within one Data Source/);
  });

  test("allows a parent move between Data Sources", () => {
    expect(
      parseBlockTransferRequest({
        ...request(),
        target: {
          kind: "data_source",
          dataSourceId: "data-source-b",
          viewId: "view-b",
          groupKey: "plan",
        },
      }).target,
    ).toMatchObject({ dataSourceId: "data-source-b" });
  });

  test("rejects transferred roots as target anchors", () => {
    expect(() =>
      parseBlockTransferRequest({
        ...request(),
        target: {
          kind: "library",
          libraryId: "library-a",
          beforeBlockId: "card-1",
        },
      }),
    ).toThrow(/cannot be a transferred root/);
  });

  test("allows Copy into the same parent because it creates fresh identity", () => {
    expect(
      parseBlockTransferRequest({
        ...request(),
        mode: "copy",
        target: {
          kind: "data_source",
          dataSourceId: "data-source-a",
          viewId: "view-a",
          groupKey: null,
        },
      }).mode,
    ).toBe("copy");
  });

  test("round-trips an exact List occurrence placement", () => {
    const logical = blockTransferIntentFromRequest({
      ...request(),
      mode: "copy",
      target: {
        kind: "data_source",
        dataSourceId: "data-source-b",
        viewId: "view-b",
        groupKey: null,
      },
    });
    const listIntent = {
      ...logical,
      target: {
        kind: "data_source" as const,
        dataSourceId: "data-source-b",
        placement: {
          kind: "list_occurrence" as const,
          viewId: "view-b",
          preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
          expectedProjection: {
            scopeKey: "list:view-b",
            schemaVersion: 2,
            revision: 4,
            coveredCommitSeq: 9,
            effectHash: null,
          },
          target: { kind: "root" as const },
        },
      },
    };
    expect(parseBlockTransferIntent(listIntent)).toEqual(listIntent);
  });
});
