import {
  canonicalizeCanvasSceneMutationRequest,
  canonicalizeCanvasSceneMutationResult,
  type CanvasSceneMutationCommandResult,
  type CanvasSceneMutationError,
  type CanvasSceneMutationRequest,
  type CanvasSceneRealtimeEvent,
  type CanvasSceneSubscribeRequest,
  type CanvasSceneSyncCommandResult,
  type CanvasSceneSyncRequest,
} from "../../shared/block-documents/canvas-scene-sync";
import { CanvasSceneContractError } from "../../shared/block-documents/canvas-scene";
import { DocumentHttpWireError } from "../../shared/block-documents/http-wire";
import {
  parseCanvasSceneCompactionResult,
  parseCanvasSceneCompactionStats,
  type CanvasSceneCompactionCommandResult,
  type CanvasSceneCompactionReadCommandResult,
  type CanvasSceneCompactionReadRequest,
  type CanvasSceneCompactionRequest,
  type CanvasSceneCompactionStats,
} from "../../shared/block-documents/canvas-scene-maintenance";
import { decodeCanvasSceneSseEvent } from "../../shared/block-documents/canvas-scene-http-contract";
import { CoreModuleResponseError } from "./core-client";
import { documentSessionError, unwrapDocumentSessionFailure } from "./document-session-error";
import {
  contentRoutingContextKey,
  type ContentRoutingContext,
  type ContentRoutingIdentity,
} from "../../shared/content-routing-context";
import {
  findCoreModulePayload,
  rendererLocalCommitApply,
  type CoreClientPort,
  type CoreRequestOptions,
  type CoreEventEnvelope,
} from "./types";

export type CoreCanvasSceneAdapterBinding = ContentRoutingIdentity;

type CanvasFailure = Extract<CanvasSceneMutationCommandResult, { readonly ok: false }>;
type CanvasSyncSuccess = Extract<CanvasSceneSyncCommandResult, { readonly ok: true }>;
type CanvasMutationSuccess = Extract<CanvasSceneMutationCommandResult, { readonly ok: true }>;
type CanvasCompactionReadSuccess = Extract<
  CanvasSceneCompactionReadCommandResult,
  { readonly ok: true }
>;
type CanvasCompactionSuccess = Extract<CanvasSceneCompactionCommandResult, { readonly ok: true }>;

class CanvasSceneAdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasSceneAdapterContractError";
  }
}

export interface CoreCanvasSceneAdapter {
  sync(request: CanvasSceneSyncRequest): Promise<CanvasSceneSyncCommandResult>;
  applyMutation(request: CanvasSceneMutationRequest): Promise<CanvasSceneMutationCommandResult>;
  readCompaction(
    request: CanvasSceneCompactionReadRequest,
  ): Promise<CanvasSceneCompactionReadCommandResult>;
  compact(
    request: CanvasSceneCompactionRequest,
    stats: CanvasSceneCompactionStats,
  ): Promise<CanvasSceneCompactionCommandResult>;
}

export interface CoreCanvasSceneCommands {
  readonly sync: (request: CanvasSceneSyncRequest) => Promise<CanvasSyncSuccess>;
  readonly applyMutation: (request: CanvasSceneMutationRequest) => Promise<CanvasMutationSuccess>;
  readonly readCompaction: (
    request: CanvasSceneCompactionReadRequest,
  ) => Promise<CanvasCompactionReadSuccess>;
  readonly compact: (
    request: CanvasSceneCompactionRequest,
    stats: CanvasSceneCompactionStats,
  ) => Promise<CanvasCompactionSuccess>;
}

