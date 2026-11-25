import { describe, expect, test, vi } from "vite-plus/test";
import type { BoardSummary, DatabasePageSummary } from "./types";
import {
  collectPlacedPageIds,
  createPageElement,
  getPageIdFromElement,
  getPageTitleHintFromElement,
  haveSamePageIds,
  syncPlacedPageIds,
  updatePageElements,
} from "./canvas-card-elements";
import {
  type CanvasPresenceRealtimeEvent,
  type PortableCanvasScene,
  CANVAS_PRESENCE_HEARTBEAT_MS,
  CANVAS_PRESENCE_POINTER_INTERVAL_MS,
  type CanvasPresenceEvent,
} from "../../shared/block-documents";
import type { CanvasSceneProvider, CanvasSceneProviderStatus } from "./canvas-scene-provider";
import {
  createCanvasDocumentSessionRegistry,
  type CanvasDocumentSessionCallbacks,
} from "./canvas-document-session";
import { createCanvasElementChangeTracker } from "./canvas-element-change-tracker";
import {
  canvasElement,
  representativeCanvasElements,
} from "./canvas-element-change-tracker.test-fixtures";
import type { SocketId } from "@excalidraw/excalidraw/types";
import { createCanvasPresenceController } from "./canvas-presence-controller";

describe("canvas card elements", () => {
  function cardElement(pageId: string) {
    return {
      type: "rectangle",
      customData: {
        type: "nodex-card",
        pageId,
        columnId: "triage",
      },
    };
  }

  function sortedJson(ids: ReadonlySet<string>) {
    return JSON.stringify([...ids].sort());
  }

  describe("canvas-card-elements placed card helpers", () => {
    test("collectPlacedPageIds keeps only Nodex card elements", () => {
      const ids = collectPlacedPageIds([
        cardElement("card-1"),
        { type: "ellipse" },
        { type: "rectangle", customData: { type: "other", pageId: "foreign-card" } },
        cardElement("card-2"),
      ]);

      expect(sortedJson(ids)).toBe(JSON.stringify(["card-1", "card-2"]));
    });

    test("collectPlacedPageIds ignores invalid customData", () => {
      const ids = collectPlacedPageIds([
        null,
        undefined,
        { customData: { type: "nodex-card" } },
        { customData: { type: "nodex-card", pageId: 42 } },
        { customData: { type: "nodex-card", pageId: "" } },
        cardElement("card-1"),
      ]);

      expect(sortedJson(ids)).toBe(JSON.stringify(["card-1"]));
    });

    test("reads a standalone Card title hint without Database placement metadata", () => {
      const element = {
        customData: {
          type: "nodex-card-reference",
          targetBlockId: "standalone-card",
          titleHint: "Standalone",
        },
        label: { text: "Stale label" },
      };

      expect(getPageIdFromElement(element)).toBe("standalone-card");
      expect(getPageTitleHintFromElement(element)).toBe("Standalone");
    });

    test("haveSamePageIds compares set membership regardless of insertion order", () => {
      const left = new Set(["card-1", "card-2"]);
      const right = new Set(["card-2", "card-1"]);
      const different = new Set(["card-1", "card-3"]);

      expect(haveSamePageIds(left, right)).toBe(true);
      expect(haveSamePageIds(left, different)).toBe(false);
    });

    test("syncPlacedPageIds returns previous state when card IDs are unchanged", () => {
      const previous = new Set(["card-1", "card-2"]);

      const same = syncPlacedPageIds(previous, [
        cardElement("card-2"),
        { type: "rectangle" },
        cardElement("card-1"),
      ]);
      const changed = syncPlacedPageIds(previous, [cardElement("card-1")]);

      expect(same === previous).toBe(true);
      expect(changed === previous).toBe(false);
      expect(sortedJson(changed)).toBe(JSON.stringify(["card-1"]));
    });

    test("Card references do not persist Database column ownership", () => {
      const card = {
        id: "card-1",
        pageKey: null,
        title: "One",
        priority: undefined,
      } as DatabasePageSummary;

      const element = createPageElement(card, { x: 1, y: 2 });

      expect(JSON.stringify(element.customData)).toBe(
        JSON.stringify({
          type: "nodex-card-reference",
          targetBlockId: "card-1",
          titleHint: "One",
        }),
      );
    });

    test("metadata refresh delegates to a version-bumping Excalidraw update", () => {
      const element = {
        ...cardElement("card-1"),
        id: "element-card-1",
        version: 4,
        versionNonce: 9,
        backgroundColor: "#000000",
        label: { text: "Old title" },
      };
      let calls = 0;
      const updated = updatePageElements(
        [element],
        {
          columns: [
            {
              id: "triage",
              name: "Triage",
              cards: [
                {
                  id: "card-1",
                  title: "Fresh title",
                  priority: "p1-high",
                } as DatabasePageSummary,
              ],
            },
          ],
        } as BoardSummary,
        (current, changes) => {
          calls += 1;
          return {
            ...current,
            ...changes,
            version: Number(current.version) + 1,
            versionNonce: 3,
          };
        },
      );

      expect(calls).toBe(1);
      expect(updated?.[0]?.version).toBe(5);
      expect(updated?.[0]?.versionNonce).toBe(3);
      expect(getPageIdFromElement(updated?.[0])).toBe("card-1");
    });
  });
});

