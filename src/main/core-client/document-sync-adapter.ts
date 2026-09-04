import { documentSessionError, rethrowCoreTransportFailure } from "./document-session-error";
import { createHash } from "node:crypto";
import type { components } from "@nodex/core-protocol";

import { revocationsFromVisibilityDelta } from "../../shared/local-commit-delivery";

import {
  encodeAdditionalDocumentCommandSemanticHashInput,
  parseAdditionalDocumentCommandRequest,
  parseAdditionalDocumentCommandResult,
  type AdditionalDocumentCommandErrorCode,
  type AdditionalDocumentCommandRequest,
  type AdditionalDocumentCommandResult,
  type AdditionalDocumentHeadRevision,
  type AdditionalDocumentLibraryPlacement,
} from "../../shared/additional-document-commands";
import type {
  CreateDocumentVersionCheckpoint,
  CreatedDocumentVersionSummary,
  DocumentVersionDetail,
  DocumentVersionSummary,
  GetDocumentVersion,
  ListDocumentVersions,
  PrepareDocumentVersionRestore,
} from "../../shared/block-documents/document-history";
import {
  DocumentHistoryContractError,
  documentHistoryFailure,
  parseDocumentVersionDetail,
  parseDocumentVersionSummary,
  type DocumentHistoryCommandResult,
} from "../../shared/block-documents/document-history-transport";
import {
  DocumentOperationContractError,
  parseDocumentOperationBatch,
  parseDocumentOperationResult,
  parseReplaceDocumentFromNfm,
  parseDocumentVersionRestore,
  type DocumentMutationRequest,
  type DocumentOperationBatch,
  type DocumentOperationCommandResult,
} from "../../shared/block-documents/document-operations";
import { documentMutationFailure } from "../../shared/block-documents/document-operation-transport";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents/contracts";
import { decodeOwnedDocumentDescriptorHttp } from "../../shared/block-documents/http-contract";
import { documentBytesToBase64 } from "../../shared/block-documents/http-wire";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncCommandError,
  DocumentSyncCommandResult,
  DocumentUpdateResourceReadResult,
  DocumentUpdateResourceRef,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
} from "../../shared/block-documents/document-sync";
import { CoreModuleResponseError } from "./core-client";
import { applyResultCursor, applyResultStoreEpoch, rendererLocalCommitApply } from "./types";
import {
  resolveAuthorizedDocumentEffect,
  type ExactDocumentUpdateFetcher,
} from "./document-effect-delivery";
import type { CoreClientPort, CoreEventEnvelope, OwnedDocumentIntent } from "./types";

type CoreDocumentOwnerCommand = Extract<
  OwnedDocumentIntent,
  { readonly kind: "apply_owner_command" }
>["command"];

class DocumentUpdateResourceIntegrityError extends Error {}

const decodeCoreOwnedDocumentDescriptor = (
  value: components["schemas"]["OwnedDocumentDescriptor"],
): OwnedDocumentDescriptor => {
  if (value.sync.kind !== "yjs") {
    return decodeOwnedDocumentDescriptorHttp(
      JSON.stringify({
        ...value,
        authorization: null,
      }),
    );
  }
  const stateVector = value.sync.stateVector;
  if (
    !Array.isArray(stateVector) ||
    stateVector.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error("Core Owned Document state vector is invalid");
  }
  return decodeOwnedDocumentDescriptorHttp(
    JSON.stringify({
      ...value,
      authorization: null,
      sync: {
        kind: "yjs",
        stateVector: documentBytesToBase64(Uint8Array.from(stateVector)),
      },
    }),
  );
};

