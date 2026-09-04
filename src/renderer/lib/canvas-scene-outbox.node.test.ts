import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import {
  CANVAS_SCENE_OUTBOX_DATABASE_NAME,
  IndexedDbCanvasSceneOutbox,
  MemoryCanvasSceneOutbox,
  MAX_CANVAS_OUTBOX_MUTATIONS,
  MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT,
  type CanvasSceneOutbox,
} from "./canvas-scene-outbox";
import type { CanvasSceneMutationIntent } from "../../shared/block-documents";
import type { ContentAccessContext } from "../../shared/content-access-context";

beforeAll(() => {
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: IDBKeyRange,
  });
});

const projectAccessContext = {
  kind: "project",
  projectId: "project-1",
} as const satisfies ContentAccessContext;
const libraryAccessContext = {
  kind: "library",
} as const satisfies ContentAccessContext;
const libraryId = "library-1";

const intent = (
  mutationId: string,
  version: number,
  documentId = "document-1",
  accessContext: ContentAccessContext = projectAccessContext,
): CanvasSceneMutationIntent => ({
  mutationId,
  accessContext,
  documentId,
  storeEpoch: "epoch-1",
  generation: 1,
  baseHeadSeq: version - 1,
  elementCandidates: [
    {
      id: `element-${mutationId}`,
      type: "rectangle",
      index: `a${version}`,
      version,
      versionNonce: 10,
      isDeleted: false,
    },
  ],
  appStateIntents: {},
  fileAdditions: {},
});

const versionOneRequest = (
  mutationId: string,
  version: number,
): Readonly<Record<string, unknown>> => ({
  ...Object.fromEntries(
    Object.entries(intent(mutationId, version)).filter(([key]) => key !== "accessContext"),
  ),
  projectId: projectAccessContext.projectId,
  clientSessionId: "dead-window",
});

const verifyFifoAndIdempotence = async (outbox: CanvasSceneOutbox): Promise<void> => {
  const second = intent("mutation-z", 2);
  const first = intent("mutation-a", 1);
  await outbox.put(second);
  await outbox.put(first);
  await outbox.put(second);

  expect(
    (await outbox.list(projectAccessContext, "document-1")).map((entry) => entry.mutationId),
  ).toEqual(["mutation-z", "mutation-a"]);
  await expect(
    outbox.put({
      ...second,
      elementCandidates: [
        {
          ...second.elementCandidates[0]!,
          version: 3,
        },
      ],
    }),
  ).rejects.toThrow("already exists");

  await outbox.remove(projectAccessContext, "document-1", "mutation-z");
  await outbox.remove(projectAccessContext, "document-1", "mutation-z");
  expect(
    (await outbox.list(projectAccessContext, "document-1")).map((entry) => entry.mutationId),
  ).toEqual(["mutation-a"]);
};

const verifyQuarantine = async (outbox: CanvasSceneOutbox): Promise<void> => {
  const rejected = intent("mutation-rejected", 1);
  await outbox.put(rejected);
  await outbox.quarantine(
    rejected,
    {
      code: "invalid_canvas_scene_mutation",
      message: "invalid image assertion",
      retryable: false,
      resetRequired: false,
      mutationId: rejected.mutationId,
    },
    123,
  );

  expect(await outbox.list(projectAccessContext, "document-1")).toEqual([]);
  expect(await outbox.listQuarantined(projectAccessContext, "document-1")).toEqual([
    {
      intent: rejected,
      error: {
        code: "invalid_canvas_scene_mutation",
        message: "invalid image assertion",
        retryable: false,
        resetRequired: false,
        mutationId: rejected.mutationId,
      },
      rejectedAt: 123,
    },
  ]);
  await outbox.quarantine(
    rejected,
    {
      code: "invalid_canvas_scene_mutation",
      message: "duplicate quarantine",
      retryable: false,
      resetRequired: false,
    },
    456,
  );
  expect(await outbox.listQuarantined(projectAccessContext, "document-1")).toHaveLength(1);
};

