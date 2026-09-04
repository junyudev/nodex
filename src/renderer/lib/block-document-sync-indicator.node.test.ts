import { describe, expect, test } from "vite-plus/test";
import type { NodexYProviderStatus } from "./nodex-y-provider";
import {
  BlockDocumentSyncIndicatorError,
  resolveBlockDocumentSyncIndicator,
} from "./block-document-sync-indicator";

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
