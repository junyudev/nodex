import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
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
  useLocalConversationThreadScrollController,
} from "./local-conversation-thread-scroll-controller";
import { HookFeedbackSettingsNavigationProvider } from "./hook-feedback-settings-navigation";
import { ConversationImageAssetProvider } from "./conversation-image-asset-context";
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

interface LocalConversationThreadBodyProps {
  model: ThreadBodySurfaceModel;
  actions: ThreadStageActions;
  isWorktreeThread?: boolean;
  onForkFromTurnIntoWorktree?: LocalConversationForkIntoWorktreeHandler;
  planSidePanelState?: ThreadPlanSidePanelState | null;
  onErrorMessage: (message: string | null) => void;
  contentShiftX?: number;
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

function LocalConversationThreadBodyLayout({
  model,
  actions,
  isWorktreeThread = false,
  onForkFromTurnIntoWorktree,
  planSidePanelState,
  onErrorMessage,
  contentShiftX = 0,
  footer,
  leadingContent,
  initialUiState,
  transcriptVisible = true,
  initialRestoreSnapshot,
  onRestoreSnapshotChange,
  turnDiffHoverPreviewDisabled = false,
}: LocalConversationThreadBodyProps & {
  readonly initialRestoreSnapshot: LocalConversationThreadRestoreSnapshot;
  readonly onRestoreSnapshotChange: (update: RestoreSnapshotUpdate) => void;
}) {
  const handleMcpAppFollowUp = useCallback(
    async (message: McpAppFollowUpMessage) =>
      actions.onSendPrompt(buildMcpAppFollowUpPrompt(message)),
    [actions],
  );

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
            <LocalConversationThreadBodyOwner
              body={model.body}
              projectId={model.projectId}
              threadId={model.threadId}
              isSideChat={model.isSideChat}
              cwd={model.cwd}
              turns={model.turns}
              turnPagination={model.turnPagination ?? null}
              historyRows={model.historyRows}
              conversationEntityGeneration={model.conversationEntityGeneration}
              historyTopologyGeneration={model.historyTopologyGeneration}
              historyMutationRevision={model.historyMutationRevision}
              historyItemWindowsByTurnId={model.historyItemWindowsByTurnId}
              turnItemsPaginationById={model.turnItemsPaginationById}
              requests={model.requests}
              canonicalRequests={model.canonicalRequests ?? []}
              resumeState={model.resumeState}
              attachmentState={model.attachmentState}
              capabilityFlags={model.capabilityFlags}
              statusType={model.statusType}
              parentTurns={model.parentTurns}
              childMemberships={model.childMemberships}
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
              initialRestoreSnapshot={initialRestoreSnapshot}
              onRestoreSnapshotChange={onRestoreSnapshotChange}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
            />
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
  const { addScrollListener } = useLocalConversationThreadScrollController();
  const restoreAtom = localConversationThreadRestoreSnapshotFamily(conversationId);
  const initialRestoreSnapshotRef = useRef(appHandle.get(restoreAtom));

  const updateRestoreSnapshot = useCallback(
    (update: RestoreSnapshotUpdate) => {
      updateLocalConversationThreadRestoreSnapshot(appHandle, conversationId, update);
    },
    [appHandle, conversationId],
  );

  useLayoutEffect(
    () =>
      addScrollListener((distanceFromBottomPx) => {
        updateRestoreSnapshot((current) => ({
          ...current,
          distanceFromBottomPx: Number.isFinite(distanceFromBottomPx)
            ? Math.max(0, distanceFromBottomPx)
            : 0,
        }));
      }),
    [addScrollListener, updateRestoreSnapshot],
  );

  return (
    <LocalConversationThreadBodyLayout
      {...props}
      initialRestoreSnapshot={initialRestoreSnapshotRef.current}
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
    <HookFeedbackSettingsNavigationProvider
      hostId={model.hostId}
      onOpenHooksSettings={props.actions.onOpenHooksSettings}
    >
      <ConversationImageAssetProvider
        composerTarget={composerTarget}
        hostId={model.hostId}
        conversationId={model.threadId}
      >
        <EnsureLocalConversationThreadScrollController>
          {model.threadId ? (
            <AttachedLocalConversationThreadBody
              key={model.threadId}
              {...props}
              conversationId={model.threadId}
            />
          ) : (
            <LocalConversationThreadBodyLayout
              {...props}
              initialRestoreSnapshot={EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT}
              onRestoreSnapshotChange={ignoreRestoreSnapshotUpdate}
            />
          )}
        </EnsureLocalConversationThreadScrollController>
      </ConversationImageAssetProvider>
    </HookFeedbackSettingsNavigationProvider>
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
    left.model.turnPagination === right.model.turnPagination &&
    left.model.historyRows === right.model.historyRows &&
    left.model.conversationEntityGeneration === right.model.conversationEntityGeneration &&
    left.model.historyTopologyGeneration === right.model.historyTopologyGeneration &&
    left.model.historyMutationRevision === right.model.historyMutationRevision &&
    left.model.historyItemWindowsByTurnId === right.model.historyItemWindowsByTurnId &&
    left.model.turnItemsPaginationById === right.model.turnItemsPaginationById &&
    left.model.requests === right.model.requests &&
    left.model.canonicalRequests === right.model.canonicalRequests &&
    left.model.capabilityFlags === right.model.capabilityFlags,
);