export interface CoreDocumentSyncAdapter {
  sync(request: DocumentSyncRequest): Promise<DocumentSyncCommandResult<DocumentSyncResponse>>;
  applyUpdate(
    request: DocumentSyncApplyRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>>;
  publishAwareness(
    request: DocumentAwarenessPublishRequest,
  ): Promise<DocumentSyncCommandResult<DocumentAwarenessPublishAck>>;
  readDescriptor(input: {
    readonly ownerBlockId: string;
    readonly clientSessionId: string;
  }): Promise<OwnedDocumentDescriptor>;
  fetchUpdateResource(
    input: DocumentUpdateResourceRef & {
      readonly clientSessionId: string;
    },
  ): Promise<DocumentSyncCommandResult<DocumentUpdateResourceReadResult>>;
  prepareOwner(input: {
    readonly ownerBlockId: string;
    readonly operationId: string;
    readonly clientSessionId: string;
  }): Promise<DocumentSyncCommandResult<OwnedDocumentDescriptor>>;
  applyAdditionalDocumentCommand(
    request: AdditionalDocumentCommandRequest,
  ): Promise<AdditionalDocumentCommandResult>;
  createCheckpoint(
    request: CreateDocumentVersionCheckpoint,
  ): Promise<DocumentHistoryCommandResult<CreatedDocumentVersionSummary>>;
  listVersions(
    request: ListDocumentVersions,
  ): Promise<DocumentHistoryCommandResult<readonly DocumentVersionSummary[]>>;
  getVersion(
    request: GetDocumentVersion,
  ): Promise<DocumentHistoryCommandResult<DocumentVersionDetail>>;
  restoreVersion(request: PrepareDocumentVersionRestore): Promise<DocumentOperationCommandResult>;
  applyDocumentMutation(request: DocumentMutationRequest): Promise<DocumentOperationCommandResult>;
}

const executionHead = (
  request: AdditionalDocumentCommandRequest,
  revision: { readonly documentId: string; readonly generation: number },
): AdditionalDocumentHeadRevision => {
  if (request.coordination.kind === "receipt_replay") {
    return { ...revision, headSeq: 0 };
  }
  if (request.coordination.kind !== "hub_lease") {
    throw new TypeError(
      `Additional Document command is missing an execution head for ${revision.documentId}`,
    );
  }
  const head = request.coordination.documents.find(
    (candidate) => candidate.documentId === revision.documentId,
  );
  if (head?.generation === revision.generation) return head;
  throw new TypeError(
    `Additional Document command crossed the generation of ${revision.documentId}`,
  );
};

const coreHead = (
  request: AdditionalDocumentCommandRequest,
  revision: { readonly documentId: string; readonly generation: number },
) => {
  const head = executionHead(request, revision);
  return {
    document_id: head.documentId,
    generation: head.generation,
    head_seq: head.headSeq,
  };
};

const coreLibraryAnchor = (placement: AdditionalDocumentLibraryPlacement) => {
  const before = placement.before;
  return before
    ? {
        block_id: before.blockId,
        expected_location_revision: before.expectedLocationRevision,
      }
    : undefined;
};

const coreOwnerCommand = (request: AdditionalDocumentCommandRequest): CoreDocumentOwnerCommand => {
  const operation = request.operation;
  switch (operation.kind) {
    case "create_synced_source":
      return {
        kind: operation.kind,
        source_block_id: operation.sourceBlockId,
        document_id: operation.documentId,
        initial_blocks: operation.initialBlocks,
        before: coreLibraryAnchor(operation.placement),
      };
    case "promote_synced_source":
      return {
        kind: operation.kind,
        host: coreHead(request, operation.host),
        root_block_id: operation.rootBlockId,
        reference_block_id: operation.referenceBlockId,
        source_block_id: operation.sourceBlockId,
        source_document_id: operation.sourceDocumentId,
      };
    case "demote_synced_source":
      return {
        kind: operation.kind,
        host: coreHead(request, operation.host),
        source: coreHead(request, operation.source),
        reference_block_id: operation.referenceBlockId,
        source_block_id: operation.sourceBlockId,
      };
    case "create_template":
      return {
        kind: operation.kind,
        source_block_id: operation.sourceBlockId,
        document_id: operation.documentId,
        display_name: operation.displayName,
        initial_blocks: operation.initialBlocks,
        before: coreLibraryAnchor(operation.placement),
      };
    case "instantiate_template":
      return {
        kind: operation.kind,
        source_block_id: operation.sourceBlockId,
        source: coreHead(request, operation.source),
        target: coreHead(request, operation.target),
        parent_block_id: operation.parentBlockId,
        before_block_id: operation.beforeBlockId,
      };
    case "delete_owned_source": {
      const ownerHead = coreHead(request, operation.owner);
      return {
        kind: operation.kind,
        owner_kind: operation.ownerKind,
        owner: {
          owner_block_id: operation.owner.ownerBlockId,
          document_id: operation.owner.documentId,
          generation: operation.owner.generation,
          head_seq: ownerHead.head_seq,
          metadata_revision: operation.owner.metadataRevision,
          location_revision: operation.owner.locationRevision,
        },
      };
    }
  }
};

const additionalDocumentErrorCode = (
  error: unknown,
): { readonly code: AdditionalDocumentCommandErrorCode; readonly retryable: boolean } => {
  if (!(error instanceof CoreModuleResponseError)) {
    return { code: "unknown", retryable: documentSessionError(error).retryable };
  }
  const message = error.message.toLowerCase();
  switch (error.coreError.code) {
    case "invalid_input":
      return { code: "invalid_request", retryable: false };
    case "unauthorized":
      return { code: "project_not_found", retryable: false };
    case "not_found":
      if (message.includes("bound project")) {
        return { code: "project_not_found", retryable: false };
      }
      if (message.includes("reference") || message.includes("instance")) {
        return { code: "reference_not_found", retryable: false };
      }
      return { code: "source_not_found", retryable: false };
    case "stale_store_epoch":
      return { code: "store_epoch_mismatch", retryable: false };
    case "revision_conflict":
      if (message.includes("still referenced")) {
        return { code: "source_referenced", retryable: false };
      }
      if (message.includes("sole instance")) {
        return { code: "source_shared", retryable: false };
      }
      return { code: "block_revision_conflict", retryable: false };
    case "generation_conflict":
      return { code: "document_generation_mismatch", retryable: false };
    case "head_conflict":
      return { code: "document_head_conflict", retryable: false };
    case "idempotency_key_reused":
      return { code: "operation_id_collision", retryable: false };
    case "invalid_document_schema":
    case "schema_unsupported":
    case "store_corrupt":
      return { code: "document_state_corrupt", retryable: false };
    case "maintenance_in_progress":
      return { code: "unknown", retryable: documentSessionError(error).retryable };
    case "core_unavailable":
      if (
        message.includes("identity already exists") ||
        message.includes("cannot be reused") ||
        message.includes("cannot be deleted")
      ) {
        return { code: "identity_conflict", retryable: false };
      }
      return { code: "unknown", retryable: documentSessionError(error).retryable };
    default:
      return { code: "unknown", retryable: error.coreError.retryable };
  }
};

const additionalDocumentFailure = (
  request: AdditionalDocumentCommandRequest,
  error: unknown,
): AdditionalDocumentCommandResult => {
  const mapped = additionalDocumentErrorCode(error);
  return parseAdditionalDocumentCommandResult({
    ok: false,
    error: {
      ...mapped,
      message: error instanceof Error ? error.message : String(error),
      operationId: request.operationId,
      operationKind: request.operation.kind,
    },
  });
};

const historyFailure = <Value>(
  error: unknown,
  expected: {
    readonly generation?: number;
    readonly headSeq?: number;
  } = {},
): DocumentHistoryCommandResult<Value> => {
  if (error instanceof DocumentHistoryContractError) {
    return {
      ok: false,
      error: documentHistoryFailure("document_history_corrupt", error.message),
    };
  }
  if (!(error instanceof CoreModuleResponseError)) {
    return {
      ok: false,
      error: documentHistoryFailure(
        "unknown",
        error instanceof Error ? error.message : String(error),
        { retryable: documentSessionError(error).retryable },
      ),
    };
  }
  const recovery = error.coreError.recovery;
  switch (error.coreError.code) {
    case "invalid_input":
      return {
        ok: false,
        error: documentHistoryFailure("invalid_document_history_request", error.message),
      };
    case "unauthorized":
      return {
        ok: false,
        error: documentHistoryFailure("project_scope_mismatch", error.message),
      };
    case "not_found":
      return {
        ok: false,
        error: documentHistoryFailure(
          error.message.toLowerCase().includes("version") ||
            error.message.toLowerCase().includes("cursor")
            ? "document_version_not_found"
            : "document_not_found",
          error.message,
        ),
      };
    case "stale_store_epoch":
      return {
        ok: false,
        error: documentHistoryFailure("store_epoch_mismatch", error.message),
      };
    case "generation_conflict":
      return {
        ok: false,
        error: documentHistoryFailure("document_generation_conflict", error.message, {
          expectedGeneration: expected.generation,
          ...(recovery.kind === "current_document_head"
            ? { actualGeneration: recovery.generation }
            : {}),
        }),
      };
    case "head_conflict":
      return {
        ok: false,
        error: documentHistoryFailure("document_head_conflict", error.message, {
          expectedHeadSeq: expected.headSeq,
          ...(recovery.kind === "current_document_head"
            ? { actualHeadSeq: recovery.head_seq }
            : {}),
        }),
      };
    case "invalid_document_schema":
    case "schema_unsupported":
      return {
        ok: false,
        error: documentHistoryFailure("document_version_schema_mismatch", error.message),
      };
    case "store_corrupt":
      return {
        ok: false,
        error: documentHistoryFailure("document_history_corrupt", error.message),
      };
    default:
      return {
        ok: false,
        error: documentHistoryFailure("unknown", error.message, {
          retryable: error.coreError.retryable,
        }),
      };
  }
};

const documentMutationAdapterFailure = (
  request: DocumentMutationRequest,
  error: unknown,
): DocumentOperationCommandResult => {
  if (error instanceof DocumentOperationContractError) {
    return {
      ok: false,
      error: documentMutationFailure("document_state_corrupt", error.message, {
        mutationId: request.mutationId,
      }),
    };
  }
  if (!(error instanceof CoreModuleResponseError)) {
    return {
      ok: false,
      error: documentMutationFailure(
        "unknown",
        error instanceof Error ? error.message : String(error),
        { mutationId: request.mutationId, retryable: documentSessionError(error).retryable },
      ),
    };
  }
  const recovery = error.coreError.recovery;
  const failure = (
    code: Parameters<typeof documentMutationFailure>[0],
    options: Parameters<typeof documentMutationFailure>[2] = {},
  ): DocumentOperationCommandResult => ({
    ok: false,
    error: documentMutationFailure(code, error.message, {
      mutationId: request.mutationId,
      ...options,
    }),
  });
  switch (error.coreError.code) {
    case "invalid_input":
      if (
        error.message.includes("Duplicate Block identity") ||
        error.message.includes("DuplicateBlockId")
      ) {
        return failure("duplicate_block_id");
      }
      if (error.message.includes("BlockNotFound")) {
        return failure("block_not_found");
      }
      if (error.message.includes("InvalidAnchor")) {
        return failure("invalid_anchor");
      }
      if (error.message.includes("AncestorCycle")) {
        return failure("ancestor_cycle");
      }
      if (error.message.includes("InvalidBlock")) {
        return failure("invalid_block");
      }
      return failure("invalid_operation");
    case "unauthorized":
      return failure("project_scope_mismatch");
    case "not_found":
      return failure(
        "versionId" in request && error.message.toLowerCase().includes("version")
          ? "document_version_not_found"
          : "document_not_found",
      );
    case "stale_store_epoch":
      return failure("store_epoch_mismatch");
    case "generation_conflict":
      return failure("document_generation_conflict", {
        expectedGeneration: request.generation,
        ...(recovery.kind === "current_document_head"
          ? { actualGeneration: recovery.generation }
          : {}),
      });
    case "head_conflict":
      return failure("document_head_conflict", {
        expectedHeadSeq: request.expectedHeadSeq,
        ...(recovery.kind === "current_document_head" ? { actualHeadSeq: recovery.head_seq } : {}),
      });
    case "idempotency_key_reused":
      return failure("mutation_id_collision");
    case "revision_conflict":
      return failure("unknown", { retryable: error.coreError.retryable });
    case "invalid_document_schema":
    case "schema_unsupported":
      return failure("invalid_operation");
    case "store_corrupt":
      return failure("document_state_corrupt");
    default:
      return failure("unknown", { retryable: error.coreError.retryable });
  }
};

const parseDocumentMutationRequest = (
  request: DocumentMutationRequest,
): DocumentMutationRequest => {
  if ("operations" in request) return parseDocumentOperationBatch(request);
  if ("nfm" in request) return parseReplaceDocumentFromNfm(request);
  return parseDocumentVersionRestore(request);
};

const coreDocumentOperation = (
  operation: DocumentOperationBatch["operations"][number],
): Extract<
  OwnedDocumentIntent,
  { readonly kind: "apply_operation_batch" }
>["operations"][number] => {
  switch (operation.kind) {
    case "set_title":
      return { kind: "set_title", title: operation.title };
    case "set_rich_title":
      return { kind: "set_rich_title", rich_title: operation.richTitle };
    case "insert_block":
      return {
        kind: "insert_block",
        block: operation.block,
        ...(operation.parentBlockId === undefined
          ? {}
          : { parent_block_id: operation.parentBlockId }),
        ...(operation.beforeBlockId === undefined
          ? {}
          : { before_block_id: operation.beforeBlockId }),
      };
    case "update_block":
      return {
        kind: "update_block",
        block_id: operation.blockId,
        patch: {
          ...(operation.patch.type === undefined ? {} : { block_type: operation.patch.type }),
          ...(operation.patch.props === undefined ? {} : { props: operation.patch.props }),
          content: Object.hasOwn(operation.patch, "content")
            ? { kind: "value", value: operation.patch.content }
            : { kind: "absent" },
          unset_content: operation.patch.unsetContent === true,
        },
      };
    case "delete_block":
      return { kind: "delete_block", block_id: operation.blockId };
    case "move_block":
      return {
        kind: "move_block",
        block_id: operation.blockId,
        ...(operation.parentBlockId === undefined
          ? {}
          : { parent_block_id: operation.parentBlockId }),
        ...(operation.beforeBlockId === undefined
          ? {}
          : { before_block_id: operation.beforeBlockId }),
      };
  }
};

const coreDocumentMutationIntent = (request: DocumentMutationRequest): OwnedDocumentIntent => {
  if ("operations" in request) {
    return {
      kind: "apply_operation_batch",
      document_id: request.documentId,
      generation: request.generation,
      expected_head_seq: request.expectedHeadSeq,
      operations: request.operations.map(coreDocumentOperation),
      actor: request.actor,
    };
  }
  if ("nfm" in request) {
    return {
      kind: "replace_from_nfm",
      document_id: request.documentId,
      generation: request.generation,
      expected_head_seq: request.expectedHeadSeq,
      nfm: request.nfm,
      ...(request.richTitle === undefined ? {} : { rich_title: request.richTitle }),
      actor: request.actor,
    };
  }
  return {
    kind: "restore_version",
    document_id: request.documentId,
    version_id: request.versionId,
    generation: request.generation,
    expected_head_seq: request.expectedHeadSeq,
    actor: request.actor,
  };
};

const documentMutationKind = (
  request: DocumentMutationRequest,
): "document_operation_batch" | "replace_document_from_nfm" | "document_version_restore" => {
  if ("operations" in request) return "document_operation_batch";
  if ("nfm" in request) return "replace_document_from_nfm";
  return "document_version_restore";
};

const assertHistoryScope = (
  summary: DocumentVersionSummary,
  request: { readonly projectId: string; readonly documentId: string },
): DocumentVersionSummary => {
  if (summary.projectId === request.projectId && summary.documentId === request.documentId) {
    return summary;
  }
  throw new DocumentHistoryContractError(
    "Core Document version escaped its Project or Document boundary",
  );
};

export const createCoreDocumentSyncAdapter = (client: CoreClientPort): CoreDocumentSyncAdapter => {
  const updateResourceFetches = new Map<
    string,
    Promise<DocumentSyncCommandResult<DocumentUpdateResourceReadResult>>
  >();

  const sync = async (
    request: DocumentSyncRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncResponse>> => {
    try {
      return success(await client.documentSync(request));
    } catch (error) {
      rethrowCoreTransportFailure(error);
      return failure(error);
    }
  };

  const applyUpdate = async (
    request: DocumentSyncApplyRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>> => {
    try {
      return success(await client.documentApplyUpdate(request));
    } catch (error) {
      rethrowCoreTransportFailure(error);
      return failure(error);
    }
  };

  const readDescriptor = async (input: {
    readonly ownerBlockId: string;
    readonly clientSessionId: string;
  }): Promise<OwnedDocumentDescriptor> => {
    const snapshot = await client.documentRead(input.clientSessionId, {
      kind: "descriptor",
      owner_block_id: input.ownerBlockId,
    });
    if (snapshot.value.kind !== "descriptor") {
      throw new Error("Core returned a non-descriptor Document read value");
    }
    const descriptor = decodeCoreOwnedDocumentDescriptor(snapshot.value.descriptor);
    if (!snapshot.authorization) {
      throw new Error("Core Owned Document descriptor omitted canonical authorization");
    }
    if (descriptor.ownerBlockId !== input.ownerBlockId) {
      throw new Error("Core Owned Document descriptor escaped its owner boundary");
    }
    return { ...descriptor, authorization: snapshot.authorization };
  };

  const readUpdateResource = async (
    input: DocumentUpdateResourceRef & { readonly clientSessionId: string },
  ): Promise<DocumentSyncCommandResult<DocumentUpdateResourceReadResult>> => {
    try {
      const snapshot = await client.documentRead(input.clientSessionId, {
        kind: "fetch_update",
        document_id: input.documentId,
        generation: input.generation,
        update_id: input.updateId,
        update_hash: input.updateHash,
      });
      if (snapshot.value.kind === "update_resource_unavailable") {
        const unavailable = snapshot.value.unavailable;
        return success({
          kind: "resync-required",
          documentId: unavailable.document_id,
          requestedGeneration: unavailable.requested_generation,
          currentGeneration: unavailable.current_generation,
          currentHeadSeq: unavailable.current_head_seq,
          updateId: unavailable.update_id,
          updateHash: unavailable.update_hash,
          reason: unavailable.reason,
        });
      }
      if (snapshot.value.kind !== "update_resource") {
        throw new Error("Core returned a non-resource Document read value");
      }
      const resource = snapshot.value.resource;
      const update = Uint8Array.from(resource.update);
      const updateHash = createHash("sha256").update(update).digest("hex");
      if (
        resource.document_id !== input.documentId ||
        resource.generation !== input.generation ||
        resource.update_id !== input.updateId ||
        resource.update_hash !== input.updateHash ||
        updateHash !== resource.update_hash ||
        update.byteLength !== resource.update_byte_length
      ) {
        throw new DocumentUpdateResourceIntegrityError(
          "Core Document update resource failed exact verification",
        );
      }
      return success({
        kind: "available",
        documentId: resource.document_id,
        generation: resource.generation,
        baseHeadSeq: resource.base_head_seq,
        headSeq: resource.head_seq,
        updateId: resource.update_id,
        updateHash: resource.update_hash,
        updateByteLength: resource.update_byte_length,
        update,
      });
    } catch (error) {
      rethrowCoreTransportFailure(error);
      return failure(error);
    }
  };

  const fetchUpdateResource = (
    input: DocumentUpdateResourceRef & { readonly clientSessionId: string },
  ): Promise<DocumentSyncCommandResult<DocumentUpdateResourceReadResult>> => {
    const key = JSON.stringify([
      input.documentId,
      input.generation,
      input.updateId,
      input.updateHash,
    ]);
    const existing = updateResourceFetches.get(key);
    if (existing) return existing;

    const fetch = readUpdateResource(input).finally(() => {
      if (updateResourceFetches.get(key) === fetch) {
        updateResourceFetches.delete(key);
      }
    });
    updateResourceFetches.set(key, fetch);
    return fetch;
  };

  const applyDocumentMutation = async (
    rawRequest: DocumentMutationRequest,
  ): Promise<DocumentOperationCommandResult> => {
    let request: DocumentMutationRequest;
    try {
      request = parseDocumentMutationRequest(rawRequest);
    } catch (error) {
      rethrowCoreTransportFailure(error);
      return {
        ok: false,
        error: documentMutationFailure(
          "invalid_document_operation_request",
          error instanceof Error ? error.message : String(error),
          { mutationId: rawRequest.mutationId },
        ),
      };
    }
    try {
      const committed = await client.documentApply({
        operationId: request.mutationId,
        clientSessionId: request.clientSessionId ?? "electron:document-mutation",
        intent: coreDocumentMutationIntent(request),
      });
      const storeEpoch = applyResultStoreEpoch(committed);
      if (
        storeEpoch !== request.storeEpoch ||
        committed.receipt.operation_id !== request.mutationId ||
        committed.receipt.document_id !== request.documentId ||
        committed.receipt.generation !== request.generation ||
        committed.outcome.document_id !== request.documentId ||
        committed.outcome.generation !== request.generation ||
        committed.outcome.head_seq !== committed.receipt.head_seq
      ) {
        throw new DocumentOperationContractError(
          "Core Document mutation receipt escaped its request boundary",
        );
      }
      if (committed.outcome.outcome === "no_change") {
        if (committed.status !== "no_op") {
          throw new DocumentOperationContractError(
            "Core no-change Document mutation claimed a semantic commit",
          );
        }
        if (committed.outcome.head_seq !== request.expectedHeadSeq) {
          throw new DocumentOperationContractError(
            "Core no-change Document mutation advanced the head",
          );
        }
        return {
          ok: false,
          error: documentMutationFailure(
            "no_change",
            "versionId" in request
              ? `Document is already equal to version ${request.versionId}`
              : "Document mutation makes no semantic change",
            { mutationId: request.mutationId },
          ),
        };
      }
      if (committed.status !== "committed") {
        throw new DocumentOperationContractError(
          "Core advancing Document mutation omitted its commit identity",
        );
      }
      const effect = committed.outcome.mutation_effect;
      const committedAt = committed.outcome.committed_at;
      if (
        !effect ||
        !committedAt ||
        effect.base_head_seq !== request.expectedHeadSeq ||
        committed.outcome.head_seq !== request.expectedHeadSeq + 1
      ) {
        throw new DocumentOperationContractError(
          "Core Document mutation effect escaped its exact head boundary",
        );
      }
      const touched = new Set(effect.touched_block_ids);
      if (
        [
          ...effect.created_block_ids,
          ...effect.deleted_block_ids,
          ...effect.updated_block_ids,
          ...effect.moved_block_ids,
        ].some((blockId) => !touched.has(blockId))
      ) {
        throw new DocumentOperationContractError(
          "Core Document mutation effect omitted a semantic change from touched Blocks",
        );
      }
      if ("versionId" in request && effect.coordination !== "write_fence") {
        throw new DocumentOperationContractError(
          "Core Document restore effect is not write fenced",
        );
      }
      const result = parseDocumentOperationResult({
        mutationKind: documentMutationKind(request),
        mutationId: request.mutationId,
        projectId: request.projectId,
        storeEpoch,
        documentId: committed.outcome.document_id,
        generation: committed.outcome.generation,
        baseHeadSeq: effect.base_head_seq,
        headSeq: committed.outcome.head_seq,
        touchedBlockIds: effect.touched_block_ids,
        createdBlockIds: effect.created_block_ids,
        deletedBlockIds: effect.deleted_block_ids,
        updatedBlockIds: effect.updated_block_ids,
        movedBlockIds: effect.moved_block_ids,
        writeFenceBlockIds: effect.write_fence_block_ids,
        titleChanged: effect.title_changed,
        coordination: effect.coordination,
        commitSeq: applyResultCursor(committed),
        committedAt,
        duplicate: committed.receipt.duplicate,
      });
      if (
        result.projectId !== request.projectId ||
        result.documentId !== request.documentId ||
        result.mutationId !== request.mutationId
      ) {
        throw new DocumentOperationContractError(
          "Core Document mutation result escaped its public identity boundary",
        );
      }
      return {
        ok: true,
        value: result,
        localCommit: rendererLocalCommitApply(committed),
      };
    } catch (error) {
      rethrowCoreTransportFailure(error);
      return documentMutationAdapterFailure(request, error);
    }
  };

  return {
    readDescriptor,
    fetchUpdateResource,
    prepareOwner: async (input) => {
      try {
        const committed = await client.documentApply({
          operationId: input.operationId,
          clientSessionId: input.clientSessionId,
          intent: {
            kind: "prepare_owner",
            owner_block_id: input.ownerBlockId,
          },
        });
        const descriptor = await readDescriptor(input);
        const storeEpoch = applyResultStoreEpoch(committed);
        if (
          committed.receipt.operation_id !== input.operationId ||
          committed.receipt.document_id !== descriptor.documentId ||
          committed.outcome.document_id !== descriptor.documentId ||
          committed.outcome.generation !== descriptor.generation ||
          committed.outcome.head_seq > descriptor.headSeq ||
          storeEpoch !== descriptor.storeEpoch
        ) {
          throw new Error("Core Owned Document preparation escaped its owner boundary");
        }
        return success(descriptor);
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return failure(error);
      }
    },
    applyAdditionalDocumentCommand: async (rawRequest) => {
      let request: AdditionalDocumentCommandRequest;
      try {
        request = parseAdditionalDocumentCommandRequest(rawRequest);
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return additionalDocumentFailure(rawRequest, error);
      }
      try {
        const committed = await client.documentApply({
          operationId: request.operationId,
          clientSessionId: request.clientSessionId,
          intent: {
            kind: "apply_owner_command",
            command: coreOwnerCommand(request),
          },
        });
        const effect = committed.outcome.owner_effect;
        const committedAt = committed.outcome.committed_at;
        const storeEpoch = applyResultStoreEpoch(committed);
        if (
          storeEpoch !== request.storeEpoch ||
          committed.receipt.operation_id !== request.operationId ||
          !effect ||
          !committedAt
        ) {
          throw new Error(
            "Core Additional Document receipt escaped its operation or Store boundary",
          );
        }
        const semanticHash = createHash("sha256")
          .update(encodeAdditionalDocumentCommandSemanticHashInput(request))
          .digest("hex");
        return parseAdditionalDocumentCommandResult({
          ok: true,
          localCommit: rendererLocalCommitApply(committed),
          value: {
            operationId: request.operationId,
            projectId: request.projectId,
            storeEpoch,
            operationKind: request.operation.kind,
            semanticHash,
            duplicate: committed.receipt.duplicate,
            effect: {
              createdBlockIds: effect.created_block_ids,
              preservedBlockIds: effect.preserved_block_ids,
              deletedBlockIds: effect.deleted_block_ids,
              documentHeads: effect.document_heads.map((head) => ({
                documentId: head.document_id,
                generation: head.generation,
                headSeq: head.head_seq,
              })),
            },
            commitSeq: applyResultCursor(committed),
            committedAt,
          },
        });
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return additionalDocumentFailure(request, error);
      }
    },
    createCheckpoint: async (request) => {
      const { operationId } = request;
      try {
        const committed = await client.documentApply({
          operationId,
          clientSessionId: "electron:document-history",
          intent: {
            kind: "create_checkpoint",
            document_id: request.documentId,
            generation: request.expectedGeneration,
            expected_head_seq: request.expectedHeadSeq,
            cause: request.cause,
            label: request.label,
            actor: request.actor,
            revision_kind: request.revisionKind,
            source_mutation_id: request.sourceMutationId,
            source_change_seq: request.sourceChangeSeq,
          },
        });
        const effect = committed.outcome.checkpoint_effect;
        const storeEpoch = applyResultStoreEpoch(committed);
        if (
          storeEpoch !== request.storeEpoch ||
          committed.receipt.operation_id !== operationId ||
          committed.receipt.document_id !== request.documentId ||
          committed.receipt.generation !== request.expectedGeneration ||
          committed.receipt.head_seq !== request.expectedHeadSeq ||
          !effect
        ) {
          throw new DocumentHistoryContractError(
            "Core checkpoint receipt escaped its request boundary",
          );
        }
        return {
          ok: true,
          value: {
            checkpoint: assertHistoryScope(parseDocumentVersionSummary(effect.checkpoint), request),
            duplicate: committed.receipt.duplicate || effect.duplicate,
          },
        };
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return historyFailure(error, {
          generation: request.expectedGeneration,
          headSeq: request.expectedHeadSeq,
        });
      }
    },
    listVersions: async (request) => {
      try {
        const snapshot = await client.documentRead("electron:document-history", {
          kind: "list_versions",
          document_id: request.documentId,
          before: request.before
            ? {
                base_head_seq: request.before.baseHeadSeq,
                created_at: request.before.createdAt,
                version_id: request.before.versionId,
              }
            : undefined,
          limit: request.limit,
        });
        if (snapshot.value.kind !== "versions") {
          throw new DocumentHistoryContractError(
            "Core returned a non-list Document history snapshot",
          );
        }
        const items = snapshot.value.items.map((item) =>
          assertHistoryScope(parseDocumentVersionSummary(item), request),
        );
        const next = snapshot.value.next;
        const last = items.at(-1);
        if (
          next &&
          (!last ||
            next.base_head_seq !== last.baseHeadSeq ||
            next.created_at !== last.createdAt ||
            next.version_id !== last.versionId)
        ) {
          throw new DocumentHistoryContractError(
            "Core Document history cursor escaped its last returned version",
          );
        }
        return {
          ok: true,
          value: items,
        };
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return historyFailure(error);
      }
    },
    getVersion: async (request) => {
      try {
        const snapshot = await client.documentRead("electron:document-history", {
          kind: "get_version",
          document_id: request.documentId,
          version_id: request.versionId,
        });
        if (snapshot.value.kind !== "version") {
          throw new DocumentHistoryContractError(
            "Core returned a non-detail Document history snapshot",
          );
        }
        const detail = parseDocumentVersionDetail(snapshot.value.value);
        assertHistoryScope(detail.summary, request);
        if (detail.summary.versionId !== request.versionId) {
          throw new DocumentHistoryContractError(
            "Core Document version detail escaped its version boundary",
          );
        }
        return { ok: true, value: detail };
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return historyFailure(error);
      }
    },
    applyDocumentMutation,
    restoreVersion: async (request) => await applyDocumentMutation(request),
    sync,
    applyUpdate,
    publishAwareness: async (request: DocumentAwarenessPublishRequest) => {
      try {
        return success(await client.documentPublishAwareness(request));
      } catch (error) {
        rethrowCoreTransportFailure(error);
        return failure(error);
      }
    },
  };
};

export const mapDocumentLiveEnvelope = async (
  request: DocumentSyncSubscribeRequest,
  envelope: CoreEventEnvelope,
  fetchUpdateResource: ExactDocumentUpdateFetcher,
): Promise<readonly DocumentSyncRealtimeEvent[]> => {
  const identity = envelope.packet.manifest.identity;
  const events: DocumentSyncRealtimeEvent[] = [];
  const requiresResync = envelope.packet.atoms.some(
    (effect) =>
      effect.payload.module === "owned_document" &&
      effect.payload.event.document_id === request.documentId &&
      (effect.payload.event.kind === "document_resync_required" ||
        effect.payload.event.kind === "document_invalidated"),
  );
  const documentEffects = requiresResync
    ? []
    : envelope.packet.document_effects.filter(
        (effect) => effect.reference.document_id === request.documentId,
      );
  events.push(
    ...(await Promise.all(
      documentEffects.map((effect) =>
        resolveAuthorizedDocumentEffect(
          effect,
          envelope.packet.manifest.identity,
          fetchUpdateResource,
        ),
      ),
    )),
  );
  envelope.packet.atoms.forEach((effect) => {
    const payload = effect.payload;
    if (payload.module !== "owned_document") return;
    const event = payload.event;
    if (event.document_id !== request.documentId) return;
    if (event.kind === "document_resync_required") {
      events.push({
        kind: "resync-required",
        documentId: event.document_id,
        storeEpoch: identity.store_epoch,
        generation: event.generation,
        headSeq: event.head_seq,
        commitSeq: identity.commit_seq,
        effectSequence: effect.descriptor.atom_order,
        reason: "history-compacted",
      });
      return;
    }
    if (event.kind === "document_invalidated") {
      events.push({
        kind: "resync-required",
        documentId: event.document_id,
        storeEpoch: identity.store_epoch,
        generation: 1,
        headSeq: 0,
        commitSeq: identity.commit_seq,
        effectSequence: effect.descriptor.atom_order,
        reason: event.reason === "access_changed" ? "access-revoked" : "identity-boundary-changed",
      });
    }
  });
  if (
    envelope.packet.visibility_deltas
      .flatMap(revocationsFromVisibilityDelta)
      .some(
        (revocation) =>
          revocation.resource_kind === "document" && revocation.resource_id === request.documentId,
      )
  ) {
    events.push({
      kind: "resync-required",
      documentId: request.documentId,
      storeEpoch: identity.store_epoch,
      generation: 1,
      headSeq: 0,
      commitSeq: identity.commit_seq,
      effectSequence: 0,
      reason: "access-revoked",
    });
  }
  return events;
};

const success = <Value>(value: Value): DocumentSyncCommandResult<Value> => ({
  ok: true,
  value,
});

const failure = <Value>(error: unknown): DocumentSyncCommandResult<Value> => ({
  ok: false,
  error: commandError(error),
});

const commandError = (error: unknown): DocumentSyncCommandError => {
  if (error instanceof DocumentUpdateResourceIntegrityError) {
    return {
      code: "invalid_response",
      message: error.message,
      retryable: false,
      resetRequired: true,
    };
  }
  return documentSessionError(error);
};
