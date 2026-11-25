import { describe, expect, test } from "vite-plus/test";
import {
  allocateBlockOwnershipCopyIdentities,
  planBlockOwnershipClosure,
  type BlockOwnershipGraphReader,
  type OwnershipClosureBlock,
  type OwnershipClosureDocument,
} from "./block-ownership-copy-plan";
import { isUuidV7 } from "./uuid-v7";
import { PAGE_DOCUMENT_SCHEMA_VERSION, plainTextToPortableRichText } from "./block-documents";
import { bindBlockTransferIntent, bindBlockTransferUndoIntent } from "./block-transfer-transport";
import {
  BlockTransferContractError,
  canonicalizeBlockTransferIntent,
  canonicalizeBlockTransferLogicalIntent,
  blockTransferIntentFromRequest,
  parseBlockTransferIntent,
  parseBlockTransferRequest,
  type BlockTransferRequest,
} from "./block-transfer";
import {
  assertPageUpdateExcludesDocumentContent,
  findPageDocumentPatchFields,
} from "./page-content-authority";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "./database-identities";
import {
  PageDetailContractError,
  parseLibraryPageDetailResult,
  parsePageDetailResult,
  type PageDetailResult,
} from "./page-detail";
import { testPropertyManagement, testPropertySemantics } from "./testing/database-property-record";

describe("block ownership copy plan", () => {
  const blocks = new Map<string, OwnershipClosureBlock>([
    ["card-a", { blockId: "card-a", blockType: "page", containingDocumentId: null }],
    [
      "paragraph-a",
      { blockId: "paragraph-a", blockType: "paragraph", containingDocumentId: "document-a" },
    ],
    ["card-b", { blockId: "card-b", blockType: "page", containingDocumentId: "document-a" }],
    ["page-ref", { blockId: "page-ref", blockType: "pageRef", containingDocumentId: "document-a" }],
    [
      "paragraph-b",
      { blockId: "paragraph-b", blockType: "paragraph", containingDocumentId: "document-b" },
    ],
    [
      "template-source",
      {
        blockId: "template-source",
        blockType: "reusable_template_source",
        containingDocumentId: "document-b",
      },
    ],
    [
      "paragraph-template",
      {
        blockId: "paragraph-template",
        blockType: "paragraph",
        containingDocumentId: "document-template",
      },
    ],
    [
      "external-target",
      { blockId: "external-target", blockType: "page", containingDocumentId: null },
    ],
  ]);

  const documents = new Map<string, OwnershipClosureDocument>([
    [
      "card-a",
      {
        documentId: "document-a",
        ownerBlockId: "card-a",
        schemaKey: "nodex.page",
        schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      },
    ],
    [
      "card-b",
      {
        documentId: "document-b",
        ownerBlockId: "card-b",
        schemaKey: "nodex.page",
        schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      },
    ],
    [
      "template-source",
      {
        documentId: "document-template",
        ownerBlockId: "template-source",
        schemaKey: "nodex.reusable-template",
        schemaVersion: 2,
      },
    ],
    [
      "external-target",
      {
        documentId: "document-external",
        ownerBlockId: "external-target",
        schemaKey: "nodex.page",
        schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      },
    ],
  ]);

  const reader: BlockOwnershipGraphReader = {
    readBlock: (blockId) => blocks.get(blockId) ?? null,
    readOwnedDocument: (ownerBlockId) => documents.get(ownerBlockId) ?? null,
    readDocumentBlocks: (documentId) =>
      [...blocks.values()].filter((block) => block.containingDocumentId === documentId),
  };

  describe("Block ownership copy plan", () => {
    test("follows nested owned Documents but never reference targets", () => {
      const closure = planBlockOwnershipClosure(reader, ["card-a"]);
      expect(closure.blocks.map((block) => block.blockId)).toEqual([
        "card-a",
        "paragraph-a",
        "card-b",
        "paragraph-b",
        "template-source",
        "paragraph-template",
        "page-ref",
      ]);
      expect(closure.documents.map((document) => document.documentId)).toEqual([
        "document-a",
        "document-b",
        "document-template",
      ]);
      expect(closure.blocks.some((block) => block.blockId === "external-target")).toBe(false);
    });

    test("allocates UUID-v7 Blocks and retry-stable Document identities", () => {
      const closure = planBlockOwnershipClosure(reader, ["card-a"]);
      const first = allocateBlockOwnershipCopyIdentities("copy-operation", closure);
      const retry = allocateBlockOwnershipCopyIdentities("copy-operation", closure);
      expect(Object.values(first.blockIds).every(isUuidV7)).toBe(true);
      expect(Object.values(retry.blockIds).every(isUuidV7)).toBe(true);
      expect(retry.blockIds).not.toEqual(first.blockIds);
      expect(retry.documentIds).toEqual(first.documentIds);
      expect(new Set(Object.values(first.blockIds)).size).toBe(closure.blocks.length);
      expect(new Set(Object.values(first.documentIds)).size).toBe(closure.documents.length);
      expect(first.blockIds["card-a"]).not.toBe(first.documentIds["document-a"]);
    });
  });
});

