import {
  createElectronRendererTransport,
  type ElectronRendererBridge,
} from "./electron-renderer-transport";
import type { CommandKeymapState } from "../../shared/command-keybindings";
import type { BoardChangeEvent } from "../../shared/ipc-api";
import type { DatabaseChangeEvent } from "../../shared/database-events";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import type { ContentAccessIdentity } from "../../shared/content-access-context";

export interface RendererTransport {
  sendGitWorkerMessage: (
    message: import("../../shared/git-worker-protocol").GitWorkerMessageFromView,
  ) => Promise<void>;
  subscribeGitWorkerMessages: (
    callback: (message: import("../../shared/git-worker-protocol").GitWorkerMessageForView) => void,
  ) => () => void;
  readPageLifecyclePreflight: (
    projectId: string,
    pageId: string,
  ) => Promise<import("../../shared/page-lifecycle-v2-runtime").PageLifecyclePreflightResultV2>;
  mutatePageLifecycle: (
    projectId: string,
    request: import("../../shared/page-lifecycle-v2").PageLifecycleMutationRequestV2,
  ) => Promise<import("../../shared/page-lifecycle-v2").PageLifecycleMutationCommandResultV2>;
  listPageHistory: (
    request: import("../../shared/page-history").ListPageHistoryRequest,
  ) => Promise<import("../../shared/page-history-transport").PageHistoryCommandResult>;
  getOwnedDocumentDescriptor: (
    projectId: string,
    ownerBlockId: string,
  ) => Promise<import("../../shared/block-documents/contracts").ProjectAccessedDocumentDescriptor>;
  mutateDocument: (
    projectId: string,
    documentId: string,
    request: import("../../shared/block-documents/document-operations").DocumentMutationRequest,
  ) => Promise<
    import("../../shared/block-documents/document-operations").DocumentOperationCommandResult
  >;
  applyAdditionalDocumentCommand: (
    projectId: string,
    request: import("../../shared/additional-document-command-transport").PublicAdditionalDocumentCommandRequest,
  ) => Promise<import("../../shared/additional-document-commands").AdditionalDocumentCommandResult>;
  transferBlocks: (
    projectId: string,
    intent: import("../../shared/block-transfer-transport").PublicBlockTransferIntent,
  ) => Promise<import("../../shared/block-transfer").BlockTransferCommandResult>;
  undoBlockTransfer: (
    projectId: string,
    intent: import("../../shared/block-transfer-transport").PublicBlockTransferUndoIntent,
  ) => Promise<import("../../shared/block-transfer").BlockTransferUndoCommandResult>;
  listDocumentVersions: (
    request: import("../../shared/block-documents/document-history").ListDocumentVersions,
  ) => Promise<
    import("../../shared/block-documents/document-history-transport").DocumentHistoryCommandResult<
      readonly import("../../shared/block-documents/document-history").DocumentVersionSummary[]
    >
  >;
  getDocumentVersion: (
    request: import("../../shared/block-documents/document-history").GetDocumentVersion,
  ) => Promise<
    import("../../shared/block-documents/document-history-transport").DocumentHistoryCommandResult<
      import("../../shared/block-documents/document-history").DocumentVersionDetail
    >
  >;
  restoreDocumentVersion: (
    projectId: string,
    documentId: string,
    request: import("../../shared/block-documents/document-history").PrepareDocumentVersionRestore,
  ) => Promise<
    import("../../shared/block-documents/document-operations").DocumentOperationCommandResult
  >;
  createDocumentSyncAdapter?: (
    projectId: string,
  ) => import("./nodex-y-provider").DocumentSyncAdapter;
  createLibraryDocumentSyncAdapter?: () => import("./nodex-y-provider").DocumentSyncAdapter;
  createCanvasSceneSyncAdapter?: (
    identity: ContentAccessIdentity,
  ) => import("./canvas-scene-provider").CanvasSceneSyncAdapter;
  subscribeBoardChanges: (
    projectId: string,
    callback: (event: BoardChangeEvent) => void,
  ) => () => void;
  subscribeProjectionStream: (
    scope: ProjectionScope,
    listener: (message: ProjectionStreamMessage) => void,
  ) => () => void;
  subscribeResourceRevocations: (
    scope: ProjectionScope,
    listener: (message: ResourceRevocationMessage) => void,
  ) => () => void;
  subscribePageOwnershipPathChanges: (
    projectId: string,
    callback: (
      event: import("../../shared/page-ownership-path-events").PageOwnershipPathsChangedEvent,
    ) => void,
  ) => () => void;
  subscribeDatabaseChanges: (
    projectId: string,
    callback: (event: DatabaseChangeEvent) => void,
  ) => () => void;
  subscribeLibraryChanges?: (
    callback: (event: import("../../shared/library-events").LibraryNavigationChangedEvent) => void,
  ) => () => void;
  subscribeProjectSessionChanges: (
    callback: (event: import("../../shared/ipc-api").ProjectSessionsChangeEvent) => void,
  ) => () => void;
  subscribeProjectChanges: (
    callback: (event: import("../../shared/ipc-api").ProjectsChangeEvent) => void,
  ) => () => void;
  subscribeAcpBackendSessionChanges: (
    callback: (
      event: import("../../shared/agent-backend-api").AcpBackendSessionChangedEvent,
    ) => void,
  ) => () => void;
  subscribeCodexHostMessages: (
    callback: (message: import("./types").CodexHostMessage) => void,
  ) => () => void;
  subscribeCodexEvents: (callback: (event: import("./types").CodexEvent) => void) => () => void;
  subscribeCodexRendererClientRequests: (
    callback: (message: import("./types").CodexRendererClientRequestMessage) => void,
  ) => () => void;
  subscribeDesktopNotificationActions: (
    callback: (payload: import("./types").DesktopNotificationActionInvocation) => void,
  ) => () => void;
  subscribeWorkspaceFileChanges: (
    callback: (event: import("../../shared/types").WorkspaceFileChangedEvent) => void,
  ) => () => void;
  subscribeAppUpdateStatus: (
    callback: (status: import("./types").AppUpdateStatus) => void,
  ) => () => void;
  subscribeCommandKeymapChanges: (callback: (state: CommandKeymapState) => void) => () => void;
  subscribeCodexScheduledAutomationChanges: (
    callback: (event: import("../../shared/types").CodexScheduledAutomationChangedEvent) => void,
  ) => () => void;
  subscribeCodexAutomationRunsUpdates: (
    callback: (event: import("../../shared/types").CodexAutomationRunsUpdatedEvent) => void,
  ) => () => void;
  subscribeCodexHooksChanged: (
    callback: (event: import("../../shared/codex-hooks").CodexHooksChangedEvent) => void,
  ) => () => void;
  subscribeCodexPendingWorktreesChanged: (
    callback: (
      event: import("../../shared/codex-pending-worktree").CodexPendingWorktreesChangedEvent,
    ) => void,
  ) => () => void;
  subscribeCodexPendingWorktreeWarnings: (
    callback: (
      event: import("../../shared/codex-pending-worktree").CodexPendingWorktreeWarningEvent,
    ) => void,
  ) => () => void;
  subscribePersistedAtomUpdates: (
    callback: (update: import("../../shared/ipc-api").PersistedAtomEvent) => void,
  ) => () => void;
  getWindowFocusState: () => Promise<boolean>;
  subscribeWindowFocusChanges: (callback: (isFocused: boolean) => void) => () => void;
  getUserInputAutoResolutionSnapshot: () => Promise<
    import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionEntry[]
  >;
  recordUserInputAutoResolutionActivity: (conversationId: string) => Promise<boolean>;
  snoozeUserInputAutoResolution: (
    target: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionTarget,
  ) => Promise<boolean>;
  subscribeUserInputAutoResolutionChanges: (
    callback: (
      change: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionChange,
    ) => void,
  ) => () => void;
}

function readElectronBridge(): ElectronRendererBridge {
  const bridge = typeof window === "undefined" ? undefined : window.api;
  if (!bridge) {
    throw new Error("Nodex renderer requires the Electron preload bridge");
  }
  return bridge;
}

export function resolveRendererTransport(): RendererTransport {
  return createElectronRendererTransport(readElectronBridge());
}
