import { decodeRecoveryBundleSections } from "../../shared/block-documents/recovery-bundle";
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
    source_store_epoch: capture.source_store_epoch,
    source_generation: capture.generation,
    current: true,
    retained: true,
    restored: true,
    already_saved: false,
    can_restore: true,
    can_copy: true,
    current_generation: 1,
    current_head_seq: 1,
  };
};
const port = (drafts: RecoveryDraftSummary[] = []): DocumentRecoveryPort => ({
  subscribe: () => () => {},
  export: vi.fn(async () => ({ ok: true as const, status: "saved" as const })),
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
  apply: vi.fn(async (command) => {
    if (command.kind === "resolve")
      return { ...inspection().summary, resolution: "restored" as const, revision: 2 };
    const { manifest } = await decodeRecoveryBundleSections(command.bundle.bytes);
    const received = {
      draft_id: command.bundle.draftId,
      document_id: manifest.document_id,
      created_at: manifest.created_at,
      received_at: manifest.created_at,
      revision: 1,
      payload_hash: command.bundle.payloadHash,
      byte_length: command.bundle.bytes.length,
    };
    return {
      ...received,
      capture_receipt: {
        draft_id: received.draft_id,
        source_revision: command.bundle.sourceRevision,
        submitted_payload_hash: command.bundle.payloadHash,
        stored_payload_hash: command.bundle.payloadHash,
        stored_encoding: "bundle_v1",
        stored_byte_length: command.bundle.bytes.length,
      },
    };
  }),
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
beforeEach(() => {
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("indexedDB", new IDBFactory());
});
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
    expect(module.getSnapshot().staged[0]?.failure?.message).toBe("ACK lost");
    expect(await store.nextRecovery("document:one")).not.toBeNull();
    await module.refresh();
    expect(vi.mocked(adapter.apply)).toHaveBeenCalledTimes(1);
    await module.retry(module.getSnapshot().staged[0].sourceKey);
    expect(await store.nextRecovery("document:one")).toBeNull();
    expect(vi.mocked(adapter.apply).mock.calls[1]?.[0]).toEqual(
      vi.mocked(adapter.apply).mock.calls[0]?.[0],
    );
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
      .mock.calls.flatMap(([command]) => (command.kind === "capture" ? [command.bundle] : []));
    expect(
      (
        await Promise.all(
          captures.map(
            async (bundle) =>
              (await decodeRecoveryBundleSections(bundle.bytes)).manifest.document_id,
          ),
        )
      ).sort(),
    ).toEqual(["document:one", "document:removed"]);
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

test("the Library recovery overview ignores ordinary saves when no drafts exist", async () => {
  vi.stubGlobal("window", new EventTarget());
  const transport = port();
  let notify: Parameters<DocumentRecoveryPort["subscribe"]>[1] = () => {};
  transport.subscribe = (_scope, listener) => {
    notify = listener;
    return () => {};
  };
  const module = new DocumentRecovery(scope, null, transport);
  const release = module.connect();
  try {
    await module.refresh();
    await vi.waitFor(() => expect(module.getSnapshot().loading).toBe(false));
    vi.mocked(transport.read).mockClear();
    notify("document:one", "content");
    await Promise.resolve();
    expect(transport.read).not.toHaveBeenCalled();
    notify("document:one", "recovery");
    await vi.waitFor(() => expect(transport.read).toHaveBeenCalled());
  } finally {
    release();
  }
});

test("recovery transport takes only access identity from a retained runtime descriptor", async () => {
  const descriptor = { ...scope, documentId: "document:one", createProvider: () => {} };
  const transport = port();
  const module = new DocumentRecovery(descriptor, descriptor.documentId, transport);
  await module.refresh();
  expect(module.getSnapshot().error).toBeNull();
  for (const [requestScope] of vi.mocked(transport.read).mock.calls) {
    expect(requestScope).toEqual(scope);
    expect(structuredClone(requestScope)).toEqual(scope);
  }
});

test("a persisted cursor reaches the package after 257 permanent failures without retrying the prefix", async () => {
  const { IndexedDbCanvasSceneOutbox } = await import("./canvas-scene-outbox");
  const outbox = new IndexedDbCanvasSceneOutbox(indexedDB, scope.libraryId);
  for (let index = 0; index < 258; index += 1) {
    const intent = {
      accessContext: scope.accessContext,
      documentId: `canvas:${index}`,
      mutationId: `mutation:${index}`,
      storeEpoch: "epoch:one",
      generation: 1,
      baseHeadSeq: 0,
      elementCandidates: [
        {
          id: "rectangle",
          type: "rectangle",
          index: "a0",
          version: 1,
          versionNonce: 1,
          isDeleted: false,
        },
      ],
      appStateIntents: {},
      fileAdditions: {},
    };
    await outbox.put(intent);
    await outbox.quarantine(
      intent,
      {
        code: "unknown",
        message: "retained",
        retryable: false,
        resetRequired: false,
        mutationId: intent.mutationId,
      },
      index,
    );
  }
  const sources = [];
  let cursor: string | null = null;
  do {
    const page = await outbox.staging.listSummaries(scope, null, cursor);
    sources.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  const last = sources.at(-1)!;
  const adapter = port();
  vi.mocked(adapter.apply).mockImplementation(async (command) => {
    if (command.kind !== "capture") throw new Error("Expected a capture command");
    const { manifest } = await decodeRecoveryBundleSections(command.bundle.bytes);
    if (manifest.document_id !== last.documentId)
      throw new CoreApiError({
        code: "invalid_input",
        message: "This retained source needs manual review",
        retryable: false,
        recovery: { kind: "none" },
      });
    return port().apply(command);
  });
  // Recreating the coordinator each slice proves fairness lives in IndexedDB, not the window.
  for (let slice = 0; slice < 33; slice += 1)
    await new DocumentRecovery(scope, null, adapter).refresh();
  expect(adapter.apply).toHaveBeenCalledTimes(258);
  expect(await outbox.staging.countSummaries(scope, null)).toBe(257);
  expect((await outbox.staging.listSummaries(scope, null, last.sourceKey)).entries).toEqual([]);
});

test("another coordinator cannot remove a draft during Core reception", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(indexedDB, scope);
  await store.quarantine(snapshot(), { maxStateBytes: 1024 * 1024 });
  const healthy = port();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const api: DocumentRecoveryPort = {
    ...healthy,
    read: async () => {
      throw new Error("offline");
    },
    apply: async (command) => {
      entered();
      await gate;
      return healthy.apply(command);
    },
  };
  const sender = new DocumentRecovery(scope, "document:one", api);
  const remover = new DocumentRecovery(scope, null, api);
  await Promise.all([sender.refresh(), remover.refresh()]);
  const entry = remover.getSnapshot().staged[0];
  api.read = healthy.read;
  const sending = sender.retry(entry.sourceKey);
  await started;
  try {
    expect(remover.getSnapshot().sending).toEqual([]);
    await expect(remover.removeLocal(entry)).rejects.toThrow("another window");
    expect(await store.staging.countSummaries(scope, null)).toBe(1);
  } finally {
    release();
    await sending;
  }
  expect(await store.staging.countSummaries(scope, null)).toBe(0);
});

test("a stale coordinator cannot send a draft after local removal", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(indexedDB, scope);
  await store.quarantine(snapshot(), { maxStateBytes: 1024 * 1024 });
  const healthy = port();
  const api: DocumentRecoveryPort = {
    ...healthy,
    read: async () => {
      throw new Error("offline");
    },
  };
  const sender = new DocumentRecovery(scope, "document:one", api);
  const remover = new DocumentRecovery(scope, null, api);
  await Promise.all([sender.refresh(), remover.refresh()]);
  const entry = remover.getSnapshot().staged[0];
  await remover.removeLocal(entry);
  api.read = healthy.read;
  await expect(sender.retry(entry.sourceKey)).rejects.toThrow("changed");
  expect(api.apply).not.toHaveBeenCalled();
  expect(await store.staging.countSummaries(scope, null)).toBe(0);
});