describe("block transfer", () => {
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

    test("binds a Library transfer and inverse to exact transport and Store identities", () => {
      const logical = blockTransferIntentFromRequest({ ...request(), projectId: null });
      const { actor: _actor, clientSessionId: _clientSessionId, ...publicIntent } = logical;
      const identity = { clientSessionId: "window-current", actor: { kind: "electron_renderer" } };
      const bound = bindBlockTransferIntent(publicIntent, null, identity);
      expect(bound).toEqual({ ok: true, value: { ...publicIntent, ...identity } });
      expect(bindBlockTransferIntent(publicIntent, "project-1", identity).ok).toBe(false);
      expect(bindBlockTransferIntent(publicIntent, undefined, identity).ok).toBe(false);
      expect(bindBlockTransferIntent({ ...publicIntent, projectId: "" }, null, identity).ok).toBe(
        false,
      );
      const inverse = {
        operationId: "undo-library",
        projectId: null,
        storeEpoch: logical.storeEpoch,
        token: {
          transferOperationId: logical.operationId,
          recipeHash: "a".repeat(64),
          storeEpoch: logical.storeEpoch,
        },
      };
      expect(bindBlockTransferUndoIntent(inverse, null)).toEqual({ ok: true, value: inverse });
      expect(bindBlockTransferUndoIntent({ ...inverse, storeEpoch: "old-epoch" }, null).ok).toBe(
        false,
      );
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
      expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain(
        "expectedHeadSeq",
      );
      expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain("revision");
      expect(canonicalizeBlockTransferLogicalIntent(fencedLogical)).not.toContain("fence-document");
    });

    test("preserves the difference between an omitted group and the empty group", () => {
      for (const choice of [{}, { groupKey: null }]) {
        const placement = {
          ...request(),
          target: {
            kind: "data_source",
            dataSourceId: "data-source-b",
            viewId: "view-b",
            ...choice,
          },
        };
        const parsed = parseBlockTransferRequest(placement);
        const intent = blockTransferIntentFromRequest(parsed);
        expect(parsed.target).toEqual(placement.target);
        expect(intent.target).toEqual({
          kind: "data_source",
          dataSourceId: "data-source-b",
          placement: {
            kind: "direct",
            viewId: "view-b",
            preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
            ...choice,
          },
        });
        expect(parseBlockTransferIntent(intent)).toEqual(intent);
      }
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
            groupKey: "done",
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
});

describe("Page content authority boundary", () => {
  test("accepts relational metadata without classifying it as Document content", () => {
    const patch = {
      priority: "p1-high",
      tags: ["release"],
      dueDate: null,
    };

    assertPageUpdateExcludesDocumentContent(patch);

    expect(findPageDocumentPatchFields(patch).length).toBe(0);
  });

  test("rejects title and body snapshots before a compatibility Page update", () => {
    const fields = findPageDocumentPatchFields({
      title: "stale title",
      description: "stale body",
      priority: "p2-medium",
    });
    let message = "";

    try {
      assertPageUpdateExcludesDocumentContent({ description: "stale body" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(JSON.stringify(fields)).toBe(JSON.stringify(["title", "description"]));
    expect(message.includes("Y.Doc Document mutation")).toBe(true);
    expect(message.includes("generation/head-CAS")).toBe(true);
  });
});

describe("page detail", () => {
  const timestamp = "2026-07-16T00:00:00.000Z";
  const databaseId = parseDatabaseId("019f714b-0000-7000-8000-000000000001");
  const dataSourceId = parseDataSourceId("019f714b-0000-7000-8000-000000000002");
  const viewId = parseDatabaseViewId("019f714b-0000-7000-8000-000000000003");
  const statusPropertyId = parseDataSourcePropertyId("status");

  const memberResult = (): PageDetailResult => ({
    ok: true,
    value: {
      projectId: "project-1",
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 2,
      page: {
        pageId: "page-1",
        libraryId: "library-1",
        parent: { kind: "data_source", dataSourceId },
        lifecycle: "active",
        parentRevision: 1,
        metadataRevision: 1,
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
      intrinsicProperties: [],
      dataSourceContext: {
        kind: "member",
        pageKey: "PROJ-1",
        membership: {
          membershipId: "membership-1",
          dataSourceId,
          revision: 1,
          createdAt: timestamp,
        },
        database: {
          databaseId,
          libraryId: "library-1",
          name: "Database",
          lifecycle: "active",
          defaultViewId: viewId,
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
        properties: [
          {
            propertyId: statusPropertyId,
            dataSourceId,
            name: "Status",
            schema: { kind: "select" },
            capabilities: {
              filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
              sortable: true,
              groupable: true,
            },
            ...testPropertyManagement(),
            valueType: "select",
            config: {},
            optionCount: 1,
            rankKey: "a0",
            lifecycle: "active",
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        pageLayout: {
          dataSourceId,
          revision: 1,
          entries: [{ propertyId: statusPropertyId, rankKey: "a0", visibility: "always_show" }],
        },
        values: {
          status: {
            propertyId: statusPropertyId,
            valueType: "select",
            value: "triage",
            revision: 1,
          },
        },
      },
    },
  });

  describe("Page Detail contract", () => {
    test("accepts Page assignment fields and keeps Owner restricted to a person", () => {
      const result = memberResult();
      if (!result.ok || result.value.dataSourceContext.kind !== "member")
        throw new Error("Member fixture");
      const context = result.value.dataSourceContext;
      const person = { kind: "member", member_id: "person" } as const;
      const agent = { kind: "agent", instance_id: "codex", model: "model", effort: null } as const;
      const detail = {
        ...result.value,
        dataSourceContext: {
          ...context,
          properties: [
            ...context.properties,
            ...(
              [
                ["owner", "page_owner"],
                ["assignee", "page_assignee"],
              ] as const
            ).map(([id, role]) => ({
              ...context.properties[0]!,
              ...testPropertySemantics("assignment"),
              propertyId: parseDataSourcePropertyId(id),
              name: id,
              schema: { kind: "assignment" } as const,
              valueType: "assignment" as const,
              systemRole: role,
            })),
          ],
          values: {
            ...context.values,
            owner: {
              propertyId: parseDataSourcePropertyId("owner"),
              valueType: "assignment" as const,
              value: person,
              revision: 1,
            },
            assignee: {
              propertyId: parseDataSourcePropertyId("assignee"),
              valueType: "assignment" as const,
              value: agent,
              revision: 1,
            },
          },
        },
      };
      expect(parsePageDetailResult({ ok: true, value: detail })).toMatchObject({
        ok: true,
        value: {
          dataSourceContext: { values: { owner: { value: person }, assignee: { value: agent } } },
        },
      });
      expect(() =>
        parsePageDetailResult({
          ok: true,
          value: {
            ...detail,
            dataSourceContext: {
              ...detail.dataSourceContext,
              values: {
                ...detail.dataSourceContext.values,
                owner: { ...detail.dataSourceContext.values.owner, value: agent },
              },
            },
          },
        }),
      ).toThrow("Owner requires a Member");
    });
    test("accepts nullable string and JSON intrinsic values", () => {
      const result = memberResult();
      if (!result.ok) throw new Error("Expected Page Detail fixture");
      const parsed = parsePageDetailResult({
        ...result,
        value: {
          ...result.value,
          intrinsicProperties: [
            { key: "description", valueType: "string", value: null, revision: 1 },
            { key: "metadata", valueType: "json", value: null, revision: 2 },
          ],
        },
      });

      expect(parsed).toMatchObject({
        ok: true,
        value: {
          intrinsicProperties: [
            { key: "description", valueType: "string", value: null },
            { key: "metadata", valueType: "json", value: null },
          ],
        },
      });
    });

    test("accepts one coherent Page → Data Source → Database ownership chain", () => {
      const parsed = parsePageDetailResult(memberResult());
      expect(parsed.ok && parsed.value.page.parent).toEqual({
        kind: "data_source",
        dataSourceId,
      });
    });

    test("parses Library Page Detail without a Project coordinate", () => {
      const result = memberResult();
      if (!result.ok) return;
      const { projectId: _projectId, ...detail } = result.value;
      void _projectId;
      const parsed = parseLibraryPageDetailResult({
        ok: true,
        value: detail,
      });
      expect(parsed).toMatchObject({
        ok: true,
        value: { libraryId: detail.libraryId },
      });
      if (parsed.ok) expect("projectId" in parsed.value).toBe(false);
    });

    test("rejects a membership that differs from the exclusive Page parent", () => {
      const result = structuredClone(memberResult());
      if (!result.ok || result.value.dataSourceContext.kind !== "member") return;
      const mutable = result.value.dataSourceContext.membership as {
        dataSourceId: string;
      };
      mutable.dataSourceId = "019f714b-0000-7000-8000-000000000004";

      expect(() => parsePageDetailResult(result)).toThrow(
        "Page parent and Data Source membership diverge",
      );
    });

    test("rejects a property value whose identity is not in the Source schema", () => {
      const result = structuredClone(memberResult()) as unknown as {
        ok: true;
        value: {
          dataSourceContext: {
            values: Record<string, unknown>;
          };
        };
      };
      result.value.dataSourceContext.values["unknown-property"] = {
        propertyId: "unknown-property",
        valueType: "text",
        value: "leak",
        revision: 1,
      };

      expect(() => parsePageDetailResult(result)).toThrow(PageDetailContractError);
    });
  });
});
