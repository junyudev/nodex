import { describe, expect, test } from "vite-plus/test";

import { type BlockTransferIntent } from "../../shared/block-transfer";
import { createCoreBlockTransferAdapter } from "./block-transfer-adapter";
import { FakeCoreClient } from "./testing/fake-core-client";
import type { LibraryApplyResult } from "./types";

const identity = {
  libraryId: "library:test",
  projectId: "project:test",
  storeEpoch: "epoch:test",
} as const;

const intent: BlockTransferIntent = {
  operationId: "transfer:test",
  projectId: identity.projectId,
  storeEpoch: identity.storeEpoch,
  clientSessionId: "renderer:test",
  actor: { kind: "electron_renderer", clientId: "renderer:test" },
  mode: "move",
  rootBlockIds: ["block:root"],
  causalDependencies: [],
  source: { kind: "page", pageId: "page:source" },
  target: {
    kind: "page",
    pageId: "page:target",
    parentBlockId: "block:parent",
    beforeBlockId: "block:before",
  },
  promotionPolicy: "literal",
};

const coreResult = () => ({
  mode: "move" as const,
  source_root_block_ids: ["block:root"],
  result_root_block_ids: ["block:root"],
  copied_block_ids: {},
  transformation_evidence: [],
  final_locations: {
    "block:root": { kind: "document" as const, document_id: "document:target" },
  },
  final_location_revisions: { "block:root": 2 },
  document_commits: [
    {
      document_id: "document:source",
      generation: 1,
      base_head_seq: 3,
      head_seq: 4,
      update_id: "update:source",
      update: [1, 2, 3],
      state_vector: [4, 5],
    },
    {
      document_id: "document:target",
      generation: 2,
      base_head_seq: 7,
      head_seq: 8,
      update_id: "update:target",
      update: [6, 7],
      state_vector: [8, 9],
    },
  ],
  affected_database_ids: [],
  file_ownership_moves: [],
  page_keys: {},
  page_etags: {},
  move_etags: {},
  page_view_placements: {},
  undo_token: {
    transfer_operation_id: "transfer:test",
    recipe_hash: "a".repeat(64),
    store_epoch: identity.storeEpoch,
  },
});

const committedApply = (
  overrides: Partial<LibraryApplyResult["receipt"]> = {},
): LibraryApplyResult => ({
  status: "committed",
  outcome: {
    affected_resource_ids: ["block:root"],
    page_copy: null,
    block_transfer: coreResult(),
  },
  receipt: {
    operation_id: intent.operationId,
    duplicate: false,
    operation_kind: "transfer_blocks",
    did_mutate: true,
    created_target: null,
    affected_parent_keys: [],
    affected_page_ids: [],
    affected_database_ids: [],
    affected_view_ids: [],
    committed_revisions: { "block:root": 2 },
    commit_seq: 11,
    committed_at: "2026-07-19T19:00:00.000Z",
    ...overrides,
  },
  commit: {
    commit_seq: 11,
    store_epoch: identity.storeEpoch,
    manifest_hash: "f".repeat(64),
  },
});