/** Stateless Core protocol mapping; callers own admission and subscription authority. */
export const createCoreCanvasSceneCommands = (
  client: CoreClientPort,
  binding: CoreCanvasSceneAdapterBinding,
  options?: CoreRequestOptions,
): CoreCanvasSceneCommands => {
  const bindingAccessKey = contentRoutingContextKey(binding.routingContext);

  const assertBoundAccess = (routingContext: ContentRoutingContext): void => {
    if (contentRoutingContextKey(routingContext) === bindingAccessKey) return;
    throw new CanvasSceneAdapterContractError("Canvas request escaped its access boundary");
  };

  return {
    sync: async (request) => {
      assertBoundAccess(request.routingContext);
      const response = await client.documentCanvasSync(request, options);
      if (response.documentId !== request.documentId) {
        throw new CanvasSceneAdapterContractError("Core Canvas sync escaped its Document boundary");
      }
      if (
        response.libraryId !== binding.libraryId ||
        contentRoutingContextKey(response.routingContext) !== bindingAccessKey
      ) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas sync escaped its Library or access boundary",
        );
      }
      return { ok: true, value: response };
    },
    applyMutation: async (request) => {
      assertBoundAccess(request.routingContext);
      const canonical = canonicalizeCanvasSceneMutationRequest(request);
      const committed = await client.documentApply({
        operationId: canonical.mutationId,
        clientSessionId: canonical.clientSessionId,
        intent: {
          kind: "apply_canvas_mutation",
          document_id: canonical.documentId,
          generation: canonical.generation,
          expected_head_seq: canonical.baseHeadSeq,
          mutation: {
            elementCandidates: canonical.elementCandidates,
            appStateIntents: canonical.appStateIntents,
            fileAdditions: canonical.fileAdditions,
          },
        },
      });
      if (committed.outcome.canvas === undefined) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas mutation response has no Canvas result",
        );
      }
      const value = canonicalizeCanvasSceneMutationResult(committed.outcome.canvas);
      if (
        value.documentId !== canonical.documentId ||
        value.mutationId !== canonical.mutationId ||
        value.libraryId !== binding.libraryId ||
        contentRoutingContextKey(value.routingContext) !== bindingAccessKey
      ) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas mutation escaped its request boundary",
        );
      }
      return {
        ok: true,
        localCommit: rendererLocalCommitApply(committed),
        value,
      };
    },
    readCompaction: async (request) => {
      assertBoundAccess(request.routingContext);
      const snapshot = await client.documentRead(request.clientSessionId, {
        kind: "canvas_compaction_eligibility",
        document_id: request.documentId,
      });
      if (snapshot.value.kind !== "canvas_compaction_eligibility") {
        throw new CanvasSceneAdapterContractError(
          "Core returned the wrong Canvas maintenance read",
        );
      }
      const value = parseCanvasSceneCompactionStats(snapshot.value.stats);
      if (value.documentId !== request.documentId) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas maintenance read escaped its Document boundary",
        );
      }
      return { ok: true, value };
    },
    compact: async (request, stats) => {
      assertBoundAccess(request.routingContext);
      const committed = await client.documentApply({
        operationId: request.mutationId,
        clientSessionId: request.clientSessionId,
        intent: {
          kind: "compact_canvas_tombstones",
          document_id: request.documentId,
          generation: stats.generation,
          expected_head_seq: stats.headSeq,
          actor: { kind: "canvas_tombstone_compaction" },
        },
      });
      if (committed.outcome.canvas === undefined) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas compaction response has no Canvas result",
        );
      }
      const value = parseCanvasSceneCompactionResult(committed.outcome.canvas);
      if (
        value.documentId !== request.documentId ||
        value.operationId !== request.mutationId ||
        value.libraryId !== binding.libraryId ||
        contentRoutingContextKey(value.routingContext) !== bindingAccessKey
      ) {
        throw new CanvasSceneAdapterContractError(
          "Core Canvas compaction escaped its request boundary",
        );
      }
      return {
        ok: true,
        localCommit: rendererLocalCommitApply(committed),
        value,
      };
    },
  };
};

export const createCoreCanvasSceneAdapter = (
  client: CoreClientPort,
  binding: CoreCanvasSceneAdapterBinding,
): CoreCanvasSceneAdapter => {
  const commands = createCoreCanvasSceneCommands(client, binding);

  return {
    sync: async (request) => {
      try {
        return await commands.sync(request);
      } catch (error) {
        return mapCoreCanvasSceneFailure(error);
      }
    },
    applyMutation: async (request) => {
      try {
        return await commands.applyMutation(request);
      } catch (error) {
        return mapCoreCanvasSceneFailure(error, request.mutationId);
      }
    },
    readCompaction: async (request) => {
      try {
        return await commands.readCompaction(request);
      } catch (error) {
        return mapCoreCanvasSceneFailure(error);
      }
    },
    compact: async (request, stats) => {
      try {
        return await commands.compact(request, stats);
      } catch (error) {
        return mapCoreCanvasSceneFailure(error, request.mutationId);
      }
    },
  };
};

