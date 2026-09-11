import { createUuidV7 } from "../../../../shared/uuid-v7";
import {
  beginRendererOwnerTrace,
  recordRendererOwnerTrace,
  beginRendererStructuralSpan,
} from "@/lib/renderer-causal-trace";
import { getNodeById } from "@blocknote/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type {
  StructuralRemovalPresentation,
  StructuralRemovalReceipt,
} from "@/lib/block-document-mutation-registry";
import type { DocumentHeadFence } from "@/lib/block-document-surface-runtime";
import { ReceiptFencedOptimisticJournal } from "@/lib/receipt-fenced-optimistic-journal";
import {
  setNfmPendingRemovals,
  subscribeNfmStructuralView,
  type NfmPendingRemoval,
} from "./nfm-clipboard-paste-pending-extension";

interface RemovalModel {
  readonly head: DocumentHeadFence | null;
  readonly roots: ReadonlySet<string>;
  readonly pending: readonly NfmPendingRemoval[];
}
interface RemovalEditor {
  readonly prosemirrorState: EditorState;
  readonly domElement: HTMLElement | undefined;
  transact<T>(callback: (transaction: Transaction) => T): T;
}

/** The source requires its Document head and actual editor DOM, independently of the target. */
export class NfmStructuralRemovalPresentation {
  private readonly consumerIdentity = createUuidV7();
  private readonly pending = new Map<string, NfmPendingRemoval>();
  private readonly observations = new Set<() => void>();
  private attached = false;
  private scheduled = false;
  private readonly journal = new ReceiptFencedOptimisticJournal<RemovalModel>({
    onChange: () => this.schedule(),
  });

  constructor(
    private readonly input: {
      readonly editor: RemovalEditor;
      readonly readHead: () => DocumentHeadFence | null;
      readonly subscribeHead: (listener: () => void) => () => void;
    },
  ) {}

  attach = (): (() => void) => {
    this.attached = true;
    const releaseView = subscribeNfmStructuralView(this.input.editor, this.schedule);
    const releaseHead = this.input.subscribeHead(this.schedule);
    this.schedule();
    return () => {
      this.attached = false;
      releaseView();
      releaseHead();
    };
  };

  /** Retained editor disposal, unlike a temporary React view detachment. */
  dispose = (): void => {
    this.attached = false;
    for (const release of this.observations) release();
    this.observations.clear();
    this.pending.clear();
    this.journal.revoke("authority_revoked");
    setNfmPendingRemovals(this.input.editor, []);
  };

  accept = (operation: StructuralRemovalPresentation): void => {
    if (!this.attached || this.pending.has(operation.operationId)) return;
    const admittedHead = this.input.readHead();
    if (!admittedHead) return;
    const marker: NfmPendingRemoval = {
      operationId: operation.operationId,
      rootBlockIds: [...operation.rootBlockIds],
      action: operation.action,
    };
    this.pending.set(operation.operationId, marker);
    const trace = beginRendererOwnerTrace({
      semanticKey: "editor.structural-removal",
      operationIdentity: `${operation.operationId}:source:${this.consumerIdentity}`,
      owner: "structural-source-presentation",
      protocol: "receipt_fenced_projection",
      scopeKind: "document",
    });
    const finishHandoff = beginRendererStructuralSpan({
      gestureIdentity: operation.gestureIdentity ?? operation.operationId,
      operationIdentity: operation.operationId,
      consumerIdentity: this.consumerIdentity,
      phase: "source_handoff",
      blockCount: marker.rootBlockIds.length,
    });
    const observed = this.journal.beginObserved<StructuralRemovalReceipt>({
      trace: (event) => {
        recordRendererOwnerTrace(trace, event);
        if (["rendered", "failed", "revoked"].includes(event.kind)) finishHandoff();
      },
      operationIdentity: operation.operationId,
      conflictKeys: [`removal:${operation.operationId}`],
      apply: (model) => ({ ...model, pending: [...model.pending, marker] }),
      isCommitMaterialized: (model, receipt) => {
        const commit = receipt.documentCommits.find(
          (item) => item.documentId === admittedHead.documentId,
        );
        const { head } = model;
        return (
          !!commit &&
          !!head &&
          receipt.storeEpoch === head.storeEpoch &&
          head.documentId === admittedHead.documentId &&
          head.generation === commit.generation &&
          head.expectedHeadSeq >= commit.headSeq &&
          marker.rootBlockIds.every((id) => !model.roots.has(id))
        );
      },
    });
    let terminal = false;
    let release: (() => void) | undefined;
    const stop = () => {
      terminal = true;
      if (release) {
        release();
        this.observations.delete(release);
      }
    };
    release = operation.observe((state) => {
      if (state.status === "submitted")
        recordRendererOwnerTrace(trace, { kind: "submitted", reason: "transport_submit" });
      if (state.status === "committed") {
        observed.acknowledge(state.receipt);
        stop();
      } else if (state.status === "recovering") observed.unknown();
      else if (["noop", "rejected", "blocked", "revoked"].includes(state.status)) {
        observed.reject();
        this.pending.delete(operation.operationId);
        stop();
      }
    });
    if (terminal) release();
    else this.observations.add(release);
    // Admission feedback is synchronous; subsequent provider/view updates coalesce.
    this.reconcile();
  };

  private schedule = (): void => {
    if (!this.attached || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.attached) this.reconcile();
    });
  };

  private reconcile(): void {
    const { editor } = this.input;
    const head = this.input.readHead();
    if (!head) {
      this.journal.revoke("authority_revoked");
      this.pending.clear();
      for (const release of this.observations) release();
      this.observations.clear();
      setNfmPendingRemovals(editor, []);
      return;
    }
    const roots = new Set<string>();
    for (const marker of this.pending.values()) {
      for (const id of marker.rootBlockIds) {
        if (
          getNodeById(id, editor.prosemirrorState.doc) ||
          editor.domElement?.querySelector(`[data-id="${CSS.escape(id)}"]`)
        )
          roots.add(id);
      }
    }
    const projected = this.journal.project({ head, roots, pending: [] }, null);
    setNfmPendingRemovals(editor, projected.model.pending);
    if (projected.renderToken !== null && editor.domElement?.isConnected)
      this.journal.markRendered(projected.renderToken);
    for (const operationId of this.pending.keys()) {
      if (!this.journal.hasMatchingConflict((keys) => keys.includes(`removal:${operationId}`)))
        this.pending.delete(operationId);
    }
  }
}
