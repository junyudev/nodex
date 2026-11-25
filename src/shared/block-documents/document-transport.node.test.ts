import { describe, expect, test } from "vite-plus/test";
import {
  bindTrustedDocumentVersionCheckpoint,
  DocumentHistoryContractError,
  parseCreateDocumentVersionCheckpoint,
  parseDocumentVersionSummary,
  parseListDocumentVersions,
} from "./document-history-transport";
import {
  canonicalizeDocumentVersionRestoreIntent,
  parseDocumentVersionRestore,
} from "./document-operations";
import {
  bindTrustedDocumentMutation,
  documentMutationHttpStatus,
} from "./document-operation-transport";
import {
  decodeOwnedDocumentDescriptorHttp,
  decodeCanvasSceneSyncHttpRequest,
  decodeCanvasSceneSyncHttpResponse,
  decodeLibraryAccessedDocumentDescriptorHttp,
  decodeDocumentApplyHttpAck,
  decodeDocumentApplyHttpRequest,
  decodeDocumentAwarenessHttpRequest,
  decodeDocumentHttpError,
  decodeDocumentRealtimeSseEvent,
  decodeDocumentSyncHttpRequest,
  decodeDocumentSyncHttpResponse,
  encodeDocumentApplyHttpAck,
  encodeCanvasSceneSyncHttpRequest,
  encodeCanvasSceneSyncHttpResponse,
  encodeDocumentApplyHttpRequest,
  encodeDocumentAwarenessHttpRequest,
  encodeDocumentHttpError,
  encodeDocumentRealtimeSseEvent,
  encodeDocumentSyncHttpRequest,
  encodeDocumentSyncHttpResponse,
  encodeOwnedDocumentDescriptorHttp,
  encodeLibraryAccessedDocumentDescriptorHttp,
} from "./http-contract";
import { MAX_CANVAS_SCENE_SNAPSHOT_BYTES } from "./canvas-scene-sync";
import { canonicalStringifyCanvasScene, materializePortableCanvasScene } from "./canvas-scene";
import {
  decodeDocumentHttpEnvelope,
  encodeDocumentHttpEnvelope,
  DocumentHttpWireError,
  documentBytesFromBase64,
  documentBytesToBase64,
} from "./http-wire";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "./page-document";
import type { AuthorizedDeliveryPacket } from "../authorized-delivery-packet";

