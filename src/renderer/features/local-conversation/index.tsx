import { lazy, type ComponentProps } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";

export {
  __resetLocalConversationStoreForTests,
  consumeLocalConversationComposerIntent,
  CodexAppServerManager,
  CodexAppServerManagerRegistry,
  hydrateLocalConversationThreadSummaries,
  LocalConversationProvider,
  readLocalConversation,
  requestLocalConversationResume,
  requestLocalConversationSnapshot,
  removeLocalConversationPlanImplementationRequest,
  setLocalConversationCollaborationMode,
  setLocalConversationComposerIntent,
  useCodexAppServerControl,
  useCodexAppServerManagerForConversationId,
  useCodexAppServerRegistry,
  useCodexAvailableModels,
  useCodexConversationValue,
  useDefaultCodexAppServerManager,
  useMaybeCodexAppServerManagerForConversationId,
  useCodexThreadStartProgress,
  useComposerIntent,
  useConversation,
  useConversationAttachmentState,
  useConversationCollaborationMode,
  useConversationStreamRole,
  useConversationSubset,
  useLocalConversationAccount,
  useLocalConversationConnection,
  useProjectThreadSummaries,
} from "./local-conversation-store";
export type { LocalConversationAttachmentState } from "./conversation-attachment-state";
export { LocalConversationStageScreen as StageThreads } from "./view/local-conversation-stage-screen";
export type {
  ConnectedThreadComposerDockProps,
  ConnectedThreadStageInput,
} from "./view/connected-thread-stage";
export { ThreadSummaryPanelToggle } from "./view/summary-panel/thread-summary-panel-toggle";
export {
  selectBlockedTurnIds,
  selectConversationLiveRequests,
  selectConversationSearchUnits,
  selectPlanImplementationRequest,
  selectVisibleConversationTurns,
  type LocalConversationSearchUnit,
} from "./selectors";
export type {
  ThreadPlanSidePanelState,
  ThreadPlanSidePanelTarget,
  ThreadStageActions,
  ThreadStageRouteInput,
  SessionThreadCommands,
} from "./thread-stage-types";
// Store consumers do not load conversation, Composer, or review surfaces until presented.
const ThreadComposerDock = lazy(async () => ({
  default: (await import("./view/connected-thread-stage")).ConnectedThreadComposerDock,
}));
const ThreadStage = lazy(async () => ({
  default: (await import("./view/connected-thread-stage")).ConnectedThreadStage,
}));
const ReviewDiffPanel = lazy(async () => ({
  default: (await import("./view/connected-review-diff-panel")).ConnectedReviewDiffPanel,
}));
const SummaryPanelHeaderAction = lazy(async () => ({
  default: (await import("./view/summary-panel/thread-summary-panel-header-action"))
    .ThreadSummaryPanelHeaderAction,
}));

export function ConnectedThreadComposerDock(props: ComponentProps<typeof ThreadComposerDock>) {
  return (
    <ApplicationSurface active={props.visible}>
      <ThreadComposerDock {...props} />
    </ApplicationSurface>
  );
}

export function ConnectedThreadStage(props: ComponentProps<typeof ThreadStage>) {
  return (
    <ApplicationSurface>
      <ThreadStage {...props} />
    </ApplicationSurface>
  );
}

export function ConnectedReviewDiffPanel(props: ComponentProps<typeof ReviewDiffPanel>) {
  return (
    <ApplicationSurface>
      <ReviewDiffPanel {...props} />
    </ApplicationSurface>
  );
}

export function ThreadSummaryPanelHeaderAction(
  props: ComponentProps<typeof SummaryPanelHeaderAction>,
) {
  return (
    <ApplicationSurface>
      <SummaryPanelHeaderAction {...props} />
    </ApplicationSurface>
  );
}
