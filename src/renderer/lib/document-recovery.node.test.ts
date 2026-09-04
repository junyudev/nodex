import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as Y from "yjs";
import {
  createPageDocument,
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../shared/block-documents";
import {
  IndexedDbDocumentLocalCheckpointStore,
  type DocumentRecoverySnapshot,
} from "./document-local-checkpoint";
import { captureDocumentRecovery, encodeRecoveryEnvelope } from "./document-recovery-package";
import { DocumentRecovery, type DocumentRecoveryPort } from "./document-recovery";
import { CoreApiError } from "./core-api-error";
import type {
  RecoveryDraftCapture,
  RecoveryDraftInspection,
  RecoveryDraftSummary,
  DocumentRecoveryCommand,
} from "../../shared/block-documents/document-recovery";

const scope = { libraryId: "library:one", accessContext: { kind: "library" as const } };
const snapshot = (): DocumentRecoverySnapshot => {
  const { document } = createPageDocument({ documentId: "document:one", initialTitle: "Retained" });
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return {
    documentId: "document:one",
    storeEpoch: "epoch:one",
    generation: 1,
    headSeq: 1,
    state,
    updatedAt: "2026-09-04T00:00:00.000Z",
    recoveryId: "draft:one",
    schema: {
      ownerType: "page",
      schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
    },
    error: { code: "unknown", message: "uncertain", retryable: false, resetRequired: false },
  };
};
const summary = (capture: RecoveryDraftCapture): RecoveryDraftSummary => ({
  draft_id: capture.draft_id,
  document_id: capture.document_id,
  revision: 1,
  created_at: capture.created_at,
  received_at: capture.created_at,
  byte_length: 123,
  payload_hash: "a".repeat(64),
});
const inspection = (): RecoveryDraftInspection => {
  const capture = captureDocumentRecovery(snapshot());
  return {
    summary: summary(capture),
    capture,
    already_saved: false,
    can_restore: true,
    can_copy: true,
    current_generation: 1,
    current_head_seq: 1,
    retained: { kind: "document", title: "Retained", rich_title: [], nfm: "", files: {} },
  };
};
const port = (drafts: RecoveryDraftSummary[] = []): DocumentRecoveryPort => ({
  subscribe: () => () => {},
  read: vi.fn(async (_scope, read) => ({
    ok: true as const,
    value:
      read.kind === "list"
        ? {
            kind: "list" as const,
            page: { drafts, pending_count: drafts.filter((draft) => !draft.resolution).length },
          }
        : { kind: "inspect" as const, inspection: inspection() },
    storeEpoch: "epoch:one",
  })),
  apply: vi.fn(async (command) =>
    command.kind === "capture"
      ? summary(command.capture)
      : { ...inspection().summary, resolution: "restored" as const, revision: 2 },
  ),
});
const installStorage = () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  return entries;
};
beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
afterEach(() => vi.unstubAllGlobals());

describe("durable document recovery", () => {
  test("acknowledges only the exact captured bytes across old generations", async () => {
    const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
    const first = snapshot();
    await store.quarantine(first, { maxStateBytes: 1024 * 1024 });
    const captured = await store.nextRecovery(first.documentId);
    expect(captured?.recoveryId).toBe(first.recoveryId);
    const newer = { ...first, generation: 2, recoveryId: "draft:two" };
    await store.quarantine(newer, { maxStateBytes: 1024 * 1024 });
    expect((await store.nextRecovery(first.documentId, first.recoveryId))?.generation).toBe(2);
    await store.acknowledgeRecovery(first); // Includes less evidence than the stored merged envelope.
    expect(await store.nextRecovery(first.documentId)).not.toBeNull();
    await store.acknowledgeRecovery(captured!);
    expect((await store.nextRecovery(first.documentId))?.recoveryId).toBe("draft:two");
  });
  test("failed Core capture leaves the local package intact", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const store = new IndexedDbDocumentLocalCheckpointStore(factory);
    await store.quarantine(snapshot(), { maxStateBytes: 1024 * 1024 });
    const adapter = port();
    vi.mocked(adapter.apply).mockRejectedValueOnce(new Error("ACK lost"));
    const module = new DocumentRecovery(scope, "document:one", adapter);
    await module.refresh();
    expect(module.getSnapshot().error).toBe("ACK lost");
    expect(await store.nextRecovery("document:one")).not.toBeNull();
    await module.refresh();
    expect(await store.nextRecovery("document:one")).toBeNull();
  });
  test("Library review drains old generations without opening their source documents", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const store = new IndexedDbDocumentLocalCheckpointStore(factory);
    const first = snapshot();
    await store.quarantine(first, { maxStateBytes: 1024 * 1024 });
    await store.quarantine(
      {
        ...first,
        recoveryId: "draft:another-document",
        documentId: "document:removed",
        generation: 2,
      },
      { maxStateBytes: 1024 * 1024 },
    );
    const adapter = port();
    await new DocumentRecovery(scope, null, adapter).refresh();
    const captures = vi
      .mocked(adapter.apply)
      .mock.calls.flatMap(([command]) => (command.kind === "capture" ? [command.capture] : []));
    expect(captures.map((capture) => capture.document_id).sort()).toEqual([
      "document:one",
      "document:removed",
    ]);
    expect(await store.recoveryDocumentIds()).toEqual([]);
  });

  test("an uncertain restore survives reopening and retries the frozen identity", async () => {
    installStorage();
    const adapter = port();
    const commands: DocumentRecoveryCommand[] = [];
    adapter.apply = vi.fn(async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("ACK lost");
      return { ...inspection().summary, resolution: "restored" as const, revision: 2 };
    });
    const module = new DocumentRecovery(scope, null, adapter);
    await module.refresh();
    await expect(module.resolve(inspection(), "restore")).rejects.toThrow("ACK lost");
    const reopened = new DocumentRecovery(scope, null, adapter);
    await reopened.refresh();
    await reopened.resolve(inspection(), "restore");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });
  test("a rejected stale preview permits a fresh, explicit restore intent", async () => {
    installStorage();
    const adapter = port();
    vi.mocked(adapter.apply).mockRejectedValueOnce(
      new CoreApiError({
        code: "revision_conflict",
        message: "Preview changed",
        retryable: false,
        recovery: { kind: "none" },
      }),
    );
    const module = new DocumentRecovery(scope, null, adapter);
    await module.refresh();
    await expect(module.resolve(inspection(), "restore")).rejects.toThrow("Preview changed");
    await module.resolve({ ...inspection(), current_head_seq: 2 }, "restore");
    const commands = vi.mocked(adapter.apply).mock.calls.map(([command]) => command);
    expect(commands[0]?.operationId).not.toBe(commands[1]?.operationId);
  });
  test("capture exports undecodable source bytes without inventing coverage", () => {
    const value = { ...snapshot(), unintegratedUpdates: [new Uint8Array([255, 128, 0])] };
    const capture = captureDocumentRecovery(value);
    expect(capture.content).toMatchObject({ unintegrated_updates: [[255, 128, 0]] });
    expect(JSON.parse(encodeRecoveryEnvelope(value)).coverage).toBeUndefined();
  });
});
