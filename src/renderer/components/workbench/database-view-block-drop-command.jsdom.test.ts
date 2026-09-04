import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { registerBlockDocumentStructuralMutationParticipant } from "@/lib/block-document-mutation-registry";
import {
  createDatabaseViewMutationHistory,
  type DatabaseViewMutationHistory,
} from "./database-view-mutation-history";
import {
  commitDatabaseViewBlockDrop,
  type CommitDatabaseViewBlockDropInput,
} from "./database-view-block-drop-command";
import type { LocalBlockDragSession } from "./block-transfer/cross-surface-drag";

const mocks = vi.hoisted(() => ({
  transferBlocks: vi.fn(),
  undoBlockTransfer: vi.fn(),
  applyLibraryModule: vi.fn(),
  control: vi.fn(),
  toastDanger: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  transferBlocks: mocks.transferBlocks,
  undoBlockTransfer: mocks.undoBlockTransfer,
  applyLibraryModule: mocks.applyLibraryModule,
  applyDatabaseModule: vi.fn(),
  applyLibraryDatabaseModule: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({
  toast: { danger: mocks.toastDanger, info: mocks.toastInfo, success: mocks.toastSuccess },
}));
vi.mock("@/lib/renderer-command", () => ({ invokeRendererControl: mocks.control }));

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

const inputFor = (
  mutationHistory: DatabaseViewMutationHistory,
): CommitDatabaseViewBlockDropInput => ({
  historyScopeKey: "view-1",
  session,
  projectId: "project-1",
  storeEpoch: "epoch-1",
  dataSourceId: "data-source-1",
  placement: {
    kind: "direct",
    viewId: "view-1",
    preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
    groupKey: null,
  },
  altKey: false,
  shiftKey: false,
  mutationHistory,
});
const success = (operationId: string) => ({
  ok: true,
  value: {
    operationId,
    projectId: "project-1",
    storeEpoch: "epoch-1",
    undoToken: {
      transferOperationId: operationId,
      recipeHash: "recipe:" + operationId,
      storeEpoch: "epoch-1",
    },
    history: {
      recipeOperationId: operationId,
      recipeHash: "recipe:" + operationId,
      storeEpoch: "epoch-1",
    },
    transformationEvidence: [{ promotion: { kind: "no_match" } }],
  },
  localCommit: { status: "committed", commit: { store_epoch: "epoch-1", commit_seq: 3 } },
});
const source = () =>
  registerBlockDocumentStructuralMutationParticipant(session.sourceSurfaceId, {
    prepareAndFence: async () => ({
      documentId: "document-source",
      storeEpoch: "epoch-1",
      generation: 1,
      expectedHeadSeq: 2,
    }),
  });

describe("Database View Block drop command", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.control.mockResolvedValue({ accepted: true });
  });

  test("the View reverses each authoritative opposite without resubmitting the drop", async () => {
    const unregister = source();
    const history = createDatabaseViewMutationHistory("view-1");
    mocks.transferBlocks.mockResolvedValue(success("promotion"));
    mocks.applyLibraryModule.mockImplementation(async (_access, request) => ({
      ok: true,
      value: {
        structuralEdit: {
          history: {
            recipeOperationId: `inverse:${request.operation.token.recipeOperationId}`,
            recipeHash: "recipe:inverse",
            storeEpoch: "epoch-1",
          },
        },
      },
    }));
    try {
      expect(await commitDatabaseViewBlockDrop(inputFor(history))).toBe(true);
      for (const direction of ["undo", "redo", "undo"] as const) {
        expect((await history.request(direction).result).status).toBe("committed");
      }
      expect(
        mocks.applyLibraryModule.mock.calls.map(([access, request]) => ({
          access,
          token: request.operation.token.recipeOperationId,
        })),
      ).toEqual([
        { access: { kind: "project", projectId: "project-1" }, token: "promotion" },
        { access: { kind: "project", projectId: "project-1" }, token: "inverse:promotion" },
        { access: { kind: "project", projectId: "project-1" }, token: "inverse:inverse:promotion" },
      ]);
      expect(mocks.transferBlocks).toHaveBeenCalledTimes(1);
      expect(mocks.undoBlockTransfer).not.toHaveBeenCalled();
      expect(mocks.control).not.toHaveBeenCalled();
      history.close();
      await vi.waitFor(() =>
        expect(mocks.control).toHaveBeenCalledWith(
          "editor-history:release",
          { kind: "project", projectId: "project-1" },
          expect.objectContaining({
            operation: {
              kind: "apply_structural_edit",
              command: {
                kind: "release_history",
                tokens: [
                  {
                    recipeOperationId: "inverse:inverse:inverse:promotion",
                    recipeHash: "recipe:inverse",
                    storeEpoch: "epoch-1",
                  },
                ],
              },
            },
          }),
        ),
      );
    } finally {
      unregister();
    }
  });

  test("a partial transfer capability is released and cannot bypass the whole-gesture barrier", async () => {
    const unregister = source();
    const history = createDatabaseViewMutationHistory("view-1");
    const unsupported = success("partial");
    mocks.transferBlocks.mockResolvedValueOnce(success("older")).mockResolvedValueOnce({
      ...unsupported,
      value: { ...unsupported.value, history: null },
    });
    try {
      await commitDatabaseViewBlockDrop(inputFor(history));
      expect(await commitDatabaseViewBlockDrop(inputFor(history))).toBe(true);
      expect(history.snapshot().undo.status).toBe("blocked");
      expect(await history.undoLast()).toBe(false);
      expect(mocks.toastSuccess.mock.calls[1]?.[1]?.action).toBeUndefined();
      await vi.waitFor(() =>
        expect(mocks.control).toHaveBeenCalledWith(
          "editor-history:release",
          { kind: "project", projectId: "project-1" },
          expect.objectContaining({
            operation: {
              kind: "apply_structural_edit",
              command: {
                kind: "release_history",
                tokens: [
                  {
                    recipeOperationId: "partial",
                    recipeHash: "recipe:partial",
                    storeEpoch: "epoch-1",
                  },
                ],
              },
            },
          }),
        ),
      );
      expect(mocks.applyLibraryModule).not.toHaveBeenCalled();
    } finally {
      history.close();
      unregister();
    }
  });

  test("fails closed when the mounted source editor cannot prepare a causal head", async () => {
    const history = createDatabaseViewMutationHistory("view-1");
    expect(await commitDatabaseViewBlockDrop(inputFor(history))).toBe(false);
    expect(mocks.transferBlocks).not.toHaveBeenCalled();
    expect(history.snapshot().undo.status).toBe("empty");
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      "The dragged Page editor changed; start the drag again.",
    );
  });
  test.each(["forward", "inverse"] as const)(
    "closing the View hands an unknown %s to Main without releasing it early",
    async (phase) => {
      const unregister = source();
      const history = createDatabaseViewMutationHistory("view-1");
      const unknown = {
        ok: false,
        error: {
          code: "unknown",
          message: "Response lost",
          retryable: true,
          reloadRequired: false,
        },
      };
      mocks.transferBlocks.mockResolvedValue(phase === "forward" ? unknown : success("promotion"));
      mocks.applyLibraryModule.mockResolvedValue(unknown);
      try {
        await commitDatabaseViewBlockDrop(inputFor(history));
        if (phase === "inverse")
          expect((await history.request("undo").result).status).toBe("recovering");
        expect(mocks.control).not.toHaveBeenCalled();
        history.close();
        const call =
          phase === "forward"
            ? mocks.transferBlocks.mock.calls[0]!
            : mocks.applyLibraryModule.mock.calls[0]!;
        await vi.waitFor(() =>
          expect(mocks.control).toHaveBeenCalledExactlyOnceWith(
            phase === "forward" ? "editor-history:abandon-transfer" : "editor-history:abandon",
            call[0],
            call[1],
          ),
        );
      } finally {
        unregister();
      }
    },
  );

  test("the success toast can reverse only its still-latest transfer", async () => {
    const unregister = source();
    mocks.transferBlocks
      .mockResolvedValueOnce(success("first"))
      .mockResolvedValueOnce(success("later"));
    try {
      const history = createDatabaseViewMutationHistory("view-1");
      expect(await commitDatabaseViewBlockDrop(inputFor(history))).toBe(true);
      expect(history.snapshot().undo).toMatchObject({ status: "ready", label: "Move to Database" });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Moved as a Page",
        expect.objectContaining({
          id: "block-transfer:first",
          action: expect.objectContaining({ label: "Undo" }),
        }),
      );
      const action = mocks.toastSuccess.mock.calls[0]?.[1]?.action as { onClick: () => void };
      await commitDatabaseViewBlockDrop(inputFor(history));
      action.onClick();
      await vi.waitFor(() =>
        expect(mocks.toastInfo).toHaveBeenCalledWith(
          "This transfer is no longer the latest undoable action in this View.",
        ),
      );
      expect(mocks.undoBlockTransfer).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  test("an unknown Promotion cannot expose the older transfer to Undo", async () => {
    const unregister = source();
    mocks.transferBlocks.mockResolvedValueOnce(success("older")).mockResolvedValue({
      ok: false,
      error: { code: "unknown", message: "Response lost", retryable: true, reloadRequired: false },
    });
    try {
      const history = createDatabaseViewMutationHistory("view-1");
      await commitDatabaseViewBlockDrop(inputFor(history));
      expect(await commitDatabaseViewBlockDrop(inputFor(history))).toBe(false);
      expect(await history.undoLast()).toBe(false);
      expect(mocks.undoBlockTransfer).not.toHaveBeenCalled();
      expect(history.snapshot().undo.status).toBe("waiting");

      mocks.transferBlocks.mockResolvedValueOnce(success("newer"));
      expect((await history.recover().result).status).toBe("committed");
      expect(mocks.transferBlocks.mock.calls[2]?.[1]).toEqual(
        mocks.transferBlocks.mock.calls[1]?.[1],
      );
      mocks.applyLibraryModule.mockResolvedValue({
        ok: true,
        value: { structuralEdit: { history: null } },
      });
      expect(await history.undoLast()).toBe(true);
      expect(mocks.applyLibraryModule.mock.calls[0]?.[1].operation.token.recipeOperationId).toBe(
        "newer",
      );
    } finally {
      unregister();
    }
  });
});
