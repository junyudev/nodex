import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as Y from "yjs";
import {
  IndexedDbDocumentLocalCheckpointStore,
  type DocumentRecoverySnapshot,
} from "./document-local-checkpoint";
import { decodeRecoverySource } from "../../shared/block-documents/recovery-bundle";
import type { RecoveryCaptureReceipt } from "../../shared/block-documents/document-recovery";
import type { FrozenRecoveryRecord } from "./document-recovery-staging";

const scope = { libraryId: "library:one", accessContext: { kind: "library" as const } };
const snapshot = (title = "x".repeat(70_020)): DocumentRecoverySnapshot => {
  const document = new Y.Doc();
  document.getText("title").insert(0, title);
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return {
    documentId: "document:one",
    storeEpoch: "epoch:one",
    generation: 1,
    headSeq: 1,
    state,
    updatedAt: "2026-09-12T00:00:00.000Z",
    recoveryId: "draft:one",
    schema: { ownerType: "page", schemaKey: "nodex.page", schemaVersion: 1 },
    error: { code: "unknown", message: "uncertain", retryable: false, resetRequired: false },
    submissions: [
      {
        documentId: "document:one",
        storeEpoch: "epoch:one",
        generation: 1,
        clientSessionId: "original:session",
        updateId: "original:update",
        baseHeadSeq: 1,
        update: new Uint8Array([255]),
        touchedBlockIds: [],
      },
    ],
  };
};
const receipt = (frozen: FrozenRecoveryRecord): RecoveryCaptureReceipt => ({
  draft_id: frozen.bundle.draftId,
  source_revision: frozen.bundle.sourceRevision,
  submitted_payload_hash: frozen.bundle.payloadHash,
  stored_payload_hash: frozen.bundle.payloadHash,
  stored_encoding: "bundle_v1",
  stored_byte_length: frozen.bundle.bytes.length,
});
beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
afterEach(() => vi.unstubAllGlobals());

test("two windows freeze the same exact package and retry identity across reopen", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
  const second = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
  await first.quarantine(snapshot(), { maxStateBytes: 200_000 });
  const original = await first.nextRecovery("document:one");
  const [entry] = (await first.staging.listSummaries(scope, null, null)).entries;
  const [a, b] = await Promise.all([
    first.staging.freeze(entry, scope, "epoch:one"),
    second.staging.freeze(entry, scope, "epoch:one"),
  ]);
  expect(a.operationId).toBe(b.operationId);
  expect(a.bundle).toEqual(b.bundle);
  expect(a.bundle.bytes.length).toBeLessThan(75_000);
  expect(await decodeRecoverySource(a.bundle.bytes)).toEqual(original);
  const reopened = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
  expect(await reopened.staging.freeze(entry, scope, "epoch:one")).toEqual(a);
  expect((await reopened.readRecovery(snapshot())).at(0)?.submissions?.[0].updateId).toBe(
    "original:update",
  );
});

test("wrong receipt coordinates never clear staging; an old ACK cannot clear a newer capture", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory(), scope);
  await store.quarantine(snapshot("first"), { maxStateBytes: 200_000 });
  const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
  const frozen = await store.staging.freeze(entry, scope, "epoch:one");
  for (const wrong of [
    { ...receipt(frozen), draft_id: "other" },
    { ...receipt(frozen), submitted_payload_hash: "b".repeat(64) },
    { ...receipt(frozen), source_revision: "other" },
    { ...receipt(frozen), stored_byte_length: 1 },
  ])
    await expect(store.staging.acknowledge(entry, frozen, wrong)).rejects.toThrow("acknowledge");
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
  await store.quarantine(snapshot("newer"), { maxStateBytes: 200_000 });
  expect(await store.staging.countSummaries(scope, null)).toBe(2);
  expect(await store.staging.acknowledge(entry, frozen, receipt(frozen))).toBe(true);
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
  const remaining = (await store.staging.listSummaries(scope, null, null)).entries[0];
  expect(remaining.sourceRevision).not.toBe(entry.sourceRevision);
  const next = await store.staging.freeze(remaining, scope, "epoch:one");
  expect(next.bundle.draftId).not.toBe(frozen.bundle.draftId);
});

