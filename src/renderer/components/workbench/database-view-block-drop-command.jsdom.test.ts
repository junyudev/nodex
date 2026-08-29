import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { registerBlockDocumentStructuralMutationParticipant } from "@/lib/block-document-mutation-registry";
import { createDatabaseViewMutationHistory } from "./database-view-mutation-history";
import { commitDatabaseViewBlockDrop } from "./database-view-block-drop-command";
import type { LocalBlockDragSession } from "./block-transfer/cross-surface-drag";

const mocks = vi.hoisted(() => ({
  transferBlocks: vi.fn(),
  toastDanger: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  transferBlocks: mocks.transferBlocks,
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    danger: mocks.toastDanger,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

const session: LocalBlockDragSession = {
  sessionId: "drag-session-missing-participant",
  sourceSurfaceId: "surface-missing-participant",
  payload: {
    version: 2,
    kind: "block_transfer",
    sessionId: "drag-session-missing-participant",
    sourceSurfaceId: "surface-missing-participant",
    projectId: "project-1",
    storeEpoch: "epoch-1",
    source: { kind: "page", pageId: "page-source" },
    rootBlockIds: ["block-source"],
    displayHints: ["paragraph"],
  },
};

describe("Database View Block drop command", () => {
  beforeEach(() => {
    mocks.transferBlocks.mockReset();
    mocks.toastDanger.mockReset();
    mocks.toastInfo.mockReset();
    mocks.toastSuccess.mockReset();
  });

  test("fails closed when the mounted source editor cannot prepare a causal head", async () => {
    const committed = await commitDatabaseViewBlockDrop({
      session,
      projectId: "project-1",
      storeEpoch: "epoch-1",
      dataSourceId: "data-source-1",
      placement: {
        kind: "direct",
        viewId: "view-1",
        presentationOverride: { layout: "board" },
        groupKey: null,
      },
      altKey: false,
      shiftKey: false,
      mutationHistory: createDatabaseViewMutationHistory("view-1"),
    });

    expect(committed).toBe(false);
    expect(mocks.transferBlocks).not.toHaveBeenCalled();
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      "The dragged Page editor changed; start the drag again.",
    );
  });

  test("confirms ordinary literal promotions and exposes their Undo action", async () => {
    const unregister = registerBlockDocumentStructuralMutationParticipant(session.sourceSurfaceId, {
      prepareAndFence: async () => ({
        documentId: "document-source",
        storeEpoch: "epoch-1",
        generation: 1,
        expectedHeadSeq: 2,
      }),
    });
    mocks.transferBlocks.mockResolvedValue({
      ok: true,
      value: {
        operationId: "operation:promotion",
        undoToken: {
          transferOperationId: "operation:promotion",
          recipeHash: "recipe:promotion",
          storeEpoch: "epoch-1",
        },
        fileOwnershipMoves: [],
        transformationEvidence: [{ promotion: { kind: "no_match" } }],
      },
      localCommit: {
        status: "committed",
        commit: { store_epoch: "epoch-1", commit_seq: 3 },
      },
    });

    try {
      const mutationHistory = createDatabaseViewMutationHistory("view-1");
      const committed = await commitDatabaseViewBlockDrop({
        session,
        projectId: "project-1",
        storeEpoch: "epoch-1",
        dataSourceId: "data-source-1",
        placement: {
          kind: "direct",
          viewId: "view-1",
          presentationOverride: { layout: "board" },
          groupKey: null,
        },
        altKey: false,
        shiftKey: false,
        mutationHistory,
      });

      expect(committed).toBe(true);
      expect(mocks.toastInfo).not.toHaveBeenCalled();
      expect(mutationHistory.size()).toBe(1);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Moved as a Page",
        expect.objectContaining({
          id: "block-transfer:operation:promotion",
          action: expect.objectContaining({ label: "Undo" }),
        }),
      );
    } finally {
      unregister();
    }
  });
});
