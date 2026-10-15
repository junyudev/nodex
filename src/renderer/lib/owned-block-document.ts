import type {
  BlockId,
  DocumentId,
  LibraryAccessedDocumentDescriptor,
  OwnedDocumentDescriptor,
} from "../../shared/block-documents/contracts";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../shared/block-documents/page-document";
import type {
  DocumentSyncCommandResult,
  DocumentSyncErrorCode,
} from "../../shared/block-documents/document-sync";
import {
  BlockDocumentSchemaError,
  getOwnedDocumentSchemaRegistration,
} from "../../shared/block-documents/document-schema-adapters";
import {
  contentRoutingContextKey,
  libraryContentRoute,
  parseContentRoutingContext,
  type ContentRoutingContext,
} from "../../shared/content-routing-context";

export const PAGE_BLOCK_DOCUMENT_SCHEMA_KEY = PAGE_DOCUMENT_SCHEMA_KEY;
export const PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION = PAGE_DOCUMENT_SCHEMA_VERSION;

export interface OwnedBlockDocumentRequest {
  readonly routingContext: ContentRoutingContext;
  readonly ownerBlockId: BlockId;
}

export interface ReadyPageBlockDocumentDescriptor extends OwnedDocumentDescriptor {
  readonly ownerType: "page";
  readonly ownerLifecycle: "active";
  readonly schemaKey: typeof PAGE_BLOCK_DOCUMENT_SCHEMA_KEY;
  readonly schemaVersion: typeof PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION;
  readonly readiness: "ready";
  readonly sync: { readonly kind: "yjs"; readonly stateVector: Uint8Array };
}

export interface ReadyLibraryPageBlockDocumentDescriptor extends LibraryAccessedDocumentDescriptor {
  readonly ownerType: "page";
  readonly ownerLifecycle: "active";
  readonly schemaKey: typeof PAGE_BLOCK_DOCUMENT_SCHEMA_KEY;
  readonly schemaVersion: typeof PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION;
  readonly readiness: "ready";
  readonly sync: { readonly kind: "yjs"; readonly stateVector: Uint8Array };
}

export interface ReadyRegisteredOwnedBlockDocumentDescriptor extends OwnedDocumentDescriptor {
  readonly ownerLifecycle: "active";
  readonly readiness: "ready";
}

export type OwnedBlockDocumentErrorCode =
  | DocumentSyncErrorCode
  | "invalid_request"
  | "fetch_failed"
  | "invalid_descriptor"
  | "routing_context_mismatch"
  | "owner_mismatch"
  | "unsupported_owner_type"
  | "owner_not_active"
  | "document_not_ready"
  | "unsupported_document_schema"
  | "unsupported_sync_engine";

export interface OwnedBlockDocumentErrorModel {
  readonly code: OwnedBlockDocumentErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retrying?: boolean;
}

interface OwnedBlockDocumentRequestModel {
  readonly routingContext: ContentRoutingContext;
  readonly ownerBlockId: BlockId;
}

export type OwnedBlockDocumentModel =
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "loading";
    })
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "error";
      readonly error: OwnedBlockDocumentErrorModel;
    })
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "ready";
      readonly descriptor: ReadyPageBlockDocumentDescriptor;
    });

export type RegisteredOwnedBlockDocumentModel =
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "loading";
    })
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "error";
      readonly error: OwnedBlockDocumentErrorModel;
    })
  | (OwnedBlockDocumentRequestModel & {
      readonly status: "ready";
      readonly descriptor: ReadyRegisteredOwnedBlockDocumentDescriptor;
    });

export type OwnedBlockDocumentQuerySnapshot =
  | { readonly status: "pending" }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retrying?: boolean;
    }
  | {
      readonly status: "success";
      readonly data: ReadyPageBlockDocumentDescriptor;
    };

export type RegisteredOwnedBlockDocumentQuerySnapshot =
  | { readonly status: "pending" }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retrying?: boolean;
    }
  | {
      readonly status: "success";
      readonly data: ReadyRegisteredOwnedBlockDocumentDescriptor;
    };

export type OwnedDocumentDescriptorFetcher = (
  routingContext: ContentRoutingContext,
  ownerBlockId: BlockId,
  signal?: AbortSignal,
) => Promise<unknown>;

export class OwnedBlockDocumentBoundaryError extends Error {
  readonly code: OwnedBlockDocumentErrorCode;
  readonly retryable: boolean;

