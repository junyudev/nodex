import type {
  DocumentRecoveryScope,
  RecoveryCaptureReceipt,
} from "../../shared/block-documents/document-recovery";
import {
  contentAccessIdentityKey,
  parseContentAccessContext,
} from "../../shared/content-access-context";
import { createBoundedOperationId } from "../../shared/operation-identity";
import {
  decodeRecoverySource,
  RecoveryBundleValidationError,
  encodeRecoveryBundle,
  encodeRecoveryExport,
  recoveryPayloadHash,
  type FrozenRecoveryBundle,
  type RecoveryBundleInput,
} from "../../shared/block-documents/recovery-bundle";
import { encodeRecoveryEnvelope } from "./document-recovery-package";

export const RECOVERY_DIRECTORY_STORE = "recovery-staging-directory";
export const RECOVERY_OPERATIONS_STORE = "recovery-staging-operations";
export type RecoverySourceKind = "yjs" | "canvas";
export interface RecoveryTransferFailure {
  readonly code: string;
  readonly message: string;
  readonly effect: "not_applied" | "unknown";
  readonly retry: "automatic" | "manual" | "rebind";
  readonly actual?: number | null;
  readonly limit?: number | null;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
}
export interface RecoveryStagingSummary {
  readonly sourceKey: string;
  readonly receiptPending?: boolean;
  readonly sourceRevision: string;
  readonly sourceKind: RecoverySourceKind;
  readonly rawKey: IDBValidKey;
  readonly scope: DocumentRecoveryScope | null;
  readonly documentId: string | null;
  readonly sourceEpoch: string | null;
  readonly draftId: string | null;
  readonly createdAt: string | null;
  readonly byteLength: number | null;
  readonly encoding: "legacy" | "bundle_v1";
  readonly failure: RecoveryTransferFailure | null;
  readonly operationId: string | null;
  readonly payloadHash: string | null;
  readonly libraryKey: string;
  readonly scopeKey: string;
}
export interface FrozenRecoveryRecord {
  readonly format: "nodex-recovery-staging-v1";
  readonly scope: DocumentRecoveryScope;
  readonly storeEpoch: string;
  readonly operationId: string;
  readonly bundle: FrozenRecoveryBundle;
}
export interface RecoveryStagingPage {
  readonly entries: readonly RecoveryStagingSummary[];
  readonly nextCursor: string | null;
}
interface StagingConfiguration {
  readonly kind: RecoverySourceKind;
  readonly storeName: string;
  readonly database: () => Promise<IDBDatabase>;
  readonly source: (row: unknown) => unknown;
  readonly input: (source: unknown) => RecoveryBundleInput;
  readonly frozenRow: (original: unknown, frozen: FrozenRecoveryRecord) => unknown;
}
export const recoveryRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export const frozenRecoveryRecord = (row: unknown): FrozenRecoveryRecord | null => {
  const record = recoveryRecord(row);
  const value = recoveryRecord(record?.retainedPackage);
  if (value?.format !== "nodex-recovery-staging-v1") return null;
  const bundle = recoveryRecord(value.bundle);
  if (
    !bundle ||
    !(bundle.bytes instanceof Uint8Array) ||
    typeof bundle.payloadHash !== "string" ||
    typeof bundle.draftId !== "string" ||
    typeof bundle.sourceRevision !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.storeEpoch !== "string"
  )
    throw new Error(
      "The retained package metadata is damaged. Export its original stored representation.",
    );
  const scope = recoveryRecord(value.scope);
  if (!scope || typeof scope.libraryId !== "string")
    throw new Error("Retained package scope is unavailable");
  contentAccessIdentityKey({
    libraryId: scope.libraryId,
    accessContext: parseContentAccessContext(scope.accessContext),
  });
  return value as unknown as FrozenRecoveryRecord;
};
export const readRetainedSource = async (
  row: unknown,
  legacy: (row: unknown) => unknown,
): Promise<unknown> => {
  const frozen = frozenRecoveryRecord(row);
  if (!frozen) return legacy(row);
  if ((await recoveryPayloadHash(frozen.bundle.bytes)) !== frozen.bundle.payloadHash)
    throw new Error("The retained package digest does not match");
  return decodeRecoverySource(frozen.bundle.bytes);
};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;

