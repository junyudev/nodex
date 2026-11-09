import { useQuery } from "@tanstack/react-query";
import { SidePanelSideChatIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { ConversationContentFrame } from "@/components/ui/conversation-content-frame";
import type { ThreadStageActions } from "@/features/local-conversation/thread-stage-types";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { sessionExecutionThreadId } from "@/lib/session-execution";
import type { Project } from "@/lib/types";
import type { SideChatCreation } from "@/lib/workbench-panel-tab-model";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { AgentRuntimeSideChatPanel } from "./workbench-agent-runtime-panels";
import { SideChatFailedPanel, SideChatLoadingPanel } from "./workbench-side-chat-panels";

/**
 * The body of a side chat's durable tab. The tab exists before its Session does, so it shows the
 * Session's creation first, then the side chat itself, or that it no longer exists.
 */
export function SideChatSurfacePanel(props: {
  readonly sideChatSessionId: string;
  readonly sourceSession: WorkbenchSessionRenderProjection;
  readonly title: string;
  readonly creation: SideChatCreation | null;
  readonly projects: readonly Project[];
  readonly composerEnterBehavior: ComposerEnterBehavior;
  readonly turnDiffHoverPreviewDisabled: boolean;
  readonly onTitleChange: (title: string) => void;
  readonly onInitialSubmissionSettled: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly onRefreshSessions: (projectId: string | null) => Promise<unknown>;
  readonly onOpenThread: ThreadStageActions["onOpenThread"];
  readonly onOpenTurnDiffReview: ThreadStageActions["onOpenTurnDiffReview"];
  readonly onOpenTurnDiffFileInSidePanel: NonNullable<
    ThreadStageActions["onOpenTurnDiffFileInSidePanel"]
  >;
}) {
  const creating = props.creation?.status === "creating" || props.creation?.status === "failed";
  const sessionQuery = useQuery({
    ...projectSessionDetailQueryOptions(props.sideChatSessionId),
    enabled: !creating,
  });
  const session = sessionQuery.data;
  const parentThreadId = sessionExecutionThreadId(props.sourceSession);

  let content;
  if (props.creation?.status === "failed")
    content = (
      <SideChatFailedPanel
        errorMessage={props.creation.errorMessage ?? "The side chat could not be opened."}
        onRetry={props.onRetry}
      />
    );
  else if (creating || sessionQuery.isPending)
    content = <SideChatLoadingPanel title={props.title} />;
  else if (!session?.executionRef || !parentThreadId)
    content = <SideChatUnavailablePanel onClose={props.onClose} />;
  else {
    const opening = props.creation?.initialSubmission;
    content = (
      <AgentRuntimeSideChatPanel
        session={session}
        parentThreadId={parentThreadId}
        title={props.title}
        onTitleChange={props.onTitleChange}
        onInitialSubmissionSettled={props.onInitialSubmissionSettled}
        initialSubmission={opening}
        project={props.projects.find((project) => project.id === session.projectId) ?? null}
        initialPrompt={
          opening
            ? {
                prompt: props.creation?.draftPrompt ?? "",
                promptInput: props.creation?.draftPromptInput,
              }
            : null
        }
        onRefresh={props.onRefreshSessions}
        onOpenThread={props.onOpenThread}
        composerEnterBehavior={props.composerEnterBehavior}
        hostActions={{
          onOpenTurnDiffReview: props.onOpenTurnDiffReview,
          onOpenTurnDiffFileInSidePanel: props.onOpenTurnDiffFileInSidePanel,
        }}
        turnDiffHoverPreviewDisabled={props.turnDiffHoverPreviewDisabled}
      />
    );
  }
  return (
    <ConversationContentFrame topFade className="h-full">
      {content}
    </ConversationContentFrame>
  );
}

function SideChatUnavailablePanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary p-3 select-none">
      <div className="m-auto flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-token-bg-secondary text-token-text-secondary">
          <SidePanelSideChatIcon className="icon-md" />
        </div>
        <div className="text-base font-semibold text-token-text-primary">Side chat unavailable</div>
        <div className="mt-1 text-sm text-token-text-secondary">This side chat was deleted.</div>
        <NodexButton type="button" size="sm" className="mt-4" onClick={onClose}>
          Close tab
        </NodexButton>
      </div>
    </div>
  );
}
