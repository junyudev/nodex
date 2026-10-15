import type {
  DocumentSyncCommandError,
  OwnedDocumentDescriptor,
} from "../../shared/block-documents";
import { contentRoutingContextKey } from "../../shared/content-routing-context";

export type BlockDocumentSurfaceFailureReason = "fatal" | "reset-required" | "startup";

interface BlockDocumentSurfaceErrorOptions {
  readonly syncError?: DocumentSyncCommandError;
  readonly cause?: unknown;
}

/** Preserves protocol error semantics across the renderer runtime boundary. */
export class BlockDocumentSurfaceError extends Error {
  readonly syncError?: DocumentSyncCommandError;

  constructor(message: string, options: BlockDocumentSurfaceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BlockDocumentSurfaceError";
    this.syncError = options.syncError;
  }
}

export interface BlockDocumentSurfaceFailurePresentation {
  readonly title: string;
  readonly description: string;
  readonly diagnostics: string;
}

export interface BlockDocumentSurfaceFailureInput {
  readonly descriptor: OwnedDocumentDescriptor;
  readonly error: Error;
  readonly reason: BlockDocumentSurfaceFailureReason;
}

const resolveFailureTitle = (
  reason: BlockDocumentSurfaceFailureReason,
  syncError: DocumentSyncCommandError | undefined,
): string => {
  if (reason === "reset-required") return "This content needs to resync";
  if (syncError?.code === "invalid_session") {
    return "This document connection has ended";
  }
  if (syncError?.code === "document_not_found") {
    return "This content is no longer available";
  }
  if (syncError?.code === "document_not_ready") {
    return "This content isn’t ready to open";
  }
  if (
    syncError?.code === "unsupported_document_schema" ||
    syncError?.code === "invalid_document_update" ||
    syncError?.code === "document_update_missing_dependencies" ||
    syncError?.code === "document_state_corrupt" ||
    syncError?.code === "invalid_response"
  ) {
    return "Nodex couldn’t validate this content";
  }
  return "Couldn’t open this collaborative content";
};

const appendDiagnostic = (
  diagnostics: string[],
  label: string,
  value: string | number | boolean | undefined,
): void => {
  if (value === undefined || value === "") return;
  diagnostics.push(`${label}: ${String(value)}`);
};

export const resolveBlockDocumentSurfaceFailure = ({
  descriptor,
  error,
  reason,
}: BlockDocumentSurfaceFailureInput): BlockDocumentSurfaceFailurePresentation => {
  const syncError = error instanceof BlockDocumentSurfaceError ? error.syncError : undefined;
  const title = resolveFailureTitle(reason, syncError);
  const message = error.message.trim();
  const diagnostics: string[] = [];

  appendDiagnostic(diagnostics, "Failure", reason);
  appendDiagnostic(diagnostics, "Code", syncError?.code ?? "runtime_error");
  appendDiagnostic(diagnostics, "Message", message || title);
  appendDiagnostic(diagnostics, "Library", descriptor.libraryId);
  appendDiagnostic(diagnostics, "Access", contentRoutingContextKey(descriptor.routingContext));
  appendDiagnostic(diagnostics, "Owner block", descriptor.ownerBlockId);
  appendDiagnostic(diagnostics, "Document", descriptor.documentId);
  appendDiagnostic(diagnostics, "Store epoch", descriptor.storeEpoch);
  appendDiagnostic(diagnostics, "Generation", descriptor.generation);
  appendDiagnostic(diagnostics, "Head sequence", descriptor.headSeq);
  appendDiagnostic(diagnostics, "Schema", `${descriptor.schemaKey}@${descriptor.schemaVersion}`);
  appendDiagnostic(diagnostics, "Retryable", syncError?.retryable);
  appendDiagnostic(diagnostics, "Reset required", syncError?.resetRequired);
  appendDiagnostic(diagnostics, "Relocation", syncError?.relocationId);
  appendDiagnostic(diagnostics, "Recovery artifact", syncError?.recoveryArtifactId);

  return {
    title,
    description: message && message !== title ? message : "Reload to try again.",
    diagnostics: diagnostics.join("\n"),
  };
};
