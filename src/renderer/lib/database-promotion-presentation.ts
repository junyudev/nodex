import { createUuidV7 } from "../../shared/uuid-v7";
import {
  beginRendererOwnerTrace,
  recordRendererOwnerTrace,
  beginRendererStructuralSpan,
  withRendererStructuralSpan,
} from "./renderer-causal-trace";
import { useEffectEvent, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type {
  BlockTransferDataSourcePlacement,
  BlockTransferReceipt,
} from "../../shared/block-transfer";
import type { EffectiveDatabaseView } from "../../shared/database-kernel";
import type { HistoryCommandObservation } from "./surface-history/owner";
import { ReceiptFencedOptimisticJournal } from "./receipt-fenced-optimistic-journal";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import {
  databasePromotionReadIdentity,
  type DatabasePromotionReadEvidence,
} from "./database-promotion-read-evidence";
import { getRendererProjectionInvalidationRegistry } from "./projection-invalidation-service";

export interface DatabasePromotionSlot {
  readonly kind: "pending_promotion";
  readonly key: string;
  readonly operationId: string;
  readonly count: number;
  readonly mode: "move" | "copy";
  readonly placement: BlockTransferDataSourcePlacement;
}
export interface DatabasePromotionAdmission {
  readonly gestureIdentity?: string;
  readonly operationId: string;
  readonly rootBlockIds: readonly string[];
  readonly mode: "move" | "copy";
  readonly placement: BlockTransferDataSourcePlacement;
  readonly observe: (
    listener: (state: HistoryCommandObservation<BlockTransferReceipt>) => void,
  ) => () => void;
  readonly refresh: (cursor: {
    readonly storeEpoch: string;
    readonly commitSeq: number;
  }) => Promise<void> | void;
}
interface PromotionModel {
  readonly evidence: DatabasePromotionReadEvidence | null;
  readonly pageIds: ReadonlySet<string>;
  readonly slots: readonly DatabasePromotionSlot[];
}

/** A mounted target owns only display slots and its own bounded-read/render proof. */
export class DatabasePromotionPresentationStore {
  private readonly consumerIdentity = createUuidV7();
  private readonly listeners = new Set<() => void>();
  private readonly observations = new Set<() => void>();
  private readonly dependencyPageIds = new Set<string>();
  private revision = 0;
  private active = false;
  private readonly journal = new ReceiptFencedOptimisticJournal<PromotionModel>({
    onChange: () => {
      this.revision += 1;
      for (const listener of this.listeners) listener();
    },
  });
  constructor(
    readonly identity: string,
    readonly windowKey: string,
    readonly displayIdentity = "",
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): number => this.revision;
  getActivity = () => this.journal.getActivity();
  attach = (): (() => void) => {
    this.active = true;
    return () => {
      this.active = false;
      this.revoke();
    };
  };
  revoke = (): void => {
    for (const release of this.observations) release();
    this.observations.clear();
    this.dependencyPageIds.clear();
    this.journal.revoke("authority_revoked");
    this.revision += 1;
    for (const listener of this.listeners) listener();
  };
  pageDependencies = (): readonly string[] => [...this.dependencyPageIds];
  accept = (input: DatabasePromotionAdmission): void => {
    if (!this.active) return;
    let resultPageIds: readonly string[] | undefined;
    const slot: DatabasePromotionSlot = {
      kind: "pending_promotion",
      key: `promotion:${input.operationId}`,
      operationId: input.operationId,
      count: input.rootBlockIds.length,
      mode: input.mode,
      placement: input.placement,
    };
    const trace = beginRendererOwnerTrace({
      semanticKey: "database.promotion",
      operationIdentity: `${input.operationId}:target:${this.consumerIdentity}`,
      owner: "database-promotion-presentation",
      protocol: "receipt_fenced_projection",
      scopeKind: "database",
    });
    const finishHandoff = beginRendererStructuralSpan({
      gestureIdentity: input.gestureIdentity ?? input.operationId,
      operationIdentity: input.operationId,
      consumerIdentity: this.consumerIdentity,
      phase: "target_handoff",
      blockCount: input.rootBlockIds.length,
    });
    const observed = this.journal.beginObserved<BlockTransferReceipt>({
      trace: (event) => {
        recordRendererOwnerTrace(trace, event);
        if (["rendered", "failed", "revoked"].includes(event.kind)) finishHandoff();
      },
      operationIdentity: input.operationId,
      conflictKeys: [slot.key],
      apply: (model) => {
        const count = resultPageIds?.filter((id) => !model.pageIds.has(id)).length ?? slot.count;
        if (count === 0) return model;
        return {
          ...model,
          slots: [...model.slots, count === slot.count ? slot : { ...slot, count }],
        };
      },
      getCommitCursor: (receipt) => ({
        storeEpoch: receipt.storeEpoch,
        commitSeq: receipt.commitSeq,
      }),
      isCommitMaterialized: (model, receipt) => {
        const evidence = model.evidence;
        if (
          !evidence ||
          evidence.identity !== this.identity ||
          evidence.windowKey !== this.windowKey ||
          evidence.storeEpoch !== receipt.storeEpoch ||
          evidence.commitSeq < receipt.commitSeq
        )
          return false;
        // Both membership and absence come from this complete bounded read.
        const readPages = new Set(evidence.pageIds);
        return (
          receipt.resultRootBlockIds.length > 0 &&
          receipt.resultRootBlockIds.every((id) => readPages.has(id) === model.pageIds.has(id))
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
    release = input.observe((state) => {
      if (state.status === "submitted")
        recordRendererOwnerTrace(trace, { kind: "submitted", reason: "transport_submit" });
      if (state.status === "committed") {
        resultPageIds = state.receipt.resultRootBlockIds;
        for (const id of resultPageIds) this.dependencyPageIds.add(id);
        observed.acknowledge(state.receipt);
        stop();
        // Repair is presentation work; failure cannot change the admitted receipt.
        void Promise.resolve()
          .then(() =>
            withRendererStructuralSpan(
              {
                gestureIdentity: input.gestureIdentity ?? input.operationId,
                operationIdentity: input.operationId,
                consumerIdentity: this.consumerIdentity,
                phase: "target_refresh",
              },
              () =>
                Promise.resolve(
                  input.refresh({
                    storeEpoch: state.receipt.storeEpoch,
                    commitSeq: state.receipt.commitSeq,
                  }),
                ),
            ),
          )
          .catch(() => undefined);
      } else if (state.status === "recovering") observed.unknown();
      else if (["noop", "rejected", "blocked", "revoked"].includes(state.status)) {
        observed.reject();
        stop();
      }
    });
    if (terminal) release();
    else this.observations.add(release);
  };
  project(
    evidence: DatabasePromotionReadEvidence | null,
    pageIds: ReadonlySet<string>,
    canonicalPageIds = pageIds,
  ) {
    return this.journal.project(
      { evidence, pageIds, slots: [] },
      evidence && { storeEpoch: evidence.storeEpoch, commitSeq: evidence.commitSeq },
      true,
      { evidence, pageIds: canonicalPageIds, slots: [] },
    );
  }
  markRendered = (token: number): void => {
    this.journal.markRendered(token);
    if (!this.journal.hasWork()) this.dependencyPageIds.clear();
  };
}

let nextConsumer = 0;
export const useDatabasePromotionPresentation = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly effective: EffectiveDatabaseView;
  readonly evidence: DatabasePromotionReadEvidence | null;
  readonly pageIds: ReadonlySet<string>;
  readonly canonicalPageIds?: ReadonlySet<string>;
  readonly displayIdentity: string;
}) => {
  const identity = databasePromotionReadIdentity(input.model, input.effective);
  const windowKey = input.evidence?.windowKey ?? "pending-window";
  const owner = useMemo(
    () => new DatabasePromotionPresentationStore(identity, windowKey, input.displayIdentity),
    [identity, windowKey, input.displayIdentity],
  );
  const revision = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useLayoutEffect(() => owner.attach(), [owner]);
  const readModel = useEffectEvent(() => input.model);
  useLayoutEffect(() => {
    const model = readModel();
    if (!model.authorization) return;
    return getRendererProjectionInvalidationRegistry().register({
      scope: { ...model.accessContext, libraryId: model.libraryId },
      consumerKey: `database-promotion:${++nextConsumer}`,
      projectionEffects: "ignore",
      getCursor: () => {
        const current = readModel();
        return { storeEpoch: current.storeEpoch, commitSeq: current.commitSeq };
      },
      getDependencies: () => ({
        databaseIds: [model.databaseId],
        dataSourceIds: [model.dataSourceId],
        viewIds: [model.databaseViewId],
        pageIds: owner.pageDependencies(),
      }),
      revoke: owner.revoke,
      fence: owner.revoke,
      invalidate: () => undefined,
    });
  }, [owner]);
  const projected = useMemo(() => {
    void revision;
    return owner.project(input.evidence, input.pageIds, input.canonicalPageIds);
  }, [owner, revision, input.evidence, input.pageIds, input.canonicalPageIds]);
  useLayoutEffect(() => {
    if (projected.renderToken !== null) owner.markRendered(projected.renderToken);
  }, [owner, projected.renderToken]);
  return { owner, slots: projected.model.slots };
};
