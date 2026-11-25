import { describe, expect, test, vi } from "vite-plus/test";
import {
  materializePortableCanvasScene,
  type CanvasSceneMutationCommandResult,
  type CanvasSceneMutationError,
  type CanvasSceneMutationRequest,
  type CanvasSceneRealtimeEvent,
  type CanvasSceneSyncCommandResult,
  type CanvasPresencePublishRequest,
  type CanvasPresenceRealtimeEvent,
  type PortableCanvasScene,
} from "../../shared/block-documents";
import { MemoryCanvasSceneOutbox, type CanvasSceneOutbox } from "./canvas-scene-outbox";
import {
  CanvasSceneProvider,
  type CanvasSceneProviderScheduler,
  type CanvasSceneSyncAdapter,
  type CanvasSceneProvider as CanvasSceneProviderForCanvasSceneSurfaceRuntime,
} from "./canvas-scene-provider";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { ReadyRegisteredOwnedBlockDocumentDescriptor } from "./owned-block-document";
import type { CanvasSceneBinding } from "./canvas-scene-binding";
import type { CanvasBinaryFileResolver } from "./canvas-assets";
import type { CanvasPresenceController } from "./canvas-presence-controller";
import {
  createCanvasSceneSurfaceRegistry,
  makeCanvasSceneSurfaceKey,
} from "./canvas-scene-surface-runtime";