/** Metadata is separate from payload in the same transaction and database, so listing never loads blobs. */
export const recoverySummary = (
  kind: RecoverySourceKind,
  key: IDBValidKey,
  row: unknown,
  knownScope: DocumentRecoveryScope | null = null,
): RecoveryStagingSummary => {
  const source = recoveryRecord(row);
  const intent = recoveryRecord(source?.intent);
  let scope = knownScope;
  if (kind === "canvas" && source && text(source.libraryId) && intent) {
    try {
      scope = {
        libraryId: String(source.libraryId),
        accessContext: parseContentAccessContext(intent.accessContext),
      };
    } catch {
      scope = null;
    }
  }
  const documentId = text(
    kind === "yjs" ? source?.documentId : (intent?.documentId ?? source?.documentId),
  );
  const draftId =
    kind === "yjs"
      ? text(source?.recoveryId)
      : documentId && text(intent?.mutationId)
        ? `canvas:${documentId}:${String(intent!.mutationId)}`
        : null;
  const createdAt =
    kind === "yjs"
      ? text(source?.updatedAt)
      : typeof source?.rejectedAt === "number" &&
          Number.isFinite(source.rejectedAt) &&
          Math.abs(source.rejectedAt) <= 8.64e15
        ? new Date(source.rejectedAt).toISOString()
        : null;
  return {
    sourceKey: `${kind}:${JSON.stringify(key)}`,
    sourceRevision: crypto.randomUUID(),
    sourceKind: kind,
    rawKey: key,
    scope,
    documentId,
    sourceEpoch: text(kind === "yjs" ? source?.storeEpoch : intent?.storeEpoch),
    draftId,
    createdAt,
    byteLength: null,
    encoding: "legacy",
    failure: null,
    operationId: null,
    payloadHash: null,
    libraryKey: scope?.libraryId ?? "",
    scopeKey: scope ? contentAccessIdentityKey(scope) : "",
  };
};

export const installRecoveryDirectory = (
  database: IDBDatabase,
  transaction: IDBTransaction,
  storeName: string,
  kind: RecoverySourceKind,
): void => {
  if (!database.objectStoreNames.contains(RECOVERY_OPERATIONS_STORE))
    database.createObjectStore(RECOVERY_OPERATIONS_STORE);
  if (database.objectStoreNames.contains(RECOVERY_DIRECTORY_STORE)) return;
  const directory = database.createObjectStore(RECOVERY_DIRECTORY_STORE, { keyPath: "sourceKey" });
  directory.createIndex("library", "libraryKey");
  directory.createIndex("library-document", ["libraryKey", "documentId"]);
  directory.createIndex("scope", "scopeKey");
  directory.createIndex("scope-document", ["scopeKey", "documentId"]);
  const cursor = transaction.objectStore(storeName).openCursor();
  cursor.onsuccess = () => {
    const entry = cursor.result;
    if (!entry) return;
    directory.put(recoverySummary(kind, entry.primaryKey, entry.value));
    entry.continue();
  };
};

export const recoveryRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Recovery storage request failed")),
      { once: true },
    );
  });
export const recoveryTransaction = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("Recovery storage transaction failed")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("Recovery storage transaction was aborted")),
      { once: true },
    );
  });

/** Exact structured-clone comparison avoids turning byte buffers into giant JSON strings inside a transaction. */
export const sameRecoverySource = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array)
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  if (left instanceof ArrayBuffer && right instanceof ArrayBuffer)
    return sameRecoverySource(new Uint8Array(left), new Uint8Array(right));
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => sameRecoverySource(item, right[index]))
    );
  const a = recoveryRecord(left),
    b = recoveryRecord(right);
  if (!a || !b) return false;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameRecoverySource(a[key], b[key]))
  );
};

export const verifyRecoveryReceipt = (
  frozen: FrozenRecoveryRecord,
  receipt: RecoveryCaptureReceipt | undefined,
): void => {
  if (
    !receipt ||
    receipt.draft_id !== frozen.bundle.draftId ||
    receipt.source_revision !== frozen.bundle.sourceRevision ||
    receipt.submitted_payload_hash !== frozen.bundle.payloadHash ||
    !/^[a-f0-9]{64}$/.test(receipt.stored_payload_hash) ||
    !["bundle_v1", "legacy_json"].includes(receipt.stored_encoding) ||
    !Number.isSafeInteger(receipt.stored_byte_length) ||
    receipt.stored_byte_length < 1 ||
    (receipt.stored_encoding === "bundle_v1" &&
      (receipt.stored_payload_hash !== frozen.bundle.payloadHash ||
        receipt.stored_byte_length !== frozen.bundle.bytes.length))
  )
    throw new Error(
      "Core did not acknowledge this complete retained package. The local copy is unchanged.",
    );
};

