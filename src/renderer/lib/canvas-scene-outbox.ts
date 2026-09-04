import { encodeRecoveryEnvelope } from "./document-recovery-package";
import type { PortableCanvasScene } from "../../shared/block-documents";
import {
  canonicalizeCanvasSceneMutationIntent,
  encodeCanonicalCanvasSceneMutationIntent,
  type CanvasSceneMutationError,
  type CanvasSceneMutationIntent,
} from "../../shared/block-documents";
import {
  contentAccessContextKey,
  contentAccessIdentityKey,
  type ContentAccessContext,
} from "../../shared/content-access-context";

export interface QuarantinedCanvasSceneMutation {
  readonly scene?: PortableCanvasScene;
  readonly intent: CanvasSceneMutationIntent;
  readonly error: CanvasSceneMutationError;
  readonly rejectedAt: number;
}

export interface CanvasSceneOutbox {
  readonly libraryId: string;
  list: (
    accessContext: ContentAccessContext,
    documentId: string,
  ) => Promise<readonly CanvasSceneMutationIntent[]>;
  listQuarantined: (
    accessContext: ContentAccessContext,
    documentId: string,
  ) => Promise<readonly QuarantinedCanvasSceneMutation[]>;
  put: (intent: CanvasSceneMutationIntent) => Promise<void>;
  quarantine: (
    intent: CanvasSceneMutationIntent,
    error: CanvasSceneMutationError,
    rejectedAt: number,
    scene?: PortableCanvasScene,
  ) => Promise<void>;
  remove: (
    accessContext: ContentAccessContext,
    documentId: string,
    mutationId: string,
  ) => Promise<void>;
  clear: (accessContext: ContentAccessContext, documentId: string) => Promise<void>;
}

export const MAX_CANVAS_OUTBOX_MUTATIONS = 256;
export const MAX_CANVAS_OUTBOX_BYTES = 32 * 1024 * 1024;
const mutationBytes = (intent: CanvasSceneMutationIntent): number =>
  new TextEncoder().encode(encodeCanonicalCanvasSceneMutationIntent(intent)).byteLength;
const assertOutboxCapacity = (
  existing: readonly CanvasSceneMutationIntent[],
  next: CanvasSceneMutationIntent,
): void => {
  const bytes = existing.reduce(
    (total, intent) => total + mutationBytes(intent),
    mutationBytes(next),
  );
  if (existing.length >= MAX_CANVAS_OUTBOX_MUTATIONS || bytes > MAX_CANVAS_OUTBOX_BYTES)
    throw new Error(
      "Unsaved Canvas changes reached the local limit. Export recovery before continuing.",
    );
};

const outboxBoundaryKey = (
  libraryId: string,
  accessContext: ContentAccessContext,
  documentId: string,
): string => JSON.stringify([contentAccessIdentityKey({ libraryId, accessContext }), documentId]);

const canonicalOutboxLibraryId = (libraryId: string): string => {
  contentAccessIdentityKey({
    libraryId,
    accessContext: { kind: "library" },
  });
  return libraryId;
};

/** Deterministic test/default-memory implementation; production may use IndexedDB. */
export class MemoryCanvasSceneOutbox implements CanvasSceneOutbox {
  readonly libraryId: string;
  private readonly intents = new Map<string, Map<string, CanvasSceneMutationIntent>>();
  private readonly quarantined = new Map<string, Map<string, QuarantinedCanvasSceneMutation>>();

  constructor(libraryId: string) {
    this.libraryId = canonicalOutboxLibraryId(libraryId);
  }

  list = async (
    accessContext: ContentAccessContext,
    documentId: string,
  ): Promise<readonly CanvasSceneMutationIntent[]> => [
    ...(this.intents.get(outboxBoundaryKey(this.libraryId, accessContext, documentId))?.values() ??
      []),
  ];

  listQuarantined = async (
    accessContext: ContentAccessContext,
    documentId: string,
  ): Promise<readonly QuarantinedCanvasSceneMutation[]> => [
    ...(this.quarantined
      .get(outboxBoundaryKey(this.libraryId, accessContext, documentId))
      ?.values() ?? []),
  ];