describe("document history transport", () => {
  const restoreRequest = {
    mutationId: "restore:version-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    documentId: "document-1",
    versionId: `document-version:${"a".repeat(64)}`,
    generation: 3,
    expectedHeadSeq: 17,
    clientSessionId: "untrusted-window",
    actor: { kind: "untrusted" },
  } as const;

  describe("Document history transport contracts", () => {
    test("parses restore as a bounded stable checkpoint identity", () => {
      const parsed = parseDocumentVersionRestore(restoreRequest);
      expect(parsed.versionId).toBe(restoreRequest.versionId);
      expect(parsed.expectedHeadSeq).toBe(17);
    });

    test("keeps host audit identity outside exact restore semantics", () => {
      const first = canonicalizeDocumentVersionRestoreIntent(restoreRequest);
      const retried = canonicalizeDocumentVersionRestoreIntent({
        ...restoreRequest,
        clientSessionId: "replacement-window",
        actor: { kind: "trusted", retry: true },
      });
      expect(first).toBe(retried);
    });

    test("binds checkpoint actor at the trusted transport boundary", () => {
      const bound = bindTrustedDocumentVersionCheckpoint(
        {
          operationId: "checkpoint:one",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          documentId: "document-1",
          expectedGeneration: 2,
          expectedHeadSeq: 9,
          cause: "manual",
          actor: { kind: "spoofed" },
        },
        "project-1",
        "document-1",
        { kind: "electron_renderer", clientId: "window-1" },
      );
      expect(bound.actor.kind).toBe("electron_renderer");
      expect(bound.actor.clientId).toBe("window-1");
      expect(bound.operationId).toBe("checkpoint:one");
      const { operationId: _operationId, ...withoutIdentity } = bound;
      expect(() => parseCreateDocumentVersionCheckpoint(withoutIdentity)).toThrow(
        DocumentHistoryContractError,
      );
    });

    test("rejects partial pagination cursors and cross-scope checkpoints", () => {
      let cursorError: unknown;
      let scopeError: unknown;
      try {
        parseListDocumentVersions({
          projectId: "project-1",
          documentId: "document-1",
          before: { baseHeadSeq: 4 },
        });
      } catch (error) {
        cursorError = error;
      }
      try {
        bindTrustedDocumentVersionCheckpoint(
          {
            operationId: "checkpoint:cross-scope",
            projectId: "project-2",
            storeEpoch: "epoch-1",
            documentId: "document-1",
            expectedGeneration: 2,
            expectedHeadSeq: 9,
            cause: "manual",
            actor: {},
          },
          "project-1",
          "document-1",
          {},
        );
      } catch (error) {
        scopeError = error;
      }
      expect(cursorError instanceof DocumentHistoryContractError).toBe(true);
      expect(scopeError instanceof DocumentHistoryContractError).toBe(true);
    });

    test("rejects inconsistent checkpoint evidence and summary metadata", () => {
      expect(() =>
        bindTrustedDocumentVersionCheckpoint(
          {
            operationId: "checkpoint:inconsistent-evidence",
            projectId: "project-1",
            storeEpoch: "epoch-1",
            documentId: "document-1",
            expectedGeneration: 2,
            expectedHeadSeq: 9,
            cause: "manual",
            actor: {},
            revisionKind: "manual",
            sourceMutationId: "mutation-1",
          },
          "project-1",
          "document-1",
          {},
        ),
      ).toThrow(DocumentHistoryContractError);
      expect(() =>
        parseDocumentVersionSummary({
          versionId: `document-version:${"a".repeat(64)}`,
          documentId: "document-1",
          projectId: "project-1",
          generation: 1,
          baseHeadSeq: 1,
          schemaKey: "nodex.canvas",
          schemaVersion: 1,
          cause: "manual",
          label: null,
          actor: {},
          revisionKind: "manual",
          sourceMutationId: null,
          sourceChangeSeq: null,
          pinned: true,
          checkpointHash: "b".repeat(64),
          materializationHash: "c".repeat(64),
          byteLength: 16,
          materializationKind: "canvas_scene",
          title: null,
          preview: "Canvas",
          blockCount: 1,
          createdAt: "2026-07-19T21:20:00.000Z",
          fileSnapshotStatus: "exact",
          checkpointMetadata: { format: "block_tree_snapshot_v2" },
        }),
      ).toThrow(DocumentHistoryContractError);
    });

    test.each(["block_tree_snapshot_v2", "block_tree_snapshot_v3"])(
      "accepts an empty Page checkpoint in %s",
      (format) => {
        expect(
          parseDocumentVersionSummary({
            versionId: `document-version:${"d".repeat(64)}`,
            documentId: "document-1",
            projectId: "project-1",
            generation: 1,
            baseHeadSeq: 0,
            schemaKey: "nodex.page",
            schemaVersion: 3,
            cause: "manual",
            label: null,
            actor: {},
            revisionKind: "manual",
            sourceMutationId: null,
            sourceChangeSeq: null,
            pinned: true,
            checkpointHash: "e".repeat(64),
            materializationHash: "f".repeat(64),
            byteLength: 16,
            materializationKind: "page",
            title: "",
            preview: "",
            blockCount: 0,
            createdAt: "2026-07-19T21:30:00.000Z",
            fileSnapshotStatus: "exact",
            checkpointMetadata: { format },
          }),
        ).toMatchObject({ title: "", preview: "", blockCount: 0 });
      },
    );
  });
});

