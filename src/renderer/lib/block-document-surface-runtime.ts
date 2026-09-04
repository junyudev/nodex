import * as Y from "yjs";
import { writeTextToClipboardStrict } from "./clipboard";
import type { Awareness } from "y-protocols/awareness";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import {
  getRegisteredBlockDocumentSchemaAdapter,
  inspectRegisteredOwnedBlockDocument,
  type OwnedDocumentEnvelope,
} from "../../shared/block-documents/document-schema-adapters";
import {
  createDefaultDocumentLocalCheckpointStore,
  type DocumentLocalCheckpointStore,
} from "./document-local-checkpoint";
import {
  NodexYProvider,
  type DocumentSyncAdapter,
  type NodexYProviderOptions,
  type NodexYProviderStatus,
} from "./nodex-y-provider";
import { BlockDocumentSurfaceError } from "./block-document-surface-failure";
import { parseContentAccessContext } from "../../shared/content-access-context";
import {
  DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
  assertDocumentWaitActive,
  waitForDocumentOperation,
  type DocumentWaitOptions,
} from "./document-wait";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export type BlockDocumentSurfacePhase =
  | "idle"
  | "connecting"
  | "ready"
  | "saving"
  | "offline"
  | "error"
  | "reset-required"
  | "closing"
  | "closed";

export interface BlockDocumentSurfaceStatus {
  readonly structuralWaitStartedAt: number | null;
  readonly phase: BlockDocumentSurfacePhase;
  readonly ready: boolean;
  readonly reloadRequired: boolean;
  readonly descriptor: OwnedDocumentDescriptor;
  readonly provider: NodexYProviderStatus;
  readonly error?: Error;
}

export type BlockDocumentSurfacePersistPreparer = () => void | Promise<void>;

export interface DocumentHeadFence {
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
}

/** Surface-scoped causal barrier for a structural mutation. */
export interface BlockDocumentMutationBarrier {
  readonly libraryId?: string;
  readonly flushAndFence: (options?: DocumentWaitOptions) => Promise<DocumentHeadFence>;
}

export interface BlockDocumentSurfaceCloseResult {
  readonly timedOut: boolean;
  readonly flush: "completed" | "failed" | "skipped" | "timed-out";
  readonly checkpoint: "completed" | "failed" | "isolated" | "timed-out";
}

export interface BlockDocumentSurfacePersistResult {
  readonly timedOut: boolean;
  readonly flush: "completed" | "failed" | "timed-out";
  readonly checkpoint: "completed" | "failed" | "timed-out";
}

export interface BlockDocumentSurfaceReloadContext {
  readonly descriptor: OwnedDocumentDescriptor;
  readonly reason: "fatal" | "reset-required";
  readonly error: Error;
}

export interface BlockDocumentSurfaceProvider {
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly clientSessionId: string;
  getStatus: () => NodexYProviderStatus;
  subscribeStatus: (listener: () => void) => () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  flush: (options?: DocumentWaitOptions) => Promise<void>;
  checkpoint: () => Promise<void>;
  isolate: NodexYProvider["isolate"];
  exportRecovery: NodexYProvider["exportRecovery"];
  destroy: () => void;
}

export type BlockDocumentSurfaceProviderFactory = (
  options: NodexYProviderOptions,
) => BlockDocumentSurfaceProvider;

export type BlockDocumentSurfaceDocumentFactory = (descriptor: OwnedDocumentDescriptor) => Y.Doc;

export type BlockDocumentSurfaceOpenDocument = (
  document: Y.Doc,
  descriptor: OwnedDocumentDescriptor,
) => OwnedDocumentEnvelope;

export type BlockDocumentSurfaceCloseTimeoutScheduler = (
  callback: () => void,
  timeoutMs: number,
) => () => void;