const verifyAccessIsolation = async (outbox: CanvasSceneOutbox): Promise<void> => {
  const projectIntent = intent("shared-mutation", 1);
  const libraryIntent = intent("shared-mutation", 1, "document-1", libraryAccessContext);
  await outbox.put(projectIntent);
  await outbox.put(libraryIntent);

  expect(await outbox.list(projectAccessContext, "document-1")).toEqual([projectIntent]);
  expect(await outbox.list(libraryAccessContext, "document-1")).toEqual([libraryIntent]);

  await outbox.clear(projectAccessContext, "document-1");
  expect(await outbox.list(projectAccessContext, "document-1")).toEqual([]);
  expect(await outbox.list(libraryAccessContext, "document-1")).toEqual([libraryIntent]);
};

const openVersionOneDatabase = (factory: IDBFactory, rows: readonly unknown[]): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const request = factory.open(CANVAS_SCENE_OUTBOX_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("canvas-scene-mutations", { keyPath: "key" });
      store.createIndex("document-id", "documentId", { unique: false });
      for (const [index, row] of rows.entries()) {
        const mutationId = `mutation-${index + 1}`;
        store.add({
          key: JSON.stringify(["document-1", mutationId]),
          documentId: "document-1",
          mutationId,
          request: row,
        });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });

interface VersionThreeQuarantineRow {
  readonly intent: Readonly<Record<string, unknown>>;
  readonly error: Readonly<Record<string, unknown>>;
  readonly rejectedAt: number;
}

const legacyProjectMutationIntent = (
  mutationId: string,
  version: number,
): Readonly<Record<string, unknown>> => ({
  ...Object.fromEntries(
    Object.entries(intent(mutationId, version)).filter(([key]) => key !== "accessContext"),
  ),
  projectId: projectAccessContext.projectId,
});

