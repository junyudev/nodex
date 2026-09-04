import type * as Y from "yjs";
import type { SurfaceHistorySelectionPair } from "@blocknote/core/yjs";
import type { BlockHistoryPatch } from "../../../../shared/block-documents/block-history-patch";
import {
  MAX_STRUCTURAL_HISTORY_RECONCILIATION_TOKENS,
  type LibraryStructuralHistoryToken,
} from "../../../../shared/library-module";
import type { SurfaceHistoryDirection } from "../../../../shared/surface-history";
import {
  createSurfaceHistory,
  type HistoryCommandHandle,
  type HistoryCommandOutcome,
  type HistoryPreparation,
  type HistoryReceiptInterpretation,
  type SurfaceHistory,
} from "../../../lib/surface-history/owner";
import type { NfmTextHistoryJournal } from "./nfm-text-history-journal";
import { promotionRetentionResources } from "../../../lib/surface-history/structural-resources";
import type { NfmHistoryReconciliationSnapshot } from "./nfm-history-reconciliation";
import {
  nfmCommandLabel,
  type NfmHistoryCommand,
  type NfmHistoryInverse,
  type NfmHistoryReceipt,
  type NfmHistoryRequest,
} from "./nfm-history-command";

type YStackItem = Y.UndoManager["undoStack"][number];
interface StackItemEvent {
  readonly stackItem: YStackItem;
  readonly type: "undo" | "redo";
  readonly origin?: unknown;
  readonly changedParentTypes: Y.Transaction["changedParentTypes"];
}
type CaptureIntent = { readonly kind: "native_capture" };
type Owner = SurfaceHistory<
  NfmHistoryCommand | CaptureIntent,
  NfmHistoryReceipt,
  NfmHistoryInverse
>;
export interface NfmHistoryLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxQueued: number;
  readonly maxRetainedIdentities: number;
}
const DEFAULT_LIMITS: NfmHistoryLimits = {
  maxEntries: 500,
  maxBytes: 64 * 1024 * 1024,
  maxQueued: 100,
  maxRetainedIdentities: 10_000,
};
export interface NfmHistoryLaneOptions {
  readonly limits?: Partial<NfmHistoryLimits>;
  readonly undoManager?: Y.UndoManager | null;
  readonly textHistory?: NfmTextHistoryJournal;
  readonly textSelection?: (item: YStackItem) => SurfaceHistorySelectionPair | undefined;
  readonly prepareCommand?: (
    command: NfmHistoryCommand,
  ) => Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>>;
  readonly prepareTextReverse?: (
    patch: BlockHistoryPatch,
    selection?: SurfaceHistorySelectionPair,
  ) => Promise<NfmHistoryRequest>;
  readonly prepareStructuralReverse?: (
    token: LibraryStructuralHistoryToken,
    selection?: SurfaceHistorySelectionPair,
  ) => Promise<NfmHistoryRequest>;
  readonly submit?: (
    request: NfmHistoryRequest,
  ) => Promise<HistoryCommandOutcome<NfmHistoryReceipt>>;
  readonly releaseStructural?: (tokens: readonly LibraryStructuralHistoryToken[]) => Promise<void>;
  readonly abandonCommand?: (request: NfmHistoryRequest) => Promise<void>;
  readonly reconcileStructural?: (
    tokens: readonly LibraryStructuralHistoryToken[],
  ) => Promise<NfmHistoryReconciliationSnapshot>;
  readonly onCommitted?: (receipt: NfmHistoryReceipt) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}
type Handlers = Omit<
  NfmHistoryLaneOptions,
  "undoManager" | "textHistory" | "textSelection" | "limits"
>;
interface NativeCapture {
  readonly item: YStackItem;
  entryId?: number;
}
type StructuralInverse = Extract<NfmHistoryInverse, { kind: "structural" }>;
interface IndexedEntry {
  readonly lane: NfmHistoryLane;
  readonly entryId: number;
  readonly inverse: StructuralInverse;
}
const structuralEntries = new Map<string, IndexedEntry>();
const tokenKey = (token: LibraryStructuralHistoryToken) =>
  `${token.storeEpoch}\0${token.recipeOperationId}`;

