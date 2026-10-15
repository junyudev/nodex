import { describe, expect, test } from "vite-plus/test";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  type OwnedDocumentDescriptor,
} from "../../shared/block-documents";
import {
  BlockDocumentSurfaceError,
  resolveBlockDocumentSurfaceFailure,
} from "./block-document-surface-failure";

const descriptor = (): OwnedDocumentDescriptor => ({
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-1" },
  ownerBlockId: "card-1",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document:card-1",
  storeEpoch: "store-7",
  generation: 3,
  headSeq: 12,
  schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([0]) },
});

describe("block Document surface failure presentation", () => {
  test("preserves a protocol failure as a user reason and copyable diagnostics", () => {
    const presentation = resolveBlockDocumentSurfaceFailure({
      descriptor: descriptor(),
      reason: "fatal",
      error: new BlockDocumentSurfaceError("The Y.Doc is missing its registered body root", {
        syncError: {
          code: "document_state_corrupt",
          message: "The Y.Doc is missing its registered body root",
          retryable: false,
          resetRequired: false,
          recoveryArtifactId: "recovery-1",
        },
      }),
    });

    expect(presentation.title).toBe("Nodex couldn’t validate this content");
    expect(presentation.description).toBe("The Y.Doc is missing its registered body root");
    expect(presentation.diagnostics).toContain("Code: document_state_corrupt");
    expect(presentation.diagnostics).toContain("Document: document:card-1");
    expect(presentation.diagnostics).toContain("Generation: 3");
    expect(presentation.diagnostics).toContain("Recovery artifact: recovery-1");
  });

  test("distinguishes a reset boundary from a generic startup failure", () => {
    const reset = resolveBlockDocumentSurfaceFailure({
      descriptor: descriptor(),
      reason: "reset-required",
      error: new BlockDocumentSurfaceError("Document generation changed", {
        syncError: {
          code: "document_generation_mismatch",
          message: "Document generation changed",
          retryable: false,
          resetRequired: true,
        },
      }),
    });
    const startup = resolveBlockDocumentSurfaceFailure({
      descriptor: descriptor(),
      reason: "startup",
      error: new TypeError("Document adapter could not be created"),
    });

    expect(reset.title).toBe("This content needs to resync");
    expect(reset.diagnostics).toContain("Reset required: true");
    expect(startup.title).toBe("Couldn’t open this collaborative content");
    expect(startup.diagnostics).toContain("Code: runtime_error");
  });
});
