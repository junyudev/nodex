import { describe, expect, test, vi, it, onTestFailed } from "vite-plus/test";
import type { BlockTransferIntent } from "../../shared/block-transfer";
import { createCoreBlockTransferAdapter } from "./block-transfer-adapter";
import { CoreModuleResponseError } from "./core-client";
import { FakeCoreClient, createFakeCoreHandshake } from "./testing/fake-core-client";
import type {
  LibraryApplyResult,
  OwnedDocumentApplyResult,
  CoreClientPort,
  CoreDocumentEventSubscription,
} from "./types";
import {
  materializePortableCanvasScene,
  type DocumentSyncApplyRequest,
  type CanvasSceneMutationRequest,
} from "../../shared/block-documents";
import { DocumentHttpWireError } from "../../shared/block-documents/http-wire";
import { committedLocalCommit } from "../../shared/testing/local-commit";
import {
  createCoreCanvasSceneAdapter as createCoreCanvasSceneAdapterBase,
  createCoreCanvasSceneAdapter,
} from "./core-canvas-scene-adapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it as itdesktopdocumentsyncbridge } from "@effect/vitest";
import type { DocumentSyncClientTarget } from "../document-sync-transport";
import {
  DesktopDocumentSessionRuntime,
  desktopDocumentSessionRuntimeLive,
} from "./desktop-document-sync-bridge";
import type { CoreGenerationClient } from "./core-generation-client";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { live as coreModulesLive } from "../core-runtime/CoreModules";
import { live as documentLiveRuntimeLive } from "../core-runtime/DocumentLiveRuntime";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import * as Y from "yjs";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { NodexYProvider } from "../../renderer/lib/nodex-y-provider";
import { CanvasSceneProvider } from "../../renderer/lib/canvas-scene-provider";
import { MemoryCanvasSceneOutbox } from "../../renderer/lib/canvas-scene-outbox";
import { createBoundedOperationId, isBoundedOperationId } from "../../shared/operation-identity";