export interface BlockDocumentSurfaceRuntimeOptions {
  readonly descriptor: OwnedDocumentDescriptor;
  readonly adapter: DocumentSyncAdapter;
  readonly createDocument?: BlockDocumentSurfaceDocumentFactory;
  readonly createProvider?: BlockDocumentSurfaceProviderFactory;
  readonly openDocument?: BlockDocumentSurfaceOpenDocument;
  readonly localCheckpointStore?: DocumentLocalCheckpointStore | null;
  readonly closeTimeoutMs?: number;
  readonly scheduleCloseTimeout?: BlockDocumentSurfaceCloseTimeoutScheduler;
  readonly reload?: (context: BlockDocumentSurfaceReloadContext) => void | Promise<void>;
}

interface ReadyWaiter {
  readonly resolve: (document: OwnedDocumentEnvelope) => void;
  readonly reject: (error: Error) => void;
}

interface SurfaceTerminalState {
  readonly reason: "fatal" | "reset-required";
  readonly error: Error;
}

interface CloseTaskState {
  completed: boolean;
  failed: boolean;
}

const requirePositiveTimeout = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_CLOSE_TIMEOUT_MS;
  if (Number.isFinite(value) && value > 0) return value;
  throw new TypeError("closeTimeoutMs must be positive");
};

const validateDescriptor = (descriptor: OwnedDocumentDescriptor): OwnedDocumentDescriptor => {
  if (!descriptor.libraryId || descriptor.libraryId !== descriptor.libraryId.trim()) {
    throw new TypeError("Block Document descriptor has an invalid libraryId");
  }
  parseContentAccessContext(descriptor.accessContext);
  if (!descriptor.documentId || descriptor.documentId !== descriptor.documentId.trim()) {
    throw new TypeError("Block Document descriptor has an invalid documentId");
  }
  if (!descriptor.storeEpoch || descriptor.storeEpoch !== descriptor.storeEpoch.trim()) {
    throw new TypeError("Block Document descriptor has an invalid storeEpoch");
  }
  if (!Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1) {
    throw new TypeError("Block Document descriptor has an invalid generation");
  }
  if (descriptor.readiness !== "ready") {
    throw new TypeError("Block Document surface requires a ready Document");
  }
  if (descriptor.sync.kind !== "yjs") {
    throw new TypeError("Block Document surface requires the Yjs sync engine");
  }
  if (descriptor.ownerLifecycle !== "active") {
    throw new TypeError("Block Document surface requires an active owner");
  }
  const adapter = getRegisteredBlockDocumentSchemaAdapter({
    ownerType: descriptor.ownerType,
    schemaKey: descriptor.schemaKey,
    schemaVersion: descriptor.schemaVersion,
  });
  if (adapter.syncEngine !== "yjs") {
    throw new TypeError("Block Document schema is not registered for Yjs");
  }
  return descriptor;
};

const createEmptyDocument: BlockDocumentSurfaceDocumentFactory = (descriptor): Y.Doc =>
  new Y.Doc({ guid: descriptor.documentId });

const createProvider: BlockDocumentSurfaceProviderFactory = (
  options,
): BlockDocumentSurfaceProvider => new NodexYProvider(options);

const openValidatedOwnedDocument: BlockDocumentSurfaceOpenDocument = (
  document,
  descriptor,
): OwnedDocumentEnvelope =>
  inspectRegisteredOwnedBlockDocument(document, {
    ownerType: descriptor.ownerType,
    schemaKey: descriptor.schemaKey,
    schemaVersion: descriptor.schemaVersion,
  }).envelope;

const defaultCloseTimeoutScheduler: BlockDocumentSurfaceCloseTimeoutScheduler = (
  callback,
  timeoutMs,
): (() => void) => {
  const timeout = globalThis.setTimeout(callback, timeoutMs);
  return () => globalThis.clearTimeout(timeout);
};

const providerError = (status: NodexYProviderStatus): Error => {
  const message = status.error?.message ?? `Document provider entered ${status.phase}`;
  return new BlockDocumentSurfaceError(message, {
    syncError: status.error,
  });
};

const observeCloseTask = (task: Promise<void>, state: CloseTaskState): Promise<void> =>
  task.then(
    () => {
      state.completed = true;
    },
    () => {
      state.failed = true;
    },
  );

