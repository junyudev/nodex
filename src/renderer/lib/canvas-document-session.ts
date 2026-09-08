import type {
  CanvasPresenceRealtimeEvent,
  PortableCanvasScene,
} from "../../shared/block-documents";
import type { CanvasSceneProvider } from "./canvas-scene-provider";
import { CanvasSceneStagedFileCatalog } from "./canvas-scene-binding";
import { observeCanvasContentIssues } from "./canvas-content-issues";
import {
  contentAccessIdentityKey,
  type ContentAccessIdentity,
} from "../../shared/content-access-context";

export interface CanvasDocumentSessionCallbacks {
  readonly onScene: (scene: PortableCanvasScene) => void;
  readonly onPresence: (event: CanvasPresenceRealtimeEvent) => void;
}

export interface CanvasDocumentSessionAcquireInput extends ContentAccessIdentity {
  readonly ownerBlockId: string;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly createProvider: (callbacks: CanvasDocumentSessionCallbacks) => CanvasSceneProvider;
}

export interface CanvasDocumentSessionLease {
  readonly provider: CanvasSceneProvider;
  readonly stagedFileCatalog: CanvasSceneStagedFileCatalog;
  connect(): Promise<void>;
  subscribeScene(listener: (scene: PortableCanvasScene) => void): () => void;
  subscribePresence(listener: (event: CanvasPresenceRealtimeEvent) => void): () => void;
  release(): Promise<void>;
}

export interface CanvasDocumentSessionRegistry {
  acquire(input: CanvasDocumentSessionAcquireInput): CanvasDocumentSessionLease;
  retireOwner(identity: ContentAccessIdentity, ownerBlockId: string): Promise<void>;
}

const sessionKey = (identity: ContentAccessIdentity, documentId: string): string =>
  JSON.stringify([contentAccessIdentityKey(identity), documentId]);

class DefaultCanvasDocumentSession {
  private readonly releaseIssues: () => void;
  readonly provider: CanvasSceneProvider;
  readonly stagedFileCatalog = new CanvasSceneStagedFileCatalog();

  private readonly sceneListeners = new Set<(scene: PortableCanvasScene) => void>();
  private readonly presenceListeners = new Set<(event: CanvasPresenceRealtimeEvent) => void>();
  private readonly presenceReplay: CanvasPresenceRealtimeEvent[] = [];
  private referenceCount = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private connectPromise: Promise<void> | null = null;
  private connected = false;

  constructor(
    readonly key: string,
    readonly accessIdentityKey: string,
    readonly ownerBlockId: string,
    readonly storeEpoch: string,
    readonly generation: number,
    private readonly connectBarrier: Promise<void>,
    createProvider: CanvasDocumentSessionAcquireInput["createProvider"],
    private readonly onLastRelease: (session: DefaultCanvasDocumentSession) => Promise<void>,
    scope: CanvasDocumentSessionAcquireInput,
  ) {
    this.provider = createProvider({
      onScene: (scene) => {
        for (const listener of this.sceneListeners) listener(scene);
      },
      onPresence: (event) => {
        if (event.type === "canvas_presence_snapshot") {
          this.presenceReplay.length = 0;
        }
        this.presenceReplay.push(event);
        if (this.presenceReplay.length > 128) this.presenceReplay.shift();
        for (const listener of this.presenceListeners) listener(event);
      },
    });
    this.releaseIssues = observeCanvasContentIssues(this.provider, scope);
  }

  isCompatible(input: CanvasDocumentSessionAcquireInput): boolean {
    return (
      !this.closing &&
      this.ownerBlockId === input.ownerBlockId &&
      this.storeEpoch === input.storeEpoch &&
      this.generation === input.generation
    );
  }

  acquire(): CanvasDocumentSessionLease {
    if (this.closing) {
      throw new Error("Canvas Document session is closing");
    }
    this.referenceCount += 1;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      this.referenceCount -= 1;
      if (this.referenceCount > 0) return;
      await this.onLastRelease(this);
    };