describe("canvas scene provider", () => {
  const libraryId = "library-1";
  const routingContext = { kind: "project", projectId: "project-1" } as const;

  const element = (version: number, text = `v${version}`) => ({
    id: "element-1",
    type: "text",
    index: "a0",
    version,
    versionNonce: 10,
    isDeleted: false,
    text,
  });

  const scene = (version = 1): PortableCanvasScene =>
    materializePortableCanvasScene({ elements: [element(version)] });

  class MemoryAdapter implements CanvasSceneSyncAdapter {
    readonly calls: string[] = [];
    readonly applied: CanvasSceneMutationRequest[] = [];
    listener: ((event: CanvasSceneRealtimeEvent) => void) | null = null;
    presenceListener: ((event: CanvasPresenceRealtimeEvent) => void) | null = null;
    readonly presencePublications: CanvasPresencePublishRequest[] = [];
    currentScene = scene();
    generation = 1;
    headSeq = 0;
    applyError: Error | null = null;
    applyCommandError: CanvasSceneMutationError | null = null;
    syncImplementation: CanvasSceneSyncAdapter["sync"] | null = null;
    private readonly committed = new Map<
      string,
      Extract<Awaited<CanvasSceneMutationCommandResult>, { readonly ok: true }>["value"]
    >();

    subscribe: CanvasSceneSyncAdapter["subscribe"] = (_request, listener, presenceListener) => {
      this.calls.push("subscribe");
      this.listener = listener;
      this.presenceListener = presenceListener ?? null;
      return () => {
        this.listener = null;
        this.presenceListener = null;
      };
    };

    publishPresence: NonNullable<CanvasSceneSyncAdapter["publishPresence"]> = async (request) => {
      this.presencePublications.push(request);
      return { ok: true, value: { accepted: true, applied: true } };
    };

    sync: CanvasSceneSyncAdapter["sync"] = async (request) => {
      this.calls.push("sync");
      if (this.syncImplementation) return await this.syncImplementation(request);
      return {
        ok: true,
        value: {
          kind: "snapshot",
          syncRequestId: request.syncRequestId,
          libraryId,
          routingContext,
          documentId: "document-1",
          storeEpoch: "epoch-1",
          generation: this.generation,
          headSeq: this.headSeq,
          sceneHash: "a".repeat(64),
          scene: this.currentScene,
        },
      };
    };

    applyMutation: CanvasSceneSyncAdapter["applyMutation"] = async (request) => {
      this.calls.push(`apply:${request.mutationId}`);
      this.applied.push(request);
      if (this.applyError) throw this.applyError;
      if (this.applyCommandError) {
        return { ok: false, error: this.applyCommandError };
      }
      const committed = this.committed.get(request.mutationId);
      if (committed) {
        return {
          ok: true,
          localCommit: noOpLocalCommit(request.storeEpoch, committed.headSeq),
          value: { ...committed, duplicate: true },
        };
      }
      const elements = new Map(
        this.currentScene.elements.map((candidate) => [candidate.id as string, candidate]),
      );
      for (const candidate of request.elementCandidates) {
        elements.set(candidate.id as string, candidate);
      }
      this.currentScene = materializePortableCanvasScene({
        elements: [...elements.values()],
        appState: this.currentScene.appState,
        files: { ...this.currentScene.files, ...request.fileAdditions },
      });
      const baseHeadSeq = this.headSeq;
      this.headSeq += 1;
      const result = {
        ok: true,
        localCommit: noOpLocalCommit(request.storeEpoch, this.headSeq),
        value: {
          mutationId: request.mutationId,
          libraryId,
          routingContext: request.routingContext,
          documentId: request.documentId,
          storeEpoch: request.storeEpoch,
          generation: request.generation,
          baseHeadSeq,
          headSeq: this.headSeq,
          duplicate: false,
          outcome: "committed",
          sceneHash: "b".repeat(64),
          changedElementIds: request.elementCandidates.map((candidate) => candidate.id as string),
          appliedAppStateKeys: [],
          skippedAppStateKeys: [],
          addedFileIds: [],
          removedFileIds: [],
          committedAt: "2026-07-13T00:00:00.000Z",
          committedDelta: {
            elementUpdates: request.elementCandidates,
            appState: this.currentScene.appState,
            fileAdditions: request.fileAdditions,
            removedFileIds: [],
          },
        },
      } as const;
      this.committed.set(request.mutationId, result.value);
      return result;
    };
  }

  const manualScheduler = () => {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const schedule: CanvasSceneProviderScheduler = (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    };
    return { callbacks, delays, schedule };
  };

  const makeProvider = (input: {
    adapter: MemoryAdapter;
    outbox?: CanvasSceneOutbox;
    schedule?: CanvasSceneProviderScheduler;
    scheduleRetry?: CanvasSceneProviderScheduler;
    onScene?: (value: PortableCanvasScene) => void;
    now?: () => number;
    random?: () => number;
    clientSessionId?: string;
    onPresence?: (event: CanvasPresenceRealtimeEvent) => void;
  }) => {
    let mutationSequence = 0;
    let syncSequence = 0;
    return new CanvasSceneProvider({
      libraryId,
      routingContext,
      documentId: "document-1",
      clientSessionId: input.clientSessionId ?? "window-1",
      adapter: input.adapter,
      outbox: input.outbox ?? new MemoryCanvasSceneOutbox(libraryId),
      createMutationId: () => {
        mutationSequence += 1;
        return `mutation-${mutationSequence}`;
      },
      createSyncRequestId: () => {
        syncSequence += 1;
        return `sync-${syncSequence}`;
      },
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.scheduleRetry ? { scheduleRetry: input.scheduleRetry } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.random ? { random: input.random } : {}),
      onScene: input.onScene ?? (() => undefined),
      ...(input.onPresence ? { onPresence: input.onPresence } : {}),
    });
  };

  describe("CanvasSceneProvider", () => {
    test("rejects an outbox bound to another Library", () => {
      expect(() =>
        makeProvider({
          adapter: new MemoryAdapter(),
          outbox: new MemoryCanvasSceneOutbox("library-foreign"),
        }),
      ).toThrow("outbox crossed its Library boundary");
    });

    test("buffers the initial presence snapshot until generation is synchronized", async () => {
      const adapter = new MemoryAdapter();
      const received: CanvasPresenceRealtimeEvent[] = [];
      adapter.syncImplementation = async (request) => {
        adapter.presenceListener?.({
          type: "canvas_presence_snapshot",
          libraryId,
          routingContext,
          documentId: "document-1",
          generation: 1,
          presences: [],
        });
        return {
          ok: true,
          value: {
            kind: "snapshot",
            syncRequestId: request.syncRequestId,
            libraryId: "library-1",
            routingContext,
            documentId: "document-1",
            storeEpoch: "epoch-1",
            generation: 1,
            headSeq: 0,
            sceneHash: "a".repeat(64),
            scene: adapter.currentScene,
          },
        };
      };
      const provider = makeProvider({
        adapter,
        onPresence: (event) => received.push(event),
      });

      await provider.connect();
      expect(received).toHaveLength(1);
      await expect(
        provider.publishPresence(1, {
          selectedElementIds: [],
          idle: "active",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(adapter.presencePublications[0]).toMatchObject({
        publication: {
          documentId: "document-1",
          generation: 1,
          clock: 1,
        },
      });
      await provider.close();
    });

    test("does not allocate or persist a no-op observation", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const coalescing = manualScheduler();
      const provider = makeProvider({
        adapter,
        outbox,
        schedule: coalescing.schedule,
      });
      await provider.connect();

      const submission = provider.enqueue({ elementCandidates: [] });
      await Promise.all([submission.durable, submission.committed]);

      expect(coalescing.callbacks).toHaveLength(0);
      expect(adapter.applied).toHaveLength(0);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      await provider.close();
    });

    test("accepts an up-to-date repair without reparsing or presenting the scene", async () => {
      const adapter = new MemoryAdapter();
      const presented: PortableCanvasScene[] = [];
      const provider = makeProvider({
        adapter,
        onScene: (value) => presented.push(value),
      });
      await provider.connect();
      expect(presented).toHaveLength(1);
      adapter.syncImplementation = async (request) => ({
        ok: true,
        value: {
          kind: "up_to_date",
          syncRequestId: request.syncRequestId,
          libraryId: "library-1",
          routingContext: request.routingContext,
          documentId: request.documentId,
          storeEpoch: "epoch-1",
          generation: 1,
          headSeq: 0,
          sceneHash: "a".repeat(64),
        },
      });

      adapter.listener?.({
        type: "canvas_scene_resync_required",
        libraryId,
        routingContext,
        documentId: "document-1",
        storeEpoch: "epoch-1",
        generation: 1,
        headSeq: 0,
      });
      await vi.waitUntil(() => adapter.calls.filter((call) => call === "sync").length === 2);

      expect(presented).toHaveLength(1);
      expect(provider.getStatus().phase).toBe("ready");
      await provider.close();
    });

    test("rejects up-to-date without a local scene and a wrong sync request ID", async () => {
      const noSceneAdapter = new MemoryAdapter();
      noSceneAdapter.syncImplementation = async (request) => ({
        ok: true,
        value: {
          kind: "up_to_date",
          syncRequestId: request.syncRequestId,
          libraryId: "library-1",
          routingContext: request.routingContext,
          documentId: request.documentId,
          storeEpoch: "epoch-1",
          generation: 1,
          headSeq: 0,
          sceneHash: "a".repeat(64),
        },
      });
      const noSceneProvider = makeProvider({ adapter: noSceneAdapter });
      await noSceneProvider.connect();
      expect(noSceneProvider.getStatus()).toMatchObject({
        phase: "error",
        error: { message: expect.stringContaining("without a local scene") },
      });
      await expect(noSceneProvider.close({ requireCommitted: false })).rejects.toThrow(
        "without a local scene",
      );

      const wrongIdAdapter = new MemoryAdapter();
      wrongIdAdapter.syncImplementation = async (request) => ({
        ok: true,
        value: {
          kind: "snapshot",
          syncRequestId: `${request.syncRequestId}:stale`,
          libraryId: "library-1",
          routingContext: request.routingContext,
          documentId: request.documentId,
          storeEpoch: "epoch-1",
          generation: 1,
          headSeq: 0,
          sceneHash: "a".repeat(64),
          scene: scene(),
        },
      });
      const wrongIdProvider = makeProvider({ adapter: wrongIdAdapter });
      await wrongIdProvider.connect();
      expect(wrongIdProvider.getStatus()).toMatchObject({
        phase: "error",
        error: { message: expect.stringContaining("active request") },
      });
      await expect(wrongIdProvider.close({ requireCommitted: false })).rejects.toThrow(
        "active request",
      );
    });

    test("subscribes before sync and coalesces observations into one durable mutation", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const coalescing = manualScheduler();
      const provider = makeProvider({ adapter, outbox, schedule: coalescing.schedule });
      await provider.connect();
      expect(adapter.calls.slice(0, 2)).toEqual(["subscribe", "sync"]);

      const first = provider.submit({ elementCandidates: [element(2)] });
      const second = provider.submit({ elementCandidates: [element(3)] });
      expect(adapter.applied).toHaveLength(0);
      coalescing.callbacks.shift()?.();
      await Promise.all([first, second]);

      expect(adapter.applied).toHaveLength(1);
      expect(adapter.applied[0]?.elementCandidates[0]?.version).toBe(3);
      expect(adapter.calls.filter((call) => call === "sync")).toHaveLength(1);
      expect(provider.getScene()?.elements[0]?.version).toBe(3);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      expect(provider.getStatus().phase).toBe("ready");
      await provider.close();
    });

    test("persists the exact request before send and retries it unchanged", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const retry = manualScheduler();
      adapter.applyError = new Error("offline");
      const provider = makeProvider({ adapter, outbox, scheduleRetry: retry.schedule });
      await provider.connect();
      const submitted = provider.submit({ elementCandidates: [element(2)] });
      const flushing = provider.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const stored = await outbox.list(routingContext, "document-1");
      expect(stored).toHaveLength(1);
      expect(adapter.applied).toHaveLength(1);
      adapter.applyError = null;
      retry.callbacks.shift()?.();
      await Promise.all([submitted, flushing]);
      expect(adapter.applied).toHaveLength(2);
      expect(adapter.applied[1]).toEqual(adapter.applied[0]);
      await provider.close();
    });

    test("backs repeated transport failures off exponentially", async () => {
      const adapter = new MemoryAdapter();
      const retry = manualScheduler();
      adapter.applyError = new Error("offline");
      const provider = makeProvider({
        adapter,
        scheduleRetry: retry.schedule,
        random: () => 0.5,
      });
      await provider.connect();
      const submission = provider.enqueue({
        elementCandidates: [element(2)],
      });
      await submission.durable;
      await vi.waitUntil(() => retry.callbacks.length === 1);
      expect(retry.delays).toEqual([150]);

      retry.callbacks.shift()?.();
      await vi.waitUntil(() => retry.callbacks.length === 1);
      expect(retry.delays).toEqual([150, 300]);

      adapter.applyError = null;
      retry.callbacks.shift()?.();
      await submission.committed;
      await provider.close();
    });

    test("quarantines a deterministic rejection and continues with later edits", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      adapter.applyCommandError = {
        code: "invalid_canvas_scene_mutation",
        message: "Canvas managed file image cannot be redefined",
        retryable: false,
        resetRequired: false,
        mutationId: "mutation-1",
      };
      const provider = makeProvider({ adapter, outbox, now: () => 123 });
      await provider.connect();

      const rejected = provider.enqueue({
        elementCandidates: [element(2)],
      });
      await rejected.durable;
      await expect(rejected.committed).rejects.toThrow("cannot be redefined");
      await vi.waitUntil(() => provider.getStatus().phase === "ready");

      expect(await outbox.list(routingContext, "document-1")).toEqual([]);
      expect(await outbox.listQuarantined(routingContext, "document-1")).toEqual([
        expect.objectContaining({
          rejectedAt: 123,
          intent: expect.objectContaining({ mutationId: "mutation-1" }),
        }),
      ]);

      adapter.applyCommandError = null;
      await provider.submit({ elementCandidates: [element(3)] });
      expect(provider.getScene()?.elements[0]?.version).toBe(3);
      await provider.close();

      const reopenedAdapter = new MemoryAdapter();
      const reopened = makeProvider({
        adapter: reopenedAdapter,
        outbox,
        clientSessionId: "window-reopened",
      });
      await reopened.connect();
      expect(reopenedAdapter.applied).toEqual([]);
      await reopened.close();
    });

    test("lets a new client session recover an intent after local-durable close", async () => {
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const firstAdapter = new MemoryAdapter();
      const retry = manualScheduler();
      firstAdapter.applyError = new Error("offline");
      const first = makeProvider({
        adapter: firstAdapter,
        outbox,
        scheduleRetry: retry.schedule,
        clientSessionId: "window-1",
      });
      await first.connect();

      const submission = first.enqueue({ elementCandidates: [element(2)] });
      await submission.durable;
      void submission.committed.catch(() => undefined);
      await first.close({ requireCommitted: false });
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(1);

      const secondAdapter = new MemoryAdapter();
      const second = makeProvider({
        adapter: secondAdapter,
        outbox,
        clientSessionId: "window-2",
      });
      await second.connect();
      await vi.waitUntil(() => secondAdapter.applied.length === 1);

      expect(secondAdapter.applied[0]?.clientSessionId).toBe("window-2");
      expect(secondAdapter.applied[0]?.mutationId).toBe(firstAdapter.applied[0]?.mutationId);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      await second.close();
    });

    test("owner retirement clears active local intent and closes terminally", async () => {
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const adapter = new MemoryAdapter();
      const retry = manualScheduler();
      adapter.applyError = new Error("offline");
      const provider = makeProvider({
        adapter,
        outbox,
        scheduleRetry: retry.schedule,
      });
      await provider.connect();

      const submission = provider.enqueue({
        elementCandidates: [element(2)],
      });
      await submission.durable;
      void submission.committed.catch(() => undefined);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(1);

      await provider.retireOwner();

      expect(await outbox.list(routingContext, "document-1")).toEqual([]);
      expect(provider.getStatus().phase).toBe("closed");
      await expect(provider.connect()).rejects.toThrow("closed");
    });

    test("persists later FIFO intents while an older intent is offline", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      const retry = manualScheduler();
      adapter.applyError = new Error("offline");
      const provider = makeProvider({
        adapter,
        outbox,
        scheduleRetry: retry.schedule,
      });
      await provider.connect();

      const first = provider.enqueue({ elementCandidates: [element(2)] });
      await first.durable;
      void first.committed.catch(() => undefined);
      await vi.waitUntil(() => retry.callbacks.length === 1);

      const second = provider.enqueue({
        elementCandidates: [
          {
            ...element(1),
            id: "element-2",
            index: "a1",
          },
        ],
      });
      void second.committed.catch(() => undefined);
      await provider.persistDurable();
      await second.durable;

      expect(
        (await outbox.list(routingContext, "document-1")).map((entry) => entry.mutationId),
      ).toEqual(["mutation-1", "mutation-2"]);
      await provider.close({ requireCommitted: false });
    });

    test("repairs realtime gaps with a full sync and presents the canonical scene", async () => {
      const adapter = new MemoryAdapter();
      const presented: PortableCanvasScene[] = [];
      const provider = makeProvider({
        adapter,
        onScene: (value) => presented.push(value),
      });
      await provider.connect();
      adapter.currentScene = scene(4);
      adapter.headSeq = 3;
      adapter.listener?.({
        type: "canvas_scene_resync_required",
        libraryId,
        routingContext,
        documentId: "document-1",
        storeEpoch: "epoch-1",
        generation: 1,
        headSeq: 3,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(provider.getStatus().headSeq).toBe(3);
      expect(presented.at(-1)?.elements[0]?.version).toBe(4);
      await provider.close();
    });

    test("does not let a delayed full sync rewind newer realtime commits", async () => {
      const adapter = new MemoryAdapter();
      const provider = makeProvider({ adapter });
      await provider.connect();
      let resolveSync!: (result: CanvasSceneSyncCommandResult) => void;
      let pendingSyncRequestId = "";
      adapter.syncImplementation = (request) =>
        new Promise((resolve) => {
          pendingSyncRequestId = request.syncRequestId;
          resolveSync = resolve;
        });
      adapter.listener?.({
        type: "canvas_scene_resync_required",
        libraryId,
        routingContext,
        documentId: "document-1",
        storeEpoch: "epoch-1",
        generation: 1,
        headSeq: 1,
      });
      await Promise.resolve();
      for (const [headSeq, version] of [
        [1, 2],
        [2, 3],
      ] as const) {
        adapter.listener?.({
          type: "canvas_scene_committed",
          libraryId,
          routingContext,
          documentId: "document-1",
          storeEpoch: "epoch-1",
          generation: 1,
          mutationId: `remote-${headSeq}`,
          baseHeadSeq: headSeq - 1,
          headSeq,
          sceneHash: "c".repeat(64),
          elementUpdates: [element(version)],
          appState: {},
          fileAdditions: {},
          removedFileIds: [],
        });
      }
      resolveSync({
        ok: true,
        value: {
          kind: "snapshot",
          syncRequestId: pendingSyncRequestId,
          libraryId,
          routingContext,
          documentId: "document-1",
          storeEpoch: "epoch-1",
          generation: 1,
          headSeq: 0,
          sceneHash: "a".repeat(64),
          scene: scene(1),
        },
      });
      await vi.waitUntil(() => provider.getStatus().phase === "ready");
      expect(provider.getStatus().headSeq).toBe(2);
      expect(provider.getScene()?.elements[0]?.version).toBe(3);
      adapter.syncImplementation = null;
      await provider.close();
    });

    test("retries exact delivery when durable ACK cleanup fails", async () => {
      class FailingRemoveOutbox implements CanvasSceneOutbox {
        private readonly delegate = new MemoryCanvasSceneOutbox(libraryId);
        readonly libraryId = this.delegate.libraryId;
        removeAttempts = 0;
        list = this.delegate.list;
        listQuarantined = this.delegate.listQuarantined;
        put = this.delegate.put;
        quarantine = this.delegate.quarantine;
        clear = this.delegate.clear;
        remove = async (
          outboxRoutingContext: ContentRoutingContext,
          documentId: string,
          mutationId: string,
        ): Promise<void> => {
          this.removeAttempts += 1;
          if (this.removeAttempts === 1) throw new Error("IndexedDB delete failed");
          await this.delegate.remove(outboxRoutingContext, documentId, mutationId);
        };
      }
      const adapter = new MemoryAdapter();
      const outbox = new FailingRemoveOutbox();
      const retry = manualScheduler();
      const provider = makeProvider({ adapter, outbox, scheduleRetry: retry.schedule });
      await provider.connect();
      const submitted = provider.submit({ elementCandidates: [element(2)] });
      provider.flush().catch(() => undefined);
      await vi.waitUntil(() => retry.callbacks.length === 1);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(1);
      retry.callbacks.shift()?.();
      await submitted;
      expect(outbox.removeAttempts).toBe(2);
      expect(adapter.applied[1]).toEqual(adapter.applied[0]);
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      await provider.close();
    });

    test("retains the outbox when a successful ACK crosses its request boundary", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      adapter.applyMutation = async (request): Promise<CanvasSceneMutationCommandResult> => ({
        ok: true,
        localCommit: noOpLocalCommit(request.storeEpoch, request.baseHeadSeq + 1),
        value: {
          mutationId: request.mutationId,
          libraryId,
          routingContext: { kind: "project", projectId: "other-project" },
          documentId: request.documentId,
          storeEpoch: request.storeEpoch,
          generation: request.generation,
          baseHeadSeq: request.baseHeadSeq,
          headSeq: request.baseHeadSeq + 1,
          duplicate: false,
          outcome: "committed",
          sceneHash: "d".repeat(64),
          changedElementIds: [],
          appliedAppStateKeys: [],
          skippedAppStateKeys: [],
          addedFileIds: [],
          removedFileIds: [],
          committedAt: "2026-07-13T00:00:00.000Z",
          committedDelta: {
            elementUpdates: [],
            appState: {},
            fileAdditions: {},
            removedFileIds: [],
          },
        },
      });
      const provider = makeProvider({ adapter, outbox });
      await provider.connect();
      await expect(provider.submit({ elementCandidates: [element(2)] })).rejects.toThrow(
        "durable request boundary",
      );
      expect(await outbox.listQuarantined(routingContext, "document-1")).toHaveLength(1);
      expect(provider.getStatus().phase).toBe("error");
    });

    test("invalidates a recovered outbox across an epoch boundary", async () => {
      const adapter = new MemoryAdapter();
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      await outbox.put({
        mutationId: "old-mutation",
        routingContext,
        documentId: "document-1",
        storeEpoch: "old-epoch",
        generation: 1,
        baseHeadSeq: 0,
        elementCandidates: [element(2)],
        appStateIntents: {},
        fileAdditions: {},
      });
      const provider = makeProvider({ adapter, outbox });
      await provider.connect();
      expect(provider.getStatus().phase).toBe("reset-required");
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      expect(adapter.applied).toHaveLength(0);
    });

    test("invalidates a recovered outbox across a generation boundary", async () => {
      const adapter = new MemoryAdapter();
      adapter.generation = 2;
      const outbox = new MemoryCanvasSceneOutbox(libraryId);
      await outbox.put({
        mutationId: "old-generation-mutation",
        routingContext,
        documentId: "document-1",
        storeEpoch: "epoch-1",
        generation: 1,
        baseHeadSeq: 0,
        elementCandidates: [element(2)],
        appStateIntents: {},
        fileAdditions: {},
      });

      const provider = makeProvider({ adapter, outbox });
      await provider.connect();

      expect(provider.getStatus().phase).toBe("reset-required");
      expect(await outbox.list(routingContext, "document-1")).toHaveLength(0);
      expect(adapter.applied).toHaveLength(0);
    });

    test("close flushes the scheduled observation before unsubscribing", async () => {
      const adapter = new MemoryAdapter();
      const coalescing = manualScheduler();
      const provider = makeProvider({ adapter, schedule: coalescing.schedule });
      await provider.connect();
      const submitted = provider.submit({ elementCandidates: [element(2)] });
      await provider.close();
      await submitted;
      expect(adapter.applied).toHaveLength(1);
      expect(adapter.listener).toBeNull();
      expect(provider.getStatus().phase).toBe("closed");
    });
  });

  test("Canvas follows host reconnects and preserves terminal pending work", async () => {
    const adapter = new MemoryAdapter();
    const outbox = new MemoryCanvasSceneOutbox(libraryId);
    const provider = makeProvider({ adapter, outbox });
    try {
      await provider.connect();
      const session = {
        type: "canvas_scene_session" as const,
        libraryId,
        routingContext,
        documentId: "document-1",
        clientSessionId: "window-1",
      };
      adapter.listener?.({ ...session, state: "disconnected" });
      expect(provider.getStatus().connected).toBe(false);
      adapter.listener?.({ ...session, state: "connected" });
      await expect.poll(() => provider.getStatus().phase).toBe("ready");
      adapter.applyError = new Error("temporary transport failure");
      const submission = provider.enqueue({
        elementCandidates: [element(2)],
        appStateIntents: {},
        fileAdditions: {},
      });
      await submission.durable;
      const rejected = submission.committed.catch((error) => error);
      adapter.listener?.({
        ...session,
        state: "terminated",
        error: {
          code: "canvas_scene_corrupt",
          message: "Terminal stream failure",
          retryable: false,
          resetRequired: false,
        },
      });
      expect(await rejected).toBeInstanceOf(Error);
      await provider.checkpointRecovery();
      expect(provider.getStatus().phase).toBe("error");
      expect(await outbox.listQuarantined(routingContext, "document-1")).toHaveLength(1);
    } finally {
      await provider.close({ requireCommitted: false }).catch(() => undefined);
    }
  });

  test("connect resolves after the first physical connection's canonical resync", async () => {
    const adapter = new MemoryAdapter();
    adapter.syncImplementation = async (request) => {
      await Promise.resolve();
      adapter.syncImplementation = null;
      adapter.listener?.({
        type: "canvas_scene_session",
        libraryId,
        routingContext,
        documentId: "document-1",
        clientSessionId: "window-1",
        state: "connected",
      });
      return await adapter.sync(request);
    };
    const provider = makeProvider({ adapter });
    try {
      await provider.connect();
      expect(provider.getStatus()).toMatchObject({ phase: "ready", connected: true });
      expect(provider.getScene()).toEqual(adapter.currentScene);
    } finally {
      await provider.close({ requireCommitted: false });
    }
  });
});