describe("canvas document session", () => {
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
    routingContext: { kind: "project" as const, projectId: "project-1" },
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
          routingContext: { kind: "project", projectId: "project-1" },
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
          routingContext: { kind: "project", projectId: "project-1" },
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
      { libraryId: "library-1", routingContext: { kind: "project", projectId: "project-1" } },
      "canvas-1",
    );
    expect(factory.provider.retireOwner).toHaveBeenCalledOnce();
  });
});

describe("createCanvasElementChangeTracker", () => {
  test("seeds the initial presentation without emitting candidates", () => {
    const initial = representativeCanvasElements(3);
    const tracker = createCanvasElementChangeTracker(initial);

    expect(tracker.observeLocal(initial)).toEqual({
      elementCandidates: [],
      changedImageCandidates: [],
    });
  });

  test("emits a deletion as an explicit tombstone", () => {
    const initial = [canvasElement("element-1")];
    const tracker = createCanvasElementChangeTracker(initial);

    const delta = tracker.observeLocal([canvasElement("element-1", 2, { isDeleted: true })]);

    expect(delta.elementCandidates).toEqual([
      expect.objectContaining({
        id: "element-1",
        version: 2,
        isDeleted: true,
      }),
    ]);
  });

  test("keeps an unhanded candidate dirty across unchanged observations", () => {
    const initial = [canvasElement("element-1")];
    const tracker = createCanvasElementChangeTracker(initial);
    const changed = [canvasElement("element-1", 2, { x: 40 })];

    const first = tracker.observeLocal(changed);
    const second = tracker.observeLocal(changed);

    expect(first.elementCandidates).toHaveLength(1);
    expect(second.elementCandidates).toEqual(first.elementCandidates);
    tracker.markHandedOff(second.elementCandidates);
    expect(tracker.observeLocal(changed).elementCandidates).toEqual([]);
  });

  test("does not let remote presentation clear a dirty local candidate", () => {
    const initial = [canvasElement("element-1"), canvasElement("element-2")];
    const tracker = createCanvasElementChangeTracker(initial);
    const dirty = tracker.observeLocal([
      canvasElement("element-1", 2, { x: 40 }),
      canvasElement("element-2"),
    ]);

    tracker.acceptRemotePresentation(
      [canvasElement("element-1", 3, { x: 80 }), canvasElement("element-2", 2, { x: 20 })],
      new Set(["element-1"]),
    );

    const next = tracker.observeLocal([
      canvasElement("element-1", 2, { x: 40 }),
      canvasElement("element-2", 2, { x: 20 }),
    ]);
    expect(next.elementCandidates).toEqual(dirty.elementCandidates);
  });

  test("advances clean remote elements so their presentation does not echo", () => {
    const initial = [canvasElement("element-1")];
    const tracker = createCanvasElementChangeTracker(initial);
    const remote = [canvasElement("element-1", 2, { x: 40 })];

    tracker.acceptRemotePresentation(remote, new Set());

    expect(tracker.observeLocal(remote).elementCandidates).toEqual([]);
  });

  test("tracks only changed live image elements for asset discovery", () => {
    const initial = [
      canvasElement("element-1"),
      canvasElement("image-1", 1, { type: "image", fileId: "file-1" }),
    ];
    const tracker = createCanvasElementChangeTracker(initial);

    const delta = tracker.observeLocal([
      canvasElement("element-1"),
      canvasElement("image-1", 2, { type: "image", fileId: "file-1", x: 20 }),
    ]);

    expect(delta.changedImageCandidates).toEqual(delta.elementCandidates);
    tracker.markRejected(delta.elementCandidates);
    expect(
      tracker.observeLocal([
        canvasElement("element-1"),
        canvasElement("image-1", 2, { type: "image", fileId: "file-1", x: 20 }),
      ]).changedImageCandidates,
    ).toHaveLength(1);
  });
});