export const mapCanvasLiveEnvelope = (
  binding: CoreCanvasSceneAdapterBinding,
  request: CanvasSceneSubscribeRequest,
  envelope: CoreEventEnvelope,
): CanvasSceneRealtimeEvent | null => {
  const payload = findCoreModulePayload(envelope, "owned_document");
  if (payload?.module !== "owned_document") return null;
  const event = payload.event;
  if (event.kind === "canvas_generation_changed" && event.document_id === request.documentId) {
    return {
      type: "canvas_scene_resync_required",
      libraryId: binding.libraryId,
      routingContext: binding.routingContext,
      documentId: event.document_id,
      storeEpoch: envelope.packet.manifest.identity.store_epoch,
      generation: event.generation,
      headSeq: event.head_seq,
    };
  }
  if (event.kind !== "canvas_updated" || event.document_id !== request.documentId) {
    return null;
  }
  if (!envelope.packet.manifest.operation_id) return null;
  if (typeof event.mutation !== "object" || event.mutation === null) return null;
  try {
    return decodeCanvasSceneSseEvent(
      JSON.stringify({
        type: "canvas_scene_committed",
        libraryId: binding.libraryId,
        routingContext: binding.routingContext,
        documentId: event.document_id,
        storeEpoch: envelope.packet.manifest.identity.store_epoch,
        generation: event.generation,
        mutationId: envelope.packet.manifest.operation_id,
        baseHeadSeq: event.base_head_seq,
        headSeq: event.head_seq,
        sceneHash: event.scene_hash,
        ...event.mutation,
      }),
    );
  } catch {
    return null;
  }
};

export const mapCoreCanvasSceneFailure = (error: unknown, mutationId?: string): CanvasFailure => ({
  ok: false,
  error: canvasCommandError(error, mutationId),
});

const canvasCommandError = (failure: unknown, mutationId?: string): CanvasSceneMutationError => {
  const error = unwrapDocumentSessionFailure(failure);
  if (error instanceof CoreModuleResponseError) {
    const code = error.coreError.code;
    return {
      code: mapCoreErrorCode(code),
      message: error.message,
      retryable: error.coreError.retryable,
      resetRequired: code === "stale_store_epoch" || code === "generation_conflict",
      core: { code, recovery: error.coreError.recovery },
      ...(mutationId ? { mutationId } : {}),
    };
  }
  if (
    error instanceof DocumentHttpWireError ||
    error instanceof CanvasSceneContractError ||
    error instanceof CanvasSceneAdapterContractError
  ) {
    return {
      code: "canvas_scene_corrupt",
      message: error.message,
      retryable: false,
      resetRequired: false,
      ...(mutationId ? { mutationId } : {}),
    };
  }
  const documentError = documentSessionError(error);
  const code = documentError.code === "invalid_session" ? "invalid_session" : documentError.code;
  return {
    code:
      code === "transport_unavailable" ||
      code === "request_cancelled" ||
      code === "request_timeout" ||
      code === "service_busy" ||
      code === "invalid_response" ||
      code === "invalid_session"
        ? code
        : "unknown",
    message: documentError.message,
    retryable: documentError.retryable,
    resetRequired: false,
    ...(mutationId ? { mutationId } : {}),
  };
};

const mapCoreErrorCode = (
  code: CoreModuleResponseError["coreError"]["code"],
): CanvasSceneMutationError["code"] => {
  switch (code) {
    case "unauthorized":
      return "invalid_session";
    case "not_found":
      return "document_not_found";
    case "stale_store_epoch":
      return "store_epoch_mismatch";
    case "generation_conflict":
      return "document_generation_mismatch";
    case "head_conflict":
      return "future_base_head";
    case "revision_conflict":
      return "unknown";
    case "idempotency_key_reused":
      return "mutation_id_collision";
    case "invalid_document_schema":
    case "schema_unsupported":
      return "document_engine_mismatch";
    case "store_corrupt":
      return "canvas_scene_corrupt";
    case "invalid_input":
      return "invalid_canvas_scene_mutation";
    default:
      return "unknown";
  }
};