test("legacy rows without a verified Library stay discoverable and exportable", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
  await store.quarantine(snapshot("earlier world"), { maxStateBytes: 200_000 });
  const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
  expect(entry.scope).toBeNull();
  await expect(store.staging.freeze(entry, scope, "another-epoch")).rejects.toThrow(
    "cannot be verified",
  );
  const bytes = await store.staging.export(entry);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("NDRE");
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
  expect(
    (
      await store.staging.listSummaries(
        { ...scope, accessContext: { kind: "project", projectId: "project:other" } },
        null,
        null,
      )
    ).entries,
  ).toHaveLength(0);
});

test("resolve operations have one durable winner and late acknowledgements preserve newer actions", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbDocumentLocalCheckpointStore(factory, scope).staging;
  const second = new IndexedDbDocumentLocalCheckpointStore(factory, scope).staging;
  const [a, b] = await Promise.all([
    first.prepareOperation("resolve:draft", { operationId: "first", choice: "copy" }),
    second.prepareOperation("resolve:draft", { operationId: "second", choice: "copy" }),
  ]);
  expect(a).toEqual(b);
  await first.acknowledgeOperation("resolve:draft", a);
  const next = await second.prepareOperation("resolve:draft", {
    operationId: "new",
    choice: "reopen",
  });
  await first.acknowledgeOperation("resolve:draft", a);
  expect(await second.readOperation("resolve:draft")).toEqual(next);
});

test("explicit local removal clears only the reviewed package and rejects stale revisions", async () => {
  const store = new IndexedDbDocumentLocalCheckpointStore(new IDBFactory());
  await store.quarantine(snapshot("first"), { maxStateBytes: 200_000 });
  const [entry] = (await store.staging.listSummaries(scope, null, null)).entries;
  await store.quarantine(
    { ...snapshot("second"), recoveryId: "draft:two" },
    { maxStateBytes: 200_000 },
  );
  await expect(store.staging.remove({ ...entry, sourceRevision: "stale" })).rejects.toThrow(
    "Review it again",
  );
  expect(await store.staging.countSummaries(scope, null)).toBe(2);
  await store.staging.remove(entry);
  expect(await store.staging.countSummaries(scope, null)).toBe(1);
  await expect(store.staging.export(entry)).rejects.toThrow("changed");
  const [remaining] = (await store.staging.listSummaries(scope, null, null)).entries;
  expect(remaining.sourceKey).not.toBe(entry.sourceKey);
  expect((await store.staging.export(remaining)).length).toBeGreaterThan(0);
});

test("a newer capture cannot be removed by an earlier review", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbDocumentLocalCheckpointStore(factory);
  const second = new IndexedDbDocumentLocalCheckpointStore(factory);
  await first.quarantine(snapshot("reviewed"), { maxStateBytes: 200_000 });
  const [reviewed] = (await first.staging.listSummaries(scope, null, null)).entries;
  await second.quarantine(snapshot("new edits"), { maxStateBytes: 200_000 });
  await expect(first.staging.remove(reviewed)).rejects.toThrow("Review it again");
  const [current] = (await first.staging.listSummaries(scope, null, null)).entries;
  expect(current.sourceRevision).not.toBe(reviewed.sourceRevision);
  expect(await second.nextRecovery("document:one")).not.toBeNull();
});

test("a receipt claim survives its window and prevents removal until acknowledged", async () => {
  const factory = new IDBFactory();
  const sender = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
  await sender.quarantine(snapshot(), { maxStateBytes: 200_000 });
  const [entry] = (await sender.staging.listSummaries(scope, null, null)).entries;
  const frozen = await sender.staging.freeze(entry, scope, "epoch:one");
  expect(await sender.staging.claimTransfer(entry)).toBe(false);
  const reopened = new IndexedDbDocumentLocalCheckpointStore(factory, scope);
  await expect(reopened.staging.remove(entry)).rejects.toThrow(
    "Receipt for this draft is unconfirmed",
  );
  expect(await reopened.staging.claimTransfer(entry)).toBe(true);
  await reopened.staging.acknowledge(entry, frozen, receipt(frozen));
  expect(await reopened.staging.countSummaries(scope, null)).toBe(0);
});
