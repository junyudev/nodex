import { describe, expect, it, vi, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { committedLocalCommit } from "../../shared/testing/local-commit";
import { CoreModuleResponseError } from "./core-client";
import { createCoreDocumentSyncAdapter as createCoreDocumentSyncAdapterBase } from "./document-sync-adapter";
import { FakeCoreClient, createFakeCoreHandshake } from "./testing/fake-core-client";
import { it as itdesktopdocumentsyncrecovery } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Y from "yjs";
import { createPageDocument } from "../../shared/block-documents/page-document";
import type {
  DocumentSyncRealtimeEvent,
  DocumentSyncResponse,
} from "../../shared/block-documents/document-sync";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import { NodexYProvider } from "../../renderer/lib/nodex-y-provider";
import { CoreEventCompatibilityError } from "./local-http";
import { makeDesktopDocumentSessionHarness } from "./testing/desktop-document-session-harness.test-support";
import type { CoreGenerationClient } from "./core-generation-client";
import {
  CANVAS_PRESENCE_TTL_MS,
  type CanvasPresenceRealtimeEvent,
} from "../../shared/block-documents/document-presence";
import { createCanvasPresenceHub, type CanvasPresenceHubBinding } from "../canvas-presence-hub";

describe("document-sync-adapter", () => {
  type CreateDocumentAdapter = (
    client: Parameters<typeof createCoreDocumentSyncAdapterBase>[0],
  ) => ReturnType<typeof createCoreDocumentSyncAdapterBase>;

  const test = (name: string, run: (createAdapter: CreateDocumentAdapter) => Promise<void>): void =>
    it(name, () => run(createCoreDocumentSyncAdapterBase));

  const descriptorSnapshot = () => ({
    contract_version: 1 as const,
    store_epoch: "epoch:test",
    commit_head: 4,
    value: {
      kind: "descriptor" as const,
      descriptor: {
        version: 4,
        libraryId: "library:test",
        routingContext: { kind: "project" as const, projectId: "project:one" },
        ownerBlockId: "page:one",
        ownerType: "page",
        ownerLifecycle: "active" as const,
        documentId: "document:one",
        storeEpoch: "epoch:test",
        generation: 1,
        headSeq: 2,
        schemaKey: "nodex.page",
        schemaVersion: 1,
        readiness: "ready" as const,
        sync: { kind: "yjs" as const, stateVector: [] },
      },
    },
  });

  const documentVersionSummary = () => ({
    versionId: `document-version:${"a".repeat(64)}`,
    documentId: "document:one",
    projectId: "project:one",
    generation: 1,
    baseHeadSeq: 2,
    schemaKey: "nodex.page",
    schemaVersion: 1,
    cause: "manual",
    label: "Before refactor",
    actor: { kind: "electron_renderer", clientId: "renderer:history" },
    revisionKind: "manual",
    sourceMutationId: null,
    sourceChangeSeq: null,
    pinned: true,
    checkpointHash: "b".repeat(64),
    materializationHash: "c".repeat(64),
    byteLength: 128,
    materializationKind: "page",
    title: "History",
    preview: "Checkpoint preview",
    blockCount: 1,
    createdAt: "2026-07-19T21:10:00.000Z",
    fileSnapshotStatus: "exact",
    checkpointMetadata: { format: "block_tree_snapshot_v3" },
  });

  const documentVersionDetail = () => ({
    summary: documentVersionSummary(),
    materialization: {
      kind: "page",
      schemaVersion: 1,
      title: "History",
      richTitle: [{ type: "text", text: "History", styles: {} }],
      blockTree: [
        {
          id: "block:history",
          type: "paragraph",
          props: {},
          content: [],
          children: [],
        },
      ],
      markdown: "Checkpoint preview",
      plainText: "Checkpoint preview",
      preview: "Checkpoint preview",
      references: [],
      assetRefs: [],
    },
  });

  describe("Core Document sync adapter", () => {
    test("reads and prepares an exact Owned Document descriptor", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      client.enqueueDocumentRead(descriptorSnapshot());

      await expect(
        adapter.readDescriptor({
          ownerBlockId: "page:one",
          clientSessionId: "renderer:descriptor",
        }),
      ).resolves.toMatchObject({
        libraryId: "library:test",
        routingContext: { kind: "project", projectId: "project:one" },
        ownerBlockId: "page:one",
        documentId: "document:one",
        headSeq: 2,
      });

      client.enqueueDocumentApply({
        store_epoch: "epoch:test",
        event_sequence: 4,
        value: {
          document_id: "document:one",
          generation: 1,
          head_seq: 2,
          outcome: "no_change",
        },
        receipt: {
          operation_id: "prepare:one",
          duplicate: false,
          document_id: "document:one",
          generation: 1,
          head_seq: 2,
        },
      });
      client.enqueueDocumentRead(descriptorSnapshot());
      await expect(
        adapter.prepareOwner({
          ownerBlockId: "page:one",
          operationId: "prepare:one",
          clientSessionId: "renderer:prepare",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          libraryId: "library:test",
          routingContext: { kind: "project", projectId: "project:one" },
          ownerBlockId: "page:one",
          documentId: "document:one",
        },
      });
      expect(client.documentApplies).toEqual([
        {
          operationId: "prepare:one",
          clientSessionId: "renderer:prepare",
          intent: { kind: "prepare_owner", owner_block_id: "page:one" },
        },
      ]);
    });

    test("fetches one exact verified Document update resource", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const update = Uint8Array.from([1, 2, 3, 4]);
      const updateHash = createHash("sha256").update(update).digest("hex");
      client.enqueueDocumentRead({
        contract_version: 5,
        store_epoch: "epoch:test",
        commit_head: 9,
        value: {
          kind: "update_resource",
          resource: {
            document_id: "document:one",
            generation: 1,
            base_head_seq: 4,
            head_seq: 5,
            update_id: "update:one",
            update_hash: updateHash,
            update_byte_length: update.byteLength,
            update: [...update],
          },
        },
      });

      const request = {
        documentId: "document:one",
        generation: 1,
        updateId: "update:one",
        updateHash,
        clientSessionId: "renderer:resource",
      } as const;
      const firstFetch = adapter.fetchUpdateResource(request);
      const coalescedFetch = adapter.fetchUpdateResource({
        ...request,
        clientSessionId: "renderer:second-surface",
      });
      expect(coalescedFetch).toBe(firstFetch);
      await expect(firstFetch).resolves.toEqual({
        ok: true,
        value: {
          kind: "available",
          documentId: "document:one",
          generation: 1,
          baseHeadSeq: 4,
          headSeq: 5,
          updateId: "update:one",
          updateHash,
          updateByteLength: update.byteLength,
          update,
        },
      });
      expect(client.documentReads).toEqual([
        {
          clientSessionId: "renderer:resource",
          read: {
            kind: "fetch_update",
            document_id: "document:one",
            generation: 1,
            update_id: "update:one",
            update_hash: updateHash,
          },
        },
      ]);
    });

    test("fails closed when exact Document update bytes do not match their ref", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const updateHash = createHash("sha256")
        .update(Uint8Array.from([1, 2, 3]))
        .digest("hex");
      client.enqueueDocumentRead({
        contract_version: 5,
        store_epoch: "epoch:test",
        commit_head: 9,
        value: {
          kind: "update_resource",
          resource: {
            document_id: "document:one",
            generation: 1,
            base_head_seq: 4,
            head_seq: 5,
            update_id: "update:one",
            update_hash: updateHash,
            update_byte_length: 3,
            update: [9, 9, 9],
          },
        },
      });

      await expect(
        adapter.fetchUpdateResource({
          documentId: "document:one",
          generation: 1,
          updateId: "update:one",
          updateHash,
          clientSessionId: "renderer:resource",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "invalid_response",
          retryable: false,
          resetRequired: true,
        },
      });
    });

    test("maps a rejected generic typed-owner mutation to a canonical repair", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      vi.spyOn(client, "documentApplyUpdate").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code: "protected_owner_deletion",
          message: "Typed owner Page cannot contain child Blocks",
          retryable: false,
          recovery: { kind: "none" },
        }),
      );

      await expect(
        adapter.applyUpdate({
          documentId: "document:owner-guard",
          clientSessionId: "renderer:owner-guard",
          storeEpoch: "epoch:test",
          generation: 1,
          updateId: "update:owner-guard",
          baseHeadSeq: 4,
          touchedBlockIds: ["page:nested"],
          update: new Uint8Array([1]),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "protected_owner_mutation",
          retryable: false,
          resetRequired: true,
        },
      });
    });

    test("maps Additional Document owner commands and durable receipts", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      client.enqueueDocumentApply({
        store_epoch: "epoch:test",
        event_sequence: 12,
        value: {
          document_id: "document:source",
          generation: 1,
          head_seq: 1,
          outcome: "committed",
          committed_at: "2026-07-19T21:00:00.000Z",
          owner_effect: {
            created_block_ids: ["block:source", "block:content"],
            preserved_block_ids: [],
            deleted_block_ids: [],
            document_heads: [
              {
                document_id: "document:source",
                generation: 1,
                head_seq: 1,
              },
            ],
          },
        },
        receipt: {
          operation_id: "owner:create",
          duplicate: false,
          document_id: "document:source",
          generation: 1,
          head_seq: 1,
        },
      });

      const result = await adapter.applyAdditionalDocumentCommand({
        operationId: "owner:create",
        projectId: "project:one",
        storeEpoch: "epoch:test",
        clientSessionId: "renderer:one",
        actor: { kind: "electron_renderer" },
        coordination: { kind: "fifo_only" },
        operation: {
          kind: "create_synced_source",
          sourceBlockId: "block:source",
          documentId: "document:source",
          initialBlocks: [
            {
              id: "block:content",
              type: "paragraph",
              props: {},
              children: [],
            },
          ],
          placement: { kind: "library" },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          operationId: "owner:create",
          projectId: "project:one",
          duplicate: false,
          commitSeq: 12,
          committedAt: "2026-07-19T21:00:00.000Z",
          semanticHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          effect: {
            createdBlockIds: ["block:source", "block:content"],
            documentHeads: [
              {
                documentId: "document:source",
                generation: 1,
                headSeq: 1,
              },
            ],
          },
        },
      });
      expect(client.documentApplies).toEqual([
        {
          operationId: "owner:create",
          clientSessionId: "renderer:one",
          intent: {
            kind: "apply_owner_command",
            command: {
              kind: "create_synced_source",
              source_block_id: "block:source",
              document_id: "document:source",
              initial_blocks: [
                {
                  id: "block:content",
                  type: "paragraph",
                  props: {},
                  children: [],
                },
              ],
              before: undefined,
            },
          },
        },
      ]);
    });

    test("maps checkpoint creation and exact history pagination through Core", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const checkpointRequest = {
        operationId: "checkpoint:one",
        projectId: "project:one",
        storeEpoch: "epoch:test",
        documentId: "document:one",
        expectedGeneration: 1,
        expectedHeadSeq: 2,
        cause: "manual",
        label: "Before refactor",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:history",
        },
        revisionKind: "manual" as const,
      };
      const apply = vi.spyOn(client, "documentApply").mockImplementationOnce(async (input) => ({
        status: "committed" as const,
        commit: {
          store_epoch: "epoch:test",
          commit_seq: 8,
          manifest_hash: "f".repeat(64),
        },
        outcome: {
          document_id: checkpointRequest.documentId,
          generation: checkpointRequest.expectedGeneration,
          head_seq: checkpointRequest.expectedHeadSeq,
          outcome: "no_change",
          checkpoint_effect: {
            checkpoint: documentVersionSummary(),
            duplicate: false,
          },
        },
        receipt: {
          operation_id: input.operationId,
          duplicate: false,
          document_id: checkpointRequest.documentId,
          generation: checkpointRequest.expectedGeneration,
          head_seq: checkpointRequest.expectedHeadSeq,
        },
      }));

      await expect(adapter.createCheckpoint(checkpointRequest)).resolves.toEqual({
        ok: true,
        value: {
          checkpoint: documentVersionSummary(),
          duplicate: false,
        },
      });
      expect(apply).toHaveBeenCalledWith({
        operationId: checkpointRequest.operationId,
        clientSessionId: "electron:document-history",
        intent: {
          kind: "create_checkpoint",
          document_id: checkpointRequest.documentId,
          generation: 1,
          expected_head_seq: 2,
          cause: "manual",
          label: "Before refactor",
          revision_kind: "manual",
          source_mutation_id: undefined,
          source_change_seq: undefined,
        },
      });
      const before = {
        baseHeadSeq: 2,
        createdAt: "2026-07-19T21:10:00.000Z",
        versionId: documentVersionSummary().versionId,
      };
      client.enqueueDocumentRead({
        contract_version: 1,
        store_epoch: "epoch:test",
        commit_head: 8,
        value: {
          kind: "versions",
          items: [documentVersionSummary()],
          next: {
            base_head_seq: before.baseHeadSeq,
            created_at: before.createdAt,
            version_id: before.versionId,
          },
        },
      });
      await expect(
        adapter.listVersions({
          projectId: "project:one",
          documentId: "document:one",
          before,
          limit: 25,
        }),
      ).resolves.toEqual({ ok: true, value: [documentVersionSummary()] });
      expect(client.documentReads[0]).toEqual({
        clientSessionId: "electron:document-history",
        read: {
          kind: "list_versions",
          document_id: "document:one",
          before: {
            base_head_seq: before.baseHeadSeq,
            created_at: before.createdAt,
            version_id: before.versionId,
          },
          limit: 25,
        },
      });

      client.enqueueDocumentRead({
        contract_version: 1,
        store_epoch: "epoch:test",
        commit_head: 8,
        value: { kind: "version", value: documentVersionDetail() },
      });
      await expect(
        adapter.getVersion({
          projectId: null,
          documentId: "document:one",
          versionId: documentVersionSummary().versionId,
        }),
      ).resolves.toEqual({ ok: true, value: documentVersionDetail() });
    });

    test("maps a Library-scoped write-fenced restore and its durable no-change outcome", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const request = {
        mutationId: "restore:history",
        projectId: null,
        storeEpoch: "epoch:test",
        documentId: "document:one",
        versionId: documentVersionSummary().versionId,
        generation: 1,
        expectedHeadSeq: 2,
        clientSessionId: "renderer:history",
        actor: { kind: "electron_renderer", clientId: "renderer:history" },
      };
      client.enqueueDocumentApply({
        status: "committed",
        commit: {
          store_epoch: request.storeEpoch,
          commit_seq: 9,
          manifest_hash: "f".repeat(64),
        },
        outcome: {
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
          outcome: "committed",
          committed_at: "2026-07-19T21:12:00.000Z",
          mutation_effect: {
            base_head_seq: 2,
            touched_block_ids: ["page:one", "block:history"],
            created_block_ids: [],
            deleted_block_ids: [],
            updated_block_ids: ["block:history"],
            moved_block_ids: [],
            write_fence_block_ids: ["page:one", "block:history"],
            title_changed: true,
            coordination: "write_fence",
          },
        },
        receipt: {
          operation_id: request.mutationId,
          duplicate: false,
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
        },
      });

      await expect(adapter.restoreVersion(request)).resolves.toEqual({
        ok: true,
        localCommit: committedLocalCommit(request.storeEpoch, 9),
        value: {
          mutationKind: "document_version_restore",
          mutationId: request.mutationId,
          projectId: request.projectId,
          storeEpoch: request.storeEpoch,
          documentId: request.documentId,
          generation: 1,
          baseHeadSeq: 2,
          headSeq: 3,
          touchedBlockIds: ["page:one", "block:history"],
          createdBlockIds: [],
          deletedBlockIds: [],
          updatedBlockIds: ["block:history"],
          movedBlockIds: [],
          writeFenceBlockIds: ["page:one", "block:history"],
          titleChanged: true,
          coordination: "write_fence",
          commitSeq: 9,
          committedAt: "2026-07-19T21:12:00.000Z",
          duplicate: false,
        },
      });
      expect(client.documentApplies).toEqual([
        {
          operationId: request.mutationId,
          clientSessionId: request.clientSessionId,
          intent: {
            kind: "restore_version",
            document_id: request.documentId,
            version_id: request.versionId,
            generation: request.generation,
            expected_head_seq: request.expectedHeadSeq,
          },
        },
      ]);

      const noChangeRequest = {
        ...request,
        mutationId: "restore:already-current",
        expectedHeadSeq: 3,
      };
      client.enqueueDocumentApply({
        status: "no_op",
        observed: {
          store_epoch: request.storeEpoch,
          commit_head: 9,
        },
        outcome: {
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
          outcome: "no_change",
        },
        receipt: {
          operation_id: noChangeRequest.mutationId,
          duplicate: false,
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
        },
      });
      await expect(adapter.restoreVersion(noChangeRequest)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "no_change",
          mutationId: noChangeRequest.mutationId,
          retryable: false,
        },
      });
    });

    test("maps a public operation batch with presence-sensitive Block patches", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const request = {
        mutationId: "document-operation:batch",
        projectId: "project:one",
        storeEpoch: "epoch:test",
        documentId: "document:one",
        generation: 1,
        expectedHeadSeq: 2,
        clientSessionId: "renderer:document",
        actor: { kind: "electron_renderer", clientId: "renderer:document" },
        operations: [
          {
            kind: "insert_block" as const,
            block: {
              id: "block:inserted",
              type: "paragraph",
              props: {},
              content: [],
              children: [],
            },
          },
          {
            kind: "update_block" as const,
            blockId: "block:existing",
            patch: { content: null },
          },
        ],
      };
      client.enqueueDocumentApply({
        store_epoch: request.storeEpoch,
        event_sequence: 10,
        value: {
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
          outcome: "committed",
          committed_at: "2026-07-19T21:13:00.000Z",
          mutation_effect: {
            base_head_seq: 2,
            touched_block_ids: ["block:existing", "block:inserted"],
            created_block_ids: ["block:inserted"],
            deleted_block_ids: [],
            updated_block_ids: ["block:existing"],
            moved_block_ids: [],
            write_fence_block_ids: ["block:existing"],
            title_changed: false,
            coordination: "write_fence",
          },
        },
        receipt: {
          operation_id: request.mutationId,
          duplicate: false,
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
        },
      });

      await expect(adapter.applyDocumentMutation(request)).resolves.toMatchObject({
        ok: true,
        value: {
          mutationKind: "document_operation_batch",
          coordination: "write_fence",
          createdBlockIds: ["block:inserted"],
          updatedBlockIds: ["block:existing"],
        },
      });
      expect(client.documentApplies).toEqual([
        {
          operationId: request.mutationId,
          clientSessionId: request.clientSessionId,
          intent: {
            kind: "apply_operation_batch",
            document_id: request.documentId,
            generation: request.generation,
            expected_head_seq: request.expectedHeadSeq,
            operations: [
              {
                kind: "insert_block",
                block: request.operations[0]?.block,
              },
              {
                kind: "update_block",
                block_id: "block:existing",
                patch: {
                  content: { kind: "value", value: null },
                  unset_content: false,
                },
              },
            ],
          },
        },
      ]);
    });

    test("rejects a Core restore effect that omits a changed Block from touched IDs", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      const request = {
        mutationId: "restore:corrupt-effect",
        projectId: "project:one",
        storeEpoch: "epoch:test",
        documentId: "document:one",
        versionId: documentVersionSummary().versionId,
        generation: 1,
        expectedHeadSeq: 2,
        actor: { kind: "electron_renderer" },
      };
      client.enqueueDocumentApply({
        store_epoch: request.storeEpoch,
        event_sequence: 9,
        value: {
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
          outcome: "committed",
          committed_at: "2026-07-19T21:12:00.000Z",
          mutation_effect: {
            base_head_seq: 2,
            touched_block_ids: [],
            created_block_ids: [],
            deleted_block_ids: [],
            updated_block_ids: ["block:history"],
            moved_block_ids: [],
            write_fence_block_ids: ["block:history"],
            title_changed: false,
            coordination: "write_fence",
          },
        },
        receipt: {
          operation_id: request.mutationId,
          duplicate: false,
          document_id: request.documentId,
          generation: request.generation,
          head_seq: 3,
        },
      });

      await expect(adapter.restoreVersion(request)).resolves.toMatchObject({
        ok: false,
        error: { code: "document_state_corrupt", retryable: false },
      });
    });

    test("uses a placeholder execution head only for durable owner receipt replay", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      client.enqueueDocumentApply({
        store_epoch: "epoch:test",
        event_sequence: 15,
        value: {
          document_id: "document:source",
          generation: 1,
          head_seq: 7,
          outcome: "committed",
          committed_at: "2026-07-19T21:02:00.000Z",
          owner_effect: {
            created_block_ids: [],
            preserved_block_ids: ["block:content"],
            deleted_block_ids: ["block:source"],
            document_heads: [
              {
                document_id: "document:source",
                generation: 1,
                head_seq: 7,
              },
            ],
          },
        },
        receipt: {
          operation_id: "owner:delete",
          duplicate: true,
          document_id: "document:source",
          generation: 1,
          head_seq: 7,
        },
      });

      await expect(
        adapter.applyAdditionalDocumentCommand({
          operationId: "owner:delete",
          projectId: "project:one",
          storeEpoch: "epoch:test",
          clientSessionId: "renderer:reconnected",
          actor: { kind: "electron_renderer" },
          coordination: { kind: "receipt_replay" },
          operation: {
            kind: "delete_owned_source",
            ownerKind: "synced_block",
            owner: {
              ownerBlockId: "block:source",
              documentId: "document:source",
              generation: 1,
              metadataRevision: 2,
              locationRevision: 3,
            },
            referencePolicy: "require_unreferenced",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { operationId: "owner:delete", duplicate: true },
      });
      expect(client.documentApplies[0]?.intent).toMatchObject({
        kind: "apply_owner_command",
        command: {
          kind: "delete_owned_source",
          owner: { head_seq: 0 },
        },
      });
    });

    test("preserves domain-specific owner command conflicts", async (createCoreDocumentSyncAdapter) => {
      const client = new FakeCoreClient();
      const adapter = createCoreDocumentSyncAdapter(client);
      vi.spyOn(client, "documentApply").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code: "core_unavailable",
          message: "Identity already exists in blocks: block:source",
          retryable: false,
          recovery: { kind: "none" },
        }),
      );
      const request = {
        operationId: "owner:create-conflict",
        projectId: "project:one",
        storeEpoch: "epoch:test",
        clientSessionId: "renderer:one",
        actor: { kind: "electron_renderer" },
        coordination: { kind: "fifo_only" as const },
        operation: {
          kind: "create_synced_source" as const,
          sourceBlockId: "block:source",
          documentId: "document:source",
          initialBlocks: [
            {
              id: "block:content",
              type: "paragraph",
              props: {},
              children: [],
            },
          ],
          placement: { kind: "library" as const },
        },
      };

      await expect(adapter.applyAdditionalDocumentCommand(request)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "identity_conflict",
          operationId: request.operationId,
          operationKind: request.operation.kind,
          retryable: false,
        },
      });
    });
  });
});

