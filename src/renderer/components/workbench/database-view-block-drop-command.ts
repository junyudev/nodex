import { toast } from "@/components/ui/toast";
import type { BlockTransferDataSourcePlacement } from "../../../shared/block-transfer";
import {
  containsCanvasBlockDrag,
  containsDatabaseBlockDrag,
  endLocalBlockDragSession,
  summarizeBlockPagePromotionReceipt,
  summarizeBlockPageTransferSuccess,
  type LocalBlockDragSession,
} from "./block-transfer/cross-surface-drag";
import type { DatabaseViewMutationHistory } from "./database-view-mutation-history";

export interface DatabaseViewBlockDropCommitCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

export interface CommitDatabaseViewBlockDropInput {
  readonly historyScopeKey: string;
  readonly session: LocalBlockDragSession;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly dataSourceId: string;
  readonly placement: BlockTransferDataSourcePlacement;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly mutationHistory: DatabaseViewMutationHistory;
  readonly onCommitted?: (cursor?: DatabaseViewBlockDropCommitCursor) => Promise<void> | void;
}

/** One renderer command for Board/List Block promotion; Core owns final meaning. */
export const commitDatabaseViewBlockDrop = async (
  input: CommitDatabaseViewBlockDropInput,
): Promise<boolean> => {
  const { payload } = input.session;
  endLocalBlockDragSession({ sessionId: input.session.sessionId });
  if (!input.projectId) {
    toast.info("Blocks can only move into a Project Database View.");
    return false;
  }
  const projectId = input.projectId;
  if (payload.projectId !== projectId || payload.storeEpoch !== input.storeEpoch) {
    toast.danger("Block transfer belongs to another Project or store generation.");
    return false;
  }
  if (containsCanvasBlockDrag(payload)) {
    toast.info("Canvas can only move between Page Documents, not into a Database View.");
    return false;
  }
  if (containsDatabaseBlockDrag(payload)) {
    toast.info("Database blocks can only move through a typed Database action.");
    return false;
  }
  let committed;
  try {
    committed = await input.mutationHistory.executeBlockDrop({
      historyScopeKey: input.historyScopeKey,
      session: input.session,
      projectId,
      storeEpoch: input.storeEpoch,
      dataSourceId: input.dataSourceId,
      placement: input.placement,
      altKey: input.altKey,
      shiftKey: input.shiftKey,
    });
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : "The transfer could not be confirmed.");
    return false;
  }
  if (!committed) return false;
  const { result, target: historyTarget } = committed;
  const shorthandFeedback = summarizeBlockPagePromotionReceipt(result.value);
  toast.success(
    summarizeBlockPageTransferSuccess(input.altKey ? "copy" : "move", payload.rootBlockIds.length),
    {
      id: `block-transfer:${result.value.operationId}`,
      ...(shorthandFeedback ? { description: shorthandFeedback.message } : {}),
      ...(result.value.history
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                void input.mutationHistory.undoTarget(historyTarget).then(async (undone) => {
                  if (undone) await input.onCommitted?.();
                  else
                    toast.info(
                      "This transfer is no longer the latest undoable action in this View.",
                    );
                });
                return false;
              },
            },
          }
        : {}),
    },
  );
  const cursor =
    result.localCommit.status === "committed"
      ? {
          storeEpoch: result.localCommit.commit.store_epoch,
          commitSeq: result.localCommit.commit.commit_seq,
        }
      : {
          storeEpoch: result.localCommit.observed.store_epoch,
          commitSeq: result.localCommit.observed.commit_head,
        };
  await input.onCommitted?.(cursor);
  return true;
};
