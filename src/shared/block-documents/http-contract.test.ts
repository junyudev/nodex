import { describe, expect, test } from "vite-plus/test";
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
import { decodeDocumentHttpEnvelope, encodeDocumentHttpEnvelope } from "./http-wire";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "./page-document";
import type { AuthorizedDeliveryPacket } from "../authorized-delivery-packet";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const documentDelivery = (): AuthorizedDeliveryPacket => ({
  packet_version: 4,
  delivery_address: {
    kind: "document",
    library_id: "library-1",
    project_id: "project-1",
    document_id: "document-1",
  },
  authorization_scope: {
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
  visibility_deltas: [],
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
        accessContext: { kind: "library" },
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
        authorization: null,
        sync: { kind: "yjs", stateVector: bytes(1, 2, 3) },
      }),
    );
    expect(descriptor.accessContext).toEqual({ kind: "library" });
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
      accessContext: { kind: "project", projectId: "project-1" },
      ownerLifecycle: "active",
      storeEpoch: "store-1",
      generation: 2,
      headSeq: 7,
      schemaVersion: 1,
      readiness: "ready",
      authorization: null,
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
      version: 3,
      libraryId: "library-1",
      accessContext: { kind: "project", projectId: "project-1" },
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
      authorization: null,
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
    expect(decodedAck.delivery?.packet_version).toBe(4);
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
      accessContext: { kind: "project", projectId: "project-1" },
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
        request.accessContext,
        encodeCanvasSceneSyncHttpRequest(request),
      ),
    ).toEqual(request);

    const snapshot = encodeCanvasSceneSyncHttpResponse({
      kind: "snapshot",
      syncRequestId: request.syncRequestId,
      libraryId: "library-1",
      accessContext: request.accessContext,
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
      accessContext: request.accessContext,
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
      accessContext: request.accessContext,
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
      accessContext: { kind: "project", projectId: "project-1" },
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
      accessContext: { kind: "project", projectId: "project-1" },
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
    expect(decodeDocumentHttpError(encodeDocumentHttpError(error)).code).toBe("document_not_ready");

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
