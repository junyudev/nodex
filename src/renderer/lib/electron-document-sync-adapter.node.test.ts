import { describe, expect, test } from "vite-plus/test";
import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import { createCoreLocalCommitFixture } from "../../main/core-client/testing/local-commit-fixture";
import { createElectronDocumentSyncAdapter } from "./electron-document-sync-adapter";
import type { ElectronRendererBridge } from "./electron-renderer-transport";
import { rendererLocalCommitIngress } from "./local-commit-ingress";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

class FakeBridge {
  readonly calls: Array<{ readonly channel: string; readonly args: unknown[] }> = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly subscription = deferred<unknown>();
  applyResult: unknown = null;

  invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    this.calls.push({ channel, args });
    if (channel === "document-sync:subscribe") {
      return this.subscription.promise;
    }
    if (channel === "document-sync:sync") {
      return {
        ok: true,
        value: {
          documentId: "doc-1",
          storeEpoch: "epoch-1",
          generation: 1,
          headSeq: 0,
          stateVector: new Uint8Array([0]),
          update: new Uint8Array([0]),
        },
      };
    }
    if (channel === "document-sync:unsubscribe") {
      return { ok: true, value: { unsubscribed: true } };
    }
    if (channel === "document-sync:apply" && this.applyResult) {
      return this.applyResult;
    }
    return {
      ok: false,
      error: {
        code: "unknown",
        message: "unexpected command",
        retryable: false,
        resetRequired: false,
      },
    };
  };

  on = (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    const active = this.listeners.get(event) ?? new Set();
    active.add(callback);
    this.listeners.set(event, active);
    return () => active.delete(callback);
  };

  emit(event: string, value: unknown): void {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }
}

