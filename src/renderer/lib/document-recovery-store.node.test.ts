import { IDBFactory } from "fake-indexeddb";
import { expect, test } from "vitest";
import * as Y from "yjs";
import {
  IndexedDbDocumentLocalCheckpointStore,
  type DocumentLocalCheckpoint,
  type DocumentRecoverySnapshot,
} from "./document-local-checkpoint";

const boundary = { documentId: "document-1", storeEpoch: "epoch-1", generation: 1 };
const checkpoint = (
  text: string,
  coverage: Record<string, number> = {},
): DocumentLocalCheckpoint => {
  const document = new Y.Doc();
  document.getText("text").insert(0, text);
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return { ...boundary, headSeq: 2, state, coverage, updatedAt: new Date().toISOString() };
};
const recovery = (value: DocumentLocalCheckpoint): DocumentRecoverySnapshot => ({
  ...value,
  recoveryId: "recovery-1",
  schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
  error: {
    code: "recovery_required",
    message: "Structural conflict",
    retryable: false,
    resetRequired: false,
  },
});

test("quarantine atomically preserves other writers and exact submissions without deleting another generation", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbDocumentLocalCheckpointStore(factory);
  const second = new IndexedDbDocumentLocalCheckpointStore(factory);
  const a = checkpoint("A", { a: 2 });
  const b = checkpoint("B", { b: 3 });
  const newer = { ...checkpoint("new generation"), generation: 2 };
  await Promise.all([first.write(a), second.write(b), second.write(newer)]);
  const submitted = {
    ...boundary,
    clientSessionId: "old-session",
    updateId: "exact-update",
    baseHeadSeq: 2,
    update: b.state,
    touchedBlockIds: [],
  };
  await first.recordSubmission(submitted, 2);
  await expect(first.recordSubmission({ ...submitted, update: a.state }, 2)).rejects.toThrow(
    "identity",
  );
  await first.quarantine(recovery(a), { maxStateBytes: 10000 });
  expect(await first.read(boundary)).toBeNull();
  expect(await first.read({ ...boundary, generation: 2 })).toMatchObject({ state: newer.state });
  const [retained] = await second.readRecovery(boundary);
  expect(retained).toMatchObject({ coverage: { a: 2, b: 3 }, submissions: [submitted] });
  const document = new Y.Doc();
  Y.applyUpdate(document, retained!.state);
  expect(["AB", "BA"]).toContain(document.getText("text").toString());
  document.destroy();
  await second.write(b);
  expect(await first.read(boundary)).not.toBeNull();
});

test("malformed cached bytes remain exportable when they cannot be merged", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
  const malformed = new Uint8Array([255]);
  await store.write({ ...checkpoint("draft"), state: malformed });
  await store.quarantine(recovery(checkpoint("canonical")), { maxStateBytes: 10000 });
  const [retained] = await store.readRecovery(boundary);
  expect(retained?.unintegratedUpdates).toEqual([malformed]);
  const document = new Y.Doc();
  Y.applyUpdate(document, retained!.state);
  expect(document.getText("text").toString()).toBe("canonical");
  document.destroy();
  expect(await store.read(boundary)).toBeNull();
});

test("failed quarantine leaves the active bytes and original request intact", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
  const value = checkpoint("retained");
  await store.write(value);
  const request = {
    ...boundary,
    clientSessionId: "session",
    updateId: "request",
    baseHeadSeq: 2,
    update: value.state,
    touchedBlockIds: [],
  };
  await store.recordSubmission(request, 2);
  await expect(store.quarantine(recovery(value), { maxStateBytes: 1 })).rejects.toThrow(
    "local limit",
  );
  expect(await store.read(boundary)).toMatchObject({ state: value.state, submissions: [request] });
  expect(await store.readRecovery(boundary)).toHaveLength(0);
  await store.acknowledgeSubmission({ ...request, updateId: "another" });
  expect((await store.read(boundary))?.submissions).toHaveLength(1);
  await store.acknowledgeSubmission(request);
  expect((await store.read(boundary))?.submissions).toHaveLength(0);
});
