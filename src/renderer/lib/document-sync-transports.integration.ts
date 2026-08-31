import { describe, expect, test } from "vite-plus/test";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncCommandResult,
  DocumentSyncRequest,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
  DocumentSyncSubscriptionAck,
  DocumentSyncUnsubscribeAck,
} from "../../shared/block-documents/document-sync";
import { documentSyncApplyCommandResult } from "../../shared/block-documents/document-sync";
import type {
  CanvasSceneMutationCommandResult,
  CanvasSceneMutationRequest,
  CanvasSceneSubscribeRequest,
  CanvasSceneSubscriptionCommandResult,
  CanvasSceneSyncCommandResult,
  CanvasSceneSyncRequest,
} from "../../shared/block-documents/canvas-scene-sync";
import { type DocumentSyncClientTarget } from "../../main/document-sync-transport";
import type { DesktopDocumentSyncScope } from "../../main/core-client/desktop-document-sync-bridge";
import { createElectronDocumentSyncAdapter } from "./electron-document-sync-adapter";
import type { ElectronRendererBridge } from "./electron-renderer-transport";
import { NodexYProvider } from "./nodex-y-provider";

const success = <T>(value: T): DocumentSyncCommandResult<T> => ({
  ok: true,
  value,
});

class MemoryDurableBackend {
  readonly document = new Y.Doc({ guid: "document-1" });
  readonly committed = new Map<string, DocumentSyncApplyAck>();
  headSeq = 0;

  sync = async (
    request: DocumentSyncRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncResponse>> =>
    success({
      documentId: request.documentId,
      storeEpoch: "store-1",
      generation: 1,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.document),
      update: Y.encodeStateAsUpdate(this.document, request.stateVector),
    });

  applyUpdate = async (
    request: DocumentSyncApplyRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>> => {
    const existing = this.committed.get(request.updateId);
    if (existing) {
      return success({ ...existing, headSeq: this.headSeq, duplicate: true });
    }
    Y.applyUpdate(this.document, request.update);
    this.headSeq += 1;
    const ack: DocumentSyncApplyAck = {
      documentId: request.documentId,
      storeEpoch: "store-1",
      generation: 1,
      updateId: request.updateId,
      committedSeq: this.headSeq,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.document),
      duplicate: false,
      status: "committed",
      commit: {
        store_epoch: "store-1",
        commit_seq: this.headSeq,
        manifest_hash: "f".repeat(64),
      },
    };
    this.committed.set(request.updateId, ack);
    return success(ack);
  };

  applyDocumentMutation = async () => {
    throw new Error("Document mutation is not exercised by this sync transport test");
  };

  destroy(): void {
    this.document.destroy();
  }
}

interface MemoryRealtimePort {
  subscribe(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncSubscribeRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncSubscriptionAck>>;
  unsubscribe(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncSubscribeRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncUnsubscribeAck>>;
  sync(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncResponse>>;
  applyUpdate(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncApplyRequest,
  ): Promise<DocumentSyncCommandResult<DocumentSyncApplyAck>>;
  publishAwareness(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentAwarenessPublishRequest,
  ): Promise<DocumentSyncCommandResult<DocumentAwarenessPublishAck>>;
  subscribeCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneSubscribeRequest,
  ): Promise<CanvasSceneSubscriptionCommandResult>;
  syncCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneSyncRequest,
  ): Promise<CanvasSceneSyncCommandResult>;
  applyCanvasSceneMutation(
    target: DocumentSyncClientTarget,
    request: CanvasSceneMutationRequest,
  ): Promise<CanvasSceneMutationCommandResult>;
}

class MemoryDocumentRealtime implements MemoryRealtimePort {
  private readonly subscriptions = new Map<
    number,
    {
      readonly scope: DesktopDocumentSyncScope;
      readonly target: DocumentSyncClientTarget;
      readonly request: DocumentSyncSubscribeRequest;
    }
  >();

  constructor(private readonly backend: MemoryDurableBackend) {}

  subscribe: MemoryRealtimePort["subscribe"] = async (scope, target, request) => {
    this.subscriptions.set(target.id, { scope, target, request });
    target.once("destroyed", () => this.subscriptions.delete(target.id));
    return success({ subscribed: true });
  };

  unsubscribe: MemoryRealtimePort["unsubscribe"] = async (_scope, target) => {
    this.subscriptions.delete(target.id);
    return success({ unsubscribed: true });
  };

  sync: MemoryRealtimePort["sync"] = async (_scope, _target, request) =>
    await this.backend.sync(request);

  applyUpdate: MemoryRealtimePort["applyUpdate"] = async (scope, _target, request) => {
    const result = await this.backend.applyUpdate(request);
    if (!result.ok || result.value.duplicate) return result;
    for (const subscription of this.subscriptions.values()) {
      if (
        JSON.stringify(subscription.scope) !== JSON.stringify(scope) ||
        subscription.request.documentId !== request.documentId
      ) {
        continue;
      }
      subscription.target.send("document-sync:event", {
        kind: "document-update",
        documentId: request.documentId,
        storeEpoch: result.value.storeEpoch,
        generation: result.value.generation,
        headSeq: result.value.headSeq,
        updateId: request.updateId,
        clientSessionId: request.clientSessionId,
        update: request.update,
      });
    }
    return result;
  };

