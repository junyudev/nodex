import { memo, useCallback, useState, type ReactNode } from "react";
import type { MotionValue } from "motion/react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { ThreadScope } from "@/lib/workbench-ui-scopes";
import type {
  ThreadBodySurfaceModel,
  ThreadBodyUiStateOverrides,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import {
  LocalConversationThreadBodyOwner,
  type LocalConversationForkIntoWorktreeHandler,
} from "./local-conversation-thread-body-owner";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";
import { ConversationRecoveryActionsProvider } from "./conversation-recovery-actions";
import { HookFeedbackSettingsNavigationProvider } from "./hook-feedback-settings-navigation";
import { ConversationImageAssetProvider } from "./conversation-image-asset-context";
import { ConversationToolOutputProvider } from "./conversation-tool-output-context";
import { McpAppFollowUpProvider } from "../../../lib/mcp-app/mcp-app-follow-up-context";
import {
  buildMcpAppFollowUpPrompt,
  type McpAppFollowUpMessage,
} from "../../../lib/mcp-app/mcp-app-follow-up";
import {
  EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
  localConversationThreadRestoreSnapshotFamily,
  updateLocalConversationThreadRestoreSnapshot,
  type LocalConversationThreadRestoreSnapshot,
} from "./local-conversation-thread-view-state";
import { resolveImageEditComposerTarget } from "../image-edit-composer-target";
import { CodexTranscriptReadOwnerProvider } from "../normalized-transcript-hooks";
import { ConversationMarkdownSourceProvider } from "./conversation-markdown-source";
import { ComposerAppModelContextProvider } from "./composer/composer-app-model-context";
import {
  InlineVisualizationFollowUpProvider,
  type InlineVisualizationFollowUpMessage,
  type InlineVisualizationAnnotationSubmitHandler,
} from "../../../lib/inline-visualization/inline-visualization-follow-up-context";
import {
  captureInlineVisualizationFollowUp,
  captureInlineVisualizationAnnotationInput,
} from "../../../lib/inline-visualization/inline-visualization-follow-up-input";

interface LocalConversationThreadBodyProps {
  model: ThreadBodySurfaceModel;
  actions: ThreadStageActions;
  isWorktreeThread?: boolean;
  onForkFromTurnIntoWorktree?: LocalConversationForkIntoWorktreeHandler;
  planSidePanelState?: ThreadPlanSidePanelState | null;
  resolveHistoryImage?: import("../thread-stage-types").ConversationProviderPresentation["resolveHistoryImage"];
  resolveRuntimeAttachment?: import("../thread-stage-types").ConversationProviderPresentation["resolveRuntimeAttachment"];
  readToolOutput?: import("../thread-stage-types").ConversationProviderPresentation["readToolOutput"];
  onErrorMessage: (message: string | null) => void;
  contentShiftX?: MotionValue<number>;
  footer?: ReactNode;
  leadingContent?: ReactNode;
  initialUiState?: ThreadBodyUiStateOverrides;
  transcriptVisible?: boolean;
  turnDiffHoverPreviewDisabled?: boolean;
}

type RestoreSnapshotUpdate = (
  current: LocalConversationThreadRestoreSnapshot,
) => LocalConversationThreadRestoreSnapshot;

const ignoreRestoreSnapshotUpdate = () => {};
const readEmptyRestoreSnapshot = () => EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT;

function LocalConversationThreadBodyLayout({
  model,
  actions,
  isWorktreeThread = false,
  onForkFromTurnIntoWorktree,
  planSidePanelState,
  onErrorMessage,
  contentShiftX,
  footer,
  leadingContent,
  initialUiState,
  transcriptVisible = true,
  initialRestoreSnapshot,
  readRestoreSnapshot,
  onRestoreSnapshotChange,
  turnDiffHoverPreviewDisabled = false,
}: LocalConversationThreadBodyProps & {
  readonly initialRestoreSnapshot: LocalConversationThreadRestoreSnapshot;
  readonly readRestoreSnapshot: () => LocalConversationThreadRestoreSnapshot;
  readonly onRestoreSnapshotChange: (update: RestoreSnapshotUpdate) => void;
}) {
  const handleMcpAppFollowUp = useCallback(
    async (message: McpAppFollowUpMessage) =>
      actions.onSendPrompt(buildMcpAppFollowUpPrompt(message)),
    [actions],
  );
  const handleVisualizationFollowUp = useCallback(
    async (message: InlineVisualizationFollowUpMessage) => {
      const options = { untrustedAppMessage: captureInlineVisualizationFollowUp(message) };
      if (model.body.isThreadRunning && model.threadId) {
        await actions.onEnqueueQueuedFollowUp(model.threadId, message.prompt, options);
        return;
      }
      await actions.onSendPrompt(message.prompt, options);
    },
    [actions, model.body.isThreadRunning, model.threadId],
  );
  const handleVisualizationAnnotationSubmit: InlineVisualizationAnnotationSubmitHandler = async (
    message,
  ) => {
    const options = { promptInput: captureInlineVisualizationAnnotationInput(message) };
    if (model.threadId) {
      await actions.onSendCapturedFollowUp(model.threadId, message.prompt, options);
      return;
    }
    await actions.onSendPrompt(message.prompt, options);
  };

  return (
    <LocalConversationThreadScrollLayout
      contentX={contentShiftX}
      footer={footer}
      initialRestoreSnapshot={initialRestoreSnapshot}
    >
      {leadingContent}
      {transcriptVisible ? (
        <div data-local-conversation-transcript="true" className="contents">
          <McpAppFollowUpProvider onSend={handleMcpAppFollowUp}>
            <ComposerAppModelContextProvider>
              <InlineVisualizationFollowUpProvider
                onSend={handleVisualizationFollowUp}
                onSubmitAnnotations={handleVisualizationAnnotationSubmit}
              >
                <LocalConversationThreadBodyOwner
                  body={model.body}
                  projectId={model.projectId}
                  hostId={model.hostId}
                  threadId={model.threadId}
                  isSideChat={model.isSideChat}
                  cwd={model.cwd}
                  turns={model.turns}
                  firstSubmissionTurn={model.firstSubmissionTurn}
                  turnPagination={model.turnPagination ?? null}
                  historyRows={model.historyRows}
                  history={model.history}
                  historyTopologyGeneration={model.historyTopologyGeneration}
                  turnItemsPaginationById={model.turnItemsPaginationById}
                  requests={model.requests}
                  canonicalRequests={model.canonicalRequests ?? []}
                  resumeState={model.resumeState}
                  attachmentState={model.attachmentState}
                  capabilityFlags={model.capabilityFlags}
                  parentTurns={model.parentTurns}
                  childMemberships={model.childMemberships}
                  parentModel={model.parentModel}
                  backgroundAgentRows={model.backgroundAgentRows ?? []}
                  projectWorkspacePath={model.projectWorkspacePath}
                  projectlessOutputDirectory={model.projectlessOutputDirectory}
                  searchOpenTick={model.searchOpenTick}
                  threadStartProgress={model.threadStartProgress}
                  actions={actions}
                  isWorktreeThread={isWorktreeThread}
                  onForkFromTurnIntoWorktree={onForkFromTurnIntoWorktree}
                  planSidePanelState={planSidePanelState}
                  onErrorMessage={onErrorMessage}
                  initialUiState={initialUiState}
                  readRestoreSnapshot={readRestoreSnapshot}
                  onRestoreSnapshotChange={onRestoreSnapshotChange}
                  turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
                />
              </InlineVisualizationFollowUpProvider>
            </ComposerAppModelContextProvider>
          </McpAppFollowUpProvider>
        </div>
      ) : null}
    </LocalConversationThreadScrollLayout>
  );
}

function AttachedLocalConversationThreadBody({
  conversationId,
  ...props
}: LocalConversationThreadBodyProps & { readonly conversationId: string }) {
  const appHandle = useScopeHandle(appScope);
  const restoreAtom = localConversationThreadRestoreSnapshotFamily(conversationId);
  const [initialRestoreSnapshot] = useState(() => appHandle.get(restoreAtom));
  const readRestoreSnapshot = useCallback(
    () => appHandle.get(restoreAtom),
    [appHandle, restoreAtom],
  );

  const updateRestoreSnapshot = useCallback(
    (update: RestoreSnapshotUpdate) => {
      updateLocalConversationThreadRestoreSnapshot(appHandle, conversationId, update);
    },
    [appHandle, conversationId],
  );

  return (
    <LocalConversationThreadBodyLayout
      {...props}
      initialRestoreSnapshot={initialRestoreSnapshot}
      readRestoreSnapshot={readRestoreSnapshot}
      onRestoreSnapshotChange={updateRestoreSnapshot}
    />
  );
}

function LocalConversationThreadBodyScopedRoot(props: LocalConversationThreadBodyProps) {
  const { model } = props;
  const threadScopePath = useScopeHandle(ThreadScope).path;
  const composerTarget = resolveImageEditComposerTarget({
    composerScopeIdentity: model.composerScopeIdentity,
    isSideChat: model.isSideChat,
    threadScopePath,
  });
  return (
    <CodexTranscriptReadOwnerProvider conversationId={model.threadId} hostId={model.hostId}>
      <ConversationMarkdownSourceProvider
        projectId={model.projectId}
        hostId={model.hostId}
        threadId={model.threadId}
        cwd={model.cwd}
        workspaceRoot={model.projectWorkspacePath ?? null}
        onOpenThread={props.actions.onOpenThread}
        onStartNewChatWithPrompt={props.actions.onStartNewChatWithPrompt}
        imageComposerTarget={composerTarget}
        skills={model.skills}
      >
        <HookFeedbackSettingsNavigationProvider
          hostId={model.hostId}
          onOpenHooksSettings={props.actions.onOpenHooksSettings}
        >
          <ConversationImageAssetProvider
            composerTarget={composerTarget}
            hostId={model.hostId}
            conversationId={model.threadId}
            resolveHistoryImage={props.resolveHistoryImage}
            resolveRuntimeAttachment={props.resolveRuntimeAttachment}
          >
            <ConversationToolOutputProvider
              readToolOutput={props.readToolOutput}
              conversationId={model.threadId}
            >
              <ConversationRecoveryActionsProvider
                onContinueAfterFailure={props.actions.onContinueAfterFailure}
                onManageFailedProvider={props.actions.onManageFailedProvider}
              >
                <EnsureLocalConversationThreadScrollController>
                  {model.threadId ? (
                    <AttachedLocalConversationThreadBody
                      key={model.threadId}
                      {...props}
                      conversationId={model.threadId}
                      resolveHistoryImage={props.resolveHistoryImage}
                    />
                  ) : (
                    <LocalConversationThreadBodyLayout
                      {...props}
                      initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
                      readRestoreSnapshot={readEmptyRestoreSnapshot}
                      onRestoreSnapshotChange={ignoreRestoreSnapshotUpdate}
                    />
                  )}
                </EnsureLocalConversationThreadScrollController>
              </ConversationRecoveryActionsProvider>
            </ConversationToolOutputProvider>
          </ConversationImageAssetProvider>
        </HookFeedbackSettingsNavigationProvider>
      </ConversationMarkdownSourceProvider>
    </CodexTranscriptReadOwnerProvider>
  );
}

function LocalConversationThreadBodyComponent(props: LocalConversationThreadBodyProps) {
  const stableBodyIdentity = props.model.sessionId?.trim()
    ? `session:${props.model.sessionId.trim()}`
    : props.model.threadId?.trim()
      ? `conversation:${props.model.threadId.trim()}`
      : props.model.projectId
        ? `project:${props.model.projectId}:new-thread`
        : "projectless:new-thread";
  return <LocalConversationThreadBodyScopedRoot key={stableBodyIdentity} {...props} />;
}

export const LocalConversationThreadBody = memo(
  LocalConversationThreadBodyComponent,
  (left, right) =>
    left.actions === right.actions &&
    left.isWorktreeThread === right.isWorktreeThread &&
    left.onForkFromTurnIntoWorktree === right.onForkFromTurnIntoWorktree &&
    left.resolveHistoryImage === right.resolveHistoryImage &&
    left.resolveRuntimeAttachment === right.resolveRuntimeAttachment &&
    left.readToolOutput === right.readToolOutput &&
    left.planSidePanelState === right.planSidePanelState &&
    left.onErrorMessage === right.onErrorMessage &&
    left.contentShiftX === right.contentShiftX &&
    left.footer === right.footer &&
    left.leadingContent === right.leadingContent &&
    left.initialUiState === right.initialUiState &&
    left.transcriptVisible === right.transcriptVisible &&
    left.turnDiffHoverPreviewDisabled === right.turnDiffHoverPreviewDisabled &&
    left.model.searchOpenTick === right.model.searchOpenTick &&
    left.model.projectWorkspacePath === right.model.projectWorkspacePath &&
    left.model.projectlessOutputDirectory === right.model.projectlessOutputDirectory &&
    left.model.childMemberships === right.model.childMemberships &&
    left.model.backgroundAgentRows === right.model.backgroundAgentRows &&
    left.model.threadStartProgress === right.model.threadStartProgress &&
    left.model.body === right.model.body &&
    left.model.projectId === right.model.projectId &&
    left.model.hostId === right.model.hostId &&
    left.model.sessionId === right.model.sessionId &&
    left.model.threadId === right.model.threadId &&
    left.model.isSideChat === right.model.isSideChat &&
    left.model.cwd === right.model.cwd &&
    left.model.resumeState === right.model.resumeState &&
    left.model.statusType === right.model.statusType &&
    left.model.parentTurns === right.model.parentTurns &&
    left.model.turns === right.model.turns &&
    left.model.firstSubmissionTurn === right.model.firstSubmissionTurn &&
    left.model.turnPagination === right.model.turnPagination &&
    left.model.historyRows === right.model.historyRows &&
    left.model.history === right.model.history &&
    left.model.historyTopologyGeneration === right.model.historyTopologyGeneration &&
    left.model.turnItemsPaginationById === right.model.turnItemsPaginationById &&
    left.model.requests === right.model.requests &&
    left.model.canonicalRequests === right.model.canonicalRequests &&
    left.model.capabilityFlags === right.model.capabilityFlags,
);