describe("document operation transport", () => {
  const request = () => ({
    mutationId: "mutation-1",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    clientSessionId: "spoofed-session",
    actor: { kind: "spoofed" },
    documentId: "document-1",
    generation: 1,
    expectedHeadSeq: 4,
    operations: [{ kind: "set_title" as const, title: "Current" }],
  });

  describe("Document operation transport", () => {
    test("binds host identity without changing logical scope", () => {
      const bound = bindTrustedDocumentMutation(request(), "project-1", "document-1", {
        actor: { kind: "electron_renderer", clientId: "renderer-7" },
        clientSessionId: "renderer-7",
      });
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      expect(bound.value.clientSessionId).toBe("renderer-7");
      expect(JSON.stringify(bound.value.actor)).toBe(
        JSON.stringify({ kind: "electron_renderer", clientId: "renderer-7" }),
      );
      expect(bound.value.projectId).toBe("project-1");
      expect(bound.value.documentId).toBe("document-1");
    });

    test("rejects route scope mismatch and preserves a valid mutation hint", () => {
      const wrongProject = bindTrustedDocumentMutation(request(), "project-2", "document-1", {
        actor: { kind: "http_loopback" },
      });
      expect(wrongProject.ok).toBe(false);
      if (!wrongProject.ok) {
        expect(wrongProject.error.code).toBe("invalid_document_operation_request");
        expect(wrongProject.error.mutationId).toBe("mutation-1");
      }

      const malformed = bindTrustedDocumentMutation(
        { ...request(), operations: [{ kind: "unknown" }] },
        "project-1",
        "document-1",
        { actor: { kind: "http_loopback" } },
      );
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.error.mutationId).toBe("mutation-1");
    });

    test("maps typed boundary failures to stable HTTP classes", () => {
      expect(
        documentMutationHttpStatus({
          code: "block_not_found",
          message: "missing",
          retryable: false,
        }),
      ).toBe(404);
      expect(
        documentMutationHttpStatus({
          code: "document_head_conflict",
          message: "stale",
          retryable: true,
          expectedHeadSeq: 2,
          actualHeadSeq: 3,
        }),
      ).toBe(409);
      expect(
        documentMutationHttpStatus({
          code: "unknown",
          message: "offline",
          retryable: true,
        }),
      ).toBe(503);
    });
  });
});