  put = async (input: CanvasSceneMutationIntent): Promise<void> => {
    const intent = canonicalizeCanvasSceneMutationIntent(input);
    const boundary = outboxBoundaryKey(this.libraryId, intent.accessContext, intent.documentId);
    const documentIntents =
      this.intents.get(boundary) ?? new Map<string, CanvasSceneMutationIntent>();
    const existing = documentIntents.get(intent.mutationId);
    if (
      existing &&
      encodeCanonicalCanvasSceneMutationIntent(existing) !==
        encodeCanonicalCanvasSceneMutationIntent(intent)
    ) {
      throw new Error(`Canvas mutation ${intent.mutationId} already exists in the outbox`);
    }
    if (existing) return;
    assertOutboxCapacity([...documentIntents.values()], intent);
    documentIntents.set(intent.mutationId, intent);
    this.intents.set(boundary, documentIntents);
  };

  quarantine = async (
    input: CanvasSceneMutationIntent,
    error: CanvasSceneMutationError,
    rejectedAt: number,
    scene?: PortableCanvasScene,
  ): Promise<void> => {
    const intent = canonicalizeCanvasSceneMutationIntent(input);
    const boundary = outboxBoundaryKey(this.libraryId, intent.accessContext, intent.documentId);
    const documentIntents = this.intents.get(boundary);
    const active = documentIntents?.get(intent.mutationId);
    if (!active) return;
    const documentQuarantine =
      this.quarantined.get(boundary) ?? new Map<string, QuarantinedCanvasSceneMutation>();
    if (
      !documentQuarantine.has(intent.mutationId) &&
      documentQuarantine.size >= MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT
    )
      throw new Error("Canvas recovery storage is full; export recovery before continuing");
    documentQuarantine.set(intent.mutationId, {
      intent,
      error,
      rejectedAt,
      scene,
    });
    this.quarantined.set(boundary, documentQuarantine);
    documentIntents?.delete(intent.mutationId);
    if (documentIntents?.size === 0) this.intents.delete(boundary);
  };

  remove = async (
    accessContext: ContentAccessContext,
    documentId: string,
    mutationId: string,
  ): Promise<void> => {
    const boundary = outboxBoundaryKey(this.libraryId, accessContext, documentId);
    const documentIntents = this.intents.get(boundary);
    if (!documentIntents) return;
    documentIntents.delete(mutationId);
    if (documentIntents.size === 0) this.intents.delete(boundary);
  };

  clear = async (accessContext: ContentAccessContext, documentId: string): Promise<void> => {
    this.intents.delete(outboxBoundaryKey(this.libraryId, accessContext, documentId));
  };
}

export const CANVAS_SCENE_OUTBOX_DATABASE_NAME = "nodex-canvas-scene-outbox";
export const CANVAS_SCENE_OUTBOX_DATABASE_VERSION = 4;
export const MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT = 32;
const MUTATION_STORE = "canvas-scene-mutations";
const QUARANTINE_STORE = "canvas-scene-quarantine";
const DOCUMENT_MUTATION_INDEX = "document-mutation";
const DOCUMENT_SEQUENCE_INDEX = "document-sequence";

interface StoredCanvasSceneMutation {
  readonly enqueueSequence?: number;
  readonly libraryId: string;
  readonly accessKey: string;
  readonly documentId: string;
  readonly mutationId: string;
  readonly intent: CanvasSceneMutationIntent;
}

interface StoredQuarantinedCanvasSceneMutation {
  readonly scene?: PortableCanvasScene;
  readonly rejectedSequence?: number;
  readonly libraryId: string;
  readonly accessKey: string;
  readonly documentId: string;
  readonly mutationId: string;
  readonly intent: CanvasSceneMutationIntent;
  readonly error: CanvasSceneMutationError;
  readonly rejectedAt: number;
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Canvas outbox IndexedDB request failed"));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Canvas outbox transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Canvas outbox transaction was aborted"));
  });

