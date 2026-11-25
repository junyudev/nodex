import { describe, expect, test, vi } from "vite-plus/test";
import type { NodexYProviderStatus } from "./nodex-y-provider";
import {
  BlockDocumentSyncIndicatorError,
  resolveBlockDocumentSyncIndicator,
} from "./block-document-sync-indicator";
import { DocumentWaitError, waitForDocumentOperation } from "./document-wait";
import { LocalStructuralTransactionPresentationStore } from "./local-structural-transaction-presentation";
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
import {
  CANVAS_BLOCK_TYPE,
  CANVAS_DOCUMENT_SCHEMA_KEY,
  CANVAS_DOCUMENT_SCHEMA_VERSION,
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
  REUSABLE_TEMPLATE_SOURCE_TYPE,
} from "../../shared/block-documents";
import { resolveOwnedDocumentInlineMode } from "./owned-document-inline-mode";

describe("block document sync indicator", () => {
  const status = (overrides: Partial<NodexYProviderStatus> = {}): NodexYProviderStatus => ({
    phase: "synced",
    documentId: "document:card-1",
    clientSessionId: "window-1",
    connected: true,
    storeEpoch: "store-1",
    generation: 1,
    headSeq: 3,
    pendingUpdateCount: 0,
    ...overrides,
    checkpoint: overrides.checkpoint ?? { phase: "ready", failureCount: 0 },
  });

  const TEST_THRESHOLDS = {
    savingDelayMs: 10,
    longPendingMs: 50,
    offlineDelayMs: 20,
    reconnectDelayMs: 30,
  } as const;

  describe("Block Document sync indicator", () => {
    test("a failed submission journal removes the claim of device protection", () => {
      const indicator = resolveBlockDocumentSyncIndicator({
        status: status({
          phase: "offline",
          pendingUpdateCount: 1,
          checkpoint: { phase: "degraded", failureCount: 1, localVersion: 2, protectedVersion: 2 },
        }),
        phaseAgeMs: 2000,
        hasEverSynced: true,
      });
      expect(indicator?.detail).toBe(
        "Latest changes are only in this window. Keep it open while local recovery is being saved.",
      );
    });
    test("keeps synced and normal fast saves completely quiet", () => {
      expect(
        resolveBlockDocumentSyncIndicator({
          status: status(),
          phaseAgeMs: 10_000,
          hasEverSynced: true,
          thresholds: TEST_THRESHOLDS,
        }),
      ).toBe(null);

      expect(
        resolveBlockDocumentSyncIndicator({
          status: status({ phase: "saving", pendingUpdateCount: 1 }),
          phaseAgeMs: 9,
          pendingAgeMs: 9,
          hasEverSynced: true,
          thresholds: TEST_THRESHOLDS,
        }),
      ).toBe(null);
    });

    test("shows delayed saving before escalating long pending work", () => {
      const saving = resolveBlockDocumentSyncIndicator({
        status: status({ phase: "saving", pendingUpdateCount: 2 }),
        phaseAgeMs: 10,
        pendingAgeMs: 10,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(saving?.label).toBe("Saving…");
      expect(saving?.action).toBe(null);
      expect(saving?.editingBlocked).toBe(false);

      const delayed = resolveBlockDocumentSyncIndicator({
        status: status({
          phase: "saving",
          pendingUpdateCount: 2,
          error: {
            code: "transport_unavailable",
            message: "Connection lost",
            retryable: true,
            resetRequired: false,
          },
        }),
        phaseAgeMs: 50,
        pendingAgeMs: 50,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(delayed?.label).toBe("Still saving…");
      expect(delayed?.detail).toBe("Connection lost");
      expect(delayed?.action?.kind).toBe("retry");
      expect(delayed?.editingBlocked).toBe(false);
    });

    test("delays offline flicker while preserving an actionable retained-outbox state", () => {
      expect(
        resolveBlockDocumentSyncIndicator({
          status: status({
            phase: "offline",
            connected: false,
            pendingUpdateCount: 1,
          }),
          phaseAgeMs: 19,
          hasEverSynced: true,
          thresholds: TEST_THRESHOLDS,
        }),
      ).toBe(null);

      const offline = resolveBlockDocumentSyncIndicator({
        status: status({
          phase: "offline",
          connected: false,
          pendingUpdateCount: 1,
        }),
        phaseAgeMs: 20,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(offline?.label).toBe("Offline");
      expect(offline?.detail).toBe(
        "Latest changes are only in this window. Keep it open while local recovery is being saved.",
      );
      expect(offline?.action?.kind).toBe("retry");
      expect(offline?.editingBlocked).toBe(false);
    });

    test("uses the surface loader for initial connection and sparse reconnect chrome later", () => {
      const connecting = status({
        phase: "connecting",
        connected: true,
        storeEpoch: undefined,
        generation: undefined,
      });
      expect(
        resolveBlockDocumentSyncIndicator({
          status: connecting,
          phaseAgeMs: 1_000,
          hasEverSynced: false,
          thresholds: TEST_THRESHOLDS,
        }),
      ).toBe(null);

      const reconnecting = resolveBlockDocumentSyncIndicator({
        status: connecting,
        phaseAgeMs: 30,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(reconnecting?.label).toBe("Reconnecting…");
      expect(reconnecting?.action).toBe(null);

      const longReconnect = resolveBlockDocumentSyncIndicator({
        status: connecting,
        phaseAgeMs: 50,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(longReconnect?.action?.kind).toBe("retry");
    });

    test("blocks editing and requests reload for reset or terminal providers", () => {
      const reset = resolveBlockDocumentSyncIndicator({
        status: status({
          phase: "reset-required",
          connected: false,
          error: {
            code: "store_epoch_mismatch",
            message: "Old store epoch",
            retryable: false,
            resetRequired: true,
          },
        }),
        phaseAgeMs: 0,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(reset?.label).toBe("Reload required");
      expect(reset?.action?.kind).toBe("reload");
      expect(reset?.editingBlocked).toBe(true);
      expect(reset?.announce).toBe("assertive");

      const fatal = resolveBlockDocumentSyncIndicator({
        status: status({
          phase: "error",
          connected: false,
          error: {
            code: "invalid_document_update",
            message: "Document failed validation",
            retryable: false,
            resetRequired: false,
          },
        }),
        phaseAgeMs: 0,
        hasEverSynced: true,
        thresholds: TEST_THRESHOLDS,
      });
      expect(fatal?.label).toBe("Couldn’t save changes");
      expect(fatal?.detail).toBe("Document failed validation");
      expect(fatal?.action?.kind).toBe("reload");
      expect(fatal?.editingBlocked).toBe(true);
    });

    test("rejects invalid timing policy instead of silently changing semantics", () => {
      let error: unknown;
      try {
        resolveBlockDocumentSyncIndicator({
          status: status({ phase: "saving", pendingUpdateCount: 1 }),
          phaseAgeMs: 1,
          pendingAgeMs: 1,
          hasEverSynced: true,
          thresholds: {
            savingDelayMs: 20,
            longPendingMs: 10,
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof BlockDocumentSyncIndicatorError).toBe(true);
    });
  });
});

describe("document wait", () => {
  test("cancels a waiter without running its continuation after late completion", async () => {
    const controller = new AbortController();
    let complete: () => void = () => undefined;
    const durable = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const submit = vi.fn();
    const result = waitForDocumentOperation(() => durable, { signal: controller.signal })
      .then(submit)
      .catch((error) => error);
    controller.abort();
    expect(await result).toMatchObject({ reason: "cancelled" });
    complete();
    await durable;
    expect(submit).not.toHaveBeenCalled();
  });

  test("uses an absolute deadline and rejects before starting expired work", async () => {
    vi.useFakeTimers();
    try {
      const result = waitForDocumentOperation(() => new Promise<void>(() => undefined), {
        deadlineAt: Date.now() + 100,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ reason: "timeout" });
      const start = vi.fn(async () => undefined);
      await expect(
        waitForDocumentOperation(start, { deadlineAt: Date.now() - 1 }),
      ).rejects.toBeInstanceOf(DocumentWaitError);
      expect(start).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("local structural transaction presentation", () => {
  test("a newer Page move permanently supersedes an older promotion presentation", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    store.begin("promotion", "epoch");
    expect(store.claimPageIds("promotion", "epoch", ["page"])).toBe(true);
    expect(store.ownsPage("promotion", "epoch", "page")).toBe(true);

    store.beginDatabasePageMove({
      operationId: "move-away",
      storeEpoch: "epoch",
      dataSourceId: "source",
      pageIds: ["page"],
    });

    expect(store.ownsPage("promotion", "epoch", "page")).toBe(false);
    expect(store.ownsPage("move-away", "epoch", "page")).toBe(true);
    store.reject("move-away");
    expect(store.claimPageIds("promotion", "epoch", ["page"])).toBe(false);
  });

  test("keeps the source Page hidden until both projections prove the committed move", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    const scope = { storeEpoch: "epoch", dataSourceId: "source" };
    store.beginDatabasePageMove({
      operationId: "move",
      ...scope,
      pageIds: ["page"],
    });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));

    store.acknowledge({
      operationId: "move",
      storeEpoch: "epoch",
      commitSeq: 10,
      resultPageIds: ["page"],
    });
    store.markTargetMaterialized("move");
    store.observeDatabaseProjection({ ...scope, commitSeq: 9, pageIds: new Set() });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));
    store.observeDatabaseProjection({ ...scope, commitSeq: 10, pageIds: new Set(["page"]) });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set(["page"]));

    store.observeDatabaseProjection({ ...scope, commitSeq: 10, pageIds: new Set() });
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set());
  });

  test("deterministic rejection removes the predicted source projection", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    const scope = { storeEpoch: "epoch", dataSourceId: "source" };
    store.beginDatabasePageMove({ operationId: "move", ...scope, pageIds: ["page"] });
    store.reject("move");
    expect(store.hiddenDatabasePageIds(scope)).toEqual(new Set());
  });

  test("replaces planned Page claims atomically without exposing an ownership gap", () => {
    const store = new LocalStructuralTransactionPresentationStore();
    store.begin("promotion", "epoch");
    expect(store.claimPageIds("promotion", "epoch", ["planned"])).toBe(true);

    const ownershipSnapshots: boolean[] = [];
    const release = store.subscribe(() => {
      ownershipSnapshots.push(
        store.ownsPage("promotion", "epoch", "planned") ||
          store.ownsPage("promotion", "epoch", "committed"),
      );
    });

    expect(
      store.replacePageClaims({
        operationId: "promotion",
        storeEpoch: "epoch",
        previousPageIds: ["planned"],
        nextPageIds: ["planned"],
      }),
    ).toBe(true);
    expect(ownershipSnapshots).toEqual([]);

    expect(
      store.replacePageClaims({
        operationId: "promotion",
        storeEpoch: "epoch",
        previousPageIds: ["planned"],
        nextPageIds: ["committed"],
      }),
    ).toBe(true);
    expect(ownershipSnapshots).toEqual([true]);
    expect(store.ownsPage("promotion", "epoch", "planned")).toBe(false);
    expect(store.ownsPage("promotion", "epoch", "committed")).toBe(true);
    release();
  });
});

describe("owned block document", () => {
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

      const fetched = await fetchRegisteredOwnedBlockDocumentDescriptor(
        REQUEST,
        async () => synced,
      );
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
          "space",
          "test-space",
          "blockDocuments",
          "owned",
          { kind: "project", projectId: "project-a" },
          "card-a",
        ]),
      );
    });
  });
});

describe("resolveOwnedDocumentInlineMode", () => {
  test("routes BlockNote bodies inline and Canvas scenes to their own view", () => {
    expect(
      resolveOwnedDocumentInlineMode({
        ownerType: REUSABLE_TEMPLATE_SOURCE_TYPE,
        schemaKey: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
        schemaVersion: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
      }),
    ).toBe("block_tree");
    expect(
      resolveOwnedDocumentInlineMode({
        ownerType: CANVAS_BLOCK_TYPE,
        schemaKey: CANVAS_DOCUMENT_SCHEMA_KEY,
        schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
      }),
    ).toBe("scene_view");
  });
});
