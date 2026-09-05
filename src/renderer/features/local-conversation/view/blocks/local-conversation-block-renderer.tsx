import { AsyncQuestionTranscript } from "../composer/async-question-surface";
import {
  ThreadAutomaticApprovalReviewBlock,
  ThreadAgentActivityGroupBlock,
  ThreadMultiAgentActionBlock,
  ThreadAssistantActionsBlock,
  ThreadAssistantBodyBlock,
  ThreadContextCompactionBlock,
  ThreadHookBlock,
  ThreadGeneratedImageGalleryBlock,
  ThreadImageViewBlock,
  ThreadMcpServerElicitationBlock,
  ThreadPlanCardBlock,
  ThreadPlanImplementationBlock,
  ThreadReasoningBlock,
  ThreadStreamErrorBlock,
  ThreadSubagentActivityInlineGroupBlock,
  ThreadSystemErrorBlock,
  ThreadSystemBannerBlock,
  ThreadTurnDiffBlock,
  ThreadUserAttachmentStripBlock,
  ThreadToolSurfaceBlock,
  ThreadUserInputResponseCard,
  ThreadUserBubbleBlock,
  ThreadWorktreeInitBlock,
  ThreadWorkedForBlock,
} from "./local-conversation-block-leaves";
import type { CodexConversationChildMembership } from "../../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type {
  ThreadBlockModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../../thread-stage-types";

interface ThreadBlockRendererProps {
  block: ThreadBlockModel;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  isSearchMatch?: boolean;
  isActiveSearchMatch?: boolean;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  childMemberships?: readonly CodexConversationChildMembership[];
  threadCwd?: string | null;
  onEditLastUserTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => void | Promise<void>;
  onForkFromTurn?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  allowInProgressTurnDiff?: boolean;
  turnDiffHoverPreviewDisabled?: boolean;
  alwaysShowAssistantMessageActions?: boolean;
  compactUserMessageActions?: boolean;
}

