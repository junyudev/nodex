import { describe, expect, test, vi } from "vite-plus/test";
import type {
  CanvasPresenceRealtimeEvent,
  PortableCanvasScene,
} from "../../shared/block-documents";
import type { CanvasSceneProvider, CanvasSceneProviderStatus } from "./canvas-scene-provider";
import {
  createCanvasDocumentSessionRegistry,
  type CanvasDocumentSessionCallbacks,
} from "./canvas-document-session";

const scene = {
  elements: [],
  appState: {},
  files: {},
} as unknown as PortableCanvasScene;

const deferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const providerFactory = () => {
  let callbacks: CanvasDocumentSessionCallbacks | null = null;
  let currentScene = scene;
  let status: CanvasSceneProviderStatus = {
    phase: "ready",
    connected: true,
    headSeq: 0,
    pendingMutationCount: 0,
    writeFrozen: false,
  };
  const provider = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      status = { ...status, phase: "closed" };
    }),
    retireOwner: vi.fn(async () => {
      status = { ...status, phase: "closed" };
    }),
    getScene: vi.fn(() => currentScene),
    getStatus: () => status,
    subscribeStatus: () => () => {},
  } as unknown as CanvasSceneProvider;
  return {
    provider,
    create(nextCallbacks: CanvasDocumentSessionCallbacks) {
      callbacks = nextCallbacks;
      return provider;
    },
    emitScene(nextScene: PortableCanvasScene) {
      currentScene = nextScene;
      callbacks?.onScene(nextScene);
    },
    emitPresence(event: CanvasPresenceRealtimeEvent) {
      callbacks?.onPresence(event);
    },
  };
};

const input = (factory: ReturnType<typeof providerFactory>, generation = 1) => ({
  libraryId: "library-1",
  accessContext: { kind: "project" as const, projectId: "project-1" },
  ownerBlockId: "canvas-1",
  documentId: "document-1",
  storeEpoch: "epoch-1",
  generation,
  createProvider: factory.create,
});

describe("CanvasDocumentSessionRegistry", () => {
  test("shares one provider until the final surface releases", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const factory = providerFactory();
    const first = registry.acquire(input(factory));
    const second = registry.acquire(input(factory));

    expect(first.provider).toBe(second.provider);
    expect(first.stagedFileCatalog).toBe(second.stagedFileCatalog);
    await first.release();
    expect(factory.provider.close).not.toHaveBeenCalled();
    await second.release();
    expect(factory.provider.close).toHaveBeenCalledOnce();
  });

  test("fans accepted scenes out and replays them to a later surface", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const factory = providerFactory();
    const first = registry.acquire(input(factory));
    const firstListener = vi.fn();
    first.subscribeScene(firstListener);
    expect(firstListener).toHaveBeenCalledWith(scene);

    const nextScene = { ...scene, appState: { gridSize: 20 } };
    factory.emitScene(nextScene);
    expect(firstListener).toHaveBeenLastCalledWith(nextScene);

    const second = registry.acquire(input(factory));
    const secondListener = vi.fn();
    second.subscribeScene(secondListener);
    expect(secondListener).toHaveBeenCalledWith(nextScene);

    await first.release();
    await second.release();
  });

  test("waits for an incompatible generation to close before reconnecting", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const firstFactory = providerFactory();
    const secondFactory = providerFactory();
    const first = registry.acquire(input(firstFactory));
    const second = registry.acquire(input(secondFactory, 2));

    await second.connect();

    expect(firstFactory.provider.close).toHaveBeenCalledOnce();
    expect(secondFactory.provider.connect).toHaveBeenCalledOnce();
    await first.release();
    await second.release();
  });

  test("terminally retires every port for a deleted public owner", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const factory = providerFactory();
    const first = registry.acquire(input(factory));
    const second = registry.acquire(input(factory));

    await registry.retireOwner(
      {
        libraryId: "library-1",
        accessContext: { kind: "project", projectId: "project-1" },
      },
      "canvas-1",
    );

    expect(factory.provider.retireOwner).toHaveBeenCalledOnce();
    await first.release();
    await second.release();
    expect(factory.provider.close).not.toHaveBeenCalled();
  });

  test("upgrades an in-progress final release to owner retirement", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const factory = providerFactory();
    const closing = deferred();
    vi.mocked(factory.provider.close).mockReturnValueOnce(closing.promise);
    const lease = registry.acquire(input(factory));

    const release = lease.release();
    await Promise.resolve();
    const retire = registry.retireOwner(
      {
        libraryId: "library-1",
        accessContext: { kind: "project", projectId: "project-1" },
      },
      "canvas-1",
    );
    closing.resolve();
    await Promise.all([release, retire]);

    expect(factory.provider.retireOwner).toHaveBeenCalledOnce();
  });

  test("does not share a session across Library identities", async () => {
    const registry = createCanvasDocumentSessionRegistry();
    const firstFactory = providerFactory();
    const secondFactory = providerFactory();
    const first = registry.acquire(input(firstFactory));
    const second = registry.acquire({
      ...input(secondFactory),
      libraryId: "library-2",
    });

    expect(first.provider).not.toBe(second.provider);
    await first.release();
    await second.release();
  });
});

test("Canvas owner retirement still reaches a replica whose last close could not protect edits", async () => {
  const registry = createCanvasDocumentSessionRegistry();
  const factory = providerFactory();
  vi.mocked(factory.provider.close).mockRejectedValueOnce(new Error("Local storage unavailable"));
  const lease = registry.acquire(input(factory));
  await expect(lease.release()).rejects.toThrow("Local storage unavailable");
  await registry.retireOwner(
    { libraryId: "library-1", accessContext: { kind: "project", projectId: "project-1" } },
    "canvas-1",
  );
  expect(factory.provider.retireOwner).toHaveBeenCalledOnce();
});