describe("Core Block Transfer Adapter", () => {
  test("commits one logical intent without a client-visible preparation round trip", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    client.enqueueApply(committedApply());

    const committed = await adapter.commit(intent);

    expect(committed).toMatchObject({
      ok: true,
      value: {
        operationId: intent.operationId,
        commitSeq: 11,
        documentCommits: [
          { documentId: "document:source", headSeq: 4 },
          { documentId: "document:target", headSeq: 8 },
        ],
      },
    });
    expect(client.reads).toHaveLength(0);
    expect(client.applies).toHaveLength(1);
    expect(client.applies[0]?.intent).toMatchObject({
      kind: "transfer_blocks",
      intent: { root_block_ids: ["block:root"] },
    });
  });

  test("maps Core transformation and Data Source placement evidence", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    const dataSourceIntent: BlockTransferIntent = {
      ...intent,
      operationId: "transfer:data-source",
      mode: "copy",
      target: {
        kind: "data_source",
        dataSourceId: "source:target",
        placement: {
          kind: "direct",
          viewId: "view:target",
          presentationOverride: {
            layout: "board",
            sort: [
              {
                field: { kind: "property", propertyId: "priority" },
                direction: "asc",
                nulls: "last",
              },
            ],
          },
          groupKey: "ship",
          sortedPropertyValues: [
            {
              propertyId: "priority",
              value: "p3-low",
            },
          ],
        },
      },
    };
    const dataSourceResult = {
      ...coreResult(),
      mode: "copy" as const,
      result_root_block_ids: ["page:wrapper"],
      copied_block_ids: { "block:root": "block:copy" },
      transformation_evidence: [
        {
          sourceBlockId: "block:root",
          resultPageId: "page:wrapper",
          kind: "wrap" as const,
          sourceBlockType: "checkListItem",
          semanticTitleHash: "b".repeat(64),
          consumedPropertyKeys: [],
          wrapperReason: "type_requires_wrapper" as const,
          bodyRootBlockIds: ["block:copy"],
          sourceToResultBlockIds: { "block:root": "block:copy" },
          promotion: { kind: "not_requested" as const },
        },
      ],
      final_locations: {
        "page:wrapper": {
          kind: "data_source" as const,
          database_id: "database:target",
          data_source_id: "source:target",
        },
      },
      final_location_revisions: { "page:wrapper": 2 },
      affected_database_ids: ["database:target"],
      file_ownership_moves: [],
    };
    client.enqueueApply({
      ...committedApply(),
      outcome: {
        affected_resource_ids: ["page:wrapper", "database:target"],
        page_copy: null,
        block_transfer: dataSourceResult,
      },
      receipt: {
        ...committedApply().receipt,
        operation_id: dataSourceIntent.operationId,
        affected_database_ids: ["database:target"],
      },
    });

    const committed = await adapter.commit(dataSourceIntent);

    expect(committed).toMatchObject({
      ok: true,
      value: {
        operationId: dataSourceIntent.operationId,
        finalLocations: {
          "page:wrapper": {
            kind: "data_source",
            databaseBlockId: "database:target",
            dataSourceId: "source:target",
          },
        },
        affectedDatabaseBlockIds: ["database:target"],
        transformationEvidence: [
          {
            resultPageId: "page:wrapper",
            kind: "wrap",
            wrapperReason: "type_requires_wrapper",
          },
        ],
      },
    });
    expect(client.applies[0]?.intent).toMatchObject({
      intent: {
        target: {
          kind: "data_source",
          data_source_id: "source:target",
          placement: {
            kind: "direct",
            view_id: "view:target",
            presentation_override: {
              layout: "board",
              sort: [
                {
                  field: { kind: "property", property_id: "priority" },
                  direction: "asc",
                  nulls: "last",
                },
              ],
            },
            group_key: "ship",
            sorted_property_values: [
              {
                property_id: "priority",
                value: "p3-low",
              },
            ],
          },
        },
      },
    });
  });

  test("fails closed when Core returns an unsupported shorthand grammar version", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    client.enqueueApply({
      ...committedApply(),
      outcome: {
        affected_resource_ids: ["page:promoted"],
        page_copy: null,
        block_transfer: {
          ...coreResult(),
          result_root_block_ids: ["page:promoted"],
          transformation_evidence: [
            {
              sourceBlockId: "block:root",
              resultPageId: "page:promoted",
              kind: "promote",
              sourceBlockType: "paragraph",
              semanticTitleHash: "b".repeat(64),
              consumedPropertyKeys: [],
              bodyRootBlockIds: [],
              sourceToResultBlockIds: { "block:root": "page:promoted" },
              promotion: {
                kind: "preserved",
                grammar_version: 2,
                reason: "malformed_shorthand",
              },
            },
          ],
        },
      },
    } as unknown as LibraryApplyResult);

    await expect(adapter.commit(intent)).resolves.toMatchObject({
      ok: false,
      error: {
        message: "Core returned unsupported task shorthand grammar v2",
      },
    });
  });

  test("preserves a raw List occurrence and exact projection for Core", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    client.enqueueApply(committedApply());
    await adapter.commit({
      ...intent,
      target: {
        kind: "data_source",
        dataSourceId: "source:target",
        placement: {
          kind: "list_occurrence",
          viewId: "view:target",
          presentationOverride: { layout: "list" },
          expectedProjection: {
            scopeKey: "list:view:target",
            schemaVersion: 2,
            revision: 7,
            coveredCommitSeq: 11,
            effectHash: "effect",
          },
          target: {
            kind: "page",
            occurrenceKey: "occurrence:target",
            edge: "before",
          },
        },
      },
    });

    expect(client.applies[0]?.intent).toMatchObject({
      intent: {
        target: {
          kind: "data_source",
          placement: {
            kind: "list_occurrence",
            view_id: "view:target",
            presentation_override: { layout: "list" },
            expected_projection: {
              scope_key: "list:view:target",
              schema_version: 2,
              revision: 7,
              covered_commit_seq: 11,
              effect_hash: "effect",
            },
            target: {
              kind: "page",
              occurrence_key: "occurrence:target",
              edge: "before",
            },
          },
        },
      },
    });
  });

  test("lets Core resolve an idempotent replay through the same apply command", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    client.enqueueApply(committedApply({ duplicate: true }));

    await expect(adapter.commit(intent)).resolves.toMatchObject({
      ok: true,
      value: {
        operationId: intent.operationId,
        duplicate: true,
        commitSeq: 11,
      },
    });
    expect(client.reads).toHaveLength(0);
    expect(client.applies).toHaveLength(1);
  });

  test("submits an opaque Undo token and maps the authoritative inverse receipt", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });
    client.enqueueApply({
      ...committedApply(),
      outcome: {
        affected_resource_ids: ["block:root", "page:promoted"],
        page_copy: null,
        block_transfer: null,
        block_transfer_undo: {
          transfer_operation_id: "transfer:test",
          restored_source_root_ids: ["block:root"],
          removed_page_ids: ["page:promoted"],
          document_commits: [],
          file_ownership_moves: [],
        },
      },
      receipt: {
        ...committedApply().receipt,
        operation_id: "undo:test",
        operation_kind: "undo_block_transfer",
      },
    });

    const result = await adapter.undo({
      operationId: "undo:test",
      projectId: identity.projectId,
      storeEpoch: identity.storeEpoch,
      token: {
        transferOperationId: "transfer:test",
        recipeHash: "a".repeat(64),
        storeEpoch: identity.storeEpoch,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        transferOperationId: "transfer:test",
        restoredSourceRootIds: ["block:root"],
        removedPageIds: ["page:promoted"],
      },
    });
    expect(client.applies[0]?.intent).toEqual({
      kind: "undo_block_transfer",
      token: {
        transfer_operation_id: "transfer:test",
        recipe_hash: "a".repeat(64),
        store_epoch: identity.storeEpoch,
      },
    });
  });

  test("rejects a cross-project intent before contacting Core", async () => {
    const client = new FakeCoreClient();
    const adapter = createCoreBlockTransferAdapter({ client, ...identity });

    await expect(
      adapter.commit({
        ...intent,
        projectId: "project:other",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_transfer_request" },
    });
    expect(client.applies).toHaveLength(0);
  });
});