export class BlockDocumentSurfaceRuntime {
  private readonly structuralWaits = new Map<AbortController, number>();
  readonly descriptor: OwnedDocumentDescriptor;
  readonly document: Y.Doc;
  readonly provider: BlockDocumentSurfaceProvider;

  private readonly openDocument: BlockDocumentSurfaceOpenDocument;
  private readonly closeTimeoutMs: number;
  private readonly scheduleCloseTimeout: BlockDocumentSurfaceCloseTimeoutScheduler;
  private readonly reloadHandler?: BlockDocumentSurfaceRuntimeOptions["reload"];
  private readonly listeners = new Set<() => void>();
  private readonly persistPreparers = new Set<BlockDocumentSurfacePersistPreparer>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly unsubscribeProviderStatus: () => void;

  private readyDocument: OwnedDocumentEnvelope | null = null;
  private terminal: SurfaceTerminalState | null = null;
  private isolationPromise: Promise<void> | null = null;
  private connectPromise: Promise<void> | null = null;
  private persistPromise: Promise<BlockDocumentSurfacePersistResult> | null = null;
  private closePromise: Promise<BlockDocumentSurfaceCloseResult> | null = null;
  private reloadPromise: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private status: BlockDocumentSurfaceStatus;

  get libraryId(): string {
    return this.descriptor.libraryId;
  }

  constructor(options: BlockDocumentSurfaceRuntimeOptions) {
    this.descriptor = validateDescriptor(options.descriptor);
    this.openDocument = options.openDocument ?? openValidatedOwnedDocument;
    this.closeTimeoutMs = requirePositiveTimeout(options.closeTimeoutMs);
    this.scheduleCloseTimeout = options.scheduleCloseTimeout ?? defaultCloseTimeoutScheduler;
    this.reloadHandler = options.reload;

    const document = (options.createDocument ?? createEmptyDocument)(this.descriptor);
    if (document.guid !== this.descriptor.documentId) {
      document.destroy();
      throw new TypeError("Block Document factory returned a mismatched guid");
    }
    this.document = document;

    const checkpointDelegate =
      options.localCheckpointStore === undefined
        ? createDefaultDocumentLocalCheckpointStore()
        : options.localCheckpointStore;
    this.provider = (options.createProvider ?? createProvider)({
      documentId: this.descriptor.documentId,
      document: this.document,
      adapter: options.adapter,
      expectedStoreEpoch: this.descriptor.storeEpoch,
      expectedGeneration: this.descriptor.generation,
      autoConnect: false,
      localCheckpointStore: checkpointDelegate,
      documentSchema: {
        ownerType: this.descriptor.ownerType,
        schemaKey: this.descriptor.schemaKey,
        schemaVersion: this.descriptor.schemaVersion,
      },
    });
    if (this.provider.document !== this.document) {
      this.provider.destroy();
      this.document.destroy();
      throw new TypeError("Block Document provider does not own the surface Y.Doc");
    }

    this.status = this.buildStatus(this.provider.getStatus());
    this.unsubscribeProviderStatus = this.provider.subscribeStatus(this.handleProviderStatus);
    this.handleProviderStatus();
  }

  get clientSessionId(): string {
    return this.provider.clientSessionId;
  }

  get awareness(): Awareness {
    return this.provider.awareness;
  }

  getStatus = (): BlockDocumentSurfaceStatus => this.status;

  getReadyDocument = (): OwnedDocumentEnvelope | null => this.readyDocument;

