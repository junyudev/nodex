import { describe, expect, test, vi } from "vite-plus/test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import type {
  BlockDocumentSurfaceRuntime,
  BlockDocumentSurfaceStatus,
} from "./block-document-surface-runtime";
import { DocumentSessionRegistry, makeEditorSurfaceKey } from "./document-session-registry";

const descriptor = (generation = 1, headSeq = 1): OwnedDocumentDescriptor => ({
  libraryId: "library-1",
  accessContext: { kind: "project", projectId: "project-1" },
  ownerBlockId: "page-1",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document-1",
  authorization: null,
  storeEpoch: "epoch-1",
  generation,
  headSeq,
  schemaKey: "nodex.page",
  schemaVersion: 1,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([headSeq]) },
});

function createRuntime(input: {
  readonly descriptor?: OwnedDocumentDescriptor;
  readonly connect?: () => Promise<void>;
  readonly close?: () => Promise<void>;
  readonly ready?: boolean;
  readonly status?: Partial<BlockDocumentSurfaceStatus>;
  readonly retainDraftOnClose?: boolean;
}) {
  const runtimeDescriptor = input.descriptor ?? descriptor();
  const document = new Y.Doc({ guid: runtimeDescriptor.documentId });
  const awareness = new Awareness(document);
  const clearLocalAwareness = vi.fn();
  const persist = vi.fn(async () => ({
    timedOut: false,
    flush: "completed" as const,
    checkpoint: "completed" as const,
  }));
  const close = vi.fn(async () => {
    await input.close?.();
    if (!input.retainDraftOnClose) status = { ...status, phase: "closed", ready: false };
    return {
      timedOut: false,
      flush: "completed" as const,
      checkpoint: "completed" as const,
    };
  });
  const connect = vi.fn(input.connect ?? (async () => undefined));
  const ready = input.ready ?? true;
  let status: BlockDocumentSurfaceStatus = {
    phase: ready ? "ready" : "connecting",
    ready,
    reloadRequired: false,
    structuralWaitStartedAt: null,
    descriptor: runtimeDescriptor,
    provider: {
      phase: ready ? "synced" : "connecting",
      documentId: runtimeDescriptor.documentId,
      clientSessionId: "client-session-1",
      connected: ready,
      storeEpoch: runtimeDescriptor.storeEpoch,
      generation: runtimeDescriptor.generation,
      headSeq: runtimeDescriptor.headSeq,
      pendingUpdateCount: 0,
      checkpoint: { phase: "ready", failureCount: 0 },
    },
    ...input.status,
  };
  const runtime = {
    descriptor: runtimeDescriptor,
    document,
    awareness,
    connect,
    close,
    persist,
    clearLocalAwareness,
    getStatus: () => status,
  } as unknown as BlockDocumentSurfaceRuntime;
  return { runtime, connect, close, persist, clearLocalAwareness };
}

