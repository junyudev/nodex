import { describe, expect, test } from "vite-plus/test";
import {
  decodeCanvasSceneMutationRequestHttp,
  decodeCanvasSceneMutationResultHttp,
  decodeCanvasSceneSseEvent,
  decodeCanvasSceneSyncRequestHttp,
  decodeCanvasSceneSyncResultHttp,
  encodeCanvasSceneMutationRequestHttp,
  encodeCanvasSceneSyncRequestHttp,
} from "./canvas-scene-http-contract";
import { committedLocalCommit } from "../testing/local-commit";

describe("Canvas scene HTTP contract", () => {
  const emptyScene = {
    kind: "canvas_scene",
    schemaVersion: 2,
    elements: [],
    appState: {},
    files: {},
    pageReferences: [],
    plainText: "",
    preview: "",
  } as const;
  test("round-trips bounded sync and mutation requests with exact route scope", () => {
    const sync = decodeCanvasSceneSyncRequestHttp(
      encodeCanvasSceneSyncRequestHttp({
        syncRequestId: "sync-1",
        accessContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        clientSessionId: "client-1",
        knownStoreEpoch: "store-1",
        knownGeneration: 1,
        knownHeadSeq: 2,
        knownSceneHash: "a".repeat(64),
      }),
      { kind: "project", projectId: "project-1" },
      "canvas-1",
    );
    expect(sync.knownHeadSeq).toBe(2);
    const mutation = decodeCanvasSceneMutationRequestHttp(
      encodeCanvasSceneMutationRequestHttp({
        mutationId: "mutation-1",
        accessContext: { kind: "project", projectId: "project-1" },
        documentId: "canvas-1",
        storeEpoch: "store-1",
        generation: 1,
        baseHeadSeq: 2,
        clientSessionId: "client-1",
        elementCandidates: [],
        appStateIntents: {},
        fileAdditions: {},
      }),
      { kind: "project", projectId: "project-1" },
      "canvas-1",
    );
    expect(mutation.mutationId).toBe("mutation-1");
  });

  test("rejects a request whose Project route does not match", () => {
    const serialized = encodeCanvasSceneSyncRequestHttp({
      syncRequestId: "sync-2",
      accessContext: { kind: "project", projectId: "project-1" },
      documentId: "canvas-1",
      clientSessionId: "client-1",
    });
    expect(() =>
      decodeCanvasSceneSyncRequestHttp(
        serialized,
        { kind: "project", projectId: "project-2" },
        "canvas-1",
      ),
    ).toThrow("does not match its route");
  });

  test("rejects malformed successful sync and mutation envelopes", () => {
    expect(() =>
      decodeCanvasSceneSyncResultHttp(
        JSON.stringify({
          ok: true,
          value: {
            kind: "snapshot",
            syncRequestId: "sync-1",
            libraryId: "library-1",
            accessContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 0,
            scene: emptyScene,
          },
        }),
      ),
    ).toThrow("sceneHash");
    expect(() =>
      decodeCanvasSceneMutationResultHttp(
        JSON.stringify({
          ok: true,
          value: {
            mutationId: "mutation-1",
            libraryId: "library-1",
            accessContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            baseHeadSeq: 0,
            headSeq: 1,
            duplicate: false,
            outcome: "committed",
            sceneHash: "a".repeat(64),
            changedElementIds: [],
            appliedAppStateKeys: [],
            skippedAppStateKeys: [],
            addedFileIds: [],
            removedFileIds: [],
          },
        }),
      ),
    ).toThrow();
  });

  test("rejects malformed realtime coordinates and non-commit mutation events", () => {
    expect(() =>
      decodeCanvasSceneSseEvent(
        JSON.stringify({
          type: "canvas_scene_resync_required",
          libraryId: "library-1",
          accessContext: { kind: "project", projectId: "project-1" },
          documentId: "canvas-1",
          storeEpoch: "store-1",
          generation: 1,
          headSeq: "1",
        }),
      ),
    ).toThrow("headSeq");
    const value = {
      mutationId: "mutation-1",
      libraryId: "library-1",
      accessContext: { kind: "project", projectId: "project-1" },
      documentId: "canvas-1",
      storeEpoch: "store-1",
      generation: 1,
      baseHeadSeq: 0,
      headSeq: 1,
      duplicate: false,
      outcome: "committed",
      sceneHash: "a".repeat(64),
      changedElementIds: [],
      appliedAppStateKeys: [],
      skippedAppStateKeys: [],
      addedFileIds: [],
      removedFileIds: [],
      committedAt: "2026-07-13T00:00:00.000Z",
      committedDelta: {
        elementUpdates: [],
        appState: {},
        fileAdditions: {},
        removedFileIds: [],
      },
    };
    expect(() =>
      decodeCanvasSceneMutationResultHttp(
        JSON.stringify({
          ok: true,
          value,
          localCommit: committedLocalCommit("store-1", 1),
          event: {
            type: "canvas_scene_resync_required",
            libraryId: "library-1",
            accessContext: { kind: "project", projectId: "project-1" },
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 1,
          },
        }),
      ),
    ).toThrow("must be a committed event");
  });
});