describe("block-transfer-adapter", () => {
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
      page_file_entries: [],
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
    test.each([true, false])(
      "preserves Core's complete inverse capability: %s",
      async (symmetric) => {
        const client = new FakeCoreClient();
        const result = committedApply();
        const blockTransfer = {
          ...coreResult(),
          ...(symmetric
            ? {
                history: {
                  recipe_operation_id: "transfer:test",
                  recipe_hash: "a".repeat(64),
                  store_epoch: identity.storeEpoch,
                },
              }
            : {}),
        };
        client.enqueueApply({
          ...result,
          outcome: { ...result.outcome, block_transfer: blockTransfer },
        });
        const committed = await createCoreBlockTransferAdapter({ client, ...identity }).commit(
          intent,
        );
        expect(committed).toMatchObject({
          ok: true,
          value: {
            history: symmetric
              ? {
                  recipeOperationId: "transfer:test",
                  recipeHash: "a".repeat(64),
                  storeEpoch: identity.storeEpoch,
                }
              : null,
          },
        });
      },
    );
    test.each([identity.projectId, null])(
      "commits one logical intent in route %s without a preparation round trip",
      async (projectId) => {
        const client = new FakeCoreClient();
        const adapter = createCoreBlockTransferAdapter({ client, ...identity, projectId });
        client.enqueueApply(committedApply());

        const committed = await adapter.commit({ ...intent, projectId });

        expect(committed).toMatchObject({
          ok: true,
          value: {
            operationId: intent.operationId,
            projectId,
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
      },
    );

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
            preferencesOverride: {
              rulesOverride: {
                sorts: [
                  {
                    field: { kind: "property", propertyId: "priority" },
                    direction: "asc",
                    nulls: "last",
                  },
                ],
              },
              presentationOverride: {},
            },
            groupKey: "done",
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
      };
      client.enqueueApply({
        ...committedApply(),
        outcome: {
          page_file_entries: [],
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
              preferences_override: {
                rules_override: {
                  sorts: [
                    {
                      field: { kind: "property", property_id: "priority" },
                      direction: "asc",
                      nulls: "last",
                    },
                  ],
                },
                presentation_override: {},
              },
              group_key: "done",
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
          page_file_entries: [],
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
            preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
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
              preferences_override: {
                rules_override: {},
                presentation_override: {},
              },
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

    test.each([identity.projectId, null])(
      "submits an opaque Undo token in route %s and maps its inverse",
      async (projectId) => {
        const client = new FakeCoreClient();
        const adapter = createCoreBlockTransferAdapter({ client, ...identity, projectId });
        client.enqueueApply({
          ...committedApply(),
          outcome: {
            page_file_entries: [],
            affected_resource_ids: ["block:root", "page:promoted"],
            page_copy: null,
            block_transfer: null,
            block_transfer_undo: {
              transfer_operation_id: "transfer:test",
              restored_source_root_ids: ["block:root"],
              removed_page_ids: ["page:promoted"],
              document_commits: [],
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
          projectId,
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
            projectId,
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
      },
    );

    test("rejects a mismatched presentation route before contacting Core", async () => {
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

    test("keeps Core implementation errors out of transfer feedback", async () => {
      const client = new FakeCoreClient();
      const adapter = createCoreBlockTransferAdapter({ client, ...identity });
      vi.spyOn(client, "libraryApply").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code: "invalid_input",
          message:
            "document operation InvalidOperation: BlockNote-backed Documents must retain one editable root Block",
          retryable: false,
          recovery: { kind: "none" },
        }),
      );

      await expect(adapter.commit(intent)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "unsupported_transfer",
          message: "These blocks can’t be transferred to that destination.",
        },
      });
    });

    test("preserves typed View-order preparation so Main can retry only that condition eagerly", async () => {
      const client = new FakeCoreClient();
      const adapter = createCoreBlockTransferAdapter({ client, ...identity });
      vi.spyOn(client, "libraryApply").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code: "maintenance_in_progress",
          message: "View order is preparing; retry after preparation completes",
          retryable: true,
          recovery: { kind: "database_view_order_preparation", view_id: "view:target" },
        }),
      );

      await expect(adapter.commit(intent)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "view_order_preparing",
          retryable: true,
        },
      });
    });
  });
});

