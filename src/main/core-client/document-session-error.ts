import type { components } from "@nodex/core-protocol";
import type {
  DocumentSyncCommandError,
  DocumentSyncErrorCode,
} from "../../shared/block-documents/document-sync";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { DocumentLiveRuntimeError } from "../core-runtime/DocumentLiveRuntime";
import { CoreModuleResponseError } from "./core-client";
import {
  CoreEventCompatibilityError,
  CoreHttpError,
  CoreResponseTooLargeError,
  CoreTransportError,
} from "./uds-http";

type CoreError = components["schemas"]["CoreError"];

const documentErrorCodes = {
  invalid_input: "invalid_document_update",
  unauthorized: "unauthorized",
  not_found: "document_not_found",
  ambiguous: "unknown",
  conflict: "recovery_required",
  stale_store_epoch: "store_epoch_mismatch",
  revision_conflict: "recovery_required",
  generation_conflict: "document_generation_mismatch",
  head_conflict: "future_base_head",
  patch_not_found: "recovery_required",
  patch_ambiguous: "recovery_required",
  patch_overlap: "recovery_required",
  idempotency_key_reused: "update_id_collision",
  idempotency_window_expired: "recovery_required",
  legacy_idempotency_unavailable: "recovery_required",
  protected_owner_deletion: "protected_owner_mutation",
  document_update_missing_dependencies: "document_update_missing_dependencies",
  invalid_document_schema: "unsupported_document_schema",
  materialization_stale: "document_not_ready",
  maintenance_in_progress: "document_not_ready",
  schema_unsupported: "unsupported_document_schema",
  store_corrupt: "document_state_corrupt",
  protocol_incompatible: "invalid_response",
  event_replay_unavailable: "document_not_ready",
  deadline_exceeded: "request_timeout",
  cancelled: "request_cancelled",
  overloaded: "service_busy",
  resource_exhausted: "service_busy",
  core_unavailable: "transport_unavailable",
} satisfies Record<CoreError["code"], DocumentSyncErrorCode>;

/** Unwrap only application-owned boundaries, never arbitrary error-shaped objects. */
export const unwrapDocumentSessionFailure = (error: unknown): unknown => {
  if (error instanceof CoreRuntimeError || error instanceof DocumentLiveRuntimeError) {
    return error.cause === undefined ? error : unwrapDocumentSessionFailure(error.cause);
  }
  return error;
};

/** Let CoreAuthority observe physical failures before a semantic adapter returns a value. */
export const rethrowCoreTransportFailure = (error: unknown): void => {
  if (error instanceof CoreTransportError || error instanceof CoreHttpError) throw error;
};

/** One projection for direct and Desktop document commands. Unknown defects never retry. */
export const documentSessionError = (failure: unknown): DocumentSyncCommandError => {
  const error = unwrapDocumentSessionFailure(failure);
  if (error instanceof CoreModuleResponseError) {
    const core = error.coreError;
    return {
      code: documentErrorCodes[core.code],
      message: core.message,
      retryable: core.retryable,
      resetRequired:
        core.code === "stale_store_epoch" ||
        core.code === "generation_conflict" ||
        core.code === "protected_owner_deletion",
      core: { code: core.code, recovery: core.recovery },
      ...(core.recovery.kind === "document_recovery_artifact"
        ? { recoveryArtifactId: core.recovery.artifact_id }
        : {}),
    };
  }
  if (error instanceof CoreTransportError) {
    return {
      code:
        error.kind === "aborted"
          ? "request_cancelled"
          : error.kind === "timeout"
            ? "request_timeout"
            : "transport_unavailable",
      message: error.message,
      retryable: error.kind !== "aborted" && error.kind !== "unknown",
      resetRequired: false,
    };
  }
  if (error instanceof CoreHttpError) {
    return {
      code:
        error.status === 401 || error.status === 403
          ? "unauthorized"
          : error.status === 429 || error.status === 503
            ? "service_busy"
            : "invalid_response",
      message: error.message,
      retryable: error.status === 429 || error.status === 503,
      resetRequired: false,
    };
  }
  if (error instanceof CoreEventCompatibilityError || error instanceof CoreResponseTooLargeError) {
    return {
      code: "invalid_response",
      message: error.message,
      retryable: false,
      resetRequired: false,
    };
  }
  return {
    code: "unknown",
    message: "The document session failed unexpectedly. Your pending edits need recovery.",
    retryable: false,
    resetRequired: false,
  };
};
