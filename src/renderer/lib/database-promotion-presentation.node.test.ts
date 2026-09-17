import { describe, expect, test, vi } from "vite-plus/test";
import type {
  BlockTransferPresentationPlanResult,
  BlockTransferReceipt,
} from "../../shared/block-transfer";
import type { HistoryCommandObservation } from "./surface-history/owner";
import type { DatabasePromotionReadEvidence } from "./database-promotion-read-evidence";
import { DatabasePromotionPresentationStore } from "./database-promotion-presentation";
import { localStructuralTransactionPresentation } from "./local-structural-transaction-presentation";

const receipt: BlockTransferReceipt = {
  operationId: "move",
  projectId: "project",
  storeEpoch: "epoch",
  mode: "move",
  duplicate: false,
  sourceRootBlockIds: ["source"],
  resultRootBlockIds: ["page"],
  copiedBlockIds: {},
  transformationEvidence: [],
  finalLocations: {},
  finalLocationRevisions: {},
  documentCommits: [],
  affectedDatabaseBlockIds: [],
  commitSeq: 20,
  committedAt: "2026-09-12T00:00:00Z",
  undoToken: null,
  history: null,
};
const read = (pageIds: readonly string[], commitSeq = 20): DatabasePromotionReadEvidence => ({
  identity: "identity",
  windowKey: "window",
  storeEpoch: "epoch",
  scopeKey: "scope",
  commitSeq,
  pageIds,
});
const fixture = () => {
  const owner = new DatabasePromotionPresentationStore("identity");
  const detach = owner.attach();
  const refresh = vi.fn();
  const accept = (operationId = "move") => {
    let listener: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
    owner.accept({
      operationId,
      storeEpoch: "epoch",
      rootBlockIds: ["source"],
      previews: [{ rootBlockId: "source", title: "Source" }],
      mode: "move",
      placement: {
        kind: "direct",
        viewId: "view",
        groupKey: "todo",
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
      },
      refresh,
      observe: (next) => {
        listener = next;
        next({ status: "preparing" });
        return () => {
          listener = undefined;
        };
      },
    });
    return (state: HistoryCommandObservation<BlockTransferReceipt>) => listener?.(state);
  };
  return { owner, detach, accept, refresh };
};
const ack = { status: "committed", receipt, entryId: 1 } as const;

