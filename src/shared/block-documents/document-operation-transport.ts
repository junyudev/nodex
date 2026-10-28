import type { BlockTreeValue } from "./block-document-codec";
import {
  DocumentOperationContractError,
  parseDocumentOperationBatch,
  parseDocumentVersionRestore,
  parseReplaceDocumentFromMarkdown,
  type DocumentMutationRequest,
  type DocumentOperationCommandError,
} from "./document-operations";

export interface TrustedDocumentMutationIdentity {
  readonly actor: Readonly<Record<string, BlockTreeValue>>;
  readonly clientSessionId?: string;
}

export type TrustedDocumentMutationBinding =
  | { readonly ok: true; readonly value: DocumentMutationRequest }
  | { readonly ok: false; readonly error: DocumentOperationCommandError };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readMutationIdHint = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const mutationId = value.mutationId;
  if (
    typeof mutationId !== "string" ||
    mutationId.length === 0 ||
    mutationId.length > 512 ||
    mutationId !== mutationId.trim()
  ) {
    return undefined;
  }
  return mutationId;
};

export const documentMutationFailure = (
  code: DocumentOperationCommandError["code"],
  message: string,
  options: Omit<Partial<DocumentOperationCommandError>, "code" | "message" | "retryable"> & {
    readonly retryable?: boolean;
  } = {},
): DocumentOperationCommandError => {
  const { retryable = false, ...details } = options;
  return { code, message, retryable, ...details };
};

export const parseDocumentMutationRequest = (value: unknown): DocumentMutationRequest => {
  if (!isRecord(value)) {
    throw new DocumentOperationContractError("Document mutation request must be an object");
  }
  if (Object.hasOwn(value, "operations")) {
    return parseDocumentOperationBatch(value);
  }
  if (Object.hasOwn(value, "markdown")) {
    return parseReplaceDocumentFromMarkdown(value);
  }
  if (Object.hasOwn(value, "versionId")) {
    return parseDocumentVersionRestore(value);
  }
  throw new DocumentOperationContractError(
    "Document mutation request must contain operations, markdown, or versionId",
  );
};

/**
 * Enforce route/IPC scope before replacing audit identity with host-derived
 * values. Neither browser nor renderer supplied actor/session fields survive.
 */
export const bindTrustedDocumentMutation = (
  rawRequest: unknown,
  projectId: string,
  documentId: string,
  identity: TrustedDocumentMutationIdentity,
): TrustedDocumentMutationBinding => {
  let request: DocumentMutationRequest;
  try {
    request = parseDocumentMutationRequest(rawRequest);
  } catch (error) {
    return {
      ok: false,
      error: documentMutationFailure(
        "invalid_document_operation_request",
        error instanceof DocumentOperationContractError
          ? error.message
          : "Document mutation request is invalid",
        { mutationId: readMutationIdHint(rawRequest) },
      ),
    };
  }

  if (request.projectId !== projectId || request.documentId !== documentId) {
    return {
      ok: false,
      error: documentMutationFailure(
        "invalid_document_operation_request",
        "Document mutation does not match its Project and Document scope",
        { mutationId: request.mutationId },
      ),
    };
  }

  const bound = {
    ...request,
    projectId,
    documentId,
    actor: identity.actor,
    ...(identity.clientSessionId === undefined
      ? { clientSessionId: undefined }
      : { clientSessionId: identity.clientSessionId }),
  };
  try {
    return {
      ok: true,
      value:
        "operations" in request
          ? parseDocumentOperationBatch(bound)
          : "markdown" in request
            ? parseReplaceDocumentFromMarkdown(bound)
            : parseDocumentVersionRestore(bound),
    };
  } catch (error) {
    return {
      ok: false,
      error: documentMutationFailure(
        "invalid_document_operation_request",
        error instanceof DocumentOperationContractError
          ? error.message
          : "Trusted Document mutation identity is invalid",
        { mutationId: request.mutationId },
      ),
    };
  }
};

export const documentMutationHttpStatus = (
  error: DocumentOperationCommandError,
): 400 | 404 | 409 | 500 | 503 => {
  if (
    error.code === "document_not_found" ||
    error.code === "document_version_not_found" ||
    error.code === "block_not_found"
  ) {
    return 404;
  }
  if (
    error.code === "store_epoch_mismatch" ||
    error.code === "mutation_id_collision" ||
    error.code === "document_not_ready" ||
    error.code === "document_generation_conflict" ||
    error.code === "document_head_conflict" ||
    error.code === "duplicate_block_id"
  ) {
    return 409;
  }
  if (error.code === "unknown" && error.retryable) return 503;
  if (error.code === "unknown" || error.code === "document_state_corrupt") {
    return 500;
  }
  return 400;
};
