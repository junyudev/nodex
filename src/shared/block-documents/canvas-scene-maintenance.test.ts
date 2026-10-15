import { describe, expect, test } from "vite-plus/test";
import {
  parseCanvasSceneCompactionResult,
  parseCanvasSceneCompactionStats,
} from "./canvas-scene-maintenance";

describe("Canvas scene maintenance contract", () => {
  test("accepts exact eligibility and generation-rollover evidence", () => {
    expect(
      parseCanvasSceneCompactionStats({
        document_id: "document:canvas",
        generation: 3,
        head_seq: 42,
        scene_hash: "a".repeat(64),
        tombstone_count: 4,
        tombstone_bytes: 400,
        eligible: false,
      }),
    ).toMatchObject({
      generation: 3,
      headSeq: 42,
      tombstoneCount: 4,
    });
    expect(
      parseCanvasSceneCompactionResult({
        version: 1,
        kind: "tombstone_compaction",
        operationId: "compaction:one",
        libraryId: "library:one",
        routingContext: { kind: "project", projectId: "project:one" },
        documentId: "document:canvas",
        storeEpoch: "epoch:one",
        previousGeneration: 3,
        previousHeadSeq: 42,
        generation: 4,
        headSeq: 1,
        duplicate: false,
        outcome: "committed",
        sceneHash: "b".repeat(64),
        removedTombstoneCount: 4,
        removedTombstoneBytes: 400,
        checkpointVersionId: "version:before-compaction",
        committedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toMatchObject({
      previousGeneration: 3,
      generation: 4,
      headSeq: 1,
    });
  });

  test("rejects invalid eligibility and fake rollovers", () => {
    expect(() =>
      parseCanvasSceneCompactionStats({
        document_id: "document:canvas",
        generation: 3,
        head_seq: 42,
        scene_hash: "a".repeat(64),
        tombstone_count: 4,
        tombstone_bytes: 400,
        eligible: "yes",
      }),
    ).toThrow("eligible");
    expect(() =>
      parseCanvasSceneCompactionResult({
        version: 1,
        kind: "tombstone_compaction",
        operationId: "compaction:one",
        libraryId: "library:one",
        routingContext: { kind: "project", projectId: "project:one" },
        documentId: "document:canvas",
        storeEpoch: "epoch:one",
        previousGeneration: 3,
        previousHeadSeq: 42,
        generation: 3,
        headSeq: 43,
        duplicate: false,
        outcome: "committed",
        sceneHash: "b".repeat(64),
        removedTombstoneCount: 4,
        removedTombstoneBytes: 400,
        checkpointVersionId: "version:before-compaction",
        committedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toThrow("coordinates");
  });
});