describe("desktop-document-sync-recovery", () => {
  const it = itdesktopdocumentsyncrecovery;
  const documentId = "document:recovery";
  const scopes: ContentRoutingContext[] = [
    { kind: "library" },
    { kind: "project", projectId: "project:test" },
  ];

  function fixture() {
    const server = createPageDocument({ documentId, initialTitle: "Base" }).document;
    const client = new FakeCoreClient();
    Object.assign(client, {
      handshake: createFakeCoreHandshake({
        connectionBinding: "binding:test",
        libraryId: "library:test",
        profileId: "profile:test",
        storeEpoch: "epoch:test",
      }),
      forProject: () => client,
      documentSync: async () => ({
        documentId,
        storeEpoch: "epoch:test",
        generation: 1,
        headSeq: 0,
        stateVector: Y.encodeStateVector(server),
        update: Y.encodeStateAsUpdate(server),
      }),
      documentPublishAwareness: async () => ({ accepted: true }),
    });
    return { client: client as FakeCoreClient & CoreGenerationClient, server };
  }

  const withProvider = Effect.fn("DesktopDocumentRecovery.test.withProvider")(function* (
    client: CoreGenerationClient,
    scope: ContentRoutingContext,
    run: (provider: NodexYProvider, local: Y.Doc) => Promise<void>,
  ) {
    const adapter = yield* makeDesktopDocumentSessionHarness(client, scope);
    yield* Effect.promise(async () => {
      const local = new Y.Doc({ guid: documentId });
      const provider = new NodexYProvider({
        documentId,
        document: local,
        adapter,
        autoConnect: false,
        localCheckpointStore: null,
      });
      try {
        await provider.connect();
        await run(provider, local);
      } finally {
        provider.destroy();
        local.destroy();
      }
    });
  });

  scopes.forEach((scope) =>
    it.live(`preserves a deterministic rejection across the ${scope.kind} Desktop boundary`, () =>
      Effect.gen(function* () {
        const { client, server } = fixture();
        const apply = vi.fn(async () => {
          throw new CoreModuleResponseError({
            code: "invalid_input",
            message: "The document update is invalid",
            retryable: false,
            recovery: { kind: "none" },
          });
        });
        client.documentApplyUpdate = apply;
        try {
          yield* withProvider(client, scope, async (provider, local) => {
            local.getText("title").insert(4, " edited");
            const flushing = provider.flush().catch((error) => error);
            await vi.waitFor(() => expect(provider.getStatus().phase).toBe("error"));
            expect(await flushing).toBeInstanceOf(Error);
            expect(provider.getStatus()).toMatchObject({
              phase: "error",
              error: { code: "invalid_document_update", retryable: false },
              pendingUpdateCount: 1,
            });
            expect(apply).toHaveBeenCalledTimes(1);
          });
        } finally {
          server.destroy();
        }
      }),
    ),
  );

  it.live("reacquires the physical lease when Core requires a new subscription", () =>
    Effect.gen(function* () {
      const { client, server } = fixture();
      let leaseMissing = false;
      const sync = client.documentSync.bind(client);
      const open = client.openDocumentEventStream.bind(client);
      const openings = vi.fn(async (...args: Parameters<typeof open>) => {
        leaseMissing = false;
        return open(...args);
      });
      client.openDocumentEventStream = openings;
      client.documentSync = async (request) => {
        if (leaseMissing)
          throw new CoreModuleResponseError({
            code: "unauthorized",
            message: "An exact Document subscription is required",
            retryable: true,
            recovery: { kind: "reconnect_document_subscription" },
          });
        return sync(request);
      };
      try {
        yield* withProvider(client, { kind: "library" }, async (provider) => {
          leaseMissing = true;
          await provider.connect();
          await vi.waitFor(() => expect(provider.getStatus().phase).toBe("synced"));
          expect(openings).toHaveBeenCalledTimes(2);
        });
      } finally {
        server.destroy();
      }
    }),
  );

  it.live("propagates terminal stream failure and settles durable waiters", () =>
    Effect.gen(function* () {
      const { client, server } = fixture();
      const open = client.openDocumentEventStream.bind(client);
      let rejectStream: (error: Error) => void = () => undefined;
      const openings = vi.fn(async (...args: Parameters<typeof open>) => ({
        ...(await open(...args)),
        done: new Promise<void>((_resolve, reject) => {
          rejectStream = reject;
        }),
      }));
      client.openDocumentEventStream = openings;
      try {
        yield* withProvider(client, { kind: "library" }, async (provider) => {
          rejectStream(new CoreEventCompatibilityError("The document stream is incompatible"));
          await vi.waitFor(() => expect(provider.getStatus().phase).toBe("error"));
          expect(provider.getStatus().error).toMatchObject({
            code: "invalid_response",
            retryable: false,
          });
          await expect(provider.flush()).rejects.toThrow();
          expect(openings).toHaveBeenCalledTimes(1);
        });
      } finally {
        server.destroy();
      }
    }),
  );

  scopes
    .flatMap((scope) => [false, true].map((replace) => ({ scope, replace })))
    .forEach(({ scope, replace }) =>
      it.live(
        `retires ${scope.kind} awareness failures after ${replace ? "replacement" : "closure"}`,
        () => {
          const messages: unknown[] = [];
          return Effect.gen(function* () {
            const { client, server } = fixture();
            const open = client.openDocumentEventStream.bind(client);
            const close = vi.fn();
            const openings = vi.fn(async (...args: Parameters<typeof open>) => {
              const stream = await open(...args);
              return {
                ...stream,
                close: () => {
                  close();
                  stream.close();
                },
              };
            });
            client.openDocumentEventStream = openings;
            let rejectPublication: (error: Error) => void = () => undefined;
            const publish = vi.fn(
              () =>
                new Promise<{ accepted: true }>((_resolve, reject) => {
                  rejectPublication = reject;
                }),
            );
            client.documentPublishAwareness = publish;
            const adapter = yield* makeDesktopDocumentSessionHarness(client, scope);
            try {
              yield* Effect.promise(async () => {
                const request = { documentId, clientSessionId: "closing-session" };
                const release = adapter.subscribe(request, () => undefined);
                let releaseReplacement: (() => void) | undefined;
                try {
                  await adapter.sync({ ...request, stateVector: new Uint8Array([0]) });
                  const pending = adapter.publishAwareness({
                    ...request,
                    storeEpoch: "epoch:test",
                    generation: 1,
                    update: new Uint8Array([0]),
                  });
                  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
                  release();
                  await vi.waitFor(() => expect(close).toHaveBeenCalled());
                  if (replace) {
                    releaseReplacement = adapter.subscribe(request, () => undefined);
                    expect(
                      await adapter.sync({ ...request, stateVector: new Uint8Array([0]) }),
                    ).toMatchObject({ ok: true });
                  }
                  rejectPublication(
                    new CoreModuleResponseError({
                      code: "unauthorized",
                      message: "An exact Yjs subscription is required",
                      retryable: true,
                      recovery: { kind: "reconnect_document_subscription" },
                    }),
                  );
                  expect(await pending).toMatchObject({ ok: false });
                  expect(openings).toHaveBeenCalledTimes(replace ? 2 : 1);
                  expect(
                    messages.filter((message) =>
                      String(message).includes("Document session command failed"),
                    ),
                  ).toEqual([]);
                } finally {
                  releaseReplacement?.();
                  release();
                }
              });
            } finally {
              server.destroy();
            }
          }).pipe(
            Effect.withLogger(
              Logger.make(({ message }) => {
                messages.push(message);
              }),
            ),
          );
        },
      ),
    );

  it.live("a retired sync response cannot replace the new session's canonical generation", () =>
    Effect.gen(function* () {
      const { client, server } = fixture();
      const open = client.openDocumentEventStream.bind(client);
      let generation = 0;
      let emit: (event: DocumentSyncRealtimeEvent) => void = () => undefined;
      const closed = vi.fn();
      client.openDocumentEventStream = async (...args: Parameters<typeof open>) => {
        const stream = await open(...args);
        generation += 1;
        emit = args[3];
        return {
          ...stream,
          barrier: { ...stream.barrier, document_generation: generation },
          close: () => {
            closed();
            stream.close();
          },
        };
      };
      let completeOldSync: (response: DocumentSyncResponse) => void = () => undefined;
      const originalSync = client.documentSync.bind(client);
      const oldResponse = yield* Effect.promise(() =>
        originalSync({
          documentId,
          clientSessionId: "reused-session",
          stateVector: new Uint8Array([0]),
        }),
      );
      const sync = vi.fn(async () => {
        if (generation === 1)
          return new Promise<DocumentSyncResponse>((resolve) => {
            completeOldSync = resolve;
          });
        return { ...oldResponse, generation };
      });
      client.documentSync = sync;
      const adapter = yield* makeDesktopDocumentSessionHarness(client, { kind: "library" });
      try {
        yield* Effect.promise(async () => {
          const request = { documentId, clientSessionId: "reused-session" };
          const release = adapter.subscribe(request, () => undefined);
          let releaseReplacement: (() => void) | undefined;
          try {
            const oldSync = adapter.sync({ ...request, stateVector: new Uint8Array([0]) });
            await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
            release();
            await vi.waitFor(() => expect(closed).toHaveBeenCalled());
            const events: DocumentSyncRealtimeEvent[] = [];
            releaseReplacement = adapter.subscribe(request, (event) => events.push(event));
            expect(
              await adapter.sync({ ...request, stateVector: new Uint8Array([0]) }),
            ).toMatchObject({ ok: true, value: { generation: 2 } });
            completeOldSync(oldResponse);
            await oldSync;
            const update = {
              kind: "document-update",
              documentId,
              updateId: "remote-update",
              clientSessionId: "remote-session",
              storeEpoch: "epoch:test",
              generation: 2,
              headSeq: 1,
              update: new Uint8Array([0]),
            } as const;
            emit(update);
            await vi.waitFor(() => expect(events).toContainEqual(update));
            expect(events.some((event) => event.kind === "resync-required")).toBe(false);
          } finally {
            releaseReplacement?.();
            release();
          }
        });
      } finally {
        server.destroy();
      }
    }),
  );
});