describe("canvas scene surface runtime", () => {
  const descriptor = {
    documentId: "document-1",
    storeEpoch: "epoch-1",
    generation: 1,
    headSeq: 0,
    sync: { kind: "canvas_scene" },
  } as unknown as ReadyRegisteredOwnedBlockDocumentDescriptor;

  const deferred = () => {
    let resolve = (): void => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const runtimeDependencies = (input: {
    ownerBlockId?: string;
    durable?: Promise<void>;
    committed?: Promise<void>;
    closeError?: Error;
    recoveryError?: Error;
    status?: {
      readonly phase: "ready" | "saving" | "offline";
      readonly connected: boolean;
      readonly pendingMutationCount: number;
      readonly writeFrozen: boolean;
    };
  }) => {
    const calls: string[] = [];
    const binding = {
      persistDurable: async () => {
        calls.push("persist");
        await (input.durable ?? Promise.resolve());
      },
      flushCommitted: async () => {
        calls.push("flush");
        await (input.committed ?? Promise.resolve());
      },
      submitLocalScene: () => ({
        durable: Promise.resolve(),
        committed: Promise.resolve(),
      }),
      destroy: () => {
        calls.push("destroy-binding");
      },
    } as unknown as CanvasSceneBinding;
    const provider = {
      checkpointRecovery: async () => {
        calls.push("preserve-recovery");
        if (input.recoveryError) throw input.recoveryError;
      },
      connect: async () => {
        calls.push("connect");
      },
      getStatus: () =>
        input.status ?? {
          phase: "ready",
          connected: true,
          pendingMutationCount: 0,
          writeFrozen: false,
        },
      close: async () => {
        calls.push("close-provider");
        if (input.closeError) throw input.closeError;
      },
    } as unknown as CanvasSceneProviderForCanvasSceneSurfaceRuntime;
    const fileResolver = {
      destroy: () => {
        calls.push("destroy-files");
      },
    } as unknown as CanvasBinaryFileResolver;
    const presence = {
      close: async () => {
        calls.push("close-presence");
      },
    } as unknown as CanvasPresenceController;
    return {
      calls,
      input: {
        descriptor: {
          ...descriptor,
          ownerBlockId: input.ownerBlockId ?? "canvas-1",
        },
        provider,
        presence,
        binding,
        fileResolver,
        disposeSubscriptions: () => {
          calls.push("dispose-subscriptions");
        },
      },
    };
  };

  describe("CanvasSceneSurfaceRegistry", () => {
    test("retains the only draft and blocks a replacement when recovery cannot be persisted", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const first = runtimeDependencies({
        durable: Promise.reject(new Error("durability unavailable")),
        recoveryError: new Error("recovery unavailable"),
      });
      const runtime = registry.acquire({ key: "surface", ...first.input });
      await expect(registry.release("surface", runtime)).rejects.toThrow("recovery unavailable");
      expect(runtime.isClosed()).toBe(false);
      expect(first.calls).not.toContain("destroy-binding");
      await expect(registry.persistAllDurable()).rejects.toThrow("durability unavailable");
      const second = runtimeDependencies({});
      const replacement = registry.acquire({ key: "surface", ...second.input });
      await expect(replacement.connect()).rejects.toThrow("recovery unavailable");
      expect(second.calls).not.toContain("connect");
    });
    test("uses Window Session, Project Session, and tab identity", () => {
      expect(makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1")).not.toBe(
        makeCanvasSceneSurfaceKey("window-2", "session-1", "tab-1"),
      );
      expect(makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1")).not.toBe(
        makeCanvasSceneSurfaceKey("window-1", "session-2", "tab-1"),
      );
    });

    test("keeps an unmounted runtime observable until local durability settles", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const durable = deferred();
      const dependencies = runtimeDependencies({ durable: durable.promise });
      const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      const runtime = registry.acquire({ key, ...dependencies.input });

      let released = false;
      const releasing = registry.release(key, runtime).then(() => {
        released = true;
      });
      const appClosing = registry.persistAllDurable();
      await Promise.resolve();

      expect(released).toBe(false);
      expect(dependencies.calls.filter((call) => call === "persist").length).toBeGreaterThanOrEqual(
        1,
      );
      durable.resolve();
      await Promise.all([releasing, appClosing]);
      expect(dependencies.calls).toEqual(
        expect.arrayContaining([
          "close-presence",
          "close-provider",
          "dispose-subscriptions",
          "destroy-files",
          "destroy-binding",
        ]),
      );
    });

    test("does not connect a replacement until its predecessor closes", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const durable = deferred();
      const first = runtimeDependencies({ durable: durable.promise });
      const second = runtimeDependencies({});
      const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      registry.acquire({ key, ...first.input });
      const replacement = registry.acquire({ key, ...second.input });

      let connected = false;
      const connecting = replacement.connect().then(() => {
        connected = true;
      });
      await Promise.resolve();
      expect(connected).toBe(false);
      expect(second.calls).not.toContain("connect");

      durable.resolve();
      await connecting;
      expect(second.calls).toContain("connect");
    });

    test("uses the committed barrier only for explicit maintenance", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const dependencies = runtimeDependencies({});
      const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      registry.acquire({ key, ...dependencies.input });

      await registry.flushAllCommitted();

      expect(dependencies.calls).toEqual(["flush"]);
    });

    test("flushes only runtimes for the requested public Canvas owner", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const first = runtimeDependencies({ ownerBlockId: "canvas-1" });
      const second = runtimeDependencies({ ownerBlockId: "canvas-2" });
      registry.acquire({ key: "surface-1", ...first.input });
      registry.acquire({ key: "surface-2", ...second.input });

      await registry.flushOwnerCommitted("canvas-1");

      expect(first.calls).toEqual(["flush"]);
      expect(second.calls).toEqual([]);
    });

    test("runs best-effort maintenance before closing an idle provider", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const dependencies = runtimeDependencies({});
      const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      const runtime = registry.acquire({
        key,
        ...dependencies.input,
        maintainIfIdle: async () => {
          dependencies.calls.push("maintain");
        },
      });

      await registry.release(key, runtime);

      expect(dependencies.calls).toEqual([
        "persist",
        "maintain",
        "close-presence",
        "close-provider",
        "dispose-subscriptions",
        "destroy-files",
        "destroy-binding",
      ]);
    });

    test("skips maintenance with pending work and still closes after maintenance failure", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const pending = runtimeDependencies({
        status: {
          phase: "saving",
          connected: true,
          pendingMutationCount: 1,
          writeFrozen: false,
        },
      });
      const pendingKey = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      const pendingRuntime = registry.acquire({
        key: pendingKey,
        ...pending.input,
        maintainIfIdle: async () => {
          pending.calls.push("maintain");
        },
      });
      await registry.release(pendingKey, pendingRuntime);
      expect(pending.calls).not.toContain("maintain");

      const failing = runtimeDependencies({});
      const failingKey = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-2");
      const failingRuntime = registry.acquire({
        key: failingKey,
        ...failing.input,
        maintainIfIdle: async () => {
          failing.calls.push("maintain");
          throw new Error("maintenance unavailable");
        },
      });
      await expect(registry.release(failingKey, failingRuntime)).resolves.toBeUndefined();
      expect(failing.calls).toEqual(
        expect.arrayContaining(["maintain", "close-provider", "destroy-binding"]),
      );
    });

    test("preserves recovery before releasing a failed close and lets a replacement connect", async () => {
      const registry = createCanvasSceneSurfaceRegistry();
      const first = runtimeDependencies({
        durable: Promise.reject(new Error("durability unavailable")),
        closeError: new Error("provider close unavailable"),
      });
      const second = runtimeDependencies({});
      const key = makeCanvasSceneSurfaceKey("window-1", "session-1", "tab-1");
      const runtime = registry.acquire({ key, ...first.input });

      await expect(registry.release(key, runtime)).rejects.toThrow("durability unavailable");
      expect(first.calls).toEqual(
        expect.arrayContaining([
          "persist",
          "close-presence",
          "close-provider",
          "dispose-subscriptions",
          "destroy-files",
          "destroy-binding",
        ]),
      );

      await registry.flushAllCommitted();
      expect(first.calls).not.toContain("flush");

      const replacement = registry.acquire({ key, ...second.input });
      await expect(replacement.connect()).resolves.toBeUndefined();
      expect(second.calls).toContain("connect");
    });
  });
});
