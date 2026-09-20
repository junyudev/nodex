import { RecoveryBundleValidationError } from "../../shared/block-documents/recovery-bundle";
import { parseRecoveryResolveOperation } from "./document-recovery-operation";
import type {
  DocumentRecoveryCommand,
  DocumentRecoveryScope,
  RecoveryDraftInspection,
  RecoveryDraftSummary,
  RecoveryChoice,
} from "../../shared/block-documents/document-recovery";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { contentAccessIdentityKey } from "../../shared/content-access-context";
import { IndexedDbDocumentLocalCheckpointStore } from "./document-local-checkpoint";
import { IndexedDbCanvasSceneOutbox } from "./canvas-scene-outbox";
import { CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";
import { recoveryExportPort, saveRecoveryExport } from "./document-recovery-export";
import {
  type RecoveryStagingSummary,
  type RecoverySourceKind,
  type RecoveryTransferFailure,
  recoveryRecord,
  verifyRecoveryReceipt,
} from "./document-recovery-staging";
import {
  defineRendererCommand,
  invokeLocalCommitCommand,
  invokeRendererQuery,
} from "./renderer-command";
import { CoreApiError } from "./core-api-error";
import { subscribeElectronRendererLocalCommitAtoms } from "./electron-renderer-transport";
import { contentEditIssues } from "./content-edit-issues";
import { createDocumentRecoveryIssueSource } from "./document-recovery-issues";

const recoveryCommand = defineRendererCommand({
  key: "document.recovery.resolve",
  channel: "document-recovery:apply",
  authority: "core",
  owner: "DocumentRecovery",
  protocol: { kind: "returned_value" },
});
export const documentRecoveryPort = {
  export: recoveryExportPort,
  subscribe: (
    scope: DocumentRecoveryScope,
    listener: (documentId: string | null, change?: "recovery" | "content") => void,
  ) => {
    if (!window.api) throw new Error("Recovery requires the desktop bridge");
    return subscribeElectronRendererLocalCommitAtoms(
      window.api,
      { ...scope.accessContext, libraryId: scope.libraryId },
      (_packet, atom) => {
        const payload = atom.payload;
        if (payload.module === "owned_document" && "document_id" in payload.event)
          listener(
            payload.event.document_id,
            payload.event.kind === "recovery_changed" ? "recovery" : "content",
          );
        if (payload.module === "library" && Object.keys(payload.event.file_revisions).length > 0)
          listener(null, "content");
      },
      () => listener(null),
    );
  },
  read: (
    scope: DocumentRecoveryScope,
    read: import("../../shared/block-documents/document-recovery").RecoveryRead,
  ) => invokeRendererQuery("document-recovery:read", { ...scope, read }),
  apply: (
    command: DocumentRecoveryCommand,
  ): Promise<
    RecoveryDraftSummary & {
      readonly capture_receipt?: import("../../shared/block-documents/document-recovery").RecoveryCaptureReceipt;
    }
  > => invokeLocalCommitCommand(recoveryCommand, command).then((result) => result.value),
};
export type DocumentRecoveryPort = typeof documentRecoveryPort;
export interface DocumentRecoveryState {
  readonly sending: readonly string[];
  readonly acceptedLocal: Readonly<Record<string, string>>;
  readonly staged: readonly RecoveryStagingSummary[];
  readonly stagedCount: number;
  readonly localHasMore: boolean;
  readonly localError: string | null;
  readonly receivedStale: boolean;
  readonly previewRevision: number;
  readonly drafts: readonly RecoveryDraftSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly storeEpoch: string | null;
  readonly hasMore: boolean;
  readonly pendingCount: number;
}
const EMPTY: DocumentRecoveryState = {
  sending: [],
  acceptedLocal: {},
  staged: [],
  stagedCount: 0,
  localHasMore: false,
  localError: null,
  receivedStale: false,
  previewRevision: 0,
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
  readonly scope: DocumentRecoveryScope;
  private state: DocumentRecoveryState = EMPTY;
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private cursor: string | null = null;
  private continuation: ReturnType<typeof setTimeout> | null = null;
  private localPages = { yjs: 1, canvas: 1 };
  private localMore = { yjs: false, canvas: false };
  private includeResolved = false;
  private connections = 0;
  private disconnect: (() => void) | null = null;
  private localChanges: BroadcastChannel | null = null;
  private readonly checkpoint =
    typeof indexedDB === "undefined" ? null : new IndexedDbDocumentLocalCheckpointStore(indexedDB);
  private readonly canvas: IndexedDbCanvasSceneOutbox | null;
  constructor(
    scope: DocumentRecoveryScope,
    readonly documentId: string | null,
    private readonly port: DocumentRecoveryPort = documentRecoveryPort,
  ) {
    // Callers may pass a Document descriptor; transport owns only its access identity.
    this.scope = { libraryId: scope.libraryId, accessContext: scope.accessContext };
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
    const unsubscribe = this.port.subscribe(this.scope, (documentId, change) => {
      // Ordinary saves cannot create a draft. Keep the always-connected overview off that hot path.
      if (change === "content" && this.state.pendingCount === 0 && this.state.stagedCount === 0)
        return;
      if (!this.documentId || !documentId || documentId === this.documentId) void this.refresh();
    });
    const releaseIssues = contentEditIssues.register(createDocumentRecoveryIssueSource(this));
    if (typeof BroadcastChannel !== "undefined") {
      this.localChanges = new BroadcastChannel("nodex:recovery-local-changes");
      this.localChanges.addEventListener("message", () => {
        void this.loadLocal(false).catch((error: unknown) =>
          this.publish({ localError: message(error) }),
        );
      });
    }
    const refresh = () => {
      void this.refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    refresh();
    this.disconnect = () => {
      this.localChanges?.close();
      this.localChanges = null;
      releaseIssues();
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
      if (this.continuation) clearTimeout(this.continuation);
      this.continuation = null;
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
  private store(kind: RecoverySourceKind) {
    return kind === "yjs" ? this.checkpoint?.staging : this.canvas?.staging;
  }
  private async loadLocal(more: boolean): Promise<void> {
    if (more)
      for (const kind of ["yjs", "canvas"] as const)
        if (this.localMore[kind]) this.localPages[kind] += 1;
    const pages = await Promise.all(
      (["yjs", "canvas"] as const).map(async (kind) => {
        const store = this.store(kind);
        if (!store) return { entries: [] as RecoveryStagingSummary[], count: 0 };
        const entries: RecoveryStagingSummary[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < this.localPages[kind]; page += 1) {
          const result = await store.listSummaries(this.scope, this.documentId, cursor);
          entries.push(...result.entries);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        this.localMore[kind] = Boolean(cursor);
        return { entries, count: await store.countSummaries(this.scope, this.documentId) };
      }),
    );
    this.publish({
      staged: pages.flatMap((page) => page.entries),
      stagedCount: pages.reduce((count, page) => count + page.count, 0),
      localHasMore: this.localMore.yjs || this.localMore.canvas,
      localError: null,
    });
  }
  private async readReceived(more: boolean): Promise<string | null> {
    if (more && !this.cursor) return this.state.storeEpoch;
    const result = await this.port.read(this.scope, {
      kind: "list",
      document_id: this.documentId,
      include_resolved: this.includeResolved,
      before: more ? this.cursor : null,
      limit: 50,
    });
    if (!result.ok) throw new CoreApiError(result.error);
    if (result.value.kind !== "list") throw new Error("Unexpected recovery list");
    this.cursor = result.value.page.next_cursor ?? null;
    this.publish({
      drafts: more ? [...this.state.drafts, ...result.value.page.drafts] : result.value.page.drafts,
      loading: false,
      error: null,
      receivedStale: false,
      storeEpoch: result.storeEpoch,
      previewRevision: this.state.previewRevision + 1,
      hasMore: Boolean(this.cursor),
      pendingCount: result.value.page.pending_count,
    });
    return result.storeEpoch;
  }
  private async load(more: boolean): Promise<void> {
    // The local directory is independent of Core availability, including after the source document closes.
    await this.loadLocal(more).catch((error: unknown) =>
      this.publish({ localError: message(error) }),
    );
    try {
      const epoch = await this.readReceived(more);
      if (!more && epoch) {
        const changed = await this.drain(epoch);
        await this.loadLocal(false);
        if (changed) await this.readReceived(false);
        for (const draft of this.state.drafts.filter((draft) => !draft.resolution)) {
          const analysis = await this.inspect(draft.draft_id);
          if (!analysis.already_saved) continue;
          try {
            await this.resolve(analysis, "reconcile");
          } catch (error) {
            if (!(error instanceof CoreApiError) || error.code !== "revision_conflict") throw error;
            this.refreshAgain = true;
          }
        }
      }
    } catch (error) {
      this.publish({ loading: false, error: message(error), receivedStale: true });
    }
    this.publish({ loading: false });
  }
  private async transfer(entry: RecoveryStagingSummary, epoch: string): Promise<boolean> {
    const store = this.store(entry.sourceKind);
    if (!store) throw new Error("Local recovery storage is unavailable");
    this.publish({ sending: [...this.state.sending, entry.sourceKey] });
    try {
      const frozen = await store.freeze(entry, this.scope, epoch);
      const received = await this.port.apply({
        ...frozen.scope,
        kind: "capture",
        operationId: frozen.operationId,
        storeEpoch: frozen.storeEpoch,
        bundle: frozen.bundle,
      });
      verifyRecoveryReceipt(frozen, received.capture_receipt);
      if (
        received.draft_id !== frozen.bundle.draftId ||
        received.payload_hash !== received.capture_receipt?.stored_payload_hash
      )
        throw new Error("Core acknowledged another retained package. The local copy is unchanged.");
      this.publish({
        acceptedLocal: { ...this.state.acceptedLocal, [entry.sourceKey]: received.draft_id },
        drafts: [
          ...this.state.drafts.filter((draft) => draft.draft_id !== received.draft_id),
          received,
        ],
      });
      return await store.acknowledge(entry, frozen, received.capture_receipt);
    } finally {
      const index = this.state.sending.indexOf(entry.sourceKey);
      this.publish({ sending: this.state.sending.filter((_, position) => position !== index) });
    }
  }

  private transferFailure(
    error: unknown,
    previous: RecoveryTransferFailure | null,
  ): RecoveryTransferFailure {
    const attempts = (previous?.attempts ?? 0) + 1;
    const core = error instanceof CoreApiError ? error : null;
    const rejection =
      core?.recovery.kind === "recovery_package"
        ? core.recovery.failure
        : error instanceof RecoveryBundleValidationError
          ? error.failure
          : null;
    const retry =
      (core && ["unauthorized", "stale_store_epoch"].includes(core.code)) ||
      rejection?.reason === "source_unverified"
        ? "rebind"
        : rejection && rejection.effect === "not_applied"
          ? "manual"
          : core?.retryable
            ? "automatic"
            : "manual";
    return {
      code: rejection?.reason ?? core?.code ?? "local_package_unavailable",
      actual: rejection?.actual,
      limit: rejection?.limit,
      message: message(error),
      effect:
        rejection?.effect ??
        (core && !["core_unavailable", "deadline_exceeded", "cancelled"].includes(core.code)
          ? "not_applied"
          : "unknown"),
      retry,
      attempts,
      nextAttemptAt:
        retry === "automatic"
          ? Date.now() +
            Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) * (0.8 + Math.random() * 0.4)
          : null,
    };
  }
  private async drain(epoch: string): Promise<boolean> {
    const journal = this.checkpoint?.staging;
    if (!journal) return false;
    const key = `drain:${contentAccessIdentityKey(this.scope)}:${this.documentId ?? "library"}`;
    const saved = recoveryRecord(await journal.readOperation(key));
    const cursor: Record<RecoverySourceKind, string | null> = {
      yjs: typeof saved?.yjs === "string" ? saved.yjs : null,
      canvas: typeof saved?.canvas === "string" ? saved.canvas : null,
    };
    let next: RecoverySourceKind = saved?.next === "canvas" ? "canvas" : "yjs";
    const exhausted = new Set<RecoverySourceKind>();
    let attempts = 0,
      visited = 0,
      sent = 0,
      changed = false;
    while (attempts < 8 && visited < 50 && exhausted.size < 2) {
      const kind = next;
      next = kind === "yjs" ? "canvas" : "yjs";
      if (exhausted.has(kind)) continue;
      const store = this.store(kind);
      if (!store) {
        exhausted.add(kind);
        continue;
      }
      const before = cursor[kind];
      const page = await store.listSummaries(this.scope, this.documentId, before, 1);
      const entry = page.entries[0];
      if (!entry) {
        cursor[kind] = null;
        exhausted.add(kind);
        continue;
      }
      visited += 1;
      cursor[kind] = page.nextCursor;
      if (!page.nextCursor) exhausted.add(kind);
      if (
        entry.failure &&
        (entry.failure.retry !== "automatic" ||
          (entry.failure.nextAttemptAt ?? Infinity) > Date.now())
      )
        continue;
      attempts += 1;
      try {
        const frozen = await store.freeze(entry, this.scope, epoch);
        if (
          sent &&
          frozen.bundle.bytes.length > CORE_TRANSPORT_BUDGETS.recovery_bundle_bytes - sent
        ) {
          cursor[kind] = before;
          exhausted.delete(kind);
          next = kind;
          break;
        }
        sent += frozen.bundle.bytes.length;
        changed = (await this.transfer(entry, epoch)) || changed;
      } catch (error) {
        await store.recordFailure(entry, this.transferFailure(error, entry.failure));
      }
    }
    await journal.writeOperation(key, { ...cursor, next });
    if (exhausted.size < 2 && this.connections > 0 && !this.continuation)
      this.continuation = setTimeout(() => {
        this.continuation = null;
        void this.refresh();
      }, 20);
    return changed;
  }
  retry = async (sourceKey: string): Promise<void> => {
    const entry = this.state.staged.find((value) => value.sourceKey === sourceKey);
    if (!entry) throw new Error("Refresh the local recovery list before retrying");
    const epoch = await this.readReceived(false);
    if (!epoch) throw new Error("Core is unavailable. You can export the retained local package.");
    try {
      await this.transfer(entry, epoch);
    } catch (error) {
      await this.store(entry.sourceKind)?.recordFailure(
        entry,
        this.transferFailure(error, entry.failure),
      );
      throw error;
    } finally {
      await this.loadLocal(false);
    }
    await this.readReceived(false);
  };
  removeLocal = async (entry: RecoveryStagingSummary): Promise<void> => {
    if (!this.state.staged.some((value) => value.sourceKey === entry.sourceKey))
      throw new Error("Refresh the local recovery list before removing this draft");
    if (this.state.sending.includes(entry.sourceKey))
      throw new Error("Wait for this draft to finish sending before removing it");
    const store = this.store(entry.sourceKind);
    if (!store) throw new Error("Local recovery storage is unavailable");
    await store.remove(entry);
    this.localChanges?.postMessage(null);
    await this.loadLocal(false);
  };
  exportLocal = async (sourceKey: string): Promise<void> => {
    const entry = this.state.staged.find((value) => value.sourceKey === sourceKey);
    if (!entry) throw new Error("Refresh the local recovery list before exporting");
    const store = this.store(entry.sourceKind);
    if (!store) throw new Error("Local recovery storage is unavailable");
    const bytes = await store.export(entry);
    await saveRecoveryExport(this.scope, bytes, this.port.export);
  };
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
    const journal = this.checkpoint?.staging;
    if (journal) {
      try {
        const key = this.pendingKey(draftId);
        const stored = await journal.readOperation(key);
        if (stored !== undefined) {
          const operation = parseRecoveryResolveOperation(
            stored,
            this.scope,
            result.storeEpoch,
            draftId,
          );
          if (result.value.inspection.summary.revision > operation.resolve.revision)
            await this.clearPending(draftId, stored);
        }
      } catch (error) {
        this.publish({ localError: message(error) });
      }
    }
    return result.value.inspection;
  };
  preview = async (
    inspection: RecoveryDraftInspection,
    view: import("../../shared/block-documents/document-recovery").RecoveryPreviewRequest["view"],
  ): Promise<import("../../shared/block-documents/document-recovery").RecoveryPreviewResult> => {
    const result = await this.port.read(this.scope, {
      kind: "preview",
      request: {
        draft_id: inspection.summary.draft_id,
        revision: inspection.summary.revision,
        expected_generation: inspection.current_generation,
        expected_head_seq: inspection.current_head_seq,
        view,
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.kind !== "preview") throw new Error("Unexpected recovery preview");
    return result.value.result;
  };
  private pendingKey(draftId: string): string {
    return JSON.stringify([
      "resolve",
      contentAccessIdentityKey(this.scope),
      this.state.storeEpoch,
      draftId,
    ]);
  }
  private async clearPending(draftId: string, expected: unknown): Promise<void> {
    await this.checkpoint?.staging.acknowledgeOperation(this.pendingKey(draftId), expected);
  }
  resolve = async (
    inspection: RecoveryDraftInspection,
    choice: RecoveryChoice,
  ): Promise<RecoveryDraftSummary> => {
    const epoch = this.state.storeEpoch;
    const journal = this.checkpoint?.staging;
    if (!epoch) throw new Error("Refresh the recovery preview before continuing");
    if (!journal)
      throw new Error("Local recovery storage is unavailable. The action has not been sent.");
    const draftId = inspection.summary.draft_id;
    const key = this.pendingKey(draftId);
    let stored = await journal.readOperation(key);
    const legacyKey = `nodex:recovery-operation:${this.scope.libraryId}:${draftId}`;
    const legacy =
      stored === undefined && typeof localStorage !== "undefined"
        ? localStorage.getItem(legacyKey)
        : null;
    if (legacy)
      stored = parseRecoveryResolveOperation(JSON.parse(legacy), this.scope, epoch, draftId);
    if (stored !== undefined) {
      const existing = parseRecoveryResolveOperation(stored, this.scope, epoch, draftId);
      if (inspection.summary.revision > existing.resolve.revision) {
        await this.clearPending(draftId, stored);
        stored = undefined;
      }
    }
    const candidate =
      stored ??
      ({
        ...this.scope,
        kind: "resolve",
        operationId: createBoundedOperationId(`document.recovery.${choice}`),
        storeEpoch: epoch,
        resolve: {
          draft_id: draftId,
          revision: inspection.summary.revision,
          expected_generation: inspection.current_generation,
          expected_head_seq: inspection.current_head_seq,
          choice: { kind: choice },
        },
      } satisfies DocumentRecoveryCommand);
    const command = parseRecoveryResolveOperation(
      await journal.prepareOperation(key, candidate),
      this.scope,
      epoch,
      draftId,
    );
    if (command.resolve.choice.kind !== choice)
      throw new Error(
        "The previous action has not been confirmed. Retry it or refresh its result first.",
      );
    if (legacy) localStorage.removeItem(legacyKey);
    const result = await this.port.apply(command).catch(async (error: unknown) => {
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
        await this.clearPending(draftId, command);
      throw error;
    });
    this.acceptResolution(result);
    await this.clearPending(draftId, command).catch((error: unknown) =>
      this.publish({ localError: message(error) }),
    );
    return result;
  };
  export = async (draftId: string): Promise<void> => {
    const result = await this.port.export({ ...this.scope, kind: "received", draftId });
    if (!result.ok) throw new Error(result.error.message);
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
