import type { ReadyRegisteredOwnedBlockDocumentDescriptor } from "./owned-block-document";
import type { CanvasLocalSceneObservation, CanvasSceneBinding } from "./canvas-scene-binding";
import type { CanvasBinaryFileResolver } from "./canvas-assets";
import type { CanvasSceneProvider, CanvasSceneSubmission } from "./canvas-scene-provider";
import type { CanvasPresenceController } from "./canvas-presence-controller";

export interface CanvasSceneSurfaceRuntime {
  readonly key: string;
  readonly descriptor: ReadyRegisteredOwnedBlockDocumentDescriptor;
  isClosed(): boolean;
  connect(): Promise<void>;
  submitLocalScene(observation: CanvasLocalSceneObservation): CanvasSceneSubmission;
  persistDurable(): Promise<void>;
  flushCommitted(): Promise<void>;
  close(): Promise<void>;
}

export interface CanvasSceneSurfaceAcquireInput {
  readonly key: string;
  readonly descriptor: ReadyRegisteredOwnedBlockDocumentDescriptor;
  readonly provider: CanvasSceneProvider;
  readonly connectDocumentSession?: () => Promise<void>;
  readonly presence: CanvasPresenceController;
  readonly binding: CanvasSceneBinding;
  readonly fileResolver: CanvasBinaryFileResolver;
  readonly releaseDocumentSession?: () => Promise<void>;
  readonly maintainIfIdle?: () => Promise<void>;
  readonly disposeSubscriptions: () => void;
}

export interface CanvasSceneSurfaceRegistry {
  acquire(input: CanvasSceneSurfaceAcquireInput): CanvasSceneSurfaceRuntime;
  release(key: string, expected: CanvasSceneSurfaceRuntime): Promise<void>;
  dispose(key: string): Promise<void>;
  flushOwnerCommitted(ownerBlockId: string): Promise<void>;
  persistAllDurable(): Promise<void>;
  flushAllCommitted(): Promise<void>;
}

export const makeCanvasSceneSurfaceKey = (
  windowSessionId: string,
  projectSessionId: string,
  tabId: string,
): string => JSON.stringify([windowSessionId, projectSessionId, tabId]);

class DefaultCanvasSceneSurfaceRuntime implements CanvasSceneSurfaceRuntime {
  readonly key: string;
  readonly descriptor: ReadyRegisteredOwnedBlockDocumentDescriptor;

  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    input: CanvasSceneSurfaceAcquireInput,
    private readonly connectBarrier: Promise<void>,
  ) {
    this.key = input.key;
    this.descriptor = input.descriptor;
    this.provider = input.provider;
    this.connectDocumentSession = input.connectDocumentSession;
    this.presence = input.presence;
    this.binding = input.binding;
    this.fileResolver = input.fileResolver;
    this.releaseDocumentSession = input.releaseDocumentSession;
    this.maintainIfIdle = input.maintainIfIdle;
    this.disposeSubscriptions = input.disposeSubscriptions;
  }

  private readonly provider: CanvasSceneProvider;
  private readonly connectDocumentSession: (() => Promise<void>) | undefined;
  private readonly presence: CanvasPresenceController;
  private readonly binding: CanvasSceneBinding;
  private readonly fileResolver: CanvasBinaryFileResolver;
  private readonly releaseDocumentSession: (() => Promise<void>) | undefined;
  private readonly maintainIfIdle: (() => Promise<void>) | undefined;
  private readonly disposeSubscriptions: () => void;

  isClosed = (): boolean => this.closed;

  connect = async (): Promise<void> => {
    if (this.closed) throw new Error("Canvas scene surface runtime is closed");
    await this.connectBarrier;
    await (this.connectDocumentSession ? this.connectDocumentSession() : this.provider.connect());
  };

  submitLocalScene = (observation: CanvasLocalSceneObservation): CanvasSceneSubmission => {
    if (!this.closed) return this.binding.submitLocalScene(observation);
    const error = new Error("Canvas scene surface runtime is closed");
    const durable = Promise.reject(error);
    const committed = Promise.reject(error);
    void durable.catch(() => undefined);
    void committed.catch(() => undefined);
    return { durable, committed };
  };

  persistDurable = (): Promise<void> => this.binding.persistDurable();

  flushCommitted = (): Promise<void> => this.binding.flushCommitted();

  close = (): Promise<void> => {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    const promise = this.closeInternal().finally(() => {
      if (this.closePromise === promise) this.closePromise = null;
    });
    this.closePromise = promise;
    return promise;
  };

  private async closeInternal(): Promise<void> {
    let firstError: unknown = null;
    try {
      await this.binding.persistDurable();
    } catch (error) {
      await this.provider.checkpointRecovery();
      firstError = error;
    }
    this.closed = true;
    const run = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    const status = this.provider.getStatus();
    if (
      this.maintainIfIdle &&
      status.phase === "ready" &&
      status.connected &&
      status.pendingMutationCount === 0 &&
      !status.writeFrozen
    ) {
      await this.maintainIfIdle().catch(() => undefined);
    }
    await run(() => this.presence.close());
    await run(() =>
      this.releaseDocumentSession
        ? this.releaseDocumentSession()
        : this.provider.close({ requireCommitted: false }),
    );
    await run(() => this.disposeSubscriptions());
    await run(() => this.fileResolver.destroy());
    await run(() => this.binding.destroy());

    if (firstError) throw firstError;
  }
}

export const createCanvasSceneSurfaceRegistry = (): CanvasSceneSurfaceRegistry => {
  const currentByKey = new Map<string, CanvasSceneSurfaceRuntime>();
  const activeOrClosing = new Set<CanvasSceneSurfaceRuntime>();

  const forgetSettled = (key: string, runtime: CanvasSceneSurfaceRuntime): void => {
    activeOrClosing.delete(runtime);
    if (currentByKey.get(key) === runtime) currentByKey.delete(key);
  };

  const release = async (key: string, expected: CanvasSceneSurfaceRuntime): Promise<void> => {
    try {
      await expected.close();
    } finally {
      // A failed durability barrier may leave this runtime holding the only draft.
      if (expected.isClosed()) forgetSettled(key, expected);
    }
  };

  return {
    acquire(input) {
      const predecessor = currentByKey.get(input.key);
      const connectBarrier = predecessor
        ? release(input.key, predecessor).catch((error: unknown) => {
            if (!predecessor.isClosed()) throw error;
          })
        : Promise.resolve();
      void connectBarrier.catch(() => undefined);
      const runtime = new DefaultCanvasSceneSurfaceRuntime(input, connectBarrier);
      currentByKey.set(input.key, runtime);
      activeOrClosing.add(runtime);
      return runtime;
    },
    release,
    async dispose(key) {
      const runtime = currentByKey.get(key);
      if (!runtime) return;
      await release(key, runtime);
    },
    async flushOwnerCommitted(ownerBlockId) {
      for (const runtime of activeOrClosing) {
        if (runtime.descriptor.ownerBlockId !== ownerBlockId) continue;
        await runtime.flushCommitted();
      }
    },
    async persistAllDurable() {
      await Promise.all([...activeOrClosing].map((runtime) => runtime.persistDurable()));
    },
    async flushAllCommitted() {
      await Promise.all([...activeOrClosing].map((runtime) => runtime.flushCommitted()));
    },
  };
};

export const canvasSceneSurfaceRegistry = createCanvasSceneSurfaceRegistry();