describe("DocumentSessionRegistry", () => {
  test("reopens the retained replica after closing could not protect its pending edits", async () => {
    const registry = new DocumentSessionRegistry();
    const retained = createRuntime({ retainDraftOnClose: true });
    const key = makeEditorSurfaceKey("session", "page");
    const first = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => retained.runtime,
    });
    await expect(registry.dispose(key, first)).rejects.toThrow("unsaved recovery copy");
    expect(registry.canonicalDocumentSize).toBe(1);
    await registry.persistAll();
    expect(retained.persist).toHaveBeenCalledOnce();
    const reopened = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => {
        throw new Error("Must retain the pending replica");
      },
    });
    expect(reopened.runtime).toBe(retained.runtime);
  });
  test("replaces a terminal runtime when the same surface is acquired again", async () => {
    const registry = new DocumentSessionRegistry();
    const terminal = createRuntime({
      status: { reloadRequired: true },
    });
    const successor = createRuntime({});
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const first = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => terminal.runtime,
    });
    const second = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => successor.runtime,
    });

    expect(second).not.toBe(first);
    expect(second.runtime).toBe(successor.runtime);
    await second.connect();
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(successor.connect).toHaveBeenCalledTimes(1);
    await registry.dispose(key);
  });

  test("shares one canonical Yjs runtime across tab groups and closes after the last view", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const first = registry.acquire({
      key: makeEditorSurfaceKey("session-left", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const second = registry.acquire({
      key: makeEditorSurfaceKey("session-right", "tab-page-2"),
      descriptor: {
        ...descriptor(1, 9),
        ownerBlockId: "relocated-page-owner",
        ownerLifecycle: "archived",
        readiness: "pending_genesis",
      },
      createRuntime: () => {
        throw new Error("The canonical document must be reused");
      },
    });

    expect(second.runtime).toBe(first.runtime);
    expect(registry.size).toBe(2);
    expect(registry.canonicalDocumentSize).toBe(1);

    await first.dispose();
    expect(runtime.close).not.toHaveBeenCalled();
    await second.dispose();

    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(registry.canonicalDocumentSize).toBe(0);
  });

  test("keeps editor, selection, and undo ownership surface-local", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const first = registry.acquire({
      key: makeEditorSurfaceKey("session-left", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const second = registry.acquire({
      key: makeEditorSurfaceKey("session-right", "tab-page-2"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const firstEditor = { _tiptapEditor: { destroy: vi.fn() } };
    const secondEditor = { _tiptapEditor: { destroy: vi.fn() } };
    const retainedController = { dispose: vi.fn() };

    expect(first.getOrCreateEditor("page-editor", () => firstEditor)).toBe(firstEditor);
    expect(second.getOrCreateEditor("page-editor", () => secondEditor)).toBe(secondEditor);
    expect(firstEditor).not.toBe(secondEditor);
    expect(first.runtime).toBe(second.runtime);
    expect(first.getOrCreateRetainedResource("history", () => retainedController)).toBe(
      retainedController,
    );
    expect(first.getOrCreateRetainedResource("history", () => ({ dispose: vi.fn() }))).toBe(
      retainedController,
    );

    await registry.disposeAll();
    expect(firstEditor._tiptapEditor.destroy).toHaveBeenCalledOnce();
    expect(secondEditor._tiptapEditor.destroy).toHaveBeenCalledOnce();
    expect(retainedController.dispose).toHaveBeenCalledOnce();
  });

  test("retains the editor and document runtime until asynchronous history cleanup completes", async () => {
    const registry = new DocumentSessionRegistry();
    const events: string[] = [];
    const runtime = createRuntime({
      close: async () => {
        events.push("runtime closed");
      },
    });
    const surface = registry.acquire({
      key: makeEditorSurfaceKey("session-cleanup", "tab-page"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    let finishCleanup = () => {};
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    surface.getOrCreateEditor("page-editor", () => ({
      _tiptapEditor: {
        destroy: () => {
          events.push("editor destroyed");
        },
      },
    }));
    surface.getOrCreateRetainedResource("history", () => ({ dispose: () => cleanup }));
    const closing = surface.dispose();
    try {
      await Promise.resolve();
      expect(events).toEqual([]);
    } finally {
      finishCleanup();
      await closing;
    }
    expect(events).toEqual(["editor destroyed", "runtime closed"]);
  });

  test("waits for every retained cleanup even when another cleanup fails", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const surface = registry.acquire({
      key: makeEditorSurfaceKey("session-cleanup-failure", "tab-page"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    let finishCleanup = () => {};
    const pending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const destroyed = vi.fn();
    surface.getOrCreateEditor("page-editor", () => ({ _tiptapEditor: { destroy: destroyed } }));
    surface.getOrCreateRetainedResource("failed", () => ({
      dispose: () => {
        throw new Error("cleanup failed");
      },
    }));
    surface.getOrCreateRetainedResource("pending", () => ({ dispose: () => pending }));
    const closing = Promise.resolve().then(() => surface.dispose());
    const failed = expect(closing).rejects.toThrow("cleanup failed");
    try {
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(destroyed).not.toHaveBeenCalled();
    } finally {
      finishCleanup();
      await failed;
    }
    expect(destroyed).toHaveBeenCalledOnce();
  });

  test("does not share a DocumentSession across access scopes", async () => {
    const registry = new DocumentSessionRegistry();
    const firstRuntime = createRuntime({});
    const secondDescriptor = {
      ...descriptor(),
      accessContext: { kind: "project" as const, projectId: "project-2" },
    };
    const secondRuntime = createRuntime({ descriptor: secondDescriptor });
    const first = registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => firstRuntime.runtime,
    });
    const second = registry.acquire({
      key: makeEditorSurfaceKey("session-2", "tab-page-2"),
      descriptor: secondDescriptor,
      createRuntime: () => secondRuntime.runtime,
    });

    expect(first.runtime).not.toBe(second.runtime);
    expect(registry.canonicalDocumentSize).toBe(2);
    await registry.disposeAll();
  });

  test.each([
    ["store epoch", { storeEpoch: "epoch-2" }],
    ["generation", { generation: 2 }],
    ["schema", { schemaVersion: 2 }],
  ])("replaces the DocumentSession at a %s boundary", async (_, boundary) => {
    const registry = new DocumentSessionRegistry();
    const firstRuntime = createRuntime({});
    const nextDescriptor = { ...descriptor(), ...boundary };
    const nextRuntime = createRuntime({ descriptor: nextDescriptor });
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const first = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => firstRuntime.runtime,
    });
    const next = registry.acquire({
      key,
      descriptor: nextDescriptor,
      createRuntime: () => nextRuntime.runtime,
    });

    expect(next).not.toBe(first);
    expect(next.runtime).toBe(nextRuntime.runtime);
    await next.connect();
    expect(firstRuntime.close).toHaveBeenCalledOnce();
    await registry.disposeAll();
  });

  test("persists a shared canonical runtime only once at the close boundary", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    registry.acquire({
      key: makeEditorSurfaceKey("session-left", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    registry.acquire({
      key: makeEditorSurfaceKey("session-right", "tab-page-2"),
      descriptor: descriptor(1, 9),
      createRuntime: () => runtime.runtime,
    });

    await registry.persistAll();

    expect(runtime.persist).toHaveBeenCalledTimes(1);
  });

  test("keeps shared awareness while another tab-group view is active", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const first = registry.acquire({
      key: makeEditorSurfaceKey("session-left", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const second = registry.acquire({
      key: makeEditorSurfaceKey("session-right", "tab-page-2"),
      descriptor: descriptor(1, 9),
      createRuntime: () => runtime.runtime,
    });

    first.awarenessLease.publish({
      user: { name: "Left" },
      nodex: { view: "left" },
    });
    second.awarenessLease.publish({
      user: { name: "Right" },
      nodex: { view: "right" },
    });
    expect(runtime.runtime.awareness.getLocalState()).toMatchObject({
      user: { name: "Right" },
      nodex: {
        activeSurfaceId: second.awarenessLease.surfaceId,
        surfaceIds: [first.awarenessLease.surfaceId, second.awarenessLease.surfaceId].sort(),
      },
    });
    first.awarenessLease.release();
    expect(runtime.clearLocalAwareness).not.toHaveBeenCalled();
    expect(runtime.runtime.awareness.getLocalState()).toMatchObject({
      user: { name: "Right" },
      nodex: { surfaceIds: [second.awarenessLease.surfaceId] },
    });

    second.awarenessLease.release();
    expect(runtime.clearLocalAwareness).toHaveBeenCalledTimes(1);
    await registry.disposeAll();
  });

  test("keeps one model for a PageTab while durable head snapshots advance", () => {
    const registry = new DocumentSessionRegistry();
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const firstRuntime = createRuntime({});
    const createFirst = vi.fn(() => firstRuntime.runtime);
    const first = registry.acquire({
      key,
      descriptor: descriptor(1, 1),
      createRuntime: createFirst,
    });
    const second = registry.acquire({
      key,
      descriptor: descriptor(1, 2),
      createRuntime: () => {
        throw new Error("A head-only update must not replace the model");
      },
    });

    expect(second).toBe(first);
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  test("serializes generation replacement behind disposal of the old model", async () => {
    let releaseOldClose: () => void = () => undefined;
    const oldCloseBarrier = new Promise<void>((resolve) => {
      releaseOldClose = resolve;
    });
    const calls: string[] = [];
    const oldRuntime = createRuntime({
      close: async () => {
        calls.push("old-close-start");
        await oldCloseBarrier;
        calls.push("old-close-end");
      },
    });
    const nextRuntime = createRuntime({
      descriptor: descriptor(2),
      connect: async () => {
        calls.push("next-connect");
      },
    });
    const registry = new DocumentSessionRegistry();
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const oldSession = registry.acquire({
      key,
      descriptor: descriptor(1),
      createRuntime: () => oldRuntime.runtime,
    });
    await oldSession.connect();

    const nextSession = registry.acquire({
      key,
      descriptor: descriptor(2),
      createRuntime: () => nextRuntime.runtime,
    });
    const connecting = nextSession.connect();
    await vi.waitFor(() => {
      expect(calls).toEqual(["old-close-start"]);
    });
    releaseOldClose();
    await connecting;
    expect(calls).toEqual(["old-close-start", "old-close-end", "next-connect"]);
  });

  test("ignores stale view cleanup and backgrounds only the latest claim", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const session = registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const first = session.claimView();
    const second = session.claimView();
    session.awarenessLease.publish({ user: { name: "Active" } });

    expect(session.releaseView(first)).toBe(false);
    expect(runtime.clearLocalAwareness).not.toHaveBeenCalled();
    expect(runtime.persist).not.toHaveBeenCalled();

    session.releaseView(second);
    await Promise.resolve();
    expect(runtime.clearLocalAwareness).toHaveBeenCalledTimes(1);
    expect(runtime.persist).toHaveBeenCalledTimes(1);
  });

  test("can release an ephemeral preview view without an extra background persist", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const session = registry.acquire({
      key: makeEditorSurfaceKey("session-1", "preview-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    session.awarenessLease.publish({ user: { name: "Preview" } });

    const released = session.releaseView(session.claimView(), {
      persist: false,
    });
    await Promise.resolve();

    expect(released).toBe(true);
    expect(runtime.clearLocalAwareness).toHaveBeenCalledTimes(1);
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  test("flushes every ready retained model at the renderer close boundary", async () => {
    const registry = new DocumentSessionRegistry();
    const readyRuntime = createRuntime({});
    const connectingRuntime = createRuntime({ ready: false });
    registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => readyRuntime.runtime,
    });
    registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-2"),
      descriptor: {
        ...descriptor(),
        ownerBlockId: "page-2",
        documentId: "document-2",
      },
      createRuntime: () => connectingRuntime.runtime,
    });

    await registry.persistAll();

    expect(readyRuntime.persist).toHaveBeenCalledTimes(1);
    expect(connectingRuntime.persist).not.toHaveBeenCalled();
  });

  test("removes presence without persisting a model that has not synced yet", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({ ready: false });
    const session = registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    session.awarenessLease.publish({ user: { name: "Connecting" } });

    session.releaseView(session.claimView());
    await Promise.resolve();

    expect(runtime.clearLocalAwareness).toHaveBeenCalledTimes(1);
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  test("explicit close destroys a retained editor and runtime exactly once", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({});
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const session = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    const destroy = vi.fn();
    session.getOrCreateEditor("editor-1", () => ({ _tiptapEditor: { destroy } }));

    await Promise.all([registry.dispose(key), registry.dispose(key), session.dispose()]);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  test("does not wait for a stalled initial sync before closing the runtime", async () => {
    const registry = new DocumentSessionRegistry();
    const runtime = createRuntime({
      connect: () => new Promise<void>(() => undefined),
    });
    const key = makeEditorSurfaceKey("session-1", "tab-page-1");
    const session = registry.acquire({
      key,
      descriptor: descriptor(),
      createRuntime: () => runtime.runtime,
    });
    void session.connect().catch(() => undefined);
    await Promise.resolve();

    await registry.dispose(key);

    expect(runtime.connect).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  test("disposes every PageTab model owned by an archived ProjectSession", async () => {
    const registry = new DocumentSessionRegistry();
    const firstRuntime = createRuntime({});
    const secondRuntime = createRuntime({});
    const otherRuntime = createRuntime({});
    registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-1"),
      descriptor: descriptor(),
      createRuntime: () => firstRuntime.runtime,
    });
    registry.acquire({
      key: makeEditorSurfaceKey("session-1", "tab-page-2"),
      descriptor: {
        ...descriptor(),
        ownerBlockId: "page-2",
        documentId: "document-2",
      },
      createRuntime: () => secondRuntime.runtime,
    });
    registry.acquire({
      key: makeEditorSurfaceKey("session-2", "tab-page-1"),
      descriptor: {
        ...descriptor(),
        ownerBlockId: "page-3",
        documentId: "document-3",
      },
      createRuntime: () => otherRuntime.runtime,
    });

    await registry.disposeProjectSession("session-1");

    expect(firstRuntime.close).toHaveBeenCalledTimes(1);
    expect(secondRuntime.close).toHaveBeenCalledTimes(1);
    expect(otherRuntime.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });
});
