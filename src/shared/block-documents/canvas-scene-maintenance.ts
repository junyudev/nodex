import type { CanvasSceneMutationError } from "./canvas-scene-sync";
import type { LocalCommitCommandSuccess } from "../local-commit-delivery";
import { parseContentRoutingContext, type ContentRoutingContext } from "../content-routing-context";

export interface CanvasSceneCompactionReadRequest {
  readonly routingContext: ContentRoutingContext;
  readonly documentId: string;
  readonly clientSessionId: string;
}

export interface CanvasSceneCompactionRequest extends CanvasSceneCompactionReadRequest {
  readonly mutationId: string;
  readonly trigger: "automatic_idle";
}

export interface CanvasSceneCompactionStats {
  readonly documentId: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly sceneHash: string;
  readonly tombstoneCount: number;
  readonly tombstoneBytes: number;
  readonly eligible: boolean;
}

export interface CanvasSceneCompactionResult {
  readonly kind: "tombstone_compaction";
  readonly operationId: string;
  readonly libraryId: string;
  readonly routingContext: ContentRoutingContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly previousGeneration: number;
  readonly previousHeadSeq: number;
  readonly generation: number;
  readonly headSeq: number;
  readonly duplicate: boolean;
  readonly outcome: "committed" | "no_change";
  readonly sceneHash: string;
  readonly removedTombstoneCount: number;
  readonly removedTombstoneBytes: number;
  readonly checkpointVersionId: string | null;
  readonly committedAt: string;
}

export type CanvasSceneCompactionCommandResult =
  | LocalCommitCommandSuccess<CanvasSceneCompactionResult>
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

export type CanvasSceneCompactionReadCommandResult =
  | { readonly ok: true; readonly value: CanvasSceneCompactionStats }
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown, field: string, minimum: number): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
    return value;
  }
  throw new Error(`${field} must be a safe integer >= ${minimum}`);
};

const identity = (value: unknown, field: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  ) {
    return value;
  }
  throw new Error(`${field} must be a bounded identity`);
};

const hash = (value: unknown, field: string): string => {
  if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
  throw new Error(`${field} must be a lowercase SHA-256`);
};

export const parseCanvasSceneCompactionStats = (value: unknown): CanvasSceneCompactionStats => {
  if (!isRecord(value)) throw new Error("Canvas compaction stats must be an object");
  if (typeof value.eligible !== "boolean") {
    throw new Error("eligible must be boolean");
  }
  return {
    documentId: identity(value.document_id, "document_id"),
    generation: safeInteger(value.generation, "generation", 1),
    headSeq: safeInteger(value.head_seq, "head_seq", 0),
    sceneHash: hash(value.scene_hash, "scene_hash"),
    tombstoneCount: safeInteger(value.tombstone_count, "tombstone_count", 0),
    tombstoneBytes: safeInteger(value.tombstone_bytes, "tombstone_bytes", 0),
    eligible: value.eligible,
  };
};

export const parseCanvasSceneCompactionResult = (value: unknown): CanvasSceneCompactionResult => {
  if (!isRecord(value)) throw new Error("Canvas compaction result must be an object");
  if (
    value.kind !== "tombstone_compaction" ||
    (value.outcome !== "committed" && value.outcome !== "no_change") ||
    typeof value.duplicate !== "boolean" ||
    typeof value.committedAt !== "string" ||
    value.committedAt.length === 0 ||
    (value.checkpointVersionId !== null && typeof value.checkpointVersionId !== "string")
  ) {
    throw new Error("Canvas compaction result metadata is invalid");
  }
  const result: CanvasSceneCompactionResult = {
    kind: "tombstone_compaction",
    operationId: identity(value.operationId, "operationId"),
    libraryId: identity(value.libraryId, "libraryId"),
    routingContext: parseContentRoutingContext(value.routingContext),
    documentId: identity(value.documentId, "documentId"),
    storeEpoch: identity(value.storeEpoch, "storeEpoch"),
    previousGeneration: safeInteger(value.previousGeneration, "previousGeneration", 1),
    previousHeadSeq: safeInteger(value.previousHeadSeq, "previousHeadSeq", 0),
    generation: safeInteger(value.generation, "generation", 1),
    headSeq: safeInteger(value.headSeq, "headSeq", 0),
    duplicate: value.duplicate,
    outcome: value.outcome,
    sceneHash: hash(value.sceneHash, "sceneHash"),
    removedTombstoneCount: safeInteger(value.removedTombstoneCount, "removedTombstoneCount", 0),
    removedTombstoneBytes: safeInteger(value.removedTombstoneBytes, "removedTombstoneBytes", 0),
    checkpointVersionId: value.checkpointVersionId,
    committedAt: value.committedAt,
  };
  const validCommitted =
    result.outcome === "committed" &&
    result.generation === result.previousGeneration + 1 &&
    result.headSeq === 1 &&
    result.removedTombstoneCount > 0 &&
    result.checkpointVersionId !== null;
  const validNoChange =
    result.outcome === "no_change" &&
    result.generation === result.previousGeneration &&
    result.headSeq === result.previousHeadSeq &&
    result.removedTombstoneCount === 0 &&
    result.removedTombstoneBytes === 0 &&
    result.checkpointVersionId === null;
  if (!validCommitted && !validNoChange) {
    throw new Error("Canvas compaction result coordinates are inconsistent");
  }
  return result;
};