const createMutationStore = (database: IDBDatabase): IDBObjectStore => {
  const store = database.createObjectStore(MUTATION_STORE, {
    keyPath: "enqueueSequence",
    autoIncrement: true,
  });
  store.createIndex(
    DOCUMENT_MUTATION_INDEX,
    ["libraryId", "accessKey", "documentId", "mutationId"],
    { unique: true },
  );
  store.createIndex(
    DOCUMENT_SEQUENCE_INDEX,
    ["libraryId", "accessKey", "documentId", "enqueueSequence"],
    { unique: true },
  );
  return store;
};

const createQuarantineStore = (database: IDBDatabase): IDBObjectStore => {
  const store = database.createObjectStore(QUARANTINE_STORE, {
    keyPath: "rejectedSequence",
    autoIncrement: true,
  });
  store.createIndex(
    DOCUMENT_MUTATION_INDEX,
    ["libraryId", "accessKey", "documentId", "mutationId"],
    { unique: true },
  );
  store.createIndex(
    DOCUMENT_SEQUENCE_INDEX,
    ["libraryId", "accessKey", "documentId", "rejectedSequence"],
    { unique: true },
  );
  return store;
};

const legacyProjectIntent = (value: unknown): CanvasSceneMutationIntent => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Canvas outbox intent must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.accessContext !== undefined) {
    return canonicalizeCanvasSceneMutationIntent(record);
  }
  if (typeof record.projectId !== "string") {
    throw new TypeError("Legacy Canvas outbox intent has no Project access");
  }
  return canonicalizeCanvasSceneMutationIntent({
    ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "projectId")),
    accessContext: { kind: "project", projectId: record.projectId },
  });
};

const intentFromVersionOneRow = (value: unknown): CanvasSceneMutationIntent => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Canvas outbox v1 row must be an object");
  }
  const request = (value as Readonly<Record<string, unknown>>).request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError("Canvas outbox v1 row must contain a request");
  }
  return legacyProjectIntent(
    Object.fromEntries(Object.entries(request).filter(([key]) => key !== "clientSessionId")),
  );
};

const intentFromStoredRow = (value: unknown): CanvasSceneMutationIntent => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Canvas outbox row must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return record.intent === undefined
    ? intentFromVersionOneRow(record)
    : legacyProjectIntent(record.intent);
};

const openDatabase = (
  factory: IDBFactory,
  // v1-v3 were created by a renderer already bound to one Library but did not
  // persist that identity. The first v4 opener supplies that missing boundary.
  migrationLibraryId: string,
): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(
      CANVAS_SCENE_OUTBOX_DATABASE_NAME,
      CANVAS_SCENE_OUTBOX_DATABASE_VERSION,
    );
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion === 0) {
        createMutationStore(database);
        createQuarantineStore(database);
        return;
      }
      const transaction = request.transaction;
      if (!transaction || !database.objectStoreNames.contains(MUTATION_STORE)) {
        transaction?.abort();
        return;
      }
      const mutationRowsRequest = transaction.objectStore(MUTATION_STORE).getAll();
      const quarantineRowsRequest = database.objectStoreNames.contains(QUARANTINE_STORE)
        ? transaction.objectStore(QUARANTINE_STORE).getAll()
        : null;
      let mutationRows: readonly unknown[] | null = null;
      let quarantineRows: readonly unknown[] | null = quarantineRowsRequest ? null : [];
      const rebuild = (): void => {
        if (!mutationRows || !quarantineRows) return;
        try {
          const intents = mutationRows.map(intentFromStoredRow);
          const quarantined = quarantineRows.map((row) => {
            if (typeof row !== "object" || row === null || Array.isArray(row)) {
              throw new TypeError("Canvas quarantine row must be an object");
            }
            const record = row as Readonly<Record<string, unknown>>;
            if (
              typeof record.rejectedAt !== "number" ||
              typeof record.error !== "object" ||
              record.error === null
            ) {
              throw new TypeError("Canvas quarantine row metadata is invalid");
            }
            return {
              intent: intentFromStoredRow(record),
              error: record.error as CanvasSceneMutationError,
              rejectedAt: record.rejectedAt,
            };
          });
          database.deleteObjectStore(MUTATION_STORE);
          if (database.objectStoreNames.contains(QUARANTINE_STORE)) {
            database.deleteObjectStore(QUARANTINE_STORE);
          }
          const mutationStore = createMutationStore(database);
          const quarantineStore = createQuarantineStore(database);
          for (const intent of intents) {
            mutationStore.add({
              libraryId: migrationLibraryId,
              accessKey: contentAccessContextKey(intent.accessContext),
              documentId: intent.documentId,
              mutationId: intent.mutationId,
              intent,
            } satisfies StoredCanvasSceneMutation);
          }
          for (const rejected of quarantined) {
            quarantineStore.add({
              libraryId: migrationLibraryId,
              accessKey: contentAccessContextKey(rejected.intent.accessContext),
              documentId: rejected.intent.documentId,
              mutationId: rejected.intent.mutationId,
              ...rejected,
            } satisfies StoredQuarantinedCanvasSceneMutation);
          }
        } catch {
          transaction.abort();
        }
      };
      mutationRowsRequest.onsuccess = () => {
        mutationRows = mutationRowsRequest.result;
        rebuild();
      };
      mutationRowsRequest.onerror = () => transaction.abort();
      if (quarantineRowsRequest) {
        quarantineRowsRequest.onsuccess = () => {
          quarantineRows = quarantineRowsRequest.result;
          rebuild();
        };
        quarantineRowsRequest.onerror = () => transaction.abort();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the Canvas scene outbox"));
  });