const openVersionThreeDatabase = (
  factory: IDBFactory,
  mutationRows: readonly Readonly<Record<string, unknown>>[],
  quarantineRows: readonly VersionThreeQuarantineRow[],
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const request = factory.open(CANVAS_SCENE_OUTBOX_DATABASE_NAME, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      const mutationStore = database.createObjectStore("canvas-scene-mutations", {
        keyPath: "enqueueSequence",
        autoIncrement: true,
      });
      mutationStore.createIndex("document-mutation", ["documentId", "mutationId"], {
        unique: true,
      });
      mutationStore.createIndex("document-sequence", ["documentId", "enqueueSequence"], {
        unique: true,
      });
      const quarantineStore = database.createObjectStore("canvas-scene-quarantine", {
        keyPath: "rejectedSequence",
        autoIncrement: true,
      });
      quarantineStore.createIndex("document-mutation", ["documentId", "mutationId"], {
        unique: true,
      });
      quarantineStore.createIndex("document-sequence", ["documentId", "rejectedSequence"], {
        unique: true,
      });
      for (const row of mutationRows) {
        mutationStore.add({
          documentId: row.documentId,
          mutationId: row.mutationId,
          intent: row,
        });
      }
      for (const row of quarantineRows) {
        quarantineStore.add({
          documentId: row.intent.documentId,
          mutationId: row.intent.mutationId,
          ...row,
        });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });

describe("CanvasSceneOutbox", () => {
  test.each(["memory", "indexeddb"] as const)(
    "%s capacity failures retain active and quarantined edits",
    async (kind) => {
      const outbox =
        kind === "memory"
          ? new MemoryCanvasSceneOutbox(libraryId)
          : new IndexedDbCanvasSceneOutbox(new IDBFactory(), libraryId);
      for (let index = 0; index < MAX_CANVAS_OUTBOX_MUTATIONS; index++)
        await outbox.put(intent(`mutation-${index}`, index + 1));
      await expect(outbox.put(intent("overflow", 300))).rejects.toThrow("local limit");
      expect(await outbox.list(projectAccessContext, "document-1")).toHaveLength(
        MAX_CANVAS_OUTBOX_MUTATIONS,
      );
      const error = {
        code: "document_generation_mismatch",
        message: "Document replaced",
        retryable: false,
        resetRequired: true,
      } as const;
      for (let index = 0; index < MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT; index++)
        await outbox.quarantine(intent(`mutation-${index}`, index + 1), error, index);
      await expect(outbox.quarantine(intent("mutation-32", 33), error, 33)).rejects.toThrow(
        "storage is full",
      );
      expect(await outbox.listQuarantined(projectAccessContext, "document-1")).toHaveLength(
        MAX_QUARANTINED_MUTATIONS_PER_DOCUMENT,
      );
      expect(
        (await outbox.list(projectAccessContext, "document-1")).some(
          (value) => value.mutationId === "mutation-32",
        ),
      ).toBe(true);
    },
  );
  test("memory storage preserves enqueue order and duplicate position", async () => {
    await verifyFifoAndIdempotence(new MemoryCanvasSceneOutbox(libraryId));
  });

  test("memory storage atomically quarantines a rejected mutation", async () => {
    await verifyQuarantine(new MemoryCanvasSceneOutbox(libraryId));
  });

  test("memory storage isolates identical documents by access context", async () => {
    await verifyAccessIsolation(new MemoryCanvasSceneOutbox(libraryId));
  });

  test("IndexedDB v4 preserves enqueue order and duplicate position", async () => {
    await verifyFifoAndIdempotence(new IndexedDbCanvasSceneOutbox(new IDBFactory(), libraryId));
  });

  test("IndexedDB v4 atomically quarantines a rejected mutation", async () => {
    await verifyQuarantine(new IndexedDbCanvasSceneOutbox(new IDBFactory(), libraryId));
  });

  test("IndexedDB v4 isolates identical documents by access context", async () => {
    await verifyAccessIsolation(new IndexedDbCanvasSceneOutbox(new IDBFactory(), libraryId));
  });

  test("IndexedDB v4 isolates identical access and document IDs by Library", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbCanvasSceneOutbox(factory, "library-1");
    const second = new IndexedDbCanvasSceneOutbox(factory, "library-2");
    const sharedIntent = intent("shared-mutation", 1);

    await first.put(sharedIntent);
    await second.put(sharedIntent);
    expect(await first.list(projectAccessContext, "document-1")).toEqual([sharedIntent]);
    expect(await second.list(projectAccessContext, "document-1")).toEqual([sharedIntent]);

    await first.clear(projectAccessContext, "document-1");
    expect(await first.list(projectAccessContext, "document-1")).toEqual([]);
    expect(await second.list(projectAccessContext, "document-1")).toEqual([sharedIntent]);
  });

  test("migrates valid v1 requests to access-scoped v4 intents", async () => {
    const factory = new IDBFactory();
    await openVersionOneDatabase(factory, [
      versionOneRequest("mutation-1", 1),
      versionOneRequest("mutation-2", 2),
    ]);

    const outbox = new IndexedDbCanvasSceneOutbox(factory, libraryId);
    const migrated = await outbox.list(projectAccessContext, "document-1");

    expect(migrated.map((entry) => entry.mutationId)).toEqual(["mutation-1", "mutation-2"]);
    expect(migrated).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ clientSessionId: "dead-window" })]),
    );
  });

  test("migrates active and quarantined v3 rows without losing order or metadata", async () => {
    const factory = new IDBFactory();
    const first = legacyProjectMutationIntent("mutation-1", 1);
    const second = legacyProjectMutationIntent("mutation-2", 2);
    const rejected = legacyProjectMutationIntent("mutation-rejected", 3);
    const rejection = {
      code: "invalid_canvas_scene_mutation",
      message: "invalid legacy image assertion",
      retryable: false,
      resetRequired: false,
      mutationId: "mutation-rejected",
    } as const;
    await openVersionThreeDatabase(
      factory,
      [first, second],
      [
        {
          intent: rejected,
          error: rejection,
          rejectedAt: 456,
        },
      ],
    );

    const outbox = new IndexedDbCanvasSceneOutbox(factory, libraryId);
    expect(
      (await outbox.list(projectAccessContext, "document-1")).map((entry) => entry.mutationId),
    ).toEqual(["mutation-1", "mutation-2"]);
    expect(await outbox.listQuarantined(projectAccessContext, "document-1")).toEqual([
      {
        intent: {
          ...intent("mutation-rejected", 3),
        },
        error: rejection,
        rejectedAt: 456,
      },
    ]);
    const foreignLibraryOutbox = new IndexedDbCanvasSceneOutbox(factory, "library-foreign");
    expect(await foreignLibraryOutbox.list(projectAccessContext, "document-1")).toEqual([]);
  });

  test("fails a v1 upgrade visibly when a row is invalid", async () => {
    const factory = new IDBFactory();
    await openVersionOneDatabase(factory, [
      { ...versionOneRequest("mutation-1", 1), elementCandidates: null },
    ]);

    await expect(
      new IndexedDbCanvasSceneOutbox(factory, libraryId).list(projectAccessContext, "document-1"),
    ).rejects.toThrow();
  });
});
