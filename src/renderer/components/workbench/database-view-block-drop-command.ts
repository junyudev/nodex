import { toast } from "@/components/ui/toast";
import { transferBlocks } from "@/lib/api";
import { resolveBlockDocumentStructuralMutationParticipant } from "@/lib/block-document-mutation-registry";
import type { DocumentHeadFence } from "@/lib/block-document-surface-runtime";
import { readTaskShorthandPagePromotionEnabled } from "@/lib/page-promotion-preference";
import { summarizePageFileOwnershipMoveCollisions } from "@/lib/page-file-ownership-move-feedback";
import type { BlockTransferDataSourcePlacement } from "../../../shared/block-transfer";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  buildBlockToDataSourceTransferIntent,
  containsCanvasBlockDrag,
  containsDatabaseBlockDrag,
  endLocalBlockDragSession,
  resolvePagePromotionPolicy,
  summarizeBlockPagePromotionReceipt,
  type LocalBlockDragSession,
} from "./block-transfer/cross-surface-drag";
import { undoDatabaseViewBlockTransfer } from "./database-view-block-transfer-undo";
import type { DatabaseViewMutationHistory } from "./database-view-mutation-history";

export interface DatabaseViewBlockDropCommitCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

export interface CommitDatabaseViewBlockDropInput {
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
  const sourceParticipant = resolveBlockDocumentStructuralMutationParticipant(
    payload.sourceSurfaceId,
  );
  if (!sourceParticipant) {
    toast.danger("The dragged Page editor changed; start the drag again.");
    return false;
  }
  let sourceHead: DocumentHeadFence;
  try {
    sourceHead = await sourceParticipant.prepareAndFence();
  } catch (error) {
    toast.danger(
      error instanceof Error ? error.message : "The dragged Page could not prepare for transfer.",
    );
    return false;
  }
  if (sourceHead.storeEpoch !== input.storeEpoch) {
    toast.danger("The dragged Document belongs to another store generation.");
    return false;
  }
  const result = await transferBlocks(
    projectId,
    buildBlockToDataSourceTransferIntent({
      operationId: createUuidV7(),
      projectId,
      storeEpoch: input.storeEpoch,
      payload,
      dataSourceId: input.dataSourceId,
      placement: input.placement,
      altKey: input.altKey,
      promotionPolicy: resolvePagePromotionPolicy({
        preferenceEnabled: readTaskShorthandPagePromotionEnabled(),
        shiftKey: input.shiftKey,
      }),
      causalDependencies: [
        {
          documentId: sourceHead.documentId,
          generation: sourceHead.generation,
          expectedHeadSeq: sourceHead.expectedHeadSeq,
        },
      ],
    }),
  );
  if (!result.ok) {
    toast.danger(result.error.message);
    return false;
  }
  if (result.value.undoToken) {
    input.mutationHistory.registerBlockTransfer(result.value.undoToken);
  }
  const shorthandFeedback = summarizeBlockPagePromotionReceipt(result.value);
  const fileFeedback = summarizePageFileOwnershipMoveCollisions(result.value.fileOwnershipMoves);
  const feedbackOptions =
    result.value.undoToken || fileFeedback
      ? {
          id: `block-transfer:${result.value.operationId}`,
          ...(fileFeedback
            ? {
                description: `${fileFeedback.title}. ${fileFeedback.description}`,
              }
            : {}),
          ...(result.value.undoToken
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    void input.mutationHistory.undoLast({
                      listMove: async () => false,
                      blockTransfer: async (token) =>
                        await undoDatabaseViewBlockTransfer({
                          projectId,
                          storeEpoch: input.storeEpoch,
                          token,
                          onCommitted: input.onCommitted
                            ? async () => await input.onCommitted?.()
                            : undefined,
                        }),
                    });
                    return false;
                  },
                },
              }
            : {}),
        }
      : undefined;
  if (shorthandFeedback) {
    if (shorthandFeedback.tone === "info") {
      toast.info(shorthandFeedback.message, feedbackOptions);
    } else {
      toast.success(shorthandFeedback.message, feedbackOptions);
    }
  } else if (fileFeedback) {
    toast.info(fileFeedback.title, {
      ...feedbackOptions,
      description: fileFeedback.description,
    });
  }
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