describe("canvas presence controller", () => {
  const remotePresence = (
    clock: number,
    state: CanvasPresenceEvent["state"],
  ): CanvasPresenceEvent => ({
    engine: "canvas_scene",
    documentId: "document-1",
    generation: 1,
    clock,
    state,
    clientSessionId: "remote-session",
    user: {
      id: "window:2",
      displayName: "Window 2",
      color: "#1971c2",
    },
  });

  describe("CanvasPresenceController", () => {
    test("throttles pointer publications while selection and heartbeat are immediate", async () => {
      vi.useFakeTimers();
      try {
        let now = 1_000;
        const publications: Array<{
          readonly clock: number;
          readonly state:
            | Parameters<ReturnType<typeof createCanvasPresenceController>["updatePointer"]>[0]
            | null
            | object;
        }> = [];
        const controller = createCanvasPresenceController({
          now: () => now,
          schedule: (callback, delayMs) => {
            const timeout = setTimeout(callback, delayMs);
            return () => clearTimeout(timeout);
          },
          publish: async (clock, state) => {
            publications.push({ clock, state });
          },
          onCollaborators: () => undefined,
        });

        controller.updatePointer({
          x: 1,
          y: 2,
          button: "up",
          tool: "pointer",
        });
        controller.updatePointer({
          x: 3,
          y: 4,
          button: "down",
          tool: "pointer",
        });
        expect(publications).toHaveLength(1);
        now += CANVAS_PRESENCE_POINTER_INTERVAL_MS;
        await vi.advanceTimersByTimeAsync(CANVAS_PRESENCE_POINTER_INTERVAL_MS);
        expect(publications.at(-1)?.state).toMatchObject({
          pointer: { x: 3, y: 4 },
        });

        controller.updateSelection(["element-b", "element-a"]);
        expect(publications.at(-1)?.state).toMatchObject({
          selectedElementIds: ["element-a", "element-b"],
        });
        now += CANVAS_PRESENCE_HEARTBEAT_MS;
        await vi.advanceTimersByTimeAsync(CANVAS_PRESENCE_HEARTBEAT_MS);
        expect(publications.at(-1)?.clock).toBe(4);
        await controller.close();
        expect(publications.at(-1)?.state).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    test("maps snapshots and higher-clock updates to Excalidraw collaborators", () => {
      const observations: Array<ReadonlyMap<SocketId, unknown>> = [];
      const controller = createCanvasPresenceController({
        schedule: () => () => undefined,
        publish: async () => undefined,
        onCollaborators: (next) => observations.push(next),
      });
      const visible = remotePresence(2, {
        pointer: {
          x: 10,
          y: 20,
          button: "up",
          tool: "pointer",
        },
        selectedElementIds: ["element-1"],
        idle: "active",
      });
      controller.receive({
        type: "canvas_presence_snapshot",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: "document-1",
        generation: 1,
        presences: [visible],
      });
      expect(observations.at(-1)?.get("remote-session" as SocketId)).toMatchObject({
        username: "Window 2",
        pointer: { x: 10, y: 20 },
        selectedElementIds: { "element-1": true },
        color: { stroke: "#1971c2" },
      });

      controller.receive({
        type: "canvas_presence_updated",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        presence: remotePresence(1, null),
      });
      expect(observations.at(-1)?.size).toBe(1);
      controller.receive({
        type: "canvas_presence_updated",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        presence: remotePresence(2, null),
      });
      expect(observations.at(-1)?.size).toBe(0);
    });
  });
});
