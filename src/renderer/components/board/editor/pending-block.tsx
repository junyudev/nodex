import { createReactBlockSpec } from "@blocknote/react";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { useAskProgress } from "@/lib/use-ask-progress";
import { usePageDiscussionsControllerContext } from "@/features/page-discussions/page-discussions-context";
import { PendingBlockView } from "@/features/page-discussions/view/pending-block-view";
import {
  documentCommentMark,
  pendingBlockConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";

/**
 * A place in the Page where Nodex is working. With a Discussion it follows that Ask's state and
 * offers Stop, Retry and Remove; without one it is a placeholder an Agent wrote while drafting.
 */
export const createPendingBlockSpec = createReactBlockSpec(
  pendingBlockConfig,
  {
    render: function PendingBlock({ block, editor }) {
      const controller = usePageDiscussionsControllerContext();
      const discussion = block.props.discussion
        ? (controller?.views.find((view) => view.id === block.props.discussion) ?? null)
        : null;
      const request = discussion?.comments.find((comment) => comment.ask) ?? null;
      const ask = request?.ask ?? null;
      const requesterName = request?.author.kind === "member" ? request.author.name : null;
      const sessionId = ask?.sessionId ?? null;
      const progress = useAskProgress({ sessionId, runId: ask?.runId });
      const startedAt = progress.startedAt ?? request?.createdAtMs ?? null;
      return (
        <PendingBlockView
          title={block.props.intent || discussion?.quote || ""}
          state={ask?.state ?? null}
          steps={progress.steps}
          requesterName={requesterName}
          elapsedLabel={
            startedAt !== null && controller
              ? formatCompactRelativeTime(startedAt, controller.nowMs)
              : null
          }
          failureMessage={null}
          onStop={controller && request ? () => controller.actions.stopAsk(request.id) : null}
          onRetry={controller && request ? () => controller.actions.retryAsk(request.id) : null}
          onRemove={
            editor.isEditable
              ? () => {
                  editor.removeBlocks([block.id]);
                  if (discussion && controller) controller.actions.resolve(discussion.id);
                }
              : null
          }
          onOpenDiscussion={
            controller && discussion ? () => controller.setActiveId(discussion.id) : null
          }
          onOpenConversation={
            controller && sessionId ? () => controller.actions.openConversation(sessionId) : null
          }
        />
      );
    },
  },
  [documentCommentMark],
);
