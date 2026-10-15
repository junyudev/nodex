import { describe, expect, it } from "vite-plus/test";

import { materializePortableCanvasScene } from "../../shared/block-documents";
import { DocumentHttpWireError } from "../../shared/block-documents/http-wire";
import { committedLocalCommit } from "../../shared/testing/local-commit";
import { createCoreCanvasSceneAdapter as createCoreCanvasSceneAdapterBase } from "./core-canvas-scene-adapter";
import { FakeCoreClient } from "./testing/fake-core-client";
import type { OwnedDocumentApplyResult } from "./types";

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
