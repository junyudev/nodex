import { describe, expect, test } from "vite-plus/test";
import { QueryClient } from "@tanstack/react-query";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents/contracts";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "../../shared/block-documents/page-document";
import {
  SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
  SYNCED_BLOCK_SOURCE_TYPE,
} from "../../shared/block-documents/synced-block-document";
import {
  fetchOwnedBlockDocumentDescriptor,
  fetchRegisteredOwnedBlockDocumentDescriptor,
  makeOwnedBlockDocumentModel,
  OwnedBlockDocumentBoundaryError,
  ownedBlockDocumentIdentity,
  unwrapOwnedBlockDocumentPreparationResult,
  validateLibraryOwnedBlockDocumentDescriptor,
  validateOwnedBlockDocumentDescriptor,
  validateRegisteredOwnedBlockDocumentDescriptor,
  type OwnedBlockDocumentErrorCode,
  type OwnedBlockDocumentRequest,
} from "./owned-block-document";
import {
  ownedBlockDocumentQueryOptions,
  registeredOwnedBlockDocumentQueryOptions,
} from "./owned-block-document-query";

const REQUEST: OwnedBlockDocumentRequest = {
  routingContext: { kind: "project", projectId: "project-a" },
  ownerBlockId: "card-a",
};

const makeDescriptor = (
  overrides: Partial<OwnedDocumentDescriptor> = {},
): OwnedDocumentDescriptor => ({
  libraryId: "library-a",
  routingContext: REQUEST.routingContext,
  ownerBlockId: REQUEST.ownerBlockId,
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "opaque-owned-document-id",
  storeEpoch: "store-epoch-a",
  generation: 3,
  headSeq: 11,
  schemaKey: "nodex.page",
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([1, 2, 3]) },
  ...overrides,
});

const captureBoundaryCode = (operation: () => unknown): string => {
  try {
    operation();
    return "none";
  } catch (error) {
    return error instanceof OwnedBlockDocumentBoundaryError ? error.code : "unexpected";
  }
};

