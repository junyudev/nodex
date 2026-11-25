import { describe, expect, test, vi } from "vite-plus/test";
import {
  ADDITIONAL_DOCUMENT_COMMAND_CAPABILITIES,
  AdditionalDocumentCommandContractError,
  AdditionalDocumentExecutionProofError,
  MAX_ADDITIONAL_DOCUMENT_BLOCK_DEPTH,
  MAX_ADDITIONAL_DOCUMENT_BLOCKS,
  additionalDocumentCommandRequiredCoordination,
  canonicalizeAdditionalDocumentCommandIntent,
  compileAdditionalDocumentCommandExecution,
  encodeAdditionalDocumentCommandSemanticHashInput,
  isAdditionalDocumentSemanticHash,
  parseAdditionalDocumentCommandReceipt,
  parseAdditionalDocumentCommandRequest,
  parseAdditionalDocumentCommandResult,
} from "./additional-document-commands";
import type { BlockTreeNode } from "./block-documents/block-document-codec";
import { committedLocalCommit } from "./testing/local-commit";
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

describe("additional document commands", () => {
  const host = {
    documentId: "document:host",
    generation: 2,
  } as const;

  const hostHead = { ...host, headSeq: 7 } as const;

  const source = {
    documentId: "document:source",
    generation: 1,
  } as const;

  const sourceHead = { ...source, headSeq: 4 } as const;

  const owner = {
    ownerBlockId: "owner:1",
    metadataRevision: 3,
    locationRevision: 2,
    documentId: "document:owner",
    generation: 1,
  } as const;

  const paragraph = (id: string): BlockTreeNode => ({
    id,
    type: "paragraph",
    props: { textAlignment: "left" },
    content: [{ type: "text", text: id, styles: {} }],
    children: [],
  });

  const fifo = { kind: "fifo_only" } as const;

  const ownerHead = {
    documentId: owner.documentId,
    generation: owner.generation,
    headSeq: 9,
  } as const;

  const lease = (
    documents: readonly {
      readonly documentId: string;
      readonly generation: number;
      readonly headSeq: number;
    }[],
    leaseId = "lease:1",
  ) => ({ kind: "hub_lease" as const, leaseId, documents });

  const request = (operation: unknown, coordination: unknown = fifo) => ({
    operationId: "operation:1",
    projectId: "project:1",
    storeEpoch: "epoch:1",
    clientSessionId: "session:1",
    actor: { kind: "electron", windowId: 7 },
    coordination,
    operation,
  });

  const captureError = (operation: () => unknown): unknown => {
    try {
      operation();
      return null;
    } catch (error) {
      return error;
    }
  };

  const expectContractError = (operation: () => unknown): void => {
    expect(captureError(operation) instanceof AdditionalDocumentCommandContractError).toBe(true);
  };

  describe("additional document command contract", () => {
    test("parses every fixed operation shape and derives its write coordination", () => {
      const cases = [
        request({
          kind: "create_synced_source",
          sourceBlockId: "synced:source",
          documentId: "document:synced",
          initialBlocks: [paragraph("synced:root")],
          placement: {
            kind: "library",
            before: { blockId: "top:anchor", expectedLocationRevision: 5 },
          },
        }),
        request(
          {
            kind: "promote_synced_source",
            host,
            rootBlockId: "host:root",
            referenceBlockId: "synced:reference",
            sourceBlockId: "synced:owner",
            sourceDocumentId: "document:synced",
          },
          lease([hostHead]),
        ),
        request(
          {
            kind: "demote_synced_source",
            host,
            source,
            referenceBlockId: "synced:reference",
            sourceBlockId: "synced:owner",
          },
          lease([sourceHead, hostHead]),
        ),
        request({
          kind: "create_template",
          sourceBlockId: "template:source",
          documentId: "document:template",
          displayName: "Review template",
          initialBlocks: [paragraph("template:root")],
          placement: { kind: "library" },
        }),
        request(
          {
            kind: "instantiate_template",
            sourceBlockId: "template:source",
            source,
            target: host,
            parentBlockId: "host:parent",
            beforeBlockId: "host:before",
          },
          lease([hostHead, sourceHead]),
        ),
        request(
          {
            kind: "delete_owned_source",
            ownerKind: "reusable_template",
            owner,
            referencePolicy: "require_unreferenced",
          },
          lease([ownerHead]),
        ),
      ] as const;

      const kinds = cases.map(
        (candidate) => parseAdditionalDocumentCommandRequest(candidate).operation.kind,
      );
      expect(JSON.stringify(kinds)).toBe(
        JSON.stringify([
          "create_synced_source",
          "promote_synced_source",
          "demote_synced_source",
          "create_template",
          "instantiate_template",
          "delete_owned_source",
        ]),
      );
      expect(additionalDocumentCommandRequiredCoordination(cases[0])).toBe("fifo_only");
      expect(additionalDocumentCommandRequiredCoordination(cases[1])).toBe("hub_lease");
      expect(additionalDocumentCommandRequiredCoordination(cases[5])).toBe("hub_lease");
    });

    test("requires exact logical Documents while allowing renewable Hub heads", () => {
      const operation = {
        kind: "demote_synced_source",
        host,
        source,
        referenceBlockId: "synced:reference",
        sourceBlockId: "synced:source",
      } as const;
      const parsed = parseAdditionalDocumentCommandRequest(
        request(operation, lease([sourceHead, hostHead], "lease:first")),
      );
      expect(parsed.coordination.kind).toBe("hub_lease");
      if (parsed.coordination.kind !== "hub_lease") return;
      expect(parsed.coordination.documents[0]?.documentId).toBe("document:host");
      expect(parsed.coordination.documents[1]?.documentId).toBe("document:source");

      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request(operation, lease([{ ...sourceHead, generation: 2 }, hostHead])),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(request(operation, lease([hostHead]))),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request(operation, lease([hostHead, sourceHead, sourceHead])),
        ),
      );
      expectContractError(() => parseAdditionalDocumentCommandRequest(request(operation, fifo)));
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request(
            {
              kind: "create_template",
              sourceBlockId: "template:source",
              documentId: "document:template",
              displayName: "Template",
              initialBlocks: [],
              placement: { kind: "library" },
            },
            lease([hostHead]),
          ),
        ),
      );
    });

    test("binds logical revisions and anchors while excluding audit and execution heads", () => {
      const operation = {
        kind: "instantiate_template",
        sourceBlockId: "template:source",
        source,
        target: host,
        beforeBlockId: "host:before",
      } as const;
      const first = request(operation, lease([hostHead, sourceHead], "lease:first"));
      const retry = {
        ...first,
        actor: { kind: "http_loopback" },
        clientSessionId: "session:after-restart",
        coordination: lease([sourceHead, hostHead], "lease:renewed"),
      };
      const firstCanonical = canonicalizeAdditionalDocumentCommandIntent(first);
      expect(canonicalizeAdditionalDocumentCommandIntent(retry)).toBe(firstCanonical);
      const receiptReplay = {
        ...retry,
        coordination: { kind: "receipt_replay" },
      } as const;
      expect(canonicalizeAdditionalDocumentCommandIntent(receiptReplay)).toBe(firstCanonical);
      expect(parseAdditionalDocumentCommandRequest(receiptReplay).coordination.kind).toBe(
        "receipt_replay",
      );
      expect(
        new TextDecoder().decode(encodeAdditionalDocumentCommandSemanticHashInput(first)),
      ).toBe(firstCanonical);

      const changedHead = compileAdditionalDocumentCommandExecution(first, {
        leaseId: "lease:after-flush",
        documents: [
          { ...hostHead, headSeq: hostHead.headSeq + 1 },
          { ...sourceHead, headSeq: sourceHead.headSeq + 2 },
        ],
      });
      expect(canonicalizeAdditionalDocumentCommandIntent(changedHead)).toBe(firstCanonical);
      expect(changedHead.coordination.documents[0]?.headSeq).toBe(8);
      const generationChange = captureError(() =>
        compileAdditionalDocumentCommandExecution(first, {
          leaseId: "lease:generation-changed",
          documents: [{ ...hostHead, generation: hostHead.generation + 1 }, sourceHead],
        }),
      );
      expect(generationChange instanceof AdditionalDocumentExecutionProofError).toBe(true);
      if (generationChange instanceof AdditionalDocumentExecutionProofError) {
        expect(generationChange.code).toBe("document_generation_mismatch");
      }
      const changedAnchor = request(
        { ...operation, beforeBlockId: "host:other-before" },
        lease([hostHead, sourceHead], "lease:other-anchor"),
      );
      expect(canonicalizeAdditionalDocumentCommandIntent(changedAnchor) === firstCanonical).toBe(
        false,
      );
      expect(
        canonicalizeAdditionalDocumentCommandIntent({
          ...first,
          operationId: "operation:other",
        }) === firstCanonical,
      ).toBe(false);
    });

    test("enforces exact keys, bounded identities, and stable application Block IDs", () => {
      const validOperation = {
        kind: "create_synced_source",
        sourceBlockId: "synced:source",
        documentId: "document:synced",
        initialBlocks: [paragraph("block:1")],
        placement: { kind: "library" },
      } as const;
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest({
          ...request(validOperation),
          surprise: true,
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(request({ ...validOperation, surprise: true })),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            initialBlocks: [{ ...paragraph("block:1"), surprise: true }],
          }),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            initialBlocks: [paragraph(validOperation.sourceBlockId)],
          }),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            sourceBlockId: "x".repeat(513),
          }),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            initialBlocks: [paragraph("block:duplicate"), paragraph("block:duplicate")],
          }),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            placement: {
              kind: "library",
              before: {
                blockId: validOperation.sourceBlockId,
                expectedLocationRevision: 1,
              },
            },
          }),
        ),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            ...validOperation,
            initialBlocks: [
              {
                ...paragraph("block:bad-json"),
                props: { invalid: Number.NaN },
              },
            ],
          }),
        ),
      );
    });

    test("bounds content by block count, depth, actor, and total shape", () => {
      const tooMany = Array.from({ length: MAX_ADDITIONAL_DOCUMENT_BLOCKS + 1 }, (_, index) =>
        paragraph(`block:${index}`),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            kind: "create_template",
            sourceBlockId: "template:source",
            documentId: "document:template",
            displayName: "Template",
            initialBlocks: tooMany,
            placement: { kind: "library" },
          }),
        ),
      );

      let nested = paragraph(`block:${MAX_ADDITIONAL_DOCUMENT_BLOCK_DEPTH + 1}`);
      for (let depth = MAX_ADDITIONAL_DOCUMENT_BLOCK_DEPTH; depth >= 1; depth -= 1) {
        nested = { ...paragraph(`block:${depth}`), children: [nested] };
      }
      expectContractError(() =>
        parseAdditionalDocumentCommandRequest(
          request({
            kind: "create_synced_source",
            sourceBlockId: "synced:source",
            documentId: "document:synced",
            initialBlocks: [nested],
            placement: { kind: "library" },
          }),
        ),
      );

      expectContractError(() =>
        parseAdditionalDocumentCommandRequest({
          ...request({
            kind: "create_synced_source",
            sourceBlockId: "synced:source",
            documentId: "document:synced",
            initialBlocks: [paragraph("synced:root")],
            placement: { kind: "library" },
          }),
          actor: { evidence: "x".repeat(65 * 1024) },
        }),
      );
    });

    test("records identity rules and exposes every owned-Document lifecycle kernel", () => {
      expect(ADDITIONAL_DOCUMENT_COMMAND_CAPABILITIES.promote_synced_source.identitySemantics).toBe(
        "move_preserving_content_ids_create_source_and_reference_ids",
      );
      expect(ADDITIONAL_DOCUMENT_COMMAND_CAPABILITIES.demote_synced_source.identitySemantics).toBe(
        "move_preserving_content_ids_delete_source_and_reference_ids",
      );
      expect(ADDITIONAL_DOCUMENT_COMMAND_CAPABILITIES.instantiate_template.identitySemantics).toBe(
        "copy_deriving_every_content_id_from_operation_id",
      );
      expect(ADDITIONAL_DOCUMENT_COMMAND_CAPABILITIES.delete_owned_source.availability).toBe(
        "kernel_ready",
      );
    });
  });

  describe("additional document command result contract", () => {
    const receipt = {
      operationId: "operation:1",
      projectId: "project:1",
      storeEpoch: "epoch:1",
      operationKind: "instantiate_template",
      semanticHash: "a".repeat(64),
      duplicate: false,
      effect: {
        createdBlockIds: ["copy:1", "copy:2"],
        preservedBlockIds: ["template:source"],
        deletedBlockIds: [],
        documentHeads: [hostHead, sourceHead],
      },
      commitSeq: 41,
      committedAt: "2026-07-12T00:00:00.000Z",
    } as const;

    test("parses strict successful receipts for implemented kernels", () => {
      const parsed = parseAdditionalDocumentCommandReceipt(receipt);
      expect(parsed.operationKind).toBe("instantiate_template");
      expect(parsed.effect.documentHeads[0]?.documentId).toBe("document:host");
      expect(parsed.effect.documentHeads[1]?.documentId).toBe("document:source");
      const result = parseAdditionalDocumentCommandResult({
        ok: true,
        value: receipt,
        localCommit: committedLocalCommit("epoch:1", 41),
      });
      expect(result.ok).toBe(true);
      expect(isAdditionalDocumentSemanticHash(receipt.semanticHash)).toBe(true);
      expect(isAdditionalDocumentSemanticHash("A".repeat(64))).toBe(false);
    });

    test("rejects retired Canvas-owner receipts and stale capability-gap claims", () => {
      expectContractError(() =>
        parseAdditionalDocumentCommandReceipt({
          ...receipt,
          operationKind: "create_canvas_owner",
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandResult({
          ok: false,
          error: {
            code: "capability_gap",
            message: "stale gap",
            retryable: false,
            operationId: "operation:1",
            operationKind: "create_canvas_owner",
          },
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandResult({
          ok: false,
          error: {
            code: "capability_gap",
            message: "incorrect",
            retryable: true,
            operationId: "operation:1",
            operationKind: "create_canvas_owner",
          },
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandResult({
          ok: false,
          error: {
            code: "capability_gap",
            message: "incorrect",
            retryable: false,
            operationId: "operation:1",
            operationKind: "create_template",
          },
        }),
      );
    });

    test("rejects malformed hashes, unknown keys, and overlapping effect identities", () => {
      expectContractError(() =>
        parseAdditionalDocumentCommandReceipt({
          ...receipt,
          semanticHash: "A".repeat(64),
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandReceipt({ ...receipt, surprise: true }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandReceipt({
          ...receipt,
          committedAt: "not-a-date",
        }),
      );
      expectContractError(() =>
        parseAdditionalDocumentCommandReceipt({
          ...receipt,
          effect: {
            ...receipt.effect,
            deletedBlockIds: ["copy:1"],
          },
        }),
      );
    });
  });
});

describe("page lifecycle v2 runtime", () => {
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
        ] as unknown as NonNullable<
          PageLifecyclePreflightSnapshotV2["value"]["defaultView"]
        >["rows"],
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

  describe("Library Page lifecycle routing", () => {
    const libraryPreflight = (
      lifecycle: "active" | "deleted" = "active",
    ): PageLifecyclePreflightSnapshotV2 => ({
      projectId: null,
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 3,
      value: {
        defaultView: null,
        tagsProperty: null,
        reservedBlockType: null,
        page: authority(lifecycle),
      },
    });

    test("deletes through one immutable Library request after a lost transport response", async () => {
      const requests: PageLifecycleMutationRequestV2[] = [];
      const readBoardProjection = vi.fn(() =>
        Promise.reject(new Error("Library deletion must not select a Project Board")),
      );
      const deletedReceipt = { ...receipt("deleted"), projectId: null };
      const result = await executePageLifecycleIntentV2(
        { kind: "delete", projectId: null, pageId: "page-1", operationId: "operation-1" },
        {
          readPreflight: async (projectId, pageId) => {
            expect([projectId, pageId]).toEqual([null, "page-1"]);
            return { ok: true, value: libraryPreflight() };
          },
          mutate: async (projectId, request) => {
            expect(projectId).toBeNull();
            requests.push(request);
            if (requests.length === 1) throw new Error("Response lost after accepted commit");
            return {
              ok: true,
              value: { ...deletedReceipt, duplicate: true },
              localCommit: {
                status: "no_op",
                observed: { store_epoch: request.storeEpoch, commit_head: 3 },
              },
            };
          },
          readBoardProjection,
        },
      );
      expect(requests).toHaveLength(2);
      expect(readBoardProjection).not.toHaveBeenCalled();
      expect(requests[1]).toBe(requests[0]);
      expect(requests[0]).toMatchObject({
        projectId: null,
        storeEpoch: "epoch-1",
        operation: { kind: "delete_page", expectedMetadataRevision: 7, expectedParentRevision: 9 },
      });
      expect(result).toEqual({
        receipt: { ...deletedReceipt, duplicate: true },
        boardProjection: null,
      });
    });

    test("restores exact delete evidence without inferring a Project destination", () => {
      const restored = compilePageLifecycleRequestV2({
        intent: { kind: "restore", projectId: null, pageId: "page-1", operationId: "restore-1" },
        preflight: libraryPreflight("deleted"),
      });
      expect(restored).toMatchObject({
        projectId: null,
        operation: {
          kind: "restore_page",
          deleteOperationId: "delete-1",
          expectedMetadataRevision: 7,
          expectedParentRevision: 9,
        },
      });
      expect(() =>
        compilePageLifecycleRequestV2({
          intent: {
            kind: "create",
            projectId: "project-1",
            operationId: "create-1",
            pageId: "page-2",
            status: "plan",
            input: { title: "New" },
          },
          preflight: libraryPreflight(),
        }),
      ).toThrow("preflight does not match");
    });
  });
});