describe("canvas-presence-hub", () => {
  const state = (x: number) => ({
    pointer: {
      x,
      y: 4,
      button: "up" as const,
      tool: "pointer" as const,
    },
    selectedElementIds: ["element-1"],
    idle: "active" as const,
  });

  describe("CanvasPresenceHub", () => {
    test("uses higher clocks, sender exclusion, snapshots, clean removal, and TTL", () => {
      let now = 1_000;
      const events = new Map<string, CanvasPresenceRealtimeEvent[]>();
      const hub = createCanvasPresenceHub({
        now: () => now,
      });
      const binding = (key: string, targetId: number): CanvasPresenceHubBinding => ({
        key,
        targetId,
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "document-1",
        clientSessionId: `session-${key}`,
        send: (event) => {
          const current = events.get(key) ?? [];
          current.push(event);
          events.set(key, current);
        },
      });
      hub.register(binding("a", 1));
      hub.register(binding("b", 2));
      hub.adoptBoundary("a", 3);
      hub.adoptBoundary("b", 3);
      events.clear();

      expect(
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 3,
          clock: 1,
          state: state(1),
        }),
      ).toEqual({ accepted: true, applied: true });
      expect(events.get("a")).toBeUndefined();
      expect(events.get("b")?.at(-1)).toMatchObject({
        type: "canvas_presence_updated",
        presence: {
          clientSessionId: "session-a",
          state: { pointer: { x: 1 } },
          user: { id: "window:1", displayName: "Window 1" },
        },
      });

      expect(
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 3,
          clock: 1,
          state: state(2),
        }).applied,
      ).toBe(false);
      expect(
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 3,
          clock: 2,
          state: state(2),
        }).applied,
      ).toBe(true);

      hub.register(binding("c", 3));
      hub.adoptBoundary("c", 3);
      expect(events.get("c")?.at(-1)).toMatchObject({
        type: "canvas_presence_snapshot",
        presences: [{ clientSessionId: "session-a", clock: 2 }],
      });

      now += CANVAS_PRESENCE_TTL_MS - 1;
      hub.sweep();
      expect(events.get("b")?.at(-1)).toMatchObject({
        presence: { state: { pointer: { x: 2 } } },
      });
      now += 1;
      hub.sweep();
      expect(events.get("b")?.at(-1)).toMatchObject({
        presence: { clock: 2, state: null },
      });

      expect(
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 3,
          clock: 2,
          state: state(3),
        }).applied,
      ).toBe(false);
      expect(
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 3,
          clock: 3,
          state: state(3),
        }).applied,
      ).toBe(true);
      hub.unregister("a");
      expect(events.get("b")?.at(-1)).toMatchObject({
        presence: { clock: 3, state: null },
      });
      hub.destroy();
    });

    test("accepts equal-clock null only for a visible state and resets on generation", () => {
      const received: CanvasPresenceRealtimeEvent[] = [];
      const hub = createCanvasPresenceHub();
      hub.register({
        key: "a",
        targetId: 1,
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "document-1",
        clientSessionId: "session-a",
        send: () => undefined,
      });
      hub.register({
        key: "b",
        targetId: 2,
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "document-1",
        clientSessionId: "session-b",
        send: (event) => received.push(event),
      });
      hub.adoptBoundary("a", 1);
      hub.adoptBoundary("b", 1);
      const publish = (clock: number, nextState: ReturnType<typeof state> | null) =>
        hub.publish("a", {
          engine: "canvas_scene",
          documentId: "document-1",
          generation: 1,
          clock,
          state: nextState,
        });

      expect(publish(4, state(4)).applied).toBe(true);
      expect(publish(4, null).applied).toBe(true);
      expect(publish(4, null).applied).toBe(false);
      hub.adoptBoundary("a", 2);
      expect(received.at(-1)).toMatchObject({
        presence: { generation: 1, clock: 4, state: null },
      });
      expect(() => publish(5, state(5))).toThrow("generation boundary");
      hub.destroy();
    });
  });
});