describe("owned Block Document renderer boundary", () => {
  test("validates Library descriptors without admitting Project coordinates", () => {
    const ready = validateLibraryOwnedBlockDocumentDescriptor(REQUEST.ownerBlockId, {
      ...makeDescriptor(),
      routingContext: { kind: "library" },
    });
    expect(ready.routingContext).toEqual({ kind: "library" });
    expect("projectId" in ready).toBe(false);
    expect(() =>
      validateLibraryOwnedBlockDocumentDescriptor(REQUEST.ownerBlockId, makeDescriptor()),
    ).toThrow("requested access context");
  });

  test("accepts only the requested ready active nodex.page descriptor", () => {
    const descriptor = validateOwnedBlockDocumentDescriptor(REQUEST, makeDescriptor());
    expect(descriptor.documentId).toBe("opaque-owned-document-id");
    expect(descriptor.sync.kind).toBe("yjs");
    expect(JSON.stringify(ownedBlockDocumentIdentity(descriptor))).toBe(
      JSON.stringify({
        documentId: "opaque-owned-document-id",
        storeEpoch: "store-epoch-a",
        generation: 3,
      }),
    );
  });

  test("registry-dispatches body-only Synced Block descriptors without weakening the Card boundary", async () => {
    const synced = makeDescriptor({
      ownerType: SYNCED_BLOCK_SOURCE_TYPE,
      schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
      schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
    });
    const registered = validateRegisteredOwnedBlockDocumentDescriptor(REQUEST, synced);
    expect(registered.ownerType).toBe(SYNCED_BLOCK_SOURCE_TYPE);
    expect(captureBoundaryCode(() => validateOwnedBlockDocumentDescriptor(REQUEST, synced))).toBe(
      "unsupported_owner_type",
    );

    const fetched = await fetchRegisteredOwnedBlockDocumentDescriptor(REQUEST, async () => synced);
    expect(fetched.schemaKey).toBe(SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queried = await client.fetchQuery(
      registeredOwnedBlockDocumentQueryOptions(REQUEST, {
        fetchDescriptor: async () => synced,
      }),
    );
    expect(queried.ownerType).toBe(SYNCED_BLOCK_SOURCE_TYPE);
  });

  test("rejects scope, owner, type, lifecycle, readiness, and schema drift", () => {
    const cases: ReadonlyArray<{
      readonly expected: OwnedBlockDocumentErrorCode;
      readonly descriptor: unknown;
    }> = [
      {
        expected: "routing_context_mismatch",
        descriptor: makeDescriptor({
          routingContext: { kind: "project", projectId: "project-b" },
        }),
      },
      {
        expected: "owner_mismatch",
        descriptor: makeDescriptor({ ownerBlockId: "card-b" }),
      },
      {
        expected: "unsupported_owner_type",
        descriptor: makeDescriptor({
          ownerType: SYNCED_BLOCK_SOURCE_TYPE,
          schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
          schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
        }),
      },
      {
        expected: "owner_not_active",
        descriptor: makeDescriptor({ ownerLifecycle: "archived" }),
      },
      {
        expected: "document_not_ready",
        descriptor: makeDescriptor({ readiness: "pending_genesis" }),
      },
      {
        expected: "unsupported_document_schema",
        descriptor: makeDescriptor({ schemaKey: "nodex.other" }),
      },
      {
        expected: "unsupported_document_schema",
        descriptor: makeDescriptor({ schemaVersion: 1 }),
      },
    ];

    expect(
      JSON.stringify(
        cases.map(({ descriptor }) =>
          captureBoundaryCode(() => validateOwnedBlockDocumentDescriptor(REQUEST, descriptor)),
        ),
      ),
    ).toBe(JSON.stringify(cases.map(({ expected }) => expected)));
  });

  test("uses the injected fetcher exactly once and never derives document identity", async () => {
    const calls: string[] = [];
    const descriptor = await fetchOwnedBlockDocumentDescriptor(
      REQUEST,
      async (routingContext, ownerBlockId) => {
        calls.push(`${JSON.stringify(routingContext)}/${ownerBlockId}`);
        return makeDescriptor({
          documentId: "server-owned-document",
          sync: { kind: "yjs", stateVector: new Uint8Array([4]) },
        });
      },
    );

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify(['{"kind":"project","projectId":"project-a"}/card-a']),
    );
    expect(descriptor.documentId).toBe("server-owned-document");
    expect(descriptor.sync.kind).toBe("yjs");
  });

  test("preserves typed preparation failures from both renderer transports", () => {
    const code = captureBoundaryCode(() =>
      unwrapOwnedBlockDocumentPreparationResult({
        ok: false,
        error: {
          code: "document_not_ready",
          message: "legacy projections still need migration",
          retryable: true,
          resetRequired: false,
        },
      }),
    );
    expect(code).toBe("document_not_ready");
  });

  test("invalid requests fail before invoking an injected fetcher", async () => {
    let calls = 0;
    let code = "none";
    try {
      await fetchOwnedBlockDocumentDescriptor(
        {
          routingContext: { kind: "project", projectId: " project-a" },
          ownerBlockId: "card-a",
        },
        async () => {
          calls += 1;
          return makeDescriptor();
        },
      );
    } catch (error) {
      code = error instanceof OwnedBlockDocumentBoundaryError ? error.code : "unexpected";
    }
    expect(calls).toBe(0);
    expect(code).toBe("invalid_request");
  });

  test("query failures and invalid primary descriptors remain errors", async () => {
    const failedClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let failedCode = "none";
    try {
      await failedClient.fetchQuery(
        ownedBlockDocumentQueryOptions(REQUEST, {
          fetchDescriptor: async () => {
            throw new Error("transport offline");
          },
        }),
      );
    } catch (error) {
      failedCode = error instanceof OwnedBlockDocumentBoundaryError ? error.code : "unexpected";
    }
    expect(failedCode).toBe("fetch_failed");

    const invalidPrimaryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let invalidPrimaryCode = "none";
    try {
      await invalidPrimaryClient.fetchQuery(
        ownedBlockDocumentQueryOptions(REQUEST, {
          fetchDescriptor: async () =>
            makeDescriptor({
              readiness: "failed",
            }),
        }),
      );
    } catch (error) {
      invalidPrimaryCode =
        error instanceof OwnedBlockDocumentBoundaryError ? error.code : "unexpected";
    }
    expect(invalidPrimaryCode).toBe("document_not_ready");
  });

  test("models loading, errors, and ready descriptors as distinct states", () => {
    const loading = makeOwnedBlockDocumentModel(REQUEST, { status: "pending" });
    const error = makeOwnedBlockDocumentModel(REQUEST, {
      status: "error",
      error: new Error("offline"),
    });
    const ready = validateOwnedBlockDocumentDescriptor(REQUEST, makeDescriptor());
    const readyModel = makeOwnedBlockDocumentModel(REQUEST, {
      status: "success",
      data: ready,
    });

    expect(loading.status).toBe("loading");
    expect(error.status).toBe("error");
    expect(readyModel.status).toBe("ready");
  });

  test("query keys include both authority scope identifiers", () => {
    const options = ownedBlockDocumentQueryOptions(REQUEST, {
      fetchDescriptor: async () => makeDescriptor(),
    });
    expect(JSON.stringify(options.queryKey)).toBe(
      JSON.stringify([
        "blockDocuments",
        "owned",
        { kind: "project", projectId: "project-a" },
        "card-a",
      ]),
    );
  });
});