describe("Database promotion presentation", () => {
  test("shows final-looking prediction before planning and an older receipt cannot resurrect it", async () => {
    const owner = new DatabasePromotionPresentationStore("identity");
    const detach = owner.attach();
    let notify: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
    let resolvePlan:
      | ((value: {
          readonly ok: true;
          readonly value: {
            readonly operationId: string;
            readonly mode: "move";
            readonly roots: readonly [
              {
                readonly sourceBlockId: string;
                readonly resultPageId: string;
                readonly transformationKind: "wrap";
              },
            ];
          };
        }) => void)
      | undefined;
    const plan = new Promise<BlockTransferPresentationPlanResult>((resolve) => {
      resolvePlan = resolve;
    });
    owner.accept({
      operationId: "promotion",
      storeEpoch: "epoch",
      rootBlockIds: ["source"],
      previews: [{ rootBlockId: "source", title: "Source" }],
      mode: "move",
      placement: {
        kind: "direct",
        viewId: "view",
        groupKey: "todo",
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
      },
      plan,
      refresh: vi.fn(),
      observe: (listener) => {
        notify = listener;
        listener({ status: "preparing" });
        return () => {
          notify = undefined;
        };
      },
    });

    expect(owner.project(null, new Set()).model.slots).toEqual([
      expect.objectContaining({
        kind: "predicted_promotion",
        operationId: "promotion",
        previews: [{ rootBlockId: "source", title: "Source" }],
      }),
    ]);

    resolvePlan?.({
      ok: true,
      value: {
        operationId: "promotion",
        mode: "move",
        roots: [
          {
            sourceBlockId: "source",
            resultPageId: "wrapped-page",
            transformationKind: "wrap",
          },
        ],
      },
    });
    await plan;
    await Promise.resolve();
    expect(owner.project(null, new Set()).model.slots[0]?.previews).toEqual([
      { rootBlockId: "source", title: "Source", resultPageId: "wrapped-page" },
    ]);

    localStructuralTransactionPresentation.beginDatabasePageMove({
      operationId: "move-away",
      projectId: "project",
      storeEpoch: "epoch",
      dataSourceId: "source",
      pageIds: ["wrapped-page"],
    });
    expect(owner.project(null, new Set()).model.slots).toHaveLength(0);

    notify?.({
      status: "committed",
      entryId: 1,
      receipt: {
        ...receipt,
        operationId: "promotion",
        resultRootBlockIds: ["wrapped-page"],
      },
    });
    expect(owner.project(null, new Set()).model.slots).toHaveLength(0);

    localStructuralTransactionPresentation.reject("move-away");
    localStructuralTransactionPresentation.reject("promotion");
    detach();
  });

  test("ACK hands off through the current bounded read and the current rendered token", async () => {
    const { owner, accept, refresh } = fixture();
    const notify = accept();
    notify(ack);
    expect(owner.project(null, new Set(["page"])).renderToken).toBeNull();
    expect(owner.project(read([], 19), new Set()).renderToken).toBeNull();
    expect(
      owner.project({ ...read([]), identity: "other-panel" }, new Set()).renderToken,
    ).toBeNull();
    const changedWindow = { ...read(["page"]), windowKey: "other-window" };
    const gap = owner.project(changedWindow, new Set(), new Set(["page"]));
    expect(gap.renderToken).toBeNull();
    expect(gap.model.slots).toHaveLength(1);
    const candidate = owner.project(changedWindow, new Set(["page"]), new Set(["page"]));
    expect(candidate.model.slots).toHaveLength(0);
    expect(owner.getActivity().acknowledged).toBe(1);
    owner.project(null, new Set());
    owner.markRendered(candidate.renderToken!);
    expect(owner.getActivity().acknowledged).toBe(1);
    owner.markRendered(
      owner.project(changedWindow, new Set(["page"]), new Set(["page"])).renderToken!,
    );
    expect(owner.getActivity().acknowledged).toBe(0);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ storeEpoch: "epoch", commitSeq: 20 });
  });

  test("a planned Page claim stays owned while the receipt confirms it", async () => {
    const owner = new DatabasePromotionPresentationStore("identity");
    const detach = owner.attach();
    let notify: ((state: HistoryCommandObservation<BlockTransferReceipt>) => void) | undefined;
    const plan = Promise.resolve<BlockTransferPresentationPlanResult>({
      ok: true,
      value: {
        operationId: "planned",
        mode: "move",
        roots: [
          {
            sourceBlockId: "source",
            resultPageId: "page",
            transformationKind: "wrap",
          },
        ],
      },
    });
    owner.accept({
      operationId: "planned",
      storeEpoch: "epoch",
      rootBlockIds: ["source"],
      previews: [{ rootBlockId: "source", title: "Source" }],
      mode: "move",
      placement: {
        kind: "direct",
        viewId: "view",
        groupKey: "todo",
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
      },
      plan,
      refresh: vi.fn(),
      observe: (listener) => {
        notify = listener;
        listener({ status: "preparing" });
        return () => {
          notify = undefined;
        };
      },
    });
    await plan;
    await Promise.resolve();
    expect(owner.project(null, new Set()).model.slots).toHaveLength(1);

    notify?.({
      status: "committed",
      entryId: 1,
      receipt: { ...receipt, operationId: "planned" },
    });

    expect(owner.getActivity().acknowledged).toBe(1);
    expect(owner.project(read([], 19), new Set()).model.slots).toHaveLength(1);
    localStructuralTransactionPresentation.reject("planned");
    detach();
  });

  test("a reshaped bounded window can prove canonical absence without dropping prediction early", () => {
    const { owner, accept } = fixture();
    accept()(ack);
    const reshaped = { ...read([]), windowKey: "through:next-window" };

    const staleVisible = owner.project(reshaped, new Set(["page"]), new Set());
    expect(staleVisible.renderToken).toBeNull();
    expect(staleVisible.model.pageIds.has("page")).toBe(true);
    expect(staleVisible.model.slots).toHaveLength(0);

    const candidate = owner.project(reshaped, new Set(), new Set());
    expect(candidate.model.slots).toHaveLength(0);
    expect(candidate.renderToken).not.toBeNull();
    owner.markRendered(candidate.renderToken!);
    expect(owner.getActivity().acknowledged).toBe(0);
  });

  test("canonical-first recovery keeps one operation and never submits another command", () => {
    const { owner, accept } = fixture();
    const notify = accept();
    notify({ status: "recovering", reason: "Reply lost" });
    expect(owner.project(read(["page"]), new Set(["page"])).renderToken).toBeNull();
    expect(owner.getActivity().unknown).toBe(1);
    notify(ack);
    const candidate = owner.project(read(["page"]), new Set(["page"]));
    expect(candidate.model.slots).toHaveLength(0);
    expect(owner.getActivity().acknowledged).toBe(1);
    owner.markRendered(candidate.renderToken!);
    expect(owner.getActivity().acknowledged).toBe(0);
  });

  test("a visible overlay cannot use another model's membership proof", () => {
    const { owner, accept } = fixture();
    accept()(ack);
    const candidate = owner.project(read(["page"]), new Set(), new Set(["page"]));
    expect(candidate.renderToken).toBeNull();
    expect(candidate.model.slots).toHaveLength(1);
  });

  test("consecutive batches in one group do not supersede each other; detachment drops presentation only", () => {
    const { owner, accept, detach, refresh } = fixture();
    const first = accept("first");
    const second = accept("second");
    expect(owner.project(null, new Set()).model.slots.map((slot) => slot.operationId)).toEqual([
      "first",
      "second",
    ]);
    first({ status: "rejected", reason: "Conflict" });
    expect(owner.project(null, new Set()).model.slots.map((slot) => slot.operationId)).toEqual([
      "second",
    ]);
    detach();
    second(ack);
    expect(owner.project(read([]), new Set()).model.slots).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
