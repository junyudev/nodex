import { expect, test } from "vite-plus/test";
import { noOpLocalCommit } from "../../shared/testing/local-commit";
import { createElectronCanvasSceneSyncAdapter } from "./electron-canvas-scene-sync-adapter";
import type { ElectronRendererBridge } from "./electron-renderer-transport";

const emptyScene = {
  kind: "canvas_scene" as const,
  schemaVersion: 1 as const,
  elements: [],
  appState: {},
  files: {},
  pageReferences: [],
  plainText: "",
  preview: "",
};

test("Electron Canvas adapter awaits subscription and carries presence", async () => {
  const calls: string[] = [];
  const listeners = new Set<(...args: unknown[]) => void>();
  const presenceEvents: unknown[] = [];
  const bridge = {
    invoke: async (channel: string, request: { documentId: string; syncRequestId?: string }) => {
      calls.push(channel);
      if (channel === "canvas-scene:subscribe") {
        return { ok: true, value: { subscribed: true } };
      }
      if (channel === "canvas-scene:sync") {
        return {
          ok: true,
          value: {
            kind: "snapshot",
            syncRequestId: request.syncRequestId,
            libraryId: "library-1",
            accessContext: { kind: "project", projectId: "project-1" },
            documentId: request.documentId,
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 0,
            sceneHash: "a".repeat(64),
            scene: emptyScene,
          },
        };
      }
      if (channel === "canvas-scene:presence:publish") {
        return { ok: true, value: { accepted: true, applied: true } };
      }
      return { ok: true, value: { unsubscribed: true } };
    },
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ElectronRendererBridge;
  const accessContext = { kind: "project", projectId: "project-1" } as const;
  const adapter = createElectronCanvasSceneSyncAdapter(bridge, {
    libraryId: "library-1",
    accessContext,
  });
  const unsubscribe = adapter.subscribe(
    {
      accessContext,
      documentId: "canvas-1",
      clientSessionId: "client-1",
    },
    () => undefined,
    (event) => presenceEvents.push(event),
  );
  const result = await adapter.sync({
    syncRequestId: "sync-1",
    accessContext,
    documentId: "canvas-1",
    clientSessionId: "client-1",
  });
  expect(result.ok).toBe(true);
  expect(calls.slice(0, 2)).toEqual(["canvas-scene:subscribe", "canvas-scene:sync"]);
  listeners.forEach((listener) =>
    listener({
      type: "canvas_presence_snapshot",
      libraryId: "library-1",
      accessContext,
      documentId: "canvas-1",
      generation: 1,
      presences: [],
    }),
  );
  expect(presenceEvents).toHaveLength(1);
  listeners.forEach((listener) =>
    listener({
      type: "canvas_presence_snapshot",
      libraryId: "library-foreign",
      accessContext,
      documentId: "canvas-1",
      generation: 1,
      presences: [],
    }),
  );
  expect(presenceEvents).toHaveLength(1);
  await expect(
    adapter.publishPresence?.({
      accessContext,
      clientSessionId: "client-1",
      publication: {
        engine: "canvas_scene",
        documentId: "canvas-1",
        generation: 1,
        clock: 1,
        state: { selectedElementIds: [], idle: "active" },
      },
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(calls).toContain("canvas-scene:presence:publish");
  unsubscribe();
});

test("Electron Canvas routes semantic mutations through typed LocalCommit admission", async () => {
  const calls: Array<{ readonly channel: string; readonly request: unknown }> = [];
  const accessContext = { kind: "project", projectId: "project-1" } as const;
  const bridge = {
    invoke: async (channel: string, request: unknown) => {
      calls.push({ channel, request });
      if (channel === "canvas-scene:subscribe") {
        return { ok: true, value: { subscribed: true } };
      }
      if (channel === "canvas-scene:apply") {
        return {
          ok: true,
          localCommit: noOpLocalCommit("store-1", 2),
          value: {
            mutationId: "mutation-1",
            libraryId: "library-1",
            accessContext,
            documentId: "canvas-1",
            storeEpoch: "store-1",
            generation: 1,
            baseHeadSeq: 1,
            headSeq: 2,
            duplicate: false,
            outcome: "committed",
            sceneHash: "b".repeat(64),
            changedElementIds: [],
            appliedAppStateKeys: [],
            skippedAppStateKeys: [],
            addedFileIds: [],
            removedFileIds: [],
            committedAt: "2026-08-31T00:00:00.000Z",
          },
        };
      }
      return { ok: true, value: { unsubscribed: true } };
    },
    on: () => () => undefined,
  } as unknown as ElectronRendererBridge;
  const adapter = createElectronCanvasSceneSyncAdapter(bridge, {
    libraryId: "library-1",
    accessContext,
  });
  const unsubscribe = adapter.subscribe(
    {
      accessContext,
      documentId: "canvas-1",
      clientSessionId: "client-1",
    },
    () => undefined,
  );

  await expect(
    adapter.applyMutation({
      mutationId: "mutation-1",
      accessContext,
      documentId: "canvas-1",
      storeEpoch: "store-1",
      generation: 1,
      baseHeadSeq: 1,
      elementCandidates: [],
      appStateIntents: {},
      fileAdditions: {},
      clientSessionId: "client-1",
    }),
  ).resolves.toMatchObject({
    ok: true,
    localCommit: noOpLocalCommit("store-1", 2),
    value: { mutationId: "mutation-1", headSeq: 2 },
  });
  expect(calls.map(({ channel }) => channel).slice(0, 2)).toEqual([
    "canvas-scene:subscribe",
    "canvas-scene:apply",
  ]);
  expect(calls[1]?.request).toMatchObject({ mutationId: "mutation-1" });
  unsubscribe();
});

test("Electron Canvas keeps a revived exact session ahead of stale teardown", async () => {
  let resolveSubscription: (result: unknown) => void = () => undefined;
  const subscription = new Promise<unknown>((resolve) => {
    resolveSubscription = resolve;
  });
  const calls: string[] = [];
  const bridge = {
    invoke: async (channel: string, request: { documentId: string; syncRequestId?: string }) => {
      calls.push(channel);
      if (channel === "canvas-scene:subscribe") return await subscription;
      if (channel === "canvas-scene:sync") {
        return {
          ok: true,
          value: {
            kind: "snapshot",
            syncRequestId: request.syncRequestId,
            libraryId: "library-1",
            accessContext: { kind: "project", projectId: "project-1" },
            documentId: request.documentId,
            storeEpoch: "store-1",
            generation: 1,
            headSeq: 0,
            sceneHash: "a".repeat(64),
            scene: emptyScene,
          },
        };
      }
      return { ok: true, value: { unsubscribed: true } };
    },
    on: () => () => undefined,
  } as unknown as ElectronRendererBridge;
  const accessContext = { kind: "project", projectId: "project-1" } as const;
  const adapter = createElectronCanvasSceneSyncAdapter(bridge, {
    libraryId: "library-1",
    accessContext,
  });
  const request = {
    accessContext,
    documentId: "canvas-1",
    clientSessionId: "client-1",
  } as const;
  const listener = () => undefined;
  const closeFirst = adapter.subscribe(request, listener);
  closeFirst();
  const closeSecond = adapter.subscribe(request, listener);

  resolveSubscription({ ok: true, value: { subscribed: true } });
  await expect(
    adapter.sync({
      syncRequestId: "sync-2",
      ...request,
    }),
  ).resolves.toMatchObject({
    ok: true,
  });
  expect(calls).toEqual(["canvas-scene:subscribe", "canvas-scene:sync"]);

  closeSecond();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls.at(-1)).toBe("canvas-scene:unsubscribe");
});