  constructor(
    code: OwnedBlockDocumentErrorCode,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = "OwnedBlockDocumentBoundaryError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export const unwrapOwnedBlockDocumentPreparationResult = (
  result: DocumentSyncCommandResult<OwnedDocumentDescriptor>,
): OwnedDocumentDescriptor => {
  if (result.ok) return result.value;
  throw new OwnedBlockDocumentBoundaryError(result.error.code, result.error.message, {
    retryable: result.error.retryable,
  });
};

export const unwrapLibraryOwnedBlockDocumentPreparationResult = (
  result: DocumentSyncCommandResult<LibraryAccessedDocumentDescriptor>,
): LibraryAccessedDocumentDescriptor => {
  if (result.ok) return result.value;
  throw new OwnedBlockDocumentBoundaryError(result.error.code, result.error.message, {
    retryable: result.error.retryable,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isExactNonEmptyId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const requireValidRequest = (request: OwnedBlockDocumentRequest): OwnedBlockDocumentRequest => {
  if (!isExactNonEmptyId(request.ownerBlockId)) {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_request",
      "Owned Block Document requests require an exact owner Block ID",
    );
  }
  try {
    return {
      routingContext: parseContentRoutingContext(request.routingContext),
      ownerBlockId: request.ownerBlockId,
    };
  } catch (error) {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_request",
      "Owned Block Document requests require an explicit access context",
      { cause: error },
    );
  }
};

const requireDescriptorCore = (value: Record<string, unknown>): void => {
  if (
    isExactNonEmptyId(value.libraryId) &&
    isExactNonEmptyId(value.documentId) &&
    isExactNonEmptyId(value.storeEpoch) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 1 &&
    Number.isSafeInteger(value.headSeq) &&
    (value.headSeq as number) >= 0 &&
    isRecord(value.sync) &&
    (value.sync.kind === "canvas_scene" ||
      (value.sync.kind === "yjs" && value.sync.stateVector instanceof Uint8Array))
  ) {
    return;
  }
  throw new OwnedBlockDocumentBoundaryError(
    "invalid_descriptor",
    "Owned Block Document descriptor has invalid runtime identity or head fields",
  );
};

export const validateOwnedBlockDocumentDescriptor = (
  request: OwnedBlockDocumentRequest,
  value: unknown,
): ReadyPageBlockDocumentDescriptor => {
  const requested = requireValidRequest(request);
  const registered = validateRegisteredOwnedBlockDocumentDescriptor(requested, value);
  if (registered.ownerType !== "page") {
    throw new OwnedBlockDocumentBoundaryError(
      "unsupported_owner_type",
      "Page surfaces require a Page-owned Block Document",
    );
  }
  if (
    registered.schemaKey !== PAGE_BLOCK_DOCUMENT_SCHEMA_KEY ||
    registered.schemaVersion !== PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION ||
    registered.sync.kind !== "yjs"
  ) {
    throw new OwnedBlockDocumentBoundaryError(
      "unsupported_document_schema",
      `Page surfaces require ${PAGE_BLOCK_DOCUMENT_SCHEMA_KEY}@${PAGE_BLOCK_DOCUMENT_SCHEMA_VERSION}`,
    );
  }
  return registered as ReadyPageBlockDocumentDescriptor;
};

export const validateLibraryOwnedBlockDocumentDescriptor = (
  ownerBlockId: string,
  value: unknown,
): ReadyLibraryPageBlockDocumentDescriptor => {
  if (!isExactNonEmptyId(ownerBlockId)) {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_request",
      "Library Owned Block Document requests require an exact owner Block ID",
    );
  }
  const ready = validateOwnedBlockDocumentDescriptor(
    { routingContext: libraryContentRoute, ownerBlockId },
    value,
  );
  if (ready.routingContext.kind !== "library") {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_descriptor",
      "Library Owned Block Document access context is invalid",
    );
  }
  return { ...ready, routingContext: ready.routingContext };
};

export const validateRegisteredOwnedBlockDocumentDescriptor = (
  request: OwnedBlockDocumentRequest,
  value: unknown,
): ReadyRegisteredOwnedBlockDocumentDescriptor => {
  const requested = requireValidRequest(request);
  if (!isRecord(value)) {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_descriptor",
      "Owned Block Document descriptor must be an object",
    );
  }
  let descriptorRoutingContext: ContentRoutingContext;
  try {
    descriptorRoutingContext = parseContentRoutingContext(value.routingContext);
  } catch (error) {
    throw new OwnedBlockDocumentBoundaryError(
      "invalid_descriptor",
      "Owned Block Document descriptor has an invalid access context",
      { cause: error },
    );
  }
  if (
    contentRoutingContextKey(descriptorRoutingContext) !==
    contentRoutingContextKey(requested.routingContext)
  ) {
    throw new OwnedBlockDocumentBoundaryError(
      "routing_context_mismatch",
      "Owned Block Document descriptor does not match the requested access context",
    );
  }
  if (value.ownerBlockId !== requested.ownerBlockId) {
    throw new OwnedBlockDocumentBoundaryError(
      "owner_mismatch",
      "Owned Block Document descriptor does not belong to the requested owner Block",
    );
  }
  if (value.ownerLifecycle !== "active") {
    throw new OwnedBlockDocumentBoundaryError(
      "owner_not_active",
      "Owned Block Document surfaces require an active owner Block",
    );
  }
  if (value.readiness !== "ready") {
    throw new OwnedBlockDocumentBoundaryError(
      "document_not_ready",
      "Owned Block Document surfaces require a ready Document",
    );
  }
  if (
    typeof value.ownerType !== "string" ||
    typeof value.schemaKey !== "string" ||
    !Number.isSafeInteger(value.schemaVersion)
  ) {
    throw new OwnedBlockDocumentBoundaryError(
      "unsupported_document_schema",
      "Owned Block Document descriptor has an invalid owner/schema identity",
    );
  }
  let registration;
  try {
    registration = getOwnedDocumentSchemaRegistration({
      ownerType: value.ownerType,
      schemaKey: value.schemaKey,
      schemaVersion: value.schemaVersion as number,
    });
  } catch (error) {
    if (!(error instanceof BlockDocumentSchemaError)) throw error;
    throw new OwnedBlockDocumentBoundaryError("unsupported_document_schema", error.message, {
      cause: error,
    });
  }
  if (!isRecord(value.sync) || value.sync.kind !== registration.syncEngine) {
    throw new OwnedBlockDocumentBoundaryError(
      "unsupported_sync_engine",
      "Owned Document descriptor does not match its registered sync engine",
    );
  }
  requireDescriptorCore(value);
  return {
    ...value,
    routingContext: descriptorRoutingContext,
  } as unknown as ReadyRegisteredOwnedBlockDocumentDescriptor;
};