describe("http contract", () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

  const documentDelivery = (): AuthorizedDeliveryPacket => ({
    packet_version: 5,
    delivery_address: {
      kind: "document",
      library_id: "library-1",
      project_id: "project-1",
      document_id: "document-1",
    },
    manifest: {
      event_version: 8,
      identity: {
        store_epoch: "store-1",
        commit_seq: 5,
        manifest_hash: "f".repeat(64),
      },
      operation_id: "operation-1",
      committed_at: "2026-08-09T00:00:00.000Z",
    },
    atoms: [],
    document_effects: [
      {
        reference: {
          effect_order: 0,
          page_id: "page-1",
          document_id: "document-1",
          generation: 1,
          base_head_seq: 5,
          result_head_seq: 6,
          update_id: "update-1",
          update_hash: "e".repeat(64),
          update_byte_length: 2,
          resource_kind: "document_update",
        },
        inline_update: [8, 9],
      },
    ],
    projection_effects: [],
    coverage: {
      atom_ids: [],
      document_effect_orders: [0],
      inline_document_effect_orders: [0],
      projection_scope_keys: [],
    },
    packet_hash: "d".repeat(64),
  });

  describe("Document HTTP contract", () => {
    test("round-trips Library descriptors without a Project coordinate", () => {
      const descriptor = decodeLibraryAccessedDocumentDescriptorHttp(
        encodeLibraryAccessedDocumentDescriptorHttp({
          libraryId: "library-1",
          routingContext: { kind: "library" },
          ownerBlockId: "page-1",
          ownerType: "page",
          ownerLifecycle: "active",
          documentId: "document-1",
          storeEpoch: "store-1",
          generation: 1,
          headSeq: 2,
          schemaKey: "nodex.page",
          schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
          readiness: "ready",
          sync: { kind: "yjs", stateVector: bytes(1, 2, 3) },
        }),
      );
      expect(descriptor.routingContext).toEqual({ kind: "library" });
      expect(descriptor.libraryId).toBe("library-1");
      expect("projectId" in descriptor).toBe(false);
      expect(() =>
        decodeLibraryAccessedDocumentDescriptorHttp(
          JSON.stringify({
            ...JSON.parse(encodeLibraryAccessedDocumentDescriptorHttp(descriptor)),
            projectId: "forged",
          }),
        ),
      ).toThrow("unsupported fields");
    });

    test("round-trips engine-neutral Yjs and Canvas descriptors", () => {
      const common = {
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        ownerLifecycle: "active",
        storeEpoch: "store-1",
        generation: 2,
        headSeq: 7,
        schemaVersion: 1,
        readiness: "ready",
      } as const;
      const yjs = decodeOwnedDocumentDescriptorHttp(
        encodeOwnedDocumentDescriptorHttp({
          ...common,
          ownerBlockId: "card-1",
          ownerType: "page",
          documentId: "document-1",
          schemaKey: "nodex.page",
          schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
          sync: { kind: "yjs", stateVector: bytes(0, 128, 255) },
        }),
      );
      expect(yjs.sync.kind).toBe("yjs");
      if (yjs.sync.kind !== "yjs") throw new Error("Expected Yjs sync engine");
      expect(Array.from(yjs.sync.stateVector).join(",")).toBe("0,128,255");

      const canvas = decodeOwnedDocumentDescriptorHttp(
        encodeOwnedDocumentDescriptorHttp({
          ...common,
          ownerBlockId: "canvas-1",
          ownerType: "canvas",
          documentId: "canvas-document-1",
          schemaKey: "nodex.canvas",
          sync: { kind: "canvas_scene" },
        }),
      );
      expect(canvas.sync).toEqual({ kind: "canvas_scene" });
      expect("stateVector" in canvas.sync).toBe(false);
    });

    test("rejects Yjs fields on a Canvas engine descriptor", () => {
      const serialized = JSON.stringify({
        version: 4,
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        ownerBlockId: "canvas-1",
        ownerType: "canvas",
        ownerLifecycle: "active",
        documentId: "canvas-document-1",
        storeEpoch: "store-1",
        generation: 1,
        headSeq: 1,
        schemaKey: "nodex.canvas",
        schemaVersion: 1,
        readiness: "ready",
        sync: { kind: "canvas_scene", stateVector: "AA==" },
      });
      expect(() => decodeOwnedDocumentDescriptorHttp(serialized)).toThrow(
        "Canvas scene sync descriptor has unsupported fields",
      );
    });

    test("round-trips sync and apply commands without JSON-encoding binary updates", () => {
      const syncRequest = {
        documentId: "document-1",
        clientSessionId: "client-1",
        stateVector: bytes(0, 128, 255),
        historyAfterHeadSeq: 2,
      } as const;
      const decodedSyncRequest = decodeDocumentSyncHttpRequest(
        syncRequest.documentId,
        encodeDocumentSyncHttpRequest(syncRequest),
      );
      expect(Array.from(decodedSyncRequest.stateVector).join(",")).toBe("0,128,255");
      expect(decodedSyncRequest.historyAfterHeadSeq).toBe(2);

      const syncResponse = {
        documentId: "document-1",
        storeEpoch: "store-1",
        generation: 1,
        headSeq: 4,
        stateVector: bytes(1, 2),
        update: bytes(3, 4, 255),
        historyFence: { headSeq: 4, blockIds: ["block:a"], documentWide: false },
      } as const;
      const decodedSyncResponse = decodeDocumentSyncHttpResponse(
        encodeDocumentSyncHttpResponse(syncResponse),
      );
      expect(Array.from(decodedSyncResponse.stateVector).join(",")).toBe("1,2");
      expect(Array.from(decodedSyncResponse.update).join(",")).toBe("3,4,255");
      expect(decodedSyncResponse.historyFence).toEqual(syncResponse.historyFence);
      expect(() =>
        decodeDocumentSyncHttpResponse(
          encodeDocumentSyncHttpResponse({
            ...syncResponse,
            historyFence: { headSeq: 5, blockIds: [], documentWide: true },
          }),
        ),
      ).toThrow("History fence");
      expect(() =>
        decodeDocumentSyncHttpResponse(
          encodeDocumentSyncHttpResponse({
            ...syncResponse,
            historyFence: {
              headSeq: 4,
              blockIds: Array.from({ length: 513 }, (_, i) => `block:${i}`),
              documentWide: false,
            },
          }),
        ),
      ).toThrow("History fence");

      const applyRequest = {
        documentId: "document-1",
        storeEpoch: "store-1",
        generation: 1,
        updateId: "update-1",
        clientSessionId: "client-1",
        baseHeadSeq: 4,
        touchedBlockIds: ["block-a", "block-b"],
        update: bytes(5, 6, 7),
      } as const;
      const decodedApplyRequest = decodeDocumentApplyHttpRequest(
        applyRequest.documentId,
        encodeDocumentApplyHttpRequest(applyRequest),
      );
      expect(decodedApplyRequest.touchedBlockIds.join(",")).toBe("block-a,block-b");
      expect(Array.from(decodedApplyRequest.update).join(",")).toBe("5,6,7");

      const ack = {
        documentId: "document-1",
        storeEpoch: "store-1",
        generation: 1,
        updateId: "update-1",
        committedSeq: 5,
        headSeq: 6,
        stateVector: bytes(8, 9),
        duplicate: false,
        status: "committed",
        commit: {
          store_epoch: "store-1",
          commit_seq: 5,
          manifest_hash: "f".repeat(64),
        },
        delivery: documentDelivery(),
      } as const;
      const decodedAck = decodeDocumentApplyHttpAck(encodeDocumentApplyHttpAck(ack));
      expect(decodedAck.status).toBe("committed");
      if (decodedAck.status !== "committed") {
        throw new Error("Expected committed Document ACK");
      }
      expect(decodedAck.committedSeq).toBe(5);
      expect(decodedAck.commit.commit_seq).toBe(5);
      expect(decodedAck.delivery?.packet_version).toBe(5);
      expect(decodedAck.delivery?.document_effects).toHaveLength(1);
      expect(Array.from(decodedAck.stateVector).join(",")).toBe("8,9");

      const noOpAck = {
        ...ack,
        committedSeq: 6,
        duplicate: true,
        status: "no_op",
        observed: { store_epoch: "store-1", commit_head: 6 },
      } as const;
      const decodedNoOpAck = decodeDocumentApplyHttpAck(encodeDocumentApplyHttpAck(noOpAck));
      expect(decodedNoOpAck.status).toBe("no_op");
      if (decodedNoOpAck.status !== "no_op") {
        throw new Error("Expected no-op Document ACK");
      }
      expect(decodedNoOpAck.observed).toEqual({
        store_epoch: "store-1",
        commit_head: 6,
      });
      expect("commit" in decodedNoOpAck).toBe(false);
      expect("delivery" in decodedNoOpAck).toBe(false);
    });

    test("round-trips discriminated Canvas sync with raw canonical snapshot bytes", () => {
      const scene = materializePortableCanvasScene({ elements: [] });
      const request = {
        syncRequestId: "sync-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        clientSessionId: "client-1",
        knownStoreEpoch: "store-1",
        knownGeneration: 1,
        knownHeadSeq: 2,
        knownSceneHash: "a".repeat(64),
      } as const;
      expect(
        decodeCanvasSceneSyncHttpRequest(
          request.documentId,
          request.routingContext,
          encodeCanvasSceneSyncHttpRequest(request),
        ),
      ).toEqual(request);

      const snapshot = encodeCanvasSceneSyncHttpResponse({
        kind: "snapshot",
        syncRequestId: request.syncRequestId,
        libraryId: "library-1",
        routingContext: request.routingContext,
        documentId: request.documentId,
        storeEpoch: request.knownStoreEpoch,
        generation: request.knownGeneration,
        headSeq: request.knownHeadSeq,
        sceneHash: request.knownSceneHash,
        scene,
      });
      const raw = decodeDocumentHttpEnvelope(
        snapshot,
        (value) => value as Readonly<Record<string, unknown>>,
        MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
      );
      expect(new TextDecoder().decode(raw.payload)).toBe(canonicalStringifyCanvasScene(scene));
      expect(decodeCanvasSceneSyncHttpResponse(snapshot)).toEqual({
        kind: "snapshot",
        syncRequestId: request.syncRequestId,
        libraryId: "library-1",
        routingContext: request.routingContext,
        documentId: request.documentId,
        storeEpoch: request.knownStoreEpoch,
        generation: request.knownGeneration,
        headSeq: request.knownHeadSeq,
        sceneHash: request.knownSceneHash,
        scene,
      });

      const current = encodeCanvasSceneSyncHttpResponse({
        kind: "up_to_date",
        syncRequestId: "sync-2",
        libraryId: "library-1",
        routingContext: request.routingContext,
        documentId: request.documentId,
        storeEpoch: request.knownStoreEpoch,
        generation: request.knownGeneration,
        headSeq: request.knownHeadSeq,
        sceneHash: request.knownSceneHash,
      });
      expect(
        decodeDocumentHttpEnvelope(
          current,
          (value) => value as Readonly<Record<string, unknown>>,
          MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
        ).payload,
      ).toHaveLength(0);
      expect(decodeCanvasSceneSyncHttpResponse(current).kind).toBe("up_to_date");
    });

    test("rejects malformed Canvas binary sync payloads and engine confusion", () => {
      const metadata = {
        version: 3,
        engine: "canvas_scene",
        kind: "snapshot",
        syncRequestId: "sync-1",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        storeEpoch: "store-1",
        generation: 1,
        headSeq: 0,
        sceneHash: "a".repeat(64),
      } as const;
      expect(() =>
        decodeCanvasSceneSyncHttpResponse(encodeDocumentHttpEnvelope(metadata, bytes(0xff))),
      ).toThrow("UTF-8 JSON");
      expect(() =>
        decodeCanvasSceneSyncHttpResponse(
          encodeDocumentHttpEnvelope(
            metadata,
            new TextEncoder().encode(
              JSON.stringify(materializePortableCanvasScene({ elements: [] })),
            ),
          ),
        ),
      ).not.toThrow();
      expect(() =>
        decodeCanvasSceneSyncHttpResponse(
          encodeDocumentSyncHttpResponse({
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 0,
            stateVector: bytes(),
            update: bytes(),
          }),
        ),
      ).toThrow("wrong engine");
      expect(() =>
        decodeCanvasSceneSyncHttpResponse(
          encodeDocumentHttpEnvelope(metadata, new Uint8Array(MAX_CANVAS_SCENE_SNAPSHOT_BYTES + 1)),
        ),
      ).toThrow("exceeds");
    });

    test("accepts schema-valid Rust snapshot JSON with equivalent number encodings", () => {
      const metadata = {
        version: 3,
        engine: "canvas_scene",
        kind: "snapshot",
        syncRequestId: "sync-rust-numbers",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        storeEpoch: "store-1",
        generation: 1,
        headSeq: 1,
        sceneHash: "b".repeat(64),
      } as const;
      const scene = materializePortableCanvasScene({
        elements: [
          {
            id: "shape-1",
            type: "rectangle",
            isDeleted: false,
            version: 1,
            versionNonce: 2,
            index: "a0",
            x: 0,
            y: 0.000001,
            width: 100000000000000000000,
          },
        ],
      });
      const rustSerialized = canonicalStringifyCanvasScene(scene)
        .replace('"x":0', '"x":-0.0')
        .replace('"y":0.000001', '"y":1e-6')
        .replace('"width":100000000000000000000', '"width":1e20');

      const decoded = decodeCanvasSceneSyncHttpResponse(
        encodeDocumentHttpEnvelope(metadata, new TextEncoder().encode(rustSerialized)),
      );

      expect(decoded.kind).toBe("snapshot");
      if (decoded.kind !== "snapshot") throw new Error("Expected Canvas snapshot");
      expect(decoded.scene.elements[0]).toMatchObject({
        x: 0,
        y: 0.000001,
        width: 100000000000000000000,
      });
    });

    test("round-trips Awareness, realtime events, and typed errors", () => {
      const awareness = {
        documentId: "document-1",
        clientSessionId: "client-1",
        storeEpoch: "store-1",
        generation: 2,
        update: bytes(10, 255),
      } as const;
      const decodedAwareness = decodeDocumentAwarenessHttpRequest(
        awareness.documentId,
        encodeDocumentAwarenessHttpRequest(awareness),
      );
      expect(Array.from(decodedAwareness.update).join(",")).toBe("10,255");

      const events = [
        {
          kind: "connection",
          documentId: "document-1",
          clientSessionId: "client-1",
          state: "connected",
        },
        {
          kind: "store-reset",
          documentId: "document-1",
          storeEpoch: "store-restored",
        },
        {
          kind: "document-update",
          documentId: "document-1",
          storeEpoch: "store-1",
          generation: 1,
          headSeq: 1,
          updateId: "update-1",
          clientSessionId: "client-1",
          update: bytes(11, 12),
        },
        {
          kind: "awareness",
          documentId: "document-1",
          storeEpoch: "store-1",
          generation: 1,
          clientSessionId: "client-2",
          update: bytes(13),
        },
        {
          kind: "resync-required",
          documentId: "document-1",
          storeEpoch: "store-1",
          generation: 1,
          headSeq: 2,
          reason: "event-gap",
        },
      ] as const;
      const decodedKinds = events.map(
        (event) => decodeDocumentRealtimeSseEvent(encodeDocumentRealtimeSseEvent(event)).kind,
      );
      expect(decodedKinds.join(",")).toBe(
        "connection,store-reset,document-update,awareness,resync-required",
      );

      const error = {
        code: "document_not_ready",
        message: "not ready",
        retryable: true,
        resetRequired: false,
      } as const;
      expect(decodeDocumentHttpError(encodeDocumentHttpError(error)).code).toBe(
        "document_not_ready",
      );

      const recoveryError = {
        code: "block_relocated",
        message: "moved",
        retryable: false,
        resetRequired: true,
        relocationId: "relocation-1",
        recoveryArtifactId: "artifact-1",
      } as const;
      const decodedRecoveryError = decodeDocumentHttpError(encodeDocumentHttpError(recoveryError));
      expect(decodedRecoveryError.code).toBe("block_relocated");
      expect(decodedRecoveryError.relocationId).toBe("relocation-1");
      expect(decodedRecoveryError.recoveryArtifactId).toBe("artifact-1");

      const ownerRepairError = {
        code: "protected_owner_mutation",
        message: "typed owner deletion requires lifecycle authority",
        retryable: false,
        resetRequired: true,
      } as const;
      expect(decodeDocumentHttpError(encodeDocumentHttpError(ownerRepairError))).toEqual(
        ownerRepairError,
      );
    });

    test("rejects duplicate touched identities at the HTTP boundary", () => {
      const request = {
        documentId: "document-1",
        storeEpoch: "store-1",
        generation: 1,
        updateId: "update-1",
        clientSessionId: "client-1",
        baseHeadSeq: 0,
        touchedBlockIds: ["duplicate", "duplicate"],
        update: bytes(1),
      } as const;
      let rejected = false;
      try {
        decodeDocumentApplyHttpRequest(request.documentId, encodeDocumentApplyHttpRequest(request));
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });
});

describe("http wire", () => {
  interface TestMetadata {
    readonly documentId: string;
    readonly touchedBlockIds: readonly string[];
  }

  const validateTestMetadata = (value: unknown): TestMetadata => {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("metadata must be an object");
    }
    const candidate = value as Partial<TestMetadata>;
    if (
      typeof candidate.documentId !== "string" ||
      !Array.isArray(candidate.touchedBlockIds) ||
      candidate.touchedBlockIds.some((entry) => typeof entry !== "string")
    ) {
      throw new TypeError("metadata fields are invalid");
    }
    return {
      documentId: candidate.documentId,
      touchedBlockIds: candidate.touchedBlockIds as readonly string[],
    };
  };

  describe("Document HTTP binary wire", () => {
    test("round-trips bounded metadata and binary payload without header limits", () => {
      const touchedBlockIds = Array.from({ length: 1_000 }, (_value, index) => `block-${index}`);
      const payload = Uint8Array.from([0, 1, 2, 127, 128, 255]);
      const encoded = encodeDocumentHttpEnvelope(
        { documentId: "document-1", touchedBlockIds },
        payload,
      );

      const decoded = decodeDocumentHttpEnvelope(encoded, validateTestMetadata, payload.byteLength);

      expect(decoded.metadata.documentId).toBe("document-1");
      expect(decoded.metadata.touchedBlockIds.length).toBe(1_000);
      expect(Array.from(decoded.payload).join(",")).toBe("0,1,2,127,128,255");
    });

    test("rejects truncated, wrong-version, oversized, and invalid metadata", () => {
      const valid = encodeDocumentHttpEnvelope(
        { documentId: "document-1", touchedBlockIds: [] },
        Uint8Array.from([1, 2]),
      );
      const corruptVersion = valid.slice();
      corruptVersion[0] = 0;

      const failures = [
        () => decodeDocumentHttpEnvelope(valid.subarray(0, 7), validateTestMetadata, 2),
        () => decodeDocumentHttpEnvelope(corruptVersion, validateTestMetadata, 2),
        () => decodeDocumentHttpEnvelope(valid, validateTestMetadata, 1),
        () =>
          decodeDocumentHttpEnvelope(
            encodeDocumentHttpEnvelope({ unexpected: true }, new Uint8Array()),
            validateTestMetadata,
            0,
          ),
      ];

      expect(
        failures.every((run) => {
          try {
            run();
            return false;
          } catch (error) {
            return error instanceof DocumentHttpWireError;
          }
        }),
      ).toBe(true);
    });

    test("base64 conversion is byte-exact and bounded", () => {
      const bytes = Uint8Array.from([0, 17, 128, 254, 255]);
      const encoded = documentBytesToBase64(bytes);

      expect(Array.from(documentBytesFromBase64(encoded, 5)).join(",")).toBe("0,17,128,254,255");

      let oversized = false;
      try {
        documentBytesFromBase64(encoded, 4);
      } catch (error) {
        oversized = error instanceof DocumentHttpWireError;
      }
      expect(oversized).toBe(true);

      let malformed = false;
      try {
        documentBytesFromBase64("@@==", 4);
      } catch (error) {
        malformed = error instanceof DocumentHttpWireError;
      }
      expect(malformed).toBe(true);
    });
  });
});