    return {
      provider: this.provider,
      stagedFileCatalog: this.stagedFileCatalog,
      connect: async () => {
        if (released) throw new Error("Canvas Document session lease is released");
        await this.connect();
      },
      subscribeScene: (listener) => {
        if (released) return () => undefined;
        this.sceneListeners.add(listener);
        const current = this.provider.getScene();
        if (current) listener(current);
        return () => this.sceneListeners.delete(listener);
      },
      subscribePresence: (listener) => {
        if (released) return () => undefined;
        this.presenceListeners.add(listener);
        for (const event of this.presenceReplay) listener(event);
        return () => this.presenceListeners.delete(listener);
      },
      release,
    };
  }

  beginClose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.sceneListeners.clear();
    this.presenceListeners.clear();
    this.presenceReplay.length = 0;
    this.closePromise = this.provider.close({ requireCommitted: false }).finally(() => {
      if (this.provider.getStatus().phase === "closed") this.releaseIssues();
    });
    return this.closePromise;
  }

  beginOwnerRetired(): Promise<void> {
    if (this.closePromise) {
      this.closePromise = this.closePromise
        .catch(() => undefined)
        .then(() => this.provider.retireOwner())
        .finally(() => {
          if (this.provider.getStatus().phase === "closed") this.releaseIssues();
        });
      return this.closePromise;
    }
    this.closing = true;
    this.sceneListeners.clear();
    this.presenceListeners.clear();
    this.presenceReplay.length = 0;
    this.closePromise = this.provider.retireOwner().finally(() => {
      if (this.provider.getStatus().phase === "closed") this.releaseIssues();
    });
    return this.closePromise;
  }

  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectBarrier
      .then(() => this.provider.connect())
      .then(() => {
        this.connected = true;
      })
      .finally(() => {
        if (this.connectPromise === promise) this.connectPromise = null;
      });
    this.connectPromise = promise;
    return promise;
  }
}

export const createCanvasDocumentSessionRegistry = (): CanvasDocumentSessionRegistry => {
  // A failed close still owns the only unprotected copy, independently of UI observation.
  const retainedSessions = new Set<DefaultCanvasDocumentSession>();
  const currentByKey = new Map<string, DefaultCanvasDocumentSession>();
  const closingByKey = new Map<string, Promise<void>>();

  const closeLastSession = async (session: DefaultCanvasDocumentSession): Promise<void> => {
    if (currentByKey.get(session.key) === session) {
      currentByKey.delete(session.key);
    }
    const closing = session.beginClose().finally(() => {
      if (session.provider.getStatus().phase === "closed") retainedSessions.delete(session);
      if (closingByKey.get(session.key) === closing) {
        closingByKey.delete(session.key);
      }
    });
    closingByKey.set(session.key, closing);
    await closing;
  };

  const retireSession = async (session: DefaultCanvasDocumentSession): Promise<void> => {
    if (currentByKey.get(session.key) === session) {
      currentByKey.delete(session.key);
    }
    const closing = session.beginOwnerRetired().finally(() => {
      if (session.provider.getStatus().phase === "closed") retainedSessions.delete(session);
      if (closingByKey.get(session.key) === closing) {
        closingByKey.delete(session.key);
      }
    });
    closingByKey.set(session.key, closing);
    await closing;
  };

  return {
    acquire(input) {
      const key = sessionKey(input, input.documentId);
      const current = currentByKey.get(key);
      if (current?.isCompatible(input)) return current.acquire();

      const predecessor = current
        ? closeLastSession(current).catch(() => undefined)
        : (closingByKey.get(key)?.catch(() => undefined) ?? Promise.resolve());
      const session = new DefaultCanvasDocumentSession(
        key,
        contentAccessIdentityKey(input),
        input.ownerBlockId,
        input.storeEpoch,
        input.generation,
        predecessor,
        input.createProvider,
        closeLastSession,
        input,
      );
      retainedSessions.add(session);
      currentByKey.set(key, session);
      return session.acquire();
    },
    async retireOwner(identity, ownerBlockId) {
      const accessKey = contentAccessIdentityKey(identity);
      const sessions = [...retainedSessions].filter(
        (session) =>
          session.accessIdentityKey === accessKey && session.ownerBlockId === ownerBlockId,
      );
      await Promise.all(sessions.map(retireSession));
    },
  };
};

export const canvasDocumentSessionRegistry = createCanvasDocumentSessionRegistry();