  subscribe = (listener: () => void): (() => void) => {
    if (this.closed || this.closing) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  registerPersistPreparer = (preparer: BlockDocumentSurfacePersistPreparer): (() => void) => {
    if (this.closed || this.closing) return () => undefined;
    this.persistPreparers.add(preparer);
    return () => this.persistPreparers.delete(preparer);
  };

  connect = (): Promise<void> => {
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface is closed"));
    }
    if (this.terminal) {
      return Promise.reject(this.terminal.error);
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.provider
      .connect()
      .then(() => {
        this.handleProviderStatus();
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  };

  whenReady = (): Promise<OwnedDocumentEnvelope> => {
    if (this.readyDocument) return Promise.resolve(this.readyDocument);
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface closed before ready"));
    }
    return new Promise<OwnedDocumentEnvelope>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  };

  flush = (): Promise<void> => {
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface is closed"));
    }
    return this.provider.flush();
  };

  /**
   * Flushes the live Document to Core before an exact structural mutation.
   * Local checkpoints are recovery cache and deliberately stay off this
   * transaction-critical path.
   */
  private flushDurableUpdates = async (
    options: DocumentWaitOptions,
  ): Promise<BlockDocumentSurfaceStatus> => {
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface is closed"));
    }
    await waitForDocumentOperation(
      () =>
        Promise.all(
          [...this.persistPreparers].map((preparer) => Promise.resolve().then(() => preparer())),
        ),
      options,
    );
    assertDocumentWaitActive(options);
    await waitForDocumentOperation(() => this.provider.flush(options), options);
    return this.getStatus();
  };

  cancelStructuralWaits = (): void => {
    this.structuralWaits.forEach((_startedAt, controller) => controller.abort());
  };

  flushAndFence = async (input: DocumentWaitOptions = {}): Promise<DocumentHeadFence> => {
    const controller = new AbortController();
    const options = {
      deadlineAt: input.deadlineAt ?? Date.now() + DOCUMENT_STRUCTURAL_WAIT_TIMEOUT_MS,
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
    };
    this.structuralWaits.set(controller, Date.now());
    this.refreshStatus();
    try {
      const status = await this.flushDurableUpdates(options);
      assertDocumentWaitActive(options);
      return this.headFence(status);
    } finally {
      this.structuralWaits.delete(controller);
      this.refreshStatus();
    }
  };

  private headFence(status: BlockDocumentSurfaceStatus): DocumentHeadFence {
    const generation = status.provider.generation ?? status.descriptor.generation;
    const storeEpoch = status.provider.storeEpoch ?? status.descriptor.storeEpoch;
    if (
      status.provider.documentId !== status.descriptor.documentId ||
      !storeEpoch ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(status.provider.headSeq) ||
      status.provider.headSeq < 0
    ) {
      throw new BlockDocumentSurfaceError(
        "The Document did not expose a durable causal head after flush",
      );
    }
    return {
      documentId: status.descriptor.documentId,
      storeEpoch,
      generation,
      expectedHeadSeq: status.provider.headSeq,
    };
  }