export function ThreadBlockRenderer({
  block,
  isLatestTurn,
  isStreamingTurn,
  isSearchMatch = false,
  isActiveSearchMatch = false,
  projectWorkspacePath,
  projectlessOutputDirectory,
  childMemberships,
  threadCwd,
  onEditLastUserTurn,
  onForkFromTurn,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  allowInProgressTurnDiff = false,
  turnDiffHoverPreviewDisabled = false,
  alwaysShowAssistantMessageActions = false,
  compactUserMessageActions = false,
}: ThreadBlockRendererProps) {
  if (block.type === "agentActivityGroup") {
    return (
      <ThreadAgentActivityGroupBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        projectWorkspacePath={projectWorkspacePath}
        projectlessOutputDirectory={projectlessOutputDirectory}
        threadCwd={threadCwd}
        onOpenTurnDiffReview={onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
        onOpenThread={onOpenThread}
        onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
        onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
      />
    );
  }

  if (block.type === "userAttachmentStrip") {
    return (
      <ThreadUserAttachmentStripBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "workedFor") {
    return <ThreadWorkedForBlock block={block} />;
  }

  if (
    block.type === "exec" ||
    block.type === "fileChange" ||
    block.type === "mcpToolCall" ||
    block.type === "dynamicToolCall" ||
    block.type === "webSearch"
  ) {
    return (
      <ThreadToolSurfaceBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        projectWorkspacePath={projectWorkspacePath}
        projectlessOutputDirectory={projectlessOutputDirectory}
        threadCwd={threadCwd}
        onOpenTurnDiffReview={onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
        onOpenThread={onOpenThread}
        onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
        onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
      />
    );
  }

  if (block.type === "automaticApprovalReview") {
    return (
      <ThreadAutomaticApprovalReviewBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "multiAgentAction") {
    return (
      <ThreadMultiAgentActionBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        childMemberships={childMemberships}
        onOpenThread={onOpenThread}
      />
    );
  }

  if (block.type === "subagentActivityInlineGroup") {
    return (
      <ThreadSubagentActivityInlineGroupBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        onOpenThread={onOpenThread}
      />
    );
  }

  if (block.type === "turnDiff") {
    return (
      <ThreadTurnDiffBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        projectWorkspacePath={projectWorkspacePath}
        projectlessOutputDirectory={projectlessOutputDirectory}
        threadCwd={threadCwd}
        onOpenTurnDiffReview={onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
        allowInProgressTurnDiff={allowInProgressTurnDiff}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
      />
    );
  }

  if (block.type === "userMessage") {
    return (
      <ThreadUserBubbleBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        isSearchMatch={isSearchMatch}
        isActiveSearchMatch={isActiveSearchMatch}
        onEditLastUserTurn={onEditLastUserTurn}
        onForkFromTurn={onForkFromTurn}
        onOpenSideChat={onOpenSideChat}
        threadCwd={threadCwd}
        compactUserMessageActions={compactUserMessageActions}
      />
    );
  }

  if (block.type === "reasoning") {
    return (
      <ThreadReasoningBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        threadCwd={threadCwd}
        onOpenPlanInSidePanel={onOpenPlanInSidePanel}
        onClosePlanSidePanel={onClosePlanSidePanel}
        planSidePanelState={planSidePanelState}
      />
    );
  }

  if (block.type === "proposedPlan" || block.type === "todoList") {
    return (
      <ThreadPlanCardBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        threadCwd={threadCwd}
        onOpenPlanInSidePanel={onOpenPlanInSidePanel}
        onClosePlanSidePanel={onClosePlanSidePanel}
        planSidePanelState={planSidePanelState}
      />
    );
  }

  if (block.type === "steered") {
    return null;
  }

  if (block.type === "assistantMessage") {
    const assistantAfter =
      block.assistantAfterBlocks && block.assistantAfterBlocks.length > 0 ? (
        <div className="flex w-full flex-col gap-3" data-assistant-after-blocks={block.id}>
          {block.assistantAfterBlocks.map((assistantAfterBlock) => (
            <ThreadBlockRenderer
              key={assistantAfterBlock.id}
              block={assistantAfterBlock}
              isLatestTurn={isLatestTurn}
              isStreamingTurn={isStreamingTurn}
              projectWorkspacePath={projectWorkspacePath}
              childMemberships={childMemberships}
              threadCwd={threadCwd}
              onEditLastUserTurn={onEditLastUserTurn}
              onForkFromTurn={onForkFromTurn}
              onOpenTurnDiffReview={onOpenTurnDiffReview}
              onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
              onOpenSideChat={onOpenSideChat}
              onOpenThread={onOpenThread}
              onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
              onOpenPlanInSidePanel={onOpenPlanInSidePanel}
              onClosePlanSidePanel={onClosePlanSidePanel}
              planSidePanelState={planSidePanelState}
              allowInProgressTurnDiff={allowInProgressTurnDiff}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
              alwaysShowAssistantMessageActions={alwaysShowAssistantMessageActions}
            />
          ))}
        </div>
      ) : null;
    const body = (
      <ThreadAssistantBodyBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        isSearchMatch={isSearchMatch}
        isActiveSearchMatch={isActiveSearchMatch}
        onForkFromTurn={onForkFromTurn}
        onOpenSideChat={onOpenSideChat}
        assistantAfter={assistantAfter}
        alwaysShowAssistantMessageActions={alwaysShowAssistantMessageActions}
      />
    );

    if (block.entry.asyncQuestion)
      return (
        <AsyncQuestionTranscript
          threadId={block.entry.threadId}
          questionId={block.entry.asyncQuestion.id}
        >
          {body}
        </AsyncQuestionTranscript>
      );

    if (block.assistantMessageActions || assistantAfter) {
      return (
        <div className="flex flex-col" data-local-conversation-final-assistant="true">
          {body}
        </div>
      );
    }

    return body;
  }

  if (block.type === "assistantActions") {
    return (
      <ThreadAssistantActionsBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
        onForkFromTurn={onForkFromTurn}
        onOpenSideChat={onOpenSideChat}
        alwaysShowAssistantMessageActions={alwaysShowAssistantMessageActions}
      />
    );
  }

  if (block.type === "userInputResponse") {
    return (
      <ThreadUserInputResponseCard
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "mcpServerElicitation") {
    return (
      <ThreadMcpServerElicitationBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "imageView") {
    return (
      <ThreadImageViewBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "generatedImageGallery") {
    return (
      <ThreadGeneratedImageGalleryBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "hook") {
    return (
      <ThreadHookBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "planImplementation") {
    return (
      <ThreadPlanImplementationBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "contextCompaction") {
    return (
      <ThreadContextCompactionBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "worktreeInit") {
    return (
      <ThreadWorktreeInitBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "streamError") {
    return (
      <ThreadStreamErrorBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  if (block.type === "systemError") {
    return (
      <ThreadSystemErrorBlock
        block={block}
        isLatestTurn={isLatestTurn}
        isStreamingTurn={isStreamingTurn}
      />
    );
  }

  return (
    <ThreadSystemBannerBlock
      block={block}
      isLatestTurn={isLatestTurn}
      isStreamingTurn={isStreamingTurn}
    />
  );
}