const fetchDescriptor = async <T>(
  request: OwnedBlockDocumentRequest,
  fetcher: OwnedDocumentDescriptorFetcher,
  validate: (request: OwnedBlockDocumentRequest, value: unknown) => T,
): Promise<T> => {
  const requested = requireValidRequest(request);
  let descriptor: unknown;
  try {
    descriptor = await fetcher(requested.routingContext, requested.ownerBlockId);
  } catch (error) {
    if (error instanceof OwnedBlockDocumentBoundaryError) throw error;
    throw new OwnedBlockDocumentBoundaryError(
      "fetch_failed",
      error instanceof Error ? error.message : "Could not load the owned Block Document descriptor",
      { cause: error },
    );
  }
  return validate(requested, descriptor);
};

export const fetchOwnedBlockDocumentDescriptor = async (
  request: OwnedBlockDocumentRequest,
  fetcher: OwnedDocumentDescriptorFetcher,
): Promise<ReadyPageBlockDocumentDescriptor> => {
  return fetchDescriptor(request, fetcher, validateOwnedBlockDocumentDescriptor);
};

export const fetchRegisteredOwnedBlockDocumentDescriptor = (
  request: OwnedBlockDocumentRequest,
  fetcher: OwnedDocumentDescriptorFetcher,
): Promise<ReadyRegisteredOwnedBlockDocumentDescriptor> =>
  fetchDescriptor(request, fetcher, validateRegisteredOwnedBlockDocumentDescriptor);

const toErrorModel = (error: unknown, retrying = false): OwnedBlockDocumentErrorModel => {
  if (error instanceof OwnedBlockDocumentBoundaryError) {
    return {
      code: error.code,
      message: error.retryable
        ? retrying
          ? "Core is busy. Retrying this Page…"
          : "Core is busy. Try opening this Page again."
        : error.message,
      retryable: error.retryable,
      retrying,
    };
  }
  return {
    code: "fetch_failed",
    message:
      error instanceof Error ? error.message : "Could not load the owned Block Document descriptor",
  };
};

export const makeOwnedBlockDocumentModel = (
  request: OwnedBlockDocumentRequest,
  snapshot: OwnedBlockDocumentQuerySnapshot,
): OwnedBlockDocumentModel => {
  const identity = {
    routingContext: request.routingContext,
    ownerBlockId: request.ownerBlockId,
  };
  try {
    requireValidRequest(request);
  } catch (error) {
    return { ...identity, status: "error", error: toErrorModel(error) };
  }
  if (snapshot.status === "pending") {
    return { ...identity, status: "loading" };
  }
  if (snapshot.status === "error") {
    return {
      ...identity,
      status: "error",
      error: toErrorModel(snapshot.error, snapshot.retrying),
    };
  }

  return {
    ...identity,
    status: "ready",
    descriptor: snapshot.data,
  };
};

export const makeRegisteredOwnedBlockDocumentModel = (
  request: OwnedBlockDocumentRequest,
  snapshot: RegisteredOwnedBlockDocumentQuerySnapshot,
): RegisteredOwnedBlockDocumentModel => {
  const identity = {
    routingContext: request.routingContext,
    ownerBlockId: request.ownerBlockId,
  };
  try {
    requireValidRequest(request);
  } catch (error) {
    return { ...identity, status: "error", error: toErrorModel(error) };
  }
  if (snapshot.status === "pending") {
    return { ...identity, status: "loading" };
  }
  if (snapshot.status === "error") {
    return {
      ...identity,
      status: "error",
      error: toErrorModel(snapshot.error, snapshot.retrying),
    };
  }
  return {
    ...identity,
    status: "ready",
    descriptor: snapshot.data,
  };
};

export const ownedBlockDocumentIdentity = (
  descriptor: ReadyPageBlockDocumentDescriptor,
): {
  readonly documentId: DocumentId;
  readonly storeEpoch: string;
  readonly generation: number;
} => ({
  documentId: descriptor.documentId,
  storeEpoch: descriptor.storeEpoch,
  generation: descriptor.generation,
});