  checkpoint = (): Promise<void> => {
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface is closed"));
    }
    return this.provider.checkpoint();
  };

  /**
   * Gives pending updates a bounded chance to reach SQLite while always
   * checkpointing the current local state. Unlike close(), this retains the
   * live provider so hidden Page tabs can keep converging in the background.
   */
  persist = (): Promise<BlockDocumentSurfacePersistResult> => {
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.closed || this.closing) {
      return Promise.reject(new Error("Block Document surface is closed"));
    }
    if (this.persistPromise) return this.persistPromise;

    const promise = this.persistOwnedDocument().finally(() => {
      if (this.persistPromise === promise) this.persistPromise = null;
    });
    this.persistPromise = promise;
    return promise;
  };

  /** Keep durable content sync alive while removing presence for a retained tab. */
  clearLocalAwareness = (): void => {
    if (this.closed || this.closing) return;
    this.provider.awareness.setLocalState(null);
  };

  copyDiagnostics = (): Promise<void> => {
    const status = this.provider.getStatus();
    return writeTextToClipboardStrict(
      JSON.stringify(
        {
          documentId: status.documentId,
          phase: status.phase,
          connected: status.connected,
          storeEpoch: status.storeEpoch,
          generation: status.generation,
          headSeq: status.headSeq,
          pendingUpdateCount: status.pendingUpdateCount,
          checkpoint: {
            phase: status.checkpoint.phase,
            localVersion: status.checkpoint.localVersion,
            protectedVersion: status.checkpoint.protectedVersion,
          },
          error: status.error && {
            code: status.error.code,
            retryable: status.error.retryable,
            coreCode: status.error.core?.code,
            recoveryKind: status.error.core?.recovery.kind,
            recoveryArtifactId: status.error.recoveryArtifactId,
          },
          recovery: status.recovery?.phase,
        },
        null,
        2,
      ),
    );
  };

  exportRecovery = async (): Promise<void> => {
    const data = await this.provider.exportRecovery();
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = `nodex-recovery-${this.descriptor.documentId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  reload = (): Promise<void> => {
    if (!this.terminal) {
      return Promise.reject(new Error("Block Document surface does not require reload"));
    }
    if (this.reloadPromise) return this.reloadPromise;

    const terminal = this.terminal;
    this.reloadPromise = (async () => {
      await this.isolateCheckpoints();
      const closed = await this.close();
      if (closed.checkpoint === "failed" || closed.checkpoint === "timed-out")
        throw new Error("Export recovery before reloading this document");
      await this.reloadHandler?.({
        descriptor: this.descriptor,
        reason: terminal.reason,
        error: terminal.error,
      });
    })().catch((error: unknown) => {
      this.reloadPromise = null;
      throw error;
    });
    return this.reloadPromise;
  };

  close = (): Promise<BlockDocumentSurfaceCloseResult> => {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelStructuralWaits();
    this.refreshStatus();
    this.rejectReadyWaiters(
      this.terminal?.error ?? new Error("Block Document surface closed before ready"),
    );
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  };

  private readonly handleProviderStatus = (): void => {
    if (this.closed || this.closing) return;
    if (this.terminal) {
      this.refreshStatus();
      return;
    }
    const providerStatus = this.provider.getStatus();
    if (providerStatus.phase === "reset-required") {
      this.enterTerminal("reset-required", providerError(providerStatus));
      return;
    }
    if (providerStatus.phase === "error") {
      this.enterTerminal("fatal", providerError(providerStatus));
      return;
    }
    if (providerStatus.phase === "destroyed") {
      this.enterTerminal("fatal", new Error("Block Document provider was destroyed unexpectedly"));
      return;
    }
    if (providerStatus.phase === "synced" && !this.readyDocument) {
      try {
        this.readyDocument = this.openDocument(this.document, this.descriptor);
        this.resolveReadyWaiters(this.readyDocument);
      } catch (error) {
        this.enterTerminal("fatal", error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    this.refreshStatus();
  };

  private enterTerminal(reason: SurfaceTerminalState["reason"], error: Error): void {
    if (this.terminal || this.closed || this.closing) return;
    this.terminal = { reason, error };
    this.cancelStructuralWaits();
    this.readyDocument = null;
    this.provider.isolate({
      code: "invalid_response",
      message: error.message,
      retryable: false,
      resetRequired: false,
    });
    this.provider.disconnect();
    void this.isolateCheckpoints().catch(() => undefined);
    this.rejectReadyWaiters(error);
    this.refreshStatus();
  }

  private isolateCheckpoints(): Promise<void> {
    if (!this.isolationPromise) {
      this.isolationPromise = this.provider.checkpoint().catch((error: unknown) => {
        this.isolationPromise = null;
        throw error;
      });
    }
    return this.isolationPromise;
  }

  private async closeOwnedResources(): Promise<BlockDocumentSurfaceCloseResult> {
    const terminal = this.terminal;
    const checkpointState: CloseTaskState = { completed: false, failed: false };
    const terminalTimedOut = terminal
      ? await this.waitForCloseTasks(observeCloseTask(this.isolateCheckpoints(), checkpointState))
      : false;
    const persisted = terminal ? null : await (this.persistPromise ?? this.persistOwnedDocument());

    if (terminal && (terminalTimedOut || checkpointState.failed)) {
      this.closing = false;
      this.closePromise = null;
      this.refreshStatus();
      return {
        timedOut: terminalTimedOut,
        flush: "skipped",
        checkpoint: terminalTimedOut ? "timed-out" : "failed",
      };
    }
    const providerStatus = this.provider.getStatus();
    const checkpoint = providerStatus.checkpoint;
    const protectedLocally =
      persisted?.checkpoint === "completed" &&
      checkpoint.phase === "ready" &&
      checkpoint.localVersion !== undefined &&
      checkpoint.protectedVersion !== undefined &&
      checkpoint.protectedVersion >= checkpoint.localVersion;
    if (
      persisted &&
      persisted.flush !== "completed" &&
      !protectedLocally &&
      providerStatus.pendingUpdateCount > 0
    ) {
      this.closing = false;
      this.closePromise = null;
      this.refreshStatus();
      return persisted;
    }
    this.unsubscribeProviderStatus();
    try {
      this.provider.destroy();
    } catch {
      // Ownership cleanup continues; the Y.Doc must never outlive close.
    } finally {
      this.document.destroy();
      this.closed = true;
      this.closing = false;
      this.refreshStatus();
      this.persistPreparers.clear();
      this.listeners.clear();
    }

    return {
      timedOut: persisted?.timedOut ?? terminalTimedOut,
      flush: terminal ? "skipped" : (persisted?.flush ?? "failed"),
      checkpoint: terminal
        ? terminalTimedOut && !checkpointState.completed && !checkpointState.failed
          ? "timed-out"
          : checkpointState.failed
            ? "failed"
            : "isolated"
        : (persisted?.checkpoint ?? "failed"),
    };
  }

  private async persistOwnedDocument(): Promise<BlockDocumentSurfacePersistResult> {
    const flushState: CloseTaskState = { completed: false, failed: false };
    const checkpointState: CloseTaskState = { completed: false, failed: false };
    const prepare = Promise.all(
      [...this.persistPreparers].map((preparer) => Promise.resolve().then(() => preparer())),
    );
    const tasks = [
      observeCloseTask(
        prepare.then(() => this.provider.flush()),
        flushState,
      ),
      observeCloseTask(
        prepare.then(() => this.provider.checkpoint()),
        checkpointState,
      ),
    ];
    const timedOut = await this.waitForCloseTasks(Promise.all(tasks));
    return {
      timedOut,
      flush:
        timedOut && !flushState.completed && !flushState.failed
          ? "timed-out"
          : flushState.failed
            ? "failed"
            : "completed",
      checkpoint:
        timedOut && !checkpointState.completed && !checkpointState.failed
          ? "timed-out"
          : checkpointState.failed
            ? "failed"
            : "completed",
    };
  }

  private waitForCloseTasks(tasks: Promise<unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cancelTimeout = this.scheduleCloseTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      }, this.closeTimeoutMs);
      void tasks.then(
        () => {
          if (settled) return;
          settled = true;
          cancelTimeout();
          resolve(false);
        },
        () => {
          if (settled) return;
          settled = true;
          cancelTimeout();
          resolve(false);
        },
      );
    });
  }

  private resolveReadyWaiters(document: OwnedDocumentEnvelope): void {
    for (const waiter of this.readyWaiters) waiter.resolve(document);
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private buildStatus(provider: NodexYProviderStatus): BlockDocumentSurfaceStatus {
    let phase: BlockDocumentSurfacePhase;
    if (this.closed) {
      phase = "closed";
    } else if (this.closing) {
      phase = "closing";
    } else if (this.terminal?.reason === "reset-required") {
      phase = "reset-required";
    } else if (this.terminal) {
      phase = "error";
    } else if (provider.phase === "synced" && this.readyDocument) {
      phase = "ready";
    } else if (provider.phase === "saving") {
      phase = "saving";
    } else if (provider.phase === "offline") {
      phase = "offline";
    } else if (provider.phase === "connecting") {
      phase = "connecting";
    } else {
      phase = "idle";
    }
    return {
      phase,
      structuralWaitStartedAt:
        this.structuralWaits.size === 0 ? null : Math.min(...this.structuralWaits.values()),
      ready: this.readyDocument !== null && !this.terminal && !this.closed && !this.closing,
      reloadRequired: this.terminal !== null,
      descriptor: this.descriptor,
      provider,
      error: this.terminal?.error,
    };
  }

  private refreshStatus(): void {
    this.status = this.buildStatus(this.provider.getStatus());
    for (const listener of this.listeners) listener();
  }
}
