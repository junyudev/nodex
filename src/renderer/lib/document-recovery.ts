import type {
  DocumentRecoveryCommand,
  DocumentRecoveryScope,
  RecoveryDraftCapture,
  RecoveryDraftInspection,
  RecoveryDraftSummary,
  RecoveryChoice,
} from "../../shared/block-documents/document-recovery";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { contentAccessIdentityKey } from "../../shared/content-access-context";
import { IndexedDbDocumentLocalCheckpointStore } from "./document-local-checkpoint";
import { IndexedDbCanvasSceneOutbox } from "./canvas-scene-outbox";
import { captureCanvasRecovery, captureDocumentRecovery } from "./document-recovery-package";
import {
  defineRendererCommand,
  invokeLocalCommitCommand,
  invokeRendererQuery,
} from "./renderer-command";
import { CoreApiError } from "./core-api-error";
import { subscribeElectronRendererLocalCommitAtoms } from "./electron-renderer-transport";

const recoveryCommand = defineRendererCommand({
  key: "document.recovery.resolve",
  channel: "document-recovery:apply",
  authority: "core",
  owner: "DocumentRecovery",
  protocol: { kind: "returned_value" },
});
export const documentRecoveryPort = {
  subscribe: (scope: DocumentRecoveryScope, listener: (documentId: string | null) => void) => {
    if (!window.api) throw new Error("Recovery requires the desktop bridge");
    return subscribeElectronRendererLocalCommitAtoms(
      window.api,
      { ...scope.accessContext, libraryId: scope.libraryId },
      (_packet, atom) => {
        const payload = atom.payload;
        if (payload.module === "owned_document" && payload.event.kind === "recovery_changed")
          listener(payload.event.document_id);
      },
      () => listener(null),
    );
  },
  read: (
    scope: DocumentRecoveryScope,
    read: import("../../shared/block-documents/document-recovery").RecoveryRead,
  ) => invokeRendererQuery("document-recovery:read", { ...scope, read }),
  apply: (command: DocumentRecoveryCommand): Promise<RecoveryDraftSummary> =>
    invokeLocalCommitCommand(recoveryCommand, command).then((result) => result.value),
};
export type DocumentRecoveryPort = typeof documentRecoveryPort;
export interface DocumentRecoveryState {
  readonly drafts: readonly RecoveryDraftSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly storeEpoch: string | null;
  readonly hasMore: boolean;
  readonly pendingCount: number;
}
const EMPTY: DocumentRecoveryState = {
  drafts: [],
  loading: true,
  error: null,
  storeEpoch: null,
  hasMore: false,
  pendingCount: 0,
};
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Window-local coordinator; Core owns bytes and resolution. Views never infer capabilities from error codes. */
export class DocumentRecovery {
  private state: DocumentRecoveryState = EMPTY;
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private cursor: string | null = null;
  private includeResolved = false;
  private connections = 0;
  private disconnect: (() => void) | null = null;
  private readonly checkpoint =
    typeof indexedDB === "undefined" ? null : new IndexedDbDocumentLocalCheckpointStore(indexedDB);
  private readonly canvas: IndexedDbCanvasSceneOutbox | null;
  private readonly pending = new Map<string, DocumentRecoveryCommand>();
  constructor(
    readonly scope: DocumentRecoveryScope,
    readonly documentId: string | null,
    private readonly port: DocumentRecoveryPort = documentRecoveryPort,
  ) {
    this.canvas =
      typeof indexedDB === "undefined"
        ? null
        : new IndexedDbCanvasSceneOutbox(indexedDB, scope.libraryId);
  }
  getSnapshot = (): DocumentRecoveryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<DocumentRecoveryState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  connect = (): (() => void) => {
    this.connections += 1;
    if (this.connections > 1) return this.release;
    const unsubscribe = this.port.subscribe(this.scope, (documentId) => {
      if (!this.documentId || !documentId || documentId === this.documentId) void this.refresh();
    });
    const refresh = () => {
      void this.refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    refresh();
    this.disconnect = () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
    return this.release;
  };
  private release = (): void => {
    this.connections -= 1;
    if (this.connections === 0) {
      this.disconnect?.();
      this.disconnect = null;
    }
  };
  refresh = (): Promise<void> => {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = this.load(false).finally(() => {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    this.refreshing = run;
    return run;
  };
  loadMore = (): Promise<void> => this.load(true);
  setIncludeResolved = (includeResolved: boolean): Promise<void> => {
    this.includeResolved = includeResolved;
    return this.refresh();
  };
  private async load(more: boolean): Promise<void> {
    let drainError: string | null = null;
    try {
      let result = await this.port.read(this.scope, {
        kind: "list",
        document_id: this.documentId,
        include_resolved: this.includeResolved,
        before: more ? this.cursor : null,
        limit: 50,
      });
      if (!result.ok) throw new Error(result.error.message);
      const epoch = result.storeEpoch;
      if (!more) {
        await this.drain(epoch).catch((error: unknown) => {
          drainError = message(error);
        });
        result = await this.port.read(this.scope, {
          kind: "list",
          document_id: this.documentId,
          include_resolved: this.includeResolved,
          before: null,
          limit: 50,
        });
        if (!result.ok) throw new Error(result.error.message);
      }
      if (result.value.kind !== "list") throw new Error("Unexpected recovery list");
      this.cursor = result.value.page.next_cursor ?? null;
      this.publish({
        drafts: more
          ? [...this.state.drafts, ...result.value.page.drafts]
          : result.value.page.drafts,
        loading: false,
        error: drainError,
        storeEpoch: epoch,
        hasMore: Boolean(this.cursor),
        pendingCount: result.value.page.pending_count,
      });
      // Reconcile each pending package separately; never treat a partial request receipt as full coverage.
      if (!more)
        for (const draft of this.state.drafts.filter((draft) => !draft.resolution)) {
          const command: DocumentRecoveryCommand = {
            ...this.scope,
            kind: "resolve",
            operationId: createBoundedOperationId("document.recovery.reconcile"),
            storeEpoch: epoch,
            resolve: {
              draft_id: draft.draft_id,
              revision: draft.revision,
              choice: { kind: "reconcile" },
            },
          };
          try {
            const resolved = await this.port.apply(command);
            if (resolved.resolution) this.acceptResolution(resolved);
          } catch (error) {
            if (!(error instanceof CoreApiError) || error.code !== "revision_conflict") throw error;
            this.refreshAgain = true;
          }
        }
    } catch (error) {
      this.publish({ loading: false, error: message(error) });
    }
  }
  private async accept(capture: RecoveryDraftCapture, storeEpoch: string): Promise<void> {
    const received = await this.port.apply({
      ...this.scope,
      kind: "capture",
      operationId: createBoundedOperationId("document.recovery.capture"),
      storeEpoch,
      capture,
    });
    if (received.draft_id !== capture.draft_id || !received.payload_hash)
      throw new Error("Recovery package acknowledgement is incomplete");
  }
  private async drain(epoch: string): Promise<void> {
    const ids = this.documentId
      ? [this.documentId]
      : this.scope.accessContext.kind === "library"
        ? ((await this.checkpoint?.recoveryDocumentIds()) ?? [])
        : [];
    let failure: unknown;
    for (const documentId of ids) {
      let after: string | undefined;
      for (let count = 0; this.checkpoint && count < 100; count += 1) {
        const snapshot = await this.checkpoint.nextRecovery(documentId, after);
        if (!snapshot) break;
        after = snapshot.recoveryId;
        try {
          await this.accept(captureDocumentRecovery(snapshot), epoch);
          await this.checkpoint.acknowledgeRecovery(snapshot);
        } catch (error) {
          failure = error;
        }
      }
    }
    if (this.canvas && this.documentId) {
      const entries = await this.canvas.listQuarantined(this.scope.accessContext, this.documentId);
      for (const entry of entries) {
        try {
          await this.accept(captureCanvasRecovery(entry), epoch);
          await this.canvas.acknowledgeRecovery(entry);
        } catch (error) {
          failure = error;
        }
      }
    }
    if (this.canvas && !this.documentId && this.scope.accessContext.kind === "library") {
      let after: IDBValidKey | undefined;
      for (let count = 0; count < 256; count += 1) {
        const entry = await this.canvas.nextRecovery(after);
        if (!entry) break;
        after = entry.key;
        try {
          await this.accept(captureCanvasRecovery(entry.snapshot), epoch);
          await this.canvas.acknowledgeRecovery(entry.snapshot);
        } catch (error) {
          failure = error;
        }
      }
    }
    if (failure) throw failure;
  }
  private acceptResolution(result: RecoveryDraftSummary): void {
    const previous = this.state.drafts.find((draft) => draft.draft_id === result.draft_id);
    const delta = previous ? Number(!result.resolution) - Number(!previous.resolution) : 0;
    this.publish({
      drafts: this.state.drafts.map((item) => (item.draft_id === result.draft_id ? result : item)),
      pendingCount: Math.max(0, this.state.pendingCount + delta),
    });
  }

  inspect = async (draftId: string): Promise<RecoveryDraftInspection> => {
    const result = await this.port.read(this.scope, { kind: "inspect", draft_id: draftId });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.kind !== "inspect") throw new Error("Unexpected recovery preview");
    this.publish({ storeEpoch: result.storeEpoch });
    if (result.value.inspection.summary.resolution) this.clearPending(draftId);
    return result.value.inspection;
  };
  private pendingKey(draftId: string): string {
    return `nodex:recovery-operation:${this.scope.libraryId}:${draftId}`;
  }
  private clearPending(draftId: string): void {
    this.pending.delete(draftId);
    localStorage.removeItem(this.pendingKey(draftId));
  }
  resolve = async (
    inspection: RecoveryDraftInspection,
    choice: RecoveryChoice,
  ): Promise<RecoveryDraftSummary> => {
    if (!this.state.storeEpoch) throw new Error("Refresh the recovery preview before continuing");
    const draftId = inspection.summary.draft_id;
    const stored = localStorage.getItem(this.pendingKey(draftId));
    const existing =
      this.pending.get(draftId) ??
      (stored ? (JSON.parse(stored) as DocumentRecoveryCommand) : null);
    if (existing && existing.kind === "resolve" && existing.resolve.choice.kind !== choice)
      throw new Error(
        "The previous action has not been confirmed. Retry it or refresh its result first.",
      );
    const command: DocumentRecoveryCommand = existing ?? {
      ...this.scope,
      kind: "resolve",
      operationId: createBoundedOperationId(`document.recovery.${choice}`),
      storeEpoch: this.state.storeEpoch,
      resolve: {
        draft_id: draftId,
        revision: inspection.summary.revision,
        expected_generation: inspection.current_generation,
        expected_head_seq: inspection.current_head_seq,
        choice: { kind: choice },
      },
    };
    // Persist the new user intent before submission. An uncertain response always reuses this exact request.
    localStorage.setItem(this.pendingKey(draftId), JSON.stringify(command));
    this.pending.set(draftId, command);
    const result = await this.port.apply(command).catch((error: unknown) => {
      if (
        error instanceof CoreApiError &&
        [
          "revision_conflict",
          "generation_conflict",
          "stale_store_epoch",
          "unauthorized",
          "invalid_input",
          "not_found",
        ].includes(error.code)
      )
        this.clearPending(draftId);
      throw error;
    });
    this.clearPending(draftId);
    this.acceptResolution(result);
    return result;
  };
  export = async (draftId: string): Promise<void> => {
    const inspection = await this.inspect(draftId);
    const blob = new Blob(
      [JSON.stringify({ format: "nodex-document-recovery", version: 2, inspection }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nodex-recovery-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
}
const modules = new Map<string, DocumentRecovery>();
export const getDocumentRecovery = (
  scope: DocumentRecoveryScope,
  documentId: string | null,
): DocumentRecovery => {
  const key = JSON.stringify([contentAccessIdentityKey(scope), documentId]);
  const existing = modules.get(key);
  if (existing) return existing;
  const module = new DocumentRecovery(scope, documentId);
  modules.set(key, module);
  return module;
};
