import type { RecoveryDraftCapture } from "../../shared/block-documents/document-recovery";
import type { DocumentRecoverySnapshot } from "./document-local-checkpoint";
import type { QuarantinedCanvasSceneMutation } from "./canvas-scene-outbox";
import {
  CANVAS_DOCUMENT_SCHEMA_KEY,
  CANVAS_DOCUMENT_SCHEMA_VERSION,
} from "../../shared/block-documents";

/** JSON preserves every byte of the original envelope, including undecodable updates. */
export const encodeRecoveryEnvelope = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Uint8Array
      ? Array.from(item)
      : item instanceof ArrayBuffer
        ? Array.from(new Uint8Array(item))
        : item,
  );

export const captureDocumentRecovery = (
  snapshot: DocumentRecoverySnapshot,
): RecoveryDraftCapture => ({
  draft_id: snapshot.recoveryId,
  document_id: snapshot.documentId,
  source_store_epoch: snapshot.storeEpoch,
  generation: snapshot.generation,
  base_head_seq: snapshot.headSeq,
  created_at: snapshot.updatedAt,
  schema_key: snapshot.schema.schemaKey,
  schema_version: snapshot.schema.schemaVersion,
  content: {
    kind: "yjs",
    state: Array.from(new Uint8Array(snapshot.state)),
    unintegrated_updates: (snapshot.unintegratedUpdates ?? []).map((update) =>
      Array.from(new Uint8Array(update)),
    ),
  },
  source: JSON.parse(encodeRecoveryEnvelope(snapshot)) as unknown,
});

export const captureCanvasRecovery = (
  snapshot: QuarantinedCanvasSceneMutation,
): RecoveryDraftCapture => ({
  draft_id: `canvas:${snapshot.intent.documentId}:${snapshot.intent.mutationId}`,
  document_id: snapshot.intent.documentId,
  source_store_epoch: snapshot.intent.storeEpoch,
  generation: snapshot.intent.generation,
  base_head_seq: snapshot.intent.baseHeadSeq,
  created_at: new Date(snapshot.rejectedAt).toISOString(),
  schema_key: CANVAS_DOCUMENT_SCHEMA_KEY,
  schema_version: CANVAS_DOCUMENT_SCHEMA_VERSION,
  content: {
    kind: "canvas",
    scene: snapshot.scene ?? null,
    mutations: [
      {
        elementCandidates: snapshot.intent.elementCandidates,
        appStateIntents: snapshot.intent.appStateIntents,
        fileAdditions: snapshot.intent.fileAdditions,
      },
    ],
  },
  source: JSON.parse(encodeRecoveryEnvelope(snapshot)) as unknown,
});