export class RecoveryStagingStore {
  constructor(private readonly config: StagingConfiguration) {}
  async listSummaries(
    scope: DocumentRecoveryScope,
    documentId: string | null,
    after: string | null,
    limit = 50,
  ): Promise<RecoveryStagingPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error("Recovery directory page size is invalid");
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_DIRECTORY_STORE, "readonly");
    const completed = recoveryTransaction(transaction);
    const entries = await new Promise<RecoveryStagingSummary[]>((resolve, reject) => {
      const found: RecoveryStagingSummary[] = [];
      const request = transaction
        .objectStore(RECOVERY_DIRECTORY_STORE)
        .openCursor(after ? IDBKeyRange.lowerBound(after, true) : null);
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || found.length > limit) {
          resolve(found);
          return;
        }
        const entry = cursor.value as RecoveryStagingSummary;
        const visible = entry.scope
          ? entry.scope.libraryId === scope.libraryId &&
            (scope.accessContext.kind === "library" ||
              contentAccessIdentityKey(entry.scope) === contentAccessIdentityKey(scope))
          : scope.accessContext.kind === "library";
        if (visible && (!documentId || documentId === entry.documentId)) found.push(entry);
        cursor.continue();
      };
    });
    await completed;
    return {
      entries: entries.slice(0, limit),
      nextCursor: entries.length > limit ? entries[limit - 1].sourceKey : null,
    };
  }

  async countSummaries(scope: DocumentRecoveryScope, documentId: string | null): Promise<number> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_DIRECTORY_STORE, "readonly");
    const completed = recoveryTransaction(transaction);
    const library = scope.accessContext.kind === "library";
    const index = transaction
      .objectStore(RECOVERY_DIRECTORY_STORE)
      .index(`${library ? "library" : "scope"}${documentId ? "-document" : ""}`);
    const prefix = library ? scope.libraryId : contentAccessIdentityKey(scope);
    const count = recoveryRequest(
      index.count(IDBKeyRange.only(documentId ? [prefix, documentId] : prefix)),
    );
    const unbound = library
      ? recoveryRequest(index.count(IDBKeyRange.only(documentId ? ["", documentId] : "")))
      : Promise.resolve(0);
    const values = await Promise.all([count, unbound]);
    await completed;
    return values[0] + values[1];
  }

  private async read(
    entry: RecoveryStagingSummary,
  ): Promise<{ row: unknown; summary: RecoveryStagingSummary }> {
    const database = await this.config.database();
    const transaction = database.transaction(
      [this.config.storeName, RECOVERY_DIRECTORY_STORE],
      "readonly",
    );
    const completed = recoveryTransaction(transaction);
    const [row, summary] = await Promise.all([
      recoveryRequest(transaction.objectStore(this.config.storeName).get(entry.rawKey)),
      recoveryRequest(
        transaction.objectStore(RECOVERY_DIRECTORY_STORE).get(entry.sourceKey),
      ) as Promise<RecoveryStagingSummary | undefined>,
    ]);
    await completed;
    if (!row || !summary || summary.sourceRevision !== entry.sourceRevision)
      throw new Error("The local package changed. Refresh the recovery list.");
    return { row, summary };
  }

  async freeze(
    entry: RecoveryStagingSummary,
    scope: DocumentRecoveryScope,
    storeEpoch: string,
  ): Promise<FrozenRecoveryRecord> {
    const { row, summary } = await this.read(entry);
    const existing = frozenRecoveryRecord(row);
    if (existing) {
      if (
        existing.scope.libraryId !== scope.libraryId ||
        (scope.accessContext.kind !== "library" &&
          contentAccessIdentityKey(existing.scope) !== contentAccessIdentityKey(scope)) ||
        existing.storeEpoch !== storeEpoch
      )
        throw new Error(
          "This package belongs to another recovery boundary. Its original local copy is retained.",
        );
      if ((await recoveryPayloadHash(existing.bundle.bytes)) !== existing.bundle.payloadHash)
        throw new Error("The local package digest does not match");
      return existing;
    }
    // A matching globally unique Store epoch proves the Library for pre-scope Yjs rows. Earlier epochs remain unbound.
    const sourceScope =
      summary.scope ??
      (summary.sourceEpoch === storeEpoch && scope.accessContext.kind === "library" ? scope : null);
    if (
      !sourceScope ||
      sourceScope.libraryId !== scope.libraryId ||
      (scope.accessContext.kind !== "library" &&
        contentAccessIdentityKey(sourceScope) !== contentAccessIdentityKey(scope))
    )
      throw new RecoveryBundleValidationError(
        "source_unverified",
        "The source Library or access context cannot be verified. Export this local package to keep a backup, or remove it if you no longer need these edits.",
      );
    const source = this.config.source(row);
    const bundle = await encodeRecoveryBundle(this.config.input(source), summary.sourceRevision);
    const reconstructed = await decodeRecoverySource(bundle.bytes);
    if (!sameRecoverySource(source, reconstructed))
      throw new Error(
        "The original source could not be preserved completely. Its local copy is unchanged.",
      );
    const frozen: FrozenRecoveryRecord = {
      format: "nodex-recovery-staging-v1",
      scope: sourceScope,
      storeEpoch,
      operationId: createBoundedOperationId("document.recovery.capture"),
      bundle,
    };
    const database = await this.config.database();
    const transaction = database.transaction(
      [this.config.storeName, RECOVERY_DIRECTORY_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = recoveryTransaction(transaction);
    const store = transaction.objectStore(this.config.storeName);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const [current, currentSummary] = await Promise.all([
      recoveryRequest(store.get(entry.rawKey)),
      recoveryRequest(directory.get(entry.sourceKey)) as Promise<
        RecoveryStagingSummary | undefined
      >,
    ]);
    if (
      currentSummary?.sourceRevision !== summary.sourceRevision ||
      !sameRecoverySource(current, row)
    ) {
      await completed;
      // Only an identical source revision may reuse another window's frozen winner.
      if (
        currentSummary?.sourceRevision === summary.sourceRevision &&
        frozenRecoveryRecord(current)
      )
        return this.freeze(currentSummary, scope, storeEpoch);
      throw new Error("The local package changed. Refresh the recovery list.");
    }
    store.put(this.config.frozenRow(row, frozen));
    directory.put({
      ...summary,
      scope: sourceScope,
      libraryKey: sourceScope.libraryId,
      scopeKey: contentAccessIdentityKey(sourceScope),
      byteLength: bundle.bytes.length,
      encoding: "bundle_v1",
      operationId: frozen.operationId,
      payloadHash: bundle.payloadHash,
      failure: null,
    } satisfies RecoveryStagingSummary);
    await completed;
    return frozen;
  }

  async acknowledge(
    entry: RecoveryStagingSummary,
    frozen: FrozenRecoveryRecord,
    receipt: RecoveryCaptureReceipt | undefined,
  ): Promise<boolean> {
    verifyRecoveryReceipt(frozen, receipt);
    const database = await this.config.database();
    const transaction = database.transaction(
      [this.config.storeName, RECOVERY_DIRECTORY_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = recoveryTransaction(transaction);
    const store = transaction.objectStore(this.config.storeName);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const [row, summary] = await Promise.all([
      recoveryRequest(store.get(entry.rawKey)),
      recoveryRequest(directory.get(entry.sourceKey)) as Promise<
        RecoveryStagingSummary | undefined
      >,
    ]);
    const current = frozenRecoveryRecord(row);
    const matches =
      summary?.sourceRevision === entry.sourceRevision &&
      current?.operationId === frozen.operationId &&
      current.bundle.sourceRevision === frozen.bundle.sourceRevision &&
      current.bundle.payloadHash === frozen.bundle.payloadHash &&
      current.storeEpoch === frozen.storeEpoch &&
      contentAccessIdentityKey(current.scope) === contentAccessIdentityKey(frozen.scope) &&
      sameRecoverySource(current.bundle.bytes, frozen.bundle.bytes);
    if (matches) {
      store.delete(entry.rawKey);
      directory.delete(entry.sourceKey);
    }
    await completed;
    return matches;
  }

  /** A capture may outlive its renderer. Keep its claim until a receipt or definitive rejection. */
  async claimTransfer(entry: RecoveryStagingSummary): Promise<boolean> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_DIRECTORY_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = recoveryTransaction(transaction);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const current = (await recoveryRequest(directory.get(entry.sourceKey))) as
      | RecoveryStagingSummary
      | undefined;
    if (!current || current.sourceRevision !== entry.sourceRevision) {
      await completed;
      throw new Error("The local package changed. Refresh the recovery list.");
    }
    directory.put({ ...current, receiptPending: true });
    await completed;
    return current.receiptPending === true;
  }

  async rejectTransfer(entry: RecoveryStagingSummary): Promise<void> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_DIRECTORY_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = recoveryTransaction(transaction);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const current = (await recoveryRequest(directory.get(entry.sourceKey))) as
      | RecoveryStagingSummary
      | undefined;
    if (current?.sourceRevision === entry.sourceRevision)
      directory.put({ ...current, receiptPending: false });
    await completed;
  }

  /** Remove only the retained revision the user reviewed, never a newer local capture. */
  async remove(entry: RecoveryStagingSummary): Promise<void> {
    const database = await this.config.database();
    const transaction = database.transaction(
      [this.config.storeName, RECOVERY_DIRECTORY_STORE],
      "readwrite",
      { durability: "strict" },
    );
    const completed = recoveryTransaction(transaction);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const current = (await recoveryRequest(directory.get(entry.sourceKey))) as
      | RecoveryStagingSummary
      | undefined;
    if (!current || current.sourceRevision !== entry.sourceRevision) {
      await completed;
      throw new Error("The local draft changed. Review it again before removing it.");
    }
    if (current.receiptPending) {
      await completed;
      throw new Error("Receipt for this draft is unconfirmed. Retry receipt before removing it.");
    }
    transaction.objectStore(this.config.storeName).delete(current.rawKey);
    directory.delete(entry.sourceKey);
    await completed;
  }

  async recordFailure(
    entry: RecoveryStagingSummary,
    failure: RecoveryTransferFailure,
  ): Promise<void> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_DIRECTORY_STORE, "readwrite");
    const completed = recoveryTransaction(transaction);
    const directory = transaction.objectStore(RECOVERY_DIRECTORY_STORE);
    const current = (await recoveryRequest(directory.get(entry.sourceKey))) as
      | RecoveryStagingSummary
      | undefined;
    if (current?.sourceRevision === entry.sourceRevision) directory.put({ ...current, failure });
    await completed;
  }

  async export(entry: RecoveryStagingSummary): Promise<Uint8Array> {
    const { row } = await this.read(entry);
    let frozen: FrozenRecoveryRecord | null = null;
    try {
      frozen = frozenRecoveryRecord(row);
    } catch {
      /* Export damaged records exactly as stored. */
    }
    if (frozen)
      return encodeRecoveryExport(frozen.bundle.bytes, {
        draftId: frozen.bundle.draftId,
        documentId: entry.documentId ?? "unknown",
        encoding: "bundle_v1",
        expectedPayloadHash: frozen.bundle.payloadHash,
      });
    const payload = new TextEncoder().encode(encodeRecoveryEnvelope(row));
    return encodeRecoveryExport(payload, {
      draftId: entry.draftId ?? entry.sourceKey,
      documentId: entry.documentId ?? "unknown",
      encoding: "local_legacy_json",
    });
  }

  async readOperation(key: string): Promise<unknown> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_OPERATIONS_STORE, "readonly");
    const completed = recoveryTransaction(transaction);
    const value = await recoveryRequest(
      transaction.objectStore(RECOVERY_OPERATIONS_STORE).get(key),
    );
    await completed;
    return value;
  }
  async prepareOperation(key: string, value: unknown): Promise<unknown> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_OPERATIONS_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = recoveryTransaction(transaction);
    const store = transaction.objectStore(RECOVERY_OPERATIONS_STORE);
    const existing = await recoveryRequest(store.get(key));
    if (existing === undefined) store.put(value, key);
    await completed;
    return existing ?? value;
  }
  async acknowledgeOperation(key: string, expected: unknown): Promise<void> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_OPERATIONS_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = recoveryTransaction(transaction);
    const store = transaction.objectStore(RECOVERY_OPERATIONS_STORE);
    const current = await recoveryRequest(store.get(key));
    if (sameRecoverySource(current, expected)) store.delete(key);
    await completed;
  }
  async writeOperation(key: string, value: unknown): Promise<void> {
    const database = await this.config.database();
    const transaction = database.transaction(RECOVERY_OPERATIONS_STORE, "readwrite", {
      durability: "strict",
    });
    const completed = recoveryTransaction(transaction);
    const store = transaction.objectStore(RECOVERY_OPERATIONS_STORE);
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    await completed;
  }
}