  publishAwareness: MemoryRealtimePort["publishAwareness"] = async (
    scope,
    _target,
    request: DocumentAwarenessPublishRequest,
  ) => {
    for (const subscription of this.subscriptions.values()) {
      if (
        JSON.stringify(subscription.scope) !== JSON.stringify(scope) ||
        subscription.request.documentId !== request.documentId
      ) {
        continue;
      }
      subscription.target.send("document-sync:event", {
        kind: "awareness",
        documentId: request.documentId,
        storeEpoch: request.storeEpoch,
        generation: request.generation,
        clientSessionId: request.clientSessionId,
        update: request.update,
      });
    }
    return success({ accepted: true });
  };

  subscribeCanvasScene: MemoryRealtimePort["subscribeCanvasScene"] = async () => ({
    ok: false,
    error: {
      code: "unknown",
      message: "Canvas is outside this transport fixture",
      retryable: false,
      resetRequired: false,
    },
  });

  syncCanvasScene: MemoryRealtimePort["syncCanvasScene"] = async () => ({
    ok: false,
    error: {
      code: "unknown",
      message: "Canvas is outside this transport fixture",
      retryable: false,
      resetRequired: false,
    },
  });

  applyCanvasSceneMutation: MemoryRealtimePort["applyCanvasSceneMutation"] = async (
    _target,
    request,
  ) => ({
    ok: false,
    error: {
      code: "unknown",
      message: "Canvas is outside this transport fixture",
      retryable: false,
      resetRequired: false,
      mutationId: request.mutationId,
    },
  });
}

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Document transports did not settle");
};

class FakeElectronTarget extends EventEmitter implements DocumentSyncClientTarget {
  private destroyed = false;
  readonly bridgeListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly id: number,
    private readonly realtime: MemoryDocumentRealtime,
  ) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    this.bridgeListeners.get(channel)?.forEach((listener) => listener(...args));
  }

  invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const request = args[0] as DocumentSyncRequest;
    const scope = { kind: "project", projectId: "project-1" } as const;
    if (channel === "document-sync:subscribe") {
      return this.realtime.subscribe(scope, this, request);
    }
    if (channel === "document-sync:unsubscribe") {
      return this.realtime.unsubscribe(scope, this, request);
    }
    if (channel === "document-sync:sync") {
      return this.realtime.sync(scope, this, request);
    }
    if (channel === "document-sync:apply") {
      return documentSyncApplyCommandResult(
        await this.realtime.applyUpdate(
          scope,
          this,
          request as unknown as DocumentSyncApplyRequest,
        ),
      );
    }
    if (channel === "document-sync:awareness:publish") {
      return this.realtime.publishAwareness(scope, this, request as never);
    }
    throw new Error(`Unexpected channel: ${channel}`);
  };

  onBridge = (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    const listeners = this.bridgeListeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.bridgeListeners.set(channel, listeners);
    return () => listeners.delete(listener);
  };

  asBridge(): ElectronRendererBridge {
    return {
      invoke: this.invoke,
      on: this.onBridge,
    } as unknown as ElectronRendererBridge;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const runConcurrentEdit = async (
  createAdapter: (clientIndex: number) => ReturnType<typeof createElectronDocumentSyncAdapter>,
): Promise<{ readonly merged: string; readonly first: string; readonly second: string }> => {
  const firstDocument = new Y.Doc({ guid: "document-1" });
  const secondDocument = new Y.Doc({ guid: "document-1" });
  const first = new NodexYProvider({
    documentId: "document-1",
    document: firstDocument,
    adapter: createAdapter(1),
    clientSessionId: "client-1",
    autoConnect: false,
  });
  const second = new NodexYProvider({
    documentId: "document-1",
    document: secondDocument,
    adapter: createAdapter(2),
    clientSessionId: "client-2",
    autoConnect: false,
  });
  try {
    await Promise.all([first.connect(), second.connect()]);
    firstDocument.getText("title").insert(0, "A");
    secondDocument.getText("title").insert(0, "B");
    await Promise.all([first.flush(), second.flush()]);
    await waitUntil(() => first.getStatus().headSeq === 2 && second.getStatus().headSeq === 2);
    return {
      merged: firstDocument.getText("title").toString(),
      first: firstDocument.getText("title").toString(),
      second: secondDocument.getText("title").toString(),
    };
  } finally {
    first.destroy();
    second.destroy();
    firstDocument.destroy();
    secondDocument.destroy();
  }
};

describe("Document sync renderer IPC", () => {
  test("converges two independent Electron IPC provider surfaces", async () => {
    const backend = new MemoryDurableBackend();
    const realtime = new MemoryDocumentRealtime(backend);
    const targets = [new FakeElectronTarget(1, realtime), new FakeElectronTarget(2, realtime)];
    try {
      const result = await runConcurrentEdit((index) =>
        createElectronDocumentSyncAdapter(targets[index - 1]!.asBridge(), "project-1"),
      );
      expect(result.first).toBe(result.merged);
      expect(result.second).toBe(result.merged);
      expect(result.merged.length).toBe(2);
      expect(backend.document.getText("title").toString()).toBe(result.merged);
    } finally {
      targets.forEach((target) => target.destroy());
      backend.destroy();
    }
  });
});