describe("core-canvas-scene-adapter", () => {
  type CreateCanvasAdapter = (
    client: Parameters<typeof createCoreCanvasSceneAdapterBase>[0],
    binding: Parameters<typeof createCoreCanvasSceneAdapterBase>[1],
  ) => ReturnType<typeof createCoreCanvasSceneAdapterBase>;

  const test = (name: string, run: (createAdapter: CreateCanvasAdapter) => Promise<void>): void =>
    it(name, () => run(createCoreCanvasSceneAdapterBase));

  const PROJECT_ID = "project:canvas";
  const LIBRARY_ID = "library:canvas";
  const ACCESS_CONTEXT = { kind: "project", projectId: PROJECT_ID } as const;
  const BINDING = { libraryId: LIBRARY_ID, routingContext: ACCESS_CONTEXT };
  const DOCUMENT_ID = "document:canvas";
  const CLIENT_SESSION_ID = "renderer:canvas";
  const STORE_EPOCH = "epoch:canvas";
  const SCENE_HASH = "a".repeat(64);
  const COMMITTED_AT = "2026-07-19T00:00:00.000Z";

  class InvalidSnapshotCanvasClient extends FakeCoreClient {
    override documentCanvasSync(): ReturnType<FakeCoreClient["documentCanvasSync"]> {
      throw new DocumentHttpWireError("Canvas snapshot payload is invalid");
    }
  }

  const emptyScene = materializePortableCanvasScene({ elements: [] });

  const syncSnapshot = (syncRequestId: string) => ({
    kind: "snapshot" as const,
    syncRequestId,
    libraryId: LIBRARY_ID,
    routingContext: ACCESS_CONTEXT,
    documentId: DOCUMENT_ID,
    storeEpoch: STORE_EPOCH,
    generation: 1,
    headSeq: 0,
    sceneHash: SCENE_HASH,
    scene: emptyScene,
  });

  const mutationResult = {
    mutationId: "canvas-mutation:one",
    libraryId: LIBRARY_ID,
    routingContext: ACCESS_CONTEXT,
    documentId: DOCUMENT_ID,
    storeEpoch: STORE_EPOCH,
    generation: 1,
    baseHeadSeq: 0,
    headSeq: 1,
    duplicate: false,
    outcome: "committed" as const,
    sceneHash: SCENE_HASH,
    changedElementIds: [],
    appliedAppStateKeys: ["gridModeEnabled"],
    skippedAppStateKeys: [],
    addedFileIds: [],
    removedFileIds: [],
    committedAt: COMMITTED_AT,
    committedDelta: {
      elementUpdates: [],
      appState: { gridModeEnabled: true },
      fileAdditions: {},
      removedFileIds: [],
    },
  };

  const committedMutation = (): OwnedDocumentApplyResult => ({
    status: "committed",
    commit: {
      store_epoch: STORE_EPOCH,
      commit_seq: 1,
      manifest_hash: "f".repeat(64),
    },
    outcome: {
      document_id: DOCUMENT_ID,
      generation: 1,
      head_seq: 1,
      outcome: "committed",
      canvas: mutationResult,
    },
    receipt: {
      operation_id: mutationResult.mutationId,
      duplicate: false,
      document_id: DOCUMENT_ID,
      generation: 1,
      head_seq: 1,
    },
  });

  describe("Core Canvas scene adapter", () => {
    test("classifies an invalid Canvas snapshot as a terminal protocol error", async (createCoreCanvasSceneAdapter) => {
      const client = new InvalidSnapshotCanvasClient();
      const adapter = createCoreCanvasSceneAdapter(client, BINDING);
      const request = {
        syncRequestId: "sync:invalid",
        routingContext: ACCESS_CONTEXT,
        documentId: DOCUMENT_ID,
        clientSessionId: CLIENT_SESSION_ID,
      } as const;
      await expect(adapter.sync(request)).resolves.toEqual({
        ok: false,
        error: {
          code: "canvas_scene_corrupt",
          message: "Canvas snapshot payload is invalid",
          retryable: false,
          resetRequired: false,
        },
      });
    });

    test("syncs and applies Canvas commands", async (createCoreCanvasSceneAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreCanvasSceneAdapter(client, BINDING);
      const subscription = {
        routingContext: ACCESS_CONTEXT,
        documentId: DOCUMENT_ID,
        clientSessionId: CLIENT_SESSION_ID,
      } as const;
      client.enqueueDocumentCanvasSync(syncSnapshot("sync:two"));

      await expect(
        adapter.sync({
          ...subscription,
          syncRequestId: "sync:two",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          libraryId: "library:canvas",
          routingContext: { kind: "project", projectId: PROJECT_ID },
          documentId: DOCUMENT_ID,
          headSeq: 0,
          kind: "snapshot",
          scene: emptyScene,
        },
      });

      client.enqueueDocumentApply(committedMutation());
      await expect(
        adapter.applyMutation({
          ...subscription,
          mutationId: mutationResult.mutationId,
          storeEpoch: STORE_EPOCH,
          generation: 1,
          baseHeadSeq: 0,
          elementCandidates: [],
          appStateIntents: {
            gridModeEnabled: {
              expected: { kind: "absent" },
              value: { kind: "value", value: true },
            },
          },
          fileAdditions: {},
        }),
      ).resolves.toEqual({
        ok: true,
        value: mutationResult,
        localCommit: committedLocalCommit(STORE_EPOCH, 1),
      });
    });

    test("rejects Canvas sync access drift instead of rewriting Core identity", async (createCoreCanvasSceneAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreCanvasSceneAdapter(client, BINDING);
      const subscription = {
        routingContext: ACCESS_CONTEXT,
        documentId: DOCUMENT_ID,
        clientSessionId: CLIENT_SESSION_ID,
      } as const;
      client.enqueueDocumentCanvasSync({
        ...syncSnapshot("sync:granted"),
        routingContext: {
          kind: "project",
          projectId: "project:wrong-authority",
        },
      });

      await expect(
        adapter.sync({
          ...subscription,
          syncRequestId: "sync:granted",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "canvas_scene_corrupt" },
      });

      const physicalMutation = committedMutation();
      client.enqueueDocumentApply({
        ...physicalMutation,
        outcome: {
          ...physicalMutation.outcome,
          canvas: {
            ...mutationResult,
            routingContext: {
              kind: "project",
              projectId: "project:wrong-authority",
            },
          },
        },
      });
      await expect(
        adapter.applyMutation({
          ...subscription,
          mutationId: mutationResult.mutationId,
          storeEpoch: STORE_EPOCH,
          generation: 1,
          baseHeadSeq: 0,
          elementCandidates: [],
          appStateIntents: {},
          fileAdditions: {},
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "canvas_scene_corrupt" },
      });
    });

    test("reads compaction evidence and applies generation rollover", async (createCoreCanvasSceneAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreCanvasSceneAdapter(client, BINDING);
      client.enqueueDocumentRead({
        contract_version: 3,
        store_epoch: STORE_EPOCH,
        commit_head: 3,
        value: {
          kind: "canvas_compaction_eligibility",
          stats: {
            document_id: DOCUMENT_ID,
            generation: 1,
            head_seq: 9,
            scene_hash: SCENE_HASH,
            tombstone_count: 2,
            tombstone_bytes: 200,
            eligible: true,
          },
        },
      });
      const request = {
        mutationId: "canvas-compaction:one",
        routingContext: ACCESS_CONTEXT,
        documentId: DOCUMENT_ID,
        clientSessionId: CLIENT_SESSION_ID,
        trigger: "automatic_idle",
      } as const;
      const eligibility = await adapter.readCompaction(request);
      expect(eligibility).toMatchObject({
        ok: true,
        value: {
          documentId: DOCUMENT_ID,
          generation: 1,
          headSeq: 9,
          tombstoneCount: 2,
        },
      });
      if (!eligibility.ok) throw new Error("expected compaction eligibility");
      const compactionResult = {
        kind: "tombstone_compaction" as const,
        operationId: request.mutationId,
        libraryId: LIBRARY_ID,
        routingContext: ACCESS_CONTEXT,
        documentId: DOCUMENT_ID,
        storeEpoch: STORE_EPOCH,
        previousGeneration: 1,
        previousHeadSeq: 9,
        generation: 2,
        headSeq: 1,
        duplicate: false,
        outcome: "committed" as const,
        sceneHash: "b".repeat(64),
        removedTombstoneCount: 2,
        removedTombstoneBytes: 200,
        checkpointVersionId: "version:before-compaction",
        committedAt: COMMITTED_AT,
      };
      client.enqueueDocumentApply({
        store_epoch: STORE_EPOCH,
        event_sequence: 4,
        value: {
          document_id: DOCUMENT_ID,
          generation: 2,
          head_seq: 1,
          outcome: "committed",
          canvas: compactionResult,
        },
        receipt: {
          operation_id: request.mutationId,
          duplicate: false,
          document_id: DOCUMENT_ID,
          generation: 2,
          head_seq: 1,
        },
      });
      await expect(adapter.compact(request, eligibility.value)).resolves.toEqual({
        ok: true,
        value: compactionResult,
        localCommit: committedLocalCommit(STORE_EPOCH, 4),
      });
      expect(client.documentApplies[0]?.intent).toMatchObject({
        kind: "compact_canvas_tombstones",
        generation: 1,
        expected_head_seq: 9,
      });
    });
  });
});