describe("createElectronDocumentSyncAdapter", () => {
  test("admits a committed delivery before resolving the document ACK", async () => {
    const bridge = new FakeBridge();
    const delivery = createCoreLocalCommitFixture({
      authorizationScope: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-1",
      },
      commitSeq: 91,
      payload: {
        module: "library",
        library_id: "library-1",
        event: {
          kind: "library_changed",
          database_ids: [],
          file_revisions: {},
          page_file_manifest_invalidations: {},
          page_file_body_usage_revisions: {},
          page_file_content_invalidations: {},
          page_ids: [],
          parent_keys: [],
          view_ids: [],
        },
      },
    });
    bridge.applyResult = {
      ok: true,
      value: {
        documentId: "doc-1",
        storeEpoch: "epoch-1",
        generation: 1,
        updateId: "update-1",
        committedSeq: 91,
        headSeq: 1,
        stateVector: new Uint8Array([0]),
        duplicate: false,
        status: "committed",
        commit: delivery.manifest.identity,
        delivery,
      },
      localCommit: {
        status: "committed",
        commit: delivery.manifest.identity,
        delivery,
      },
    };
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    adapter.subscribe({ documentId: "doc-1", clientSessionId: "session-1" }, () => undefined);
    bridge.subscription.resolve({ ok: true, value: { subscribed: true } });
    const order: string[] = [];
    const release = rendererLocalCommitIngress.subscribeAtoms(() => order.push("admitted"));

    await adapter
      .applyUpdate({
        documentId: "doc-1",
        storeEpoch: "epoch-1",
        generation: 1,
        updateId: "update-1",
        clientSessionId: "session-1",
        baseHeadSeq: 0,
        touchedBlockIds: [],
        update: new Uint8Array([1]),
      })
      .then(() => order.push("resolved"));

    expect(order).toEqual(["admitted", "resolved"]);
    release();
  });

  test("installs realtime listening and awaits subscribe before state-vector sync", async () => {
    const bridge = new FakeBridge();
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    const events: DocumentSyncRealtimeEvent[] = [];
    const unsubscribe = adapter.subscribe(
      { documentId: "doc-1", clientSessionId: "session-1" },
      (event) => events.push(event),
    );
    const syncing = adapter.sync({
      documentId: "doc-1",
      clientSessionId: "session-1",
      stateVector: new Uint8Array([0]),
    });
    await Promise.resolve();
    expect(bridge.calls.map((call) => call.channel).join(",")).toBe("document-sync:subscribe");

    bridge.emit("document-sync:event", {
      kind: "connection",
      documentId: "doc-1",
      clientSessionId: "session-1",
      state: "connected",
    });
    expect(events.length).toBe(1);
    bridge.subscription.resolve({ ok: true, value: { subscribed: true } });
    const result = await syncing;
    expect(result.ok).toBe(true);
    expect(bridge.calls.map((call) => call.channel).join(",")).toBe(
      "document-sync:subscribe,document-sync:sync",
    );

    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.calls.map((call) => call.channel).join(",")).toBe(
      "document-sync:subscribe,document-sync:sync,document-sync:unsubscribe",
    );
    expect(
      bridge.calls.every(
        (call) => (call.args[0] as { readonly projectId?: string }).projectId === "project-1",
      ),
    ).toBe(true);
  });

  test("revives an exact session without a stale unsubscribe crossing the replacement", async () => {
    const bridge = new FakeBridge();
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    const request = {
      documentId: "doc-1",
      clientSessionId: "session-1",
    } as const;
    const listener = () => undefined;
    const closeFirst = adapter.subscribe(request, listener);
    closeFirst();
    const closeSecond = adapter.subscribe(request, listener);

    bridge.subscription.resolve({ ok: true, value: { subscribed: true } });
    await expect(
      adapter.sync({
        ...request,
        stateVector: new Uint8Array([0]),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(bridge.calls.map((call) => call.channel)).toEqual([
      "document-sync:subscribe",
      "document-sync:sync",
    ]);

    closeSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.calls.at(-1)?.channel).toBe("document-sync:unsubscribe");
  });

  test("routes binary events only to matching document subscribers", () => {
    const bridge = new FakeBridge();
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    const events: DocumentSyncRealtimeEvent[] = [];
    const otherSessionEvents: DocumentSyncRealtimeEvent[] = [];
    adapter.subscribe({ documentId: "doc-1", clientSessionId: "session-1" }, (event) =>
      events.push(event),
    );
    adapter.subscribe({ documentId: "doc-1", clientSessionId: "session-2" }, (event) =>
      otherSessionEvents.push(event),
    );

    bridge.emit("document-sync:event", {
      kind: "connection",
      documentId: "doc-1",
      clientSessionId: "session-1",
      state: "connected",
    });
    bridge.emit("document-sync:event", {
      kind: "document-update",
      documentId: "doc-2",
      storeEpoch: "epoch-1",
      generation: 1,
      headSeq: 1,
      updateId: "update-other",
      clientSessionId: "session-2",
      update: new Uint8Array([9]),
    });
    bridge.emit("document-sync:event", {
      kind: "document-update",
      documentId: "doc-1",
      storeEpoch: "epoch-1",
      generation: 1,
      headSeq: 1,
      updateId: "update-1",
      clientSessionId: "session-2",
      update: new Uint8Array([4, 5]),
    });
    bridge.emit("document-sync:event", {
      kind: "store-reset",
      documentId: "doc-1",
      storeEpoch: "epoch-restored",
    });

    expect(events.length).toBe(3);
    expect(otherSessionEvents).toHaveLength(2);
    const event = events[1];
    expect(event?.kind).toBe("document-update");
    if (event?.kind === "document-update") {
      expect(Array.from(event.update).join(",")).toBe("4,5");
    }
    expect(events[2]?.kind).toBe("store-reset");
  });

  test("returns typed subscription errors without parsing Error messages", async () => {
    const bridge = new FakeBridge();
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    adapter.subscribe({ documentId: "doc-1", clientSessionId: "session-1" }, () => undefined);
    bridge.subscription.resolve({
      ok: false,
      error: {
        code: "store_not_initialized",
        message: "backend booting",
        retryable: true,
        resetRequired: false,
      },
    });

    const result = await adapter.sync({
      documentId: "doc-1",
      clientSessionId: "session-1",
      stateVector: new Uint8Array([0]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("store_not_initialized");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("preserves protected-owner mutation recovery across Electron IPC", async () => {
    const bridge = new FakeBridge();
    bridge.applyResult = {
      ok: false,
      error: {
        code: "protected_owner_mutation",
        message: "Typed owner Page cannot contain child Blocks",
        retryable: false,
        resetRequired: true,
      },
    };
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    adapter.subscribe({ documentId: "doc-1", clientSessionId: "session-1" }, () => undefined);
    bridge.subscription.resolve({ ok: true, value: { subscribed: true } });

    await expect(
      adapter.applyUpdate({
        documentId: "doc-1",
        storeEpoch: "epoch-1",
        generation: 1,
        updateId: "update-owner-guard",
        clientSessionId: "session-1",
        baseHeadSeq: 0,
        touchedBlockIds: ["page-1"],
        update: new Uint8Array([1]),
      }),
    ).resolves.toEqual(bridge.applyResult);
  });
});

test.each(["opening", "open"])(
  "does not send queued document commands after release while %s",
  async (phase) => {
    const bridge = new FakeBridge();
    const adapter = createElectronDocumentSyncAdapter(
      bridge as unknown as ElectronRendererBridge,
      "project-1",
    );
    const request = { documentId: "doc-1", clientSessionId: "session-1" };
    const release = adapter.subscribe(request, () => undefined);
    if (phase === "open") {
      bridge.subscription.resolve({ ok: true, value: { subscribed: true } });
      await adapter.sync({ ...request, stateVector: new Uint8Array([0]) });
      bridge.calls.length = 0;
    }
    const boundary = {
      ...request,
      storeEpoch: "epoch-1",
      generation: 1,
      update: new Uint8Array([0]),
    };
    const commands = [
      adapter.sync({ ...request, stateVector: new Uint8Array([0]) }),
      adapter.applyUpdate({
        ...boundary,
        baseHeadSeq: 0,
        updateId: "update-1",
        touchedBlockIds: [],
      }),
      adapter.publishAwareness(boundary),
    ];
    release();
    bridge.subscription.resolve({ ok: true, value: { subscribed: true } });
    for (const result of await Promise.all(commands)) expect(result).toMatchObject({ ok: false });
    expect(
      bridge.calls.filter(
        ({ channel }) => !channel.endsWith(":subscribe") && !channel.endsWith(":unsubscribe"),
      ),
    ).toEqual([]);
  },
);