export class IndexedDbCanvasSceneOutbox implements CanvasSceneOutbox {
  private databasePromise: Promise<IDBDatabase> | null = null;
  readonly libraryId: string;

  constructor(
    private readonly factory: IDBFactory,
    libraryId: string,
  ) {
    this.libraryId = canonicalOutboxLibraryId(libraryId);
  }

  list = async (
    accessContext: ContentAccessContext,
    documentId: string,
  ): Promise<readonly CanvasSceneMutationIntent[]> => {
    const accessKey = contentAccessContextKey(accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction(MUTATION_STORE, "readonly");
    const stored = (await requestResult(
      transaction
        .objectStore(MUTATION_STORE)
        .index(DOCUMENT_SEQUENCE_INDEX)
        .getAll(
          IDBKeyRange.bound(
            [this.libraryId, accessKey, documentId, 0],
            [this.libraryId, accessKey, documentId, Number.MAX_SAFE_INTEGER],
          ),
        ),
    )) as readonly StoredCanvasSceneMutation[];
    await transactionComplete(transaction);
    return [...stored]
      .sort((left, right) => (left.enqueueSequence ?? 0) - (right.enqueueSequence ?? 0))
      .map((entry) => canonicalizeCanvasSceneMutationIntent(entry.intent));
  };

  listQuarantined = async (
    accessContext: ContentAccessContext,
    documentId: string,
  ): Promise<readonly QuarantinedCanvasSceneMutation[]> => {
    const accessKey = contentAccessContextKey(accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction(QUARANTINE_STORE, "readonly");
    const stored = (await requestResult(
      transaction
        .objectStore(QUARANTINE_STORE)
        .index(DOCUMENT_SEQUENCE_INDEX)
        .getAll(
          IDBKeyRange.bound(
            [this.libraryId, accessKey, documentId, 0],
            [this.libraryId, accessKey, documentId, Number.MAX_SAFE_INTEGER],
          ),
        ),
    )) as readonly StoredQuarantinedCanvasSceneMutation[];
    await transactionComplete(transaction);
    return [...stored]
      .sort((left, right) => (left.rejectedSequence ?? 0) - (right.rejectedSequence ?? 0))
      .map((entry) => ({
        intent: canonicalizeCanvasSceneMutationIntent(entry.intent),
        error: entry.error,
        rejectedAt: entry.rejectedAt,
        scene: entry.scene,
      }));
  };

  put = async (input: CanvasSceneMutationIntent): Promise<void> => {
    const intent = canonicalizeCanvasSceneMutationIntent(input);
    const accessKey = contentAccessContextKey(intent.accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction(MUTATION_STORE, "readwrite");
    const store = transaction.objectStore(MUTATION_STORE);
    const index = store.index(DOCUMENT_MUTATION_INDEX);
    const existingKey = await requestResult(
      index.getKey([this.libraryId, accessKey, intent.documentId, intent.mutationId]),
    );
    if (existingKey !== undefined) {
      const existing = (await requestResult(store.get(existingKey))) as
        | StoredCanvasSceneMutation
        | undefined;
      if (
        existing &&
        encodeCanonicalCanvasSceneMutationIntent(existing.intent) ===
          encodeCanonicalCanvasSceneMutationIntent(intent)
      ) {
        await transactionComplete(transaction);
        return;
      }
      transaction.abort();
      throw new Error(`Canvas mutation ${intent.mutationId} already exists in the outbox`);
    }
    const activeRows = (await requestResult(
      store
        .index(DOCUMENT_SEQUENCE_INDEX)
        .getAll(
          IDBKeyRange.bound(
            [this.libraryId, accessKey, intent.documentId, 0],
            [this.libraryId, accessKey, intent.documentId, Number.MAX_SAFE_INTEGER],
          ),
        ),
    )) as StoredCanvasSceneMutation[];
    try {
      assertOutboxCapacity(
        activeRows.map((value) => value.intent),
        intent,
      );
    } catch (error) {
      const completed = transactionComplete(transaction);
      transaction.abort();
      await completed.catch(() => undefined);
      throw error;
    }
    store.add({
      libraryId: this.libraryId,
      accessKey,
      documentId: intent.documentId,
      mutationId: intent.mutationId,
      intent,
    } satisfies StoredCanvasSceneMutation);
    await transactionComplete(transaction);
  };

  quarantine = async (
    input: CanvasSceneMutationIntent,
    error: CanvasSceneMutationError,
    rejectedAt: number,
    scene?: PortableCanvasScene,
  ): Promise<void> => {
    const intent = canonicalizeCanvasSceneMutationIntent(input);
    const accessKey = contentAccessContextKey(intent.accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction([MUTATION_STORE, QUARANTINE_STORE], "readwrite");
    const activeStore = transaction.objectStore(MUTATION_STORE);
    const activeKey = await requestResult(
      activeStore
        .index(DOCUMENT_MUTATION_INDEX)
        .getKey([this.libraryId, accessKey, intent.documentId, intent.mutationId]),
    );
    if (activeKey === undefined) {
      await transactionComplete(transaction);
      return;
    }
    const quarantineStore = transaction.objectStore(QUARANTINE_STORE);
    const existingRejectedKey = await requestResult(
      quarantineStore
        .index(DOCUMENT_MUTATION_INDEX)
        .getKey([this.libraryId, accessKey, intent.documentId, intent.mutationId]),
    );
    if (existingRejectedKey === undefined) {
      quarantineStore.add({
        libraryId: this.libraryId,
        accessKey,
        documentId: intent.documentId,
        mutationId: intent.mutationId,
        intent,
        error,
        rejectedAt,
        scene,
      } satisfies StoredQuarantinedCanvasSceneMutation);
    }
    activeStore.delete(activeKey);
    const rejectedKeys = await requestResult(
      quarantineStore
        .index(DOCUMENT_SEQUENCE_INDEX)
        .getAllKeys(
          IDBKeyRange.bound(
            [this.libraryId, accessKey, intent.documentId, 0],
            [this.libraryId, accessKey, intent.documentId, Number.MAX_SAFE_INTEGER],
          ),
        ),
    );
    if (rejectedKeys.length > MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT) {
      const completed = transactionComplete(transaction);
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Canvas recovery storage is full; export recovery before continuing");
    }
    await transactionComplete(transaction);
  };

  remove = async (
    accessContext: ContentAccessContext,
    documentId: string,
    mutationId: string,
  ): Promise<void> => {
    const accessKey = contentAccessContextKey(accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction(MUTATION_STORE, "readwrite");
    const store = transaction.objectStore(MUTATION_STORE);
    const existingKey = await requestResult(
      store
        .index(DOCUMENT_MUTATION_INDEX)
        .getKey([this.libraryId, accessKey, documentId, mutationId]),
    );
    if (existingKey !== undefined) store.delete(existingKey);
    await transactionComplete(transaction);
  };

  clear = async (accessContext: ContentAccessContext, documentId: string): Promise<void> => {
    const accessKey = contentAccessContextKey(accessContext);
    const database = await this.getDatabase();
    const transaction = database.transaction(MUTATION_STORE, "readwrite");
    const request = transaction
      .objectStore(MUTATION_STORE)
      .index(DOCUMENT_SEQUENCE_INDEX)
      .openCursor(
        IDBKeyRange.bound(
          [this.libraryId, accessKey, documentId, 0],
          [this.libraryId, accessKey, documentId, Number.MAX_SAFE_INTEGER],
        ),
      );
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Could not clear the Canvas scene outbox"));
    });
    await transactionComplete(transaction);
  };

  /** Read a single retained package across access contexts, scoped to its Library. */
  nextRecovery = async (
    after?: IDBValidKey,
  ): Promise<{ key: IDBValidKey; snapshot: QuarantinedCanvasSceneMutation } | null> => {
    const database = await this.getDatabase();
    const transaction = database.transaction(QUARANTINE_STORE, "readonly");
    const completed = transactionComplete(transaction);
    const value = await new Promise<{
      key: IDBValidKey;
      snapshot: QuarantinedCanvasSceneMutation;
    } | null>((resolve, reject) => {
      const request = transaction
        .objectStore(QUARANTINE_STORE)
        .openCursor(after === undefined ? null : IDBKeyRange.lowerBound(after, true));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(null);
          return;
        }
        const entry = cursor.value as StoredQuarantinedCanvasSceneMutation;
        if (entry.libraryId !== this.libraryId) {
          cursor.continue();
          return;
        }
        resolve({
          key: cursor.primaryKey,
          snapshot: {
            intent: canonicalizeCanvasSceneMutationIntent(entry.intent),
            error: entry.error,
            rejectedAt: entry.rejectedAt,
            scene: entry.scene,
          },
        });
      };
    });
    await completed;
    return value;
  };

  acknowledgeRecovery = async (snapshot: QuarantinedCanvasSceneMutation): Promise<void> => {
    const database = await this.getDatabase();
    const transaction = database.transaction(QUARANTINE_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(QUARANTINE_STORE);
    const key = await requestResult(
      store
        .index(DOCUMENT_MUTATION_INDEX)
        .getKey([
          this.libraryId,
          contentAccessContextKey(snapshot.intent.accessContext),
          snapshot.intent.documentId,
          snapshot.intent.mutationId,
        ]),
    );
    if (key !== undefined) {
      const current = (await requestResult(store.get(key))) as StoredQuarantinedCanvasSceneMutation;
      const envelope = {
        intent: canonicalizeCanvasSceneMutationIntent(current.intent),
        error: current.error,
        rejectedAt: current.rejectedAt,
        scene: current.scene,
      };
      if (encodeRecoveryEnvelope(envelope) === encodeRecoveryEnvelope(snapshot)) store.delete(key);
    }
    await completed;
  };

  private getDatabase(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = openDatabase(this.factory, this.libraryId).then(
        (database) => {
          database.onversionchange = () => {
            database.close();
            this.databasePromise = null;
          };
          return database;
        },
        (error) => {
          this.databasePromise = null;
          throw error;
        },
      );
    }
    return this.databasePromise;
  }
}

export const createDefaultCanvasSceneOutbox = (libraryId: string): CanvasSceneOutbox => {
  if (typeof globalThis.indexedDB === "undefined") {
    return new MemoryCanvasSceneOutbox(libraryId);
  }
  return new IndexedDbCanvasSceneOutbox(globalThis.indexedDB, libraryId);
};