/** Content Adapter for one NFM surface. Chronology and exact attempts belong to SurfaceHistory. */
export class NfmHistoryLane {
  private readonly owner: Owner;
  private readonly captures = new Map<number, NativeCapture>();
  private readonly captureIds = new WeakMap<YStackItem, number>();
  private nextCaptureId = 0;
  private readonly nativeWeights = new WeakMap<
    YStackItem,
    { updates: number; semanticPeak: number }
  >();
  private readonly capturedTransactions = new WeakMap<
    Y.Transaction["changedParentTypes"],
    YStackItem
  >();
  private readonly indexedKeys = new Set<string>();
  private readonly presentations = new Set<Promise<void>>();
  private readonly unsubscribeOwner: () => void;
  private localCompletion: number[] | null = null;
  private replayingText = false;
  private disposed = false;
  private attachment = 0;
  private reconciledCommitSeq = -1;
  private handlers: Handlers;
  private releaseStructural: Handlers["releaseStructural"];
  private abandonCommand: Handlers["abandonCommand"];
  private onError: Handlers["onError"];

  constructor(private readonly options: NfmHistoryLaneOptions) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.handlers = options;
    this.releaseStructural = options.releaseStructural;
    this.abandonCommand = options.abandonCommand;
    this.onError = options.onError;
    const initial = (items: readonly YStackItem[]) =>
      items.map((item) => ({
        intent: { kind: "native_capture" as const },
        receipt: { kind: "native" as const, captureId: this.registerCapture(item) },
      }));
    this.owner = createSurfaceHistory({
      scopeKey: "nfm",
      limits: { ...limits, maxPending: limits.maxQueued + 1 },
      retainedIdentityCount: () => options.textHistory?.retainedIdentityCount ?? 0,
      initialCaptures: {
        undo: initial(options.undoManager?.undoStack ?? []),
        redo: initial(options.undoManager?.redoStack ?? []),
      },
      onError: (error) => this.onError?.(error),
      adapter: {
        describe: (command: NfmHistoryCommand | CaptureIntent) =>
          command.kind === "native_capture" ? "Edit Text" : nfmCommandLabel(command),
        prepare: async (command) => {
          if (command.kind === "native_capture" || !this.handlers.prepareCommand)
            throw new Error("The editor surface is not mounted for content commands.");
          return this.handlers.prepareCommand(command);
        },
        prepareInverse: (inverse: NfmHistoryInverse) => this.prepareInverse(inverse),
        submit: async (request: NfmHistoryRequest) => {
          if (!this.handlers.submit)
            throw new Error("The editor surface is not mounted for content commands.");
          return this.handlers.submit(request);
        },
        interpret: (receipt: NfmHistoryReceipt) => this.interpret(receipt),
        inverseBytes: (inverse) => this.inverseBytes(inverse),
        exceedsReplayBounds: (inverse) =>
          inverse.kind === "native" &&
          this.options.textHistory?.exceedsBridgeBounds(this.requireCapture(inverse.captureId)) ===
            true,
        checkInverse: async (inverse) => {
          if (inverse.kind === "structural") await this.reconcile();
          return { state: "ready" };
        },
        replayLocal: (inverse, direction) => this.replayLocal(inverse, direction),
        release: (inverse, reason) => {
          if (inverse.kind === "native") {
            this.discardCapture(inverse.captureId);
            return;
          }
          if (reason === "discarded" && inverse.kind === "structural")
            return this.releaseStructural?.([inverse.token]);
        },
        discardReceipt: (receipt) => {
          if (receipt.kind === "block_transfer")
            return this.releaseStructural?.(promotionRetentionResources(receipt.result));
        },
        abandon: async (request, inverse) => {
          if (inverse?.kind === "native") this.discardCapture(inverse.captureId);
          await this.abandonCommand?.(request);
        },
      },
    });
    this.unsubscribeOwner = this.owner.subscribe(() => this.indexRetained());
    this.indexRetained();
    options.undoManager?.on("stack-item-added", this.handleStackItemAdded);
    options.undoManager?.on("stack-item-updated", this.handleStackItemAdded);
    options.undoManager?.on("stack-cleared", this.handleStackCleared);
    options.undoManager?.on("stack-item-popped", this.handleStackPopped);
    options.undoManager?.doc.on("update", this.handleDocumentUpdate);
  }

  attach(handlers: Handlers): () => void {
    if (this.disposed) return () => undefined;
    const attachment = ++this.attachment;
    this.handlers = handlers;
    this.releaseStructural = handlers.releaseStructural ?? this.releaseStructural;
    this.abandonCommand = handlers.abandonCommand ?? this.abandonCommand;
    this.onError = handlers.onError ?? this.onError;
    return () => {
      if (this.attachment === attachment) this.handlers = {};
    };
  }
  execute(command: NfmHistoryCommand): HistoryCommandHandle<NfmHistoryReceipt> {
    this.stopCapturing();
    return this.observe(this.owner.execute(command));
  }
  snapshot() {
    return this.owner.snapshot();
  }
  subscribe(listener: () => void): () => void {
    return this.owner.subscribe(listener);
  }
  canUndo(): boolean {
    return this.owner.snapshot().undo.acceptsIntent;
  }
  canRedo(): boolean {
    return this.owner.snapshot().redo.acceptsIntent;
  }
  requestUndo(): boolean {
    return this.request("undo");
  }
  requestRedo(): boolean {
    return this.request("redo");
  }
  recover(): HistoryCommandHandle<NfmHistoryReceipt> {
    return this.observe(this.owner.recover());
  }
  reset(): void {
    this.stopCapturing();
    this.owner.reset();
  }
  private request(direction: SurfaceHistoryDirection): boolean {
    if (this.disposed) return false;
    this.stopCapturing();
    this.observe(this.owner.request(direction));
    // Empty, pending and blocked still belong to this surface, never another engine.
    return true;
  }
  private observe(
    handle: HistoryCommandHandle<NfmHistoryReceipt>,
  ): HistoryCommandHandle<NfmHistoryReceipt> {
    void handle.result
      .then((resolution) => {
        if (this.disposed) return;
        if (resolution.status !== "committed") {
          if (resolution.status !== "noop") this.onError?.(new Error(resolution.reason));
          return;
        }
        const presentation = Promise.resolve()
          .then(() => this.handlers.onCommitted?.(resolution.receipt))
          .catch((error: unknown) => this.onError?.(error));
        this.presentations.add(presentation);
        void presentation.finally(() => this.presentations.delete(presentation));
      })
      .catch((error: unknown) => this.onError?.(error));
    return handle;
  }
  async whenIdle(): Promise<void> {
    await this.owner.whenIdle();
    await Promise.resolve();
    if (this.disposed) return;
    while (this.presentations.size > 0) await Promise.all(this.presentations);
  }
  stopCapturing(): void {
    this.options.undoManager?.stopCapturing();
  }

  /** A synchronous portable write fills its already-reserved semantic gesture. */
  completeLocalCapture(write: () => void): NfmHistoryReceipt {
    if (this.disposed || this.localCompletion)
      throw new Error("Local content is not available for this command.");
    this.stopCapturing();
    const captures: number[] = [];
    this.localCompletion = captures;
    try {
      write();
    } finally {
      this.localCompletion = null;
      this.stopCapturing();
    }
    if (captures.length === 0) return { kind: "no_content_change" };
    if (captures.length === 1) return { kind: "native", captureId: captures[0]! };
    for (const captureId of captures) this.discardCapture(captureId);
    return {
      kind: "barrier",
      reason: "The pasted content committed as multiple native history groups.",
    };
  }
  private registerCapture(item: YStackItem): number {
    const existing = this.captureIds.get(item);
    if (existing !== undefined) return existing;
    const captureId = ++this.nextCaptureId;
    this.captureIds.set(item, captureId);
    this.captures.set(captureId, { item });
    return captureId;
  }
  private requireCapture(captureId: number): YStackItem {
    const capture = this.captures.get(captureId);
    if (!capture) throw new Error("Document history no longer matches the surface history.");
    return capture.item;
  }
  private discardCapture(captureId: number): void {
    const capture = this.captures.get(captureId);
    if (!capture) return;
    this.captures.delete(captureId);
    this.stopCapturing();
    const replaying = this.replayingText;
    this.replayingText = true;
    try {
      this.options.undoManager?.discardStackItems([capture.item]);
    } finally {
      this.replayingText = replaying;
    }
  }
  private readonly handleStackItemAdded = (event: StackItemEvent): void => {
    this.capturedTransactions.set(event.changedParentTypes, event.stackItem);
    const weight = this.nativeWeights.get(event.stackItem) ?? { updates: 0, semanticPeak: 0 };
    weight.semanticPeak = Math.max(
      weight.semanticPeak,
      this.options.textHistory?.retainedBytes(event.stackItem) ?? 0,
    );
    this.nativeWeights.set(event.stackItem, weight);
    if (this.disposed || event.origin === this.options.undoManager || event.type !== "undo") return;
    const captureId = this.registerCapture(event.stackItem);
    if (this.localCompletion) {
      if (!this.localCompletion.includes(captureId)) this.localCompletion.push(captureId);
      return;
    }
    const capture = this.captures.get(captureId);
    if (!capture) return;
    if (capture.entryId !== undefined) {
      this.owner.refreshCapture(capture.entryId);
      this.reportRetiredCapture(captureId);
      return;
    }
    this.owner.capture({ kind: "native_capture" }, { kind: "native", captureId });
    this.reportRetiredCapture(captureId);
  };
  private readonly handleDocumentUpdate = (
    update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    const item = this.capturedTransactions.get(transaction.changedParentTypes);
    if (!item) return;
    const weight = this.nativeWeights.get(item);
    if (!weight) return;
    weight.updates += update.byteLength;
    const captureId = this.captureIds.get(item);
    const entryId = captureId === undefined ? undefined : this.captures.get(captureId)?.entryId;
    if (!this.replayingText && !this.localCompletion && entryId !== undefined) {
      this.owner.refreshCapture(entryId);
      this.reportRetiredCapture(captureId!);
    }
  };

  private reportRetiredCapture(captureId: number): void {
    if (this.captures.has(captureId)) return;
    this.onError?.(
      new Error(
        "This edit exceeds the editor history limit. Earlier Undo actions were retired; your content was not changed.",
      ),
    );
  }
  private readonly handleStackCleared = (): void => {
    if (this.replayingText) return;
    const manager = this.options.undoManager;
    if (!manager) return;
    const reachable = new Set([...manager.undoStack, ...manager.redoStack]);
    for (const entry of this.owner.retained()) {
      const inverse = entry.inverse;
      if (inverse?.kind !== "native") continue;
      const capture = this.captures.get(inverse.captureId);
      if (capture && reachable.has(capture.item)) continue;
      this.owner.reconcile({
        entryId: entry.entryId,
        expectedInverse: inverse,
        state: "superseded",
      });
    }
  };
  private readonly handleStackPopped = (): void => {
    if (this.replayingText) return;
    this.handleStackCleared();
    this.onError?.(new Error("Document history changed outside its surface history owner."));
  };
  private replayLocal(
    inverse: NfmHistoryInverse,
    direction: SurfaceHistoryDirection,
  ): { kind: "committed"; receipt: NfmHistoryReceipt } | { kind: "defer" } {
    if (inverse.kind !== "native") return { kind: "defer" };
    const item = this.requireCapture(inverse.captureId);
    if (this.options.textHistory?.requiresBridge(item)) return { kind: "defer" };
    const manager = this.options.undoManager;
    if (!manager) throw new Error("The editor surface no longer has a local document history.");
    this.replayingText = true;
    let replayed;
    try {
      replayed = manager.replayStackItem(direction, item);
    } finally {
      this.replayingText = false;
    }
    if (!replayed) throw new Error("Document history no longer matches the surface history.");
    if (!replayed.inverse) return { kind: "committed", receipt: { kind: "no_content_change" } };
    const previousWeight = this.nativeWeights.get(item);
    const weight = this.nativeWeights.get(replayed.inverse) ?? { updates: 0, semanticPeak: 0 };
    weight.semanticPeak = Math.max(
      weight.semanticPeak,
      previousWeight?.semanticPeak ?? 0,
      previousWeight?.updates ?? 0,
    );
    this.nativeWeights.set(replayed.inverse, weight);
    return {
      kind: "committed",
      receipt: { kind: "native", captureId: this.registerCapture(replayed.inverse) },
    };
  }
  private async prepareInverse(
    inverse: NfmHistoryInverse,
  ): Promise<HistoryPreparation<NfmHistoryRequest, NfmHistoryReceipt>> {
    this.stopCapturing();
    if (inverse.kind === "structural") {
      if (!this.handlers.prepareStructuralReverse)
        throw new Error("The editor surface is not mounted for history replay.");
      return {
        kind: "submit",
        request: await this.handlers.prepareStructuralReverse(inverse.token, inverse.selection),
      };
    }
    const item = this.requireCapture(inverse.captureId);
    const journal = this.options.textHistory;
    if (!journal || !this.handlers.prepareTextReverse)
      throw new Error("The editor surface is not mounted for semantic history replay.");
    const patch = structuredClone(journal.patch(item));
    if (patch.changes.length === 0)
      return { kind: "complete", receipt: { kind: "no_content_change" } };
    return {
      kind: "submit",
      request: await this.handlers.prepareTextReverse(patch, this.options.textSelection?.(item)),
    };
  }
  private interpret(receipt: NfmHistoryReceipt): HistoryReceiptInterpretation<NfmHistoryInverse> {
    if (receipt.kind === "native")
      return { kind: "reversible", inverse: { kind: "native", captureId: receipt.captureId } };
    if (receipt.kind === "no_content_change") return { kind: "noop" };
    if (receipt.kind === "barrier") return receipt;
    if (receipt.kind === "block_transfer") {
      const { history } = receipt.result;
      return history
        ? { kind: "reversible", inverse: { kind: "structural", token: history } }
        : { kind: "barrier", reason: "This transfer has no complete inverse." };
    }
    const { result, presentation } = receipt;
    if (result.history)
      this.removeSuperseded(result.supersededHistoryRecipeOperationIds, result.history.storeEpoch);
    if (!result.history)
      return { kind: "barrier", reason: "The committed edit has no complete inverse." };
    const selection = presentation?.selection;
    return {
      kind: "reversible",
      inverse: {
        kind: "structural",
        token: result.history,
        ...(selection ? { selection: { before: selection.after, after: selection.before } } : {}),
      },
    };
  }
  private inverseBytes(inverse: NfmHistoryInverse): number {
    if (inverse.kind !== "native")
      return 128 + new TextEncoder().encode(JSON.stringify(inverse)).byteLength;
    const item = this.requireCapture(inverse.captureId);
    const weight = this.nativeWeights.get(item);
    return (
      128 +
      (weight?.updates ?? 0) +
      (weight?.semanticPeak ?? 0) +
      (this.options.textHistory?.retainedBytes(item) ?? 0)
    );
  }
  private indexRetained(): void {
    for (const key of this.indexedKeys)
      if (structuralEntries.get(key)?.lane === this) structuralEntries.delete(key);
    this.indexedKeys.clear();
    for (const entry of this.owner.retained()) {
      const inverse = entry.inverse;
      if (inverse?.kind === "native") {
        const capture = this.captures.get(inverse.captureId);
        if (capture) capture.entryId = entry.entryId;
      }
      if (inverse?.kind !== "structural") continue;
      const key = tokenKey(inverse.token);
      structuralEntries.set(key, { lane: this, entryId: entry.entryId, inverse });
      this.indexedKeys.add(key);
    }
  }
  private removeSuperseded(recipeIds: readonly string[], storeEpoch: string): void {
    for (const recipeId of recipeIds) {
      const entry = structuralEntries.get(`${storeEpoch}\0${recipeId}`);
      entry?.lane.owner.reconcile({
        entryId: entry.entryId,
        expectedInverse: entry.inverse,
        state: "superseded",
      });
    }
  }
  /** Bounded authoritative reads repair missed delivery without a parallel history state. */
  async reconcile(): Promise<void> {
    if (this.disposed || !this.handlers.reconcileStructural) return;
    const entries = this.owner.retained().filter((entry) => entry.inverse?.kind === "structural");
    for (
      let offset = 0;
      offset < entries.length;
      offset += MAX_STRUCTURAL_HISTORY_RECONCILIATION_TOKENS
    ) {
      const batch = entries.slice(offset, offset + MAX_STRUCTURAL_HISTORY_RECONCILIATION_TOKENS);
      const tokens = batch.map((entry) => (entry.inverse as StructuralInverse).token);
      const snapshot = await this.handlers.reconcileStructural(tokens);
      if (this.disposed) return;
      if (snapshot.commitSeq < this.reconciledCommitSeq) continue;
      const states = new Map(snapshot.items.map((item) => [tokenKey(item.token), item]));
      if (
        states.size !== batch.length ||
        snapshot.items.length !== batch.length ||
        tokens.some((token) => states.get(tokenKey(token))?.token.recipeHash !== token.recipeHash)
      )
        throw new Error("History reconciliation did not cover the requested capabilities.");
      this.reconciledCommitSeq = snapshot.commitSeq;
      for (const entry of batch) {
        const inverse = entry.inverse as StructuralInverse;
        const state = states.get(tokenKey(inverse.token))!.state;
        if (state === "available") continue;
        this.owner.reconcile({
          entryId: entry.entryId,
          expectedInverse: inverse,
          state: state === "superseded" ? "superseded" : "unavailable",
        });
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.undoManager?.off("stack-item-added", this.handleStackItemAdded);
    this.options.undoManager?.off("stack-item-updated", this.handleStackItemAdded);
    this.options.undoManager?.off("stack-cleared", this.handleStackCleared);
    this.options.undoManager?.off("stack-item-popped", this.handleStackPopped);
    this.options.undoManager?.doc.off("update", this.handleDocumentUpdate);
    this.owner.close();
    this.unsubscribeOwner();
    this.options.textHistory?.dispose();
  }
  async close(): Promise<void> {
    this.dispose();
    await this.owner.whenIdle();
  }
}
