import type { BlockTransferUndoToken } from "../../../shared/block-transfer";
import { undoBlockTransfer } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { summarizePageFileOwnershipMoveCollisions } from "@/lib/page-file-ownership-move-feedback";

export async function undoDatabaseViewBlockTransfer(input: {
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly token: BlockTransferUndoToken;
  readonly onCommitted?: () => void | Promise<void>;
}): Promise<boolean> {
  const result = await undoBlockTransfer(input.projectId, {
    operationId: createUuidV7(),
    projectId: input.projectId,
    storeEpoch: input.storeEpoch,
    token: input.token,
  });
  if (!result.ok) {
    toast.warning(
      result.error.code === "undo_conflict"
        ? "This promotion can’t be undone because its Page or source changed afterward."
        : result.error.message,
    );
    return false;
  }
  await input.onCommitted?.();
  const fileFeedback = summarizePageFileOwnershipMoveCollisions(result.value.fileOwnershipMoves);
  toast.info("Block promotion undone.", {
    id: `block-transfer-undo:${result.value.operationId}`,
    ...(fileFeedback ? { description: `${fileFeedback.title}. ${fileFeedback.description}` } : {}),
  });
  return true;
}