describe("desktop-document-sync-bridge", () => {
  const it = itdesktopdocumentsyncbridge;
  const subscribeRequest = {
    documentId: "document:one",
    clientSessionId: "renderer:one",
  } as const;

  class FakeTarget implements DocumentSyncClientTarget {
    readonly sent: Array<{ readonly channel: string; readonly payload: unknown }> = [];
    readonly #destroyedListeners: Array<() => void> = [];
    #destroyed = false;

    constructor(readonly id: number) {}

    get destroyedListenerCount(): number {
      return this.#destroyedListeners.length;
    }

    isDestroyed(): boolean {
      return this.#destroyed;
    }

    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, payload: args[0] });
    }

    once(event: "destroyed", listener: () => void): void {
      if (event === "destroyed") this.#destroyedListeners.push(listener);
    }

    removeListener(event: "destroyed", listener: () => void): void {
      if (event !== "destroyed") return;
      const index = this.#destroyedListeners.indexOf(listener);
      if (index >= 0) this.#destroyedListeners.splice(index, 1);
    }
  }

  class ControlledOpeningDocumentStreamClient extends FakeCoreClient {
    openings = 0;
    readonly openingStarted: Promise<void>;
    #resolveOpeningStarted: () => void = () => undefined;

    constructor() {
      super();
      this.openingStarted = new Promise<void>((resolve) => {
        this.#resolveOpeningStarted = resolve;
      });
    }

    override openDocumentEventStream(
      input: Parameters<CoreClientPort["openDocumentEventStream"]>[0],
    ): Promise<CoreDocumentEventSubscription> {
      this.openings += 1;
      this.#resolveOpeningStarted();
      return new Promise<CoreDocumentEventSubscription>((_resolve, reject) => {
        const signal = input.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  }

  class TrackingDocumentStreamClient extends FakeCoreClient {
    activeSubscriptions = 0;

    override async openDocumentEventStream(
      ...args: Parameters<FakeCoreClient["openDocumentEventStream"]>
    ): Promise<CoreDocumentEventSubscription> {
      const subscription = await super.openDocumentEventStream(...args);
      this.activeSubscriptions += 1;
      let closed = false;
      return {
        ...subscription,
        close: () => {
          if (closed) return;
          closed = true;
          this.activeSubscriptions -= 1;
          subscription.close();
        },
      };
    }
  }

  const configureClient = (client: FakeCoreClient): CoreGenerationClient => {
    Object.assign(client, {
      handshake: createFakeCoreHandshake({
        connectionBinding: "binding:test",
        libraryId: "library:test",
        profileId: "profile:test",
        storeEpoch: "epoch:test",
      }),
      forProject: () => client,
    });
    return client as unknown as CoreGenerationClient;
  };

  const authorityFor = (client: CoreGenerationClient): CoreAuthority["Service"] =>
    CoreAuthority.of({
      identity: {
        libraryId: client.handshake.library_id,
        profileId: client.handshake.generation.profile_id,
        storeEpoch: client.handshake.store_epoch,
      },
    } as CoreAuthority["Service"]);

  const acquireSession = Effect.fn("DesktopDocumentSessionRuntime.test.acquire")(function* (
    client: FakeCoreClient,
  ) {
    const scope = yield* Scope.make();
    const generationClient = configureClient(client);
    const authority = authorityFor(generationClient);
    const coreSession = CoreSessionAccess.of({
      use: (operation, run, options) =>
        Effect.tryPromise({
          try: (signal) =>
            run(
              options?.projectId
                ? generationClient.forProject(options.projectId)
                : generationClient,
              signal,
            ),
          catch: (cause) => classifyCoreOperationFailure(operation, cause),
        }),
      handshake: Effect.succeed(generationClient.handshake),
    });
    const coreSessionLayer = Layer.succeed(CoreSessionAccess, coreSession);
    const dependencies = Layer.mergeAll(
      Layer.succeed(CoreAuthority, authority),
      coreSessionLayer,
      coreModulesLive.pipe(Layer.provide(coreSessionLayer)),
      documentLiveRuntimeLive,
    );
    const context = yield* Layer.buildWithScope(
      desktopDocumentSessionRuntimeLive().pipe(Layer.provide(dependencies)),
      scope,
    );
    return {
      scope,
      session: Context.get(context, DesktopDocumentSessionRuntime),
    };
  });

  it.effect("releases an active subscription and its target listener with the owning Scope", () =>
    Effect.gen(function* () {
      const client = new TrackingDocumentStreamClient();
      const { scope, session } = yield* acquireSession(client);
      const target = new FakeTarget(1);

      const subscribed = yield* session.subscribe(
        { kind: "project", projectId: "project:one" },
        target,
        subscribeRequest,
      );
      assert.deepStrictEqual(subscribed, { ok: true, value: { subscribed: true } });
      assert.strictEqual(target.destroyedListenerCount, 1);
      assert.strictEqual(client.activeSubscriptions, 1);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(target.destroyedListenerCount, 0);
      assert.strictEqual(client.activeSubscriptions, 0);

      const closedAdmission = yield* session.subscribe(
        { kind: "project", projectId: "project:one" },
        target,
        subscribeRequest,
      );
      assert.isFalse(closedAdmission.ok);
    }),
  );

  it.effect("admits a Document mutation only behind the exact live session", () =>
    Effect.gen(function* () {
      const client = new TrackingDocumentStreamClient();
      const { scope, session } = yield* acquireSession(client);
      const target = new FakeTarget(3);
      const access = { kind: "project", projectId: "project:one" } as const;
      const request = {
        ...subscribeRequest,
        storeEpoch: "epoch:test",
        generation: 1,
        updateId: "update:one",
        baseHeadSeq: 0,
        touchedBlockIds: [],
        update: new Uint8Array([1]),
      } as const;

      yield* session.subscribe(access, target, subscribeRequest);
      client.enqueueDocumentUpdateApply({
        documentId: request.documentId,
        storeEpoch: request.storeEpoch,
        generation: request.generation,
        updateId: request.updateId,
        committedSeq: 0,
        headSeq: 0,
        stateVector: new Uint8Array(),
        duplicate: false,
        status: "no_op",
        observed: { store_epoch: request.storeEpoch, commit_head: 0 },
      });

      assert.deepStrictEqual(yield* session.applyUpdate(access, target, request), {
        ok: true,
        value: {
          documentId: request.documentId,
          storeEpoch: request.storeEpoch,
          generation: request.generation,
          updateId: request.updateId,
          committedSeq: 0,
          headSeq: 0,
          stateVector: new Uint8Array(),
          duplicate: false,
          status: "no_op",
          observed: { store_epoch: request.storeEpoch, commit_head: 0 },
        },
      });

      yield* session.unsubscribe(access, target, subscribeRequest);
      assert.isFalse((yield* session.applyUpdate(access, target, request)).ok);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("starts a fresh bounded retry episode when preparing a legacy owner", () =>
    Effect.gen(function* () {
      const client = new FakeCoreClient();
      const { scope, session } = yield* acquireSession(client);

      const result = yield* session.prepareOwnedBlockDocument("project:one", "legacy-canvas-owner");

      assert.isFalse(result.ok);
      assert.strictEqual(client.documentApplies.length, 1);
      const applied = client.documentApplies[0];
      assert.deepStrictEqual(applied?.intent, {
        kind: "prepare_owner",
        owner_block_id: "legacy-canvas-owner",
      });
      const [namespace, version, issued, expires, scopeName, entropy] =
        applied?.operationId.split(":") ?? [];
      assert.strictEqual(namespace, "nodexop");
      assert.strictEqual(version, "v1");
      assert.strictEqual(scopeName, "document.prepare-project-owner");
      assert.isAbove(Number(issued), 0);
      assert.strictEqual(Number(expires) - Number(issued), 7 * 24 * 60 * 60 * 1_000);
      assert.isNotEmpty(entropy);
      assert.notInclude(applied?.operationId ?? "", "legacy-canvas-owner");

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("settles a pending reservation and its waiter when the owning Scope closes", () =>
    Effect.gen(function* () {
      const client = new ControlledOpeningDocumentStreamClient();
      const { scope, session } = yield* acquireSession(client);
      const target = new FakeTarget(2);
      const access = { kind: "project", projectId: "project:one" } as const;

      const opening = yield* Effect.forkChild(session.subscribe(access, target, subscribeRequest));
      yield* Effect.promise(() => client.openingStarted);
      const waiting = yield* Effect.forkChild(session.subscribe(access, target, subscribeRequest));
      yield* Effect.yieldNow;
      assert.strictEqual(client.openings, 1);
      assert.strictEqual(target.destroyedListenerCount, 1);

      yield* Scope.close(scope, Exit.void);
      const [openingResult, waitingResult] = yield* Effect.all([
        Fiber.join(opening),
        Fiber.join(waiting),
      ]);
      assert.isFalse(openingResult.ok);
      assert.isFalse(waitingResult.ok);
      assert.strictEqual(target.destroyedListenerCount, 0);
    }),
  );
});

describe("document-operation-window", () => {
  // This historical-storage fixture changes only the cutover clock, while Core is
  // stopped. Content still comes from the authoritative public-operation scenario.
  test.each(["page", "canvas", "checkpoint"] as const)(
    "%s saves and exact retries remain usable after the legacy identity window closes",
    async (kind) => {
      const startedAt = performance.now();
      let phase = "materializing scenario";
      let canvasProvider: CanvasSceneProvider | undefined;
      onTestFailed(() => {
        console.error("Document identity-window test failed", {
          kind,
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
          canvasStatus: canvasProvider?.getStatus(),
        });
      });
      return withCoreScenario(
        { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
        async (scenario) => {
          const { profile, manifest } = scenario;
          phase = "stopping Core for cutover";
          await scenario.withStoppedCore(async () => {
            phase = "rewriting cutover clock";
            const database = new DatabaseSync(path.join(profile.nodexHome, "nodex.db"));
            try {
              database.exec(
                "UPDATE operational_journal_state SET operation_identity_cutover_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE id = 1;",
              );
            } finally {
              database.close();
            }
            phase = "restarting Core after cutover";
          });
          const runtime = scenario.runtime;
          const client = runtime.clientForProject(manifest.projectId);
          const documents = createCoreDocumentSyncAdapter(client);
          // Prove this fixture would reject an unmigrated producer, not just accept
          // a bounded ID inside the fresh-Profile grace period.
          await expect(
            documents.prepareOwner({
              ownerBlockId: manifest.pageIdsByKey.source!,
              operationId: "legacy-prepare",
              clientSessionId: "legacy-session",
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: { core: { code: "legacy_idempotency_unavailable" } },
          });

          if (kind === "checkpoint") {
            const descriptor = await documents.readDescriptor({
              ownerBlockId: manifest.pageIdsByKey.source!,
              clientSessionId: "history",
            });
            const request = {
              operationId: createBoundedOperationId("document.checkpoint"),
              projectId: manifest.projectId,
              storeEpoch: client.handshake.store_epoch,
              documentId: descriptor.documentId,
              expectedGeneration: descriptor.generation,
              expectedHeadSeq: descriptor.headSeq,
              cause: "manual",
              actor: { kind: "test" },
            };
            const first = await documents.createCheckpoint(request);
            expect(first).toMatchObject({ ok: true, value: { duplicate: false } });
            const retried = await documents.createCheckpoint(request);
            expect(retried).toMatchObject({ ok: true, value: { duplicate: true } });
            if (!first.ok || !retried.ok) throw new Error("Checkpoint was rejected");
            expect(retried.value.checkpoint.versionId).toBe(first.value.checkpoint.versionId);
            return;
          }

          const documentId =
            manifest.entityIdsByKey?.[kind === "page" ? "sourceDocument" : "canvasDocumentId"];
          if (!documentId) throw new Error("Document scenario omitted its engine identity");
          const clientSessionId = "long-lived-renderer-session";
          phase = "opening document session";
          const stream = await client.openDocumentEventStream(
            { documentId, clientSessionId },
            () => undefined,
            () => undefined,
            () => undefined,
          );
          try {
            if (kind === "page") {
              const document = new Y.Doc({ guid: documentId });
              const requests: DocumentSyncApplyRequest[] = [];
              const provider = new NodexYProvider({
                documentId,
                document,
                clientSessionId,
                autoConnect: false,
                localCheckpointStore: null,
                adapter: {
                  ...documents,
                  subscribe: () => () => undefined,
                  applyUpdate: async (request) => {
                    requests.push(request);
                    return documents.applyUpdate(request);
                  },
                },
              });
              try {
                await provider.connect();
                document.getText("title").insert(0, "Saved after cutover: ");
                await provider.flush();
                expect(provider.getStatus().phase).toBe("synced");
                expect(requests).toHaveLength(1);
                const request = requests[0]!;
                expect(isBoundedOperationId(request.updateId)).toBe(true);
                await expect(documents.applyUpdate(request)).resolves.toMatchObject({
                  ok: true,
                  value: { duplicate: true },
                });
                const canonical = new Y.Doc();
                try {
                  const synced = await documents.sync({
                    documentId,
                    clientSessionId,
                    stateVector: Y.encodeStateVector(canonical),
                  });
                  if (!synced.ok) throw new Error(synced.error.message);
                  Y.applyUpdate(canonical, synced.value.update);
                  expect(canonical.getText("title").toString()).toBe(
                    document.getText("title").toString(),
                  );
                } finally {
                  canonical.destroy();
                }
              } finally {
                provider.destroy();
                document.destroy();
              }
              return;
            }
            const libraryId = runtime.identity.libraryId;
            const routingContext = { kind: "project", projectId: manifest.projectId } as const;
            const adapter = createCoreCanvasSceneAdapter(client, { libraryId, routingContext });
            const requests: CanvasSceneMutationRequest[] = [];
            const provider = new CanvasSceneProvider({
              libraryId,
              routingContext,
              documentId,
              clientSessionId,
              outbox: new MemoryCanvasSceneOutbox(libraryId),
              onScene: () => undefined,
              adapter: {
                ...adapter,
                subscribe: () => () => undefined,
                applyMutation: async (request) => {
                  requests.push(request);
                  return adapter.applyMutation(request);
                },
              },
            });
            canvasProvider = provider;
            try {
              phase = "connecting Canvas provider";
              await provider.connect();
              phase = "committing Canvas mutation";
              await provider.submit({
                elementCandidates: [
                  {
                    id: "test-element",
                    type: "text",
                    index: "a0",
                    version: 1,
                    versionNonce: 1,
                    isDeleted: false,
                    text: "Saved after cutover",
                  },
                ],
              });
              expect(provider.getStatus().phase).toBe("ready");
              expect(requests).toHaveLength(1);
              expect(isBoundedOperationId(requests[0]!.mutationId)).toBe(true);
              phase = "retrying Canvas mutation identity";
              await expect(adapter.applyMutation(requests[0]!)).resolves.toMatchObject({
                ok: true,
                value: { duplicate: true },
              });
              expect(provider.getScene()?.elements[0]?.text).toBe("Saved after cutover");
            } finally {
              phase = "closing Canvas provider";
              await provider.close();
            }
          } finally {
            phase = "closing document session";
            stream.close();
            phase = "scenario teardown";
          }
        },
      );
    },
  );
});
