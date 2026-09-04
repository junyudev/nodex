import type { ReadFileBytesInput, SaveFileInput } from "./library-files";
import type { ThreadBackgroundTerminal } from "@nodex/codex-app-server-protocol/v2/ThreadBackgroundTerminal";
import type {
  AcpBackendAuthenticateInput,
  AcpBackendAuthenticateResult,
  AcpBackendConfigOptionInput,
  AcpBackendConfigOptionResult,
  AcpBackendModeInput,
  AcpBackendPromptInput,
  AcpBackendPromptResult,
  AcpBackendSessionOpenInput,
  AcpBackendThreadStartInput,
  AcpBackendThreadStartResult,
} from "./agent-backend-api";
import type { AcpBackendSessionPresentation, AcpConversationSnapshot } from "./acp-conversation";
import type {
  CodexPersistedHistoryOccurrenceHydrateRequest,
  CodexPersistedHistoryOccurrenceHydrateResult,
  CodexPersistedHistorySearchResult,
} from "./codex-persisted-history-search";
import type {
  CodexHistoryResidencyPinsInput,
  CodexHistoryResidencyPinsResult,
} from "./codex-history-residency-pins";
import type {
  CodexConversationHistoryPageRequest,
  CodexConversationHistoryPageResult,
} from "./codex-conversation-history-page";
import type {
  CodexPromptRailIndexCommandResult,
  CodexPromptRailIndexRequest,
  CodexPromptRailRevealCommandResult,
  CodexPromptRailRevealRequest,
} from "./codex-prompt-rail-history";
import type { GitRepositoryIdentity } from "./git-repository-identity";
import type { ContentAccessContext } from "./content-access-context";
import type { LocalPathPresentationContext } from "./local-path-presentation";
import type {
  ManagedAssetImageBytes,
  ManagedAssetPreview,
  ManagedAssetPreviewInput,
  ManagedAssetUploadInput,
  ManagedCanvasImageMaterializationResult,
  ManagedImageSaveResult,
  ManagedResourceSaveResult,
} from "./managed-assets";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyCommandResult,
  DocumentSyncApplyRequest,
  DocumentSyncCommandResult,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
  DocumentSyncSubscriptionAck,
  DocumentSyncUnsubscribeAck,
  ProjectScopedDocumentAwarenessPublishRequest,
  ProjectScopedDocumentSyncApplyRequest,
  ProjectScopedDocumentSyncRequest,
  ProjectScopedDocumentSyncSubscribeRequest,
} from "./block-documents/document-sync";
import type {
  CanvasSceneMutationCommandResult,
  CanvasSceneMutationRequest,
  CanvasSceneSubscribeRequest,
  CanvasSceneSubscriptionCommandResult,
  CanvasSceneSyncCommandResult,
  CanvasSceneSyncRequest,
} from "./block-documents/canvas-scene-sync";
import type {
  CanvasSceneCompactionCommandResult,
  CanvasSceneCompactionReadCommandResult,
  CanvasSceneCompactionReadRequest,
  CanvasSceneCompactionRequest,
} from "./block-documents/canvas-scene-maintenance";
import type {
  CanvasPresenceCommandResult,
  CanvasPresencePublishRequest,
} from "./block-documents/document-presence";
import type {
  LibraryAccessedDocumentDescriptor,
  ProjectAccessedDocumentDescriptor,
} from "./block-documents/contracts";
import type { BlockTransferCommandResult, BlockTransferUndoCommandResult } from "./block-transfer";
import type { ProjectionCursor } from "./projection-stream";
import type {
  PublicBlockTransferIntent,
  PublicBlockTransferUndoIntent,
} from "./block-transfer-transport";
import type {
  DocumentMutationRequest,
  DocumentOperationCommandResult,
} from "./block-documents/document-operations";
import type {
  CreateDocumentVersionCheckpoint,
  CreatedDocumentVersionSummary,
  DocumentVersionDetail,
  DocumentVersionSummary,
  GetDocumentVersion,
  ListDocumentVersions,
} from "./block-documents/document-history";
import type { DocumentHistoryCommandResult } from "./block-documents/document-history-transport";
import type {
  BlockPropertyMutationCommandResultV2,
  BlockPropertyMutationRequestV2,
  LibraryBlockPropertyMutationCommandResultV2,
  LibraryBlockPropertyMutationRequestV2,
} from "./block-property-mutations-v2";
import type {
  SidebarSectionItemWindow,
  SidebarSectionItemWindowInput,
  SidebarSectionItemRef,
  SidebarSectionSummary,
  SidebarSectionWindow,
  SidebarSectionWindowInput,
} from "./sidebar-sections";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
  LibraryDatabaseModuleReadRequestV2,
  LibraryDatabaseModuleReadResultV2,
  LibraryDatabaseApplyV2,
  LibraryDatabaseApplyResultV2,
} from "./database-module-v2";
import type {
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
  LibraryModuleReadRequest,
  LibraryModuleReadResult,
} from "./library-module";
import type { AppRuntimeCapabilities } from "./runtime-capabilities";
import type {
  FileBytes,
  PickFilesInput,
  PickFilesResult,
  PreparedFileBlob,
  PrepareDroppedFilesInput,
  PrepareDroppedFilesResult,
  PrepareFileBlobInput,
  SaveFileResult,
} from "./file-resources";
import type { DatabaseChangeEvent } from "./database-events";
import type {
  PageLifecycleMutationCommandResultV2,
  PageLifecycleMutationRequestV2,
} from "./page-lifecycle-v2";
import type { PageLifecyclePreflightResultV2 } from "./page-lifecycle-v2-runtime";
import type { ListPageHistoryRequest } from "./page-history";
import type { PageHistoryCommandResult } from "./page-history-transport";
import type { LibraryPageDetailResult, PageDetailResult } from "./page-detail";
import type { AdditionalDocumentCommandResult } from "./additional-document-commands";
import type { PublicAdditionalDocumentCommandRequest } from "./additional-document-command-transport";
import type { PageTargetReadModel, ResolvePageTargetInput } from "./page-targets";
import type {
  PageOwnershipPathReadModel,
  ResolvePageOwnershipPathInput,
} from "./page-ownership-paths";
import type { DatabaseViewReadModel, ReadDatabaseViewReferenceInput } from "./database-views";
import type {
  CodexSidebarThreadMoveInput,
  CodexSidebarThreadMoveResult,
} from "./codex-sidebar-thread-move";
import type {
  CodexHooksChangedEvent,
  CodexHooksListInput,
  CodexHooksListResponse,
  CodexHooksStateUpdateInput,
} from "./codex-hooks";
import type {
  AgentImportApplyInput,
  AgentImportProgress,
  AgentImportResult,
  AgentImportScan,
  AgentImportScanInput,
} from "./agent-import";
import type { ThirdPartyNotices } from "./third-party-notices";
import type {
  CreatePastedTextAttachmentInput,
  CreatePastedTextAttachmentResult,
  ReadPastedTextAttachmentInput,
  RemovePastedTextAttachmentInput,
} from "./pasted-text-attachments";
import type {
  CodexForkBrowserSidePanelSnapshot,
  CodexForkBrowserTransferConsumeInput,
  CodexForkBrowserSceneContext,
} from "./codex-fork-browser-transfer";
import type {
  CodexUserInputAutoResolutionChange,
  CodexUserInputAutoResolutionEntry,
  CodexUserInputAutoResolutionTarget,
} from "./codex-user-input-auto-resolution";
import type {
  DictationSurface,
  DictationSettings,
  DictationSettingsPatch,
  GlobalDictationPermissionSnapshot,
  MicrophoneAccessResult,
  MicrophoneAccessStatus,
} from "./dictation";
import type {
  DictationRecordingAppendInput,
  DictationRecordingAudio,
  DictationRecordingCreateInput,
  DictationRecordingFinalizeInput,
  DictationRecordingMetadata,
  DictationRecordingSetTranscriptInput,
} from "./dictation-history";

import type {
  AcpAgentSettings,
  BackupRecord,
  BackupCapacity,
  SnapshotStorageOptimization,
  BackupSettings,
  DiagnosticsSettings,
  HistorySettings,
  AppUpdateSettings,
  AppUpdateStatus,
  CodexAccountSnapshot,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
  CodexApprovalResponse,
  CodexCanonicalOptionPickerResponse,
  CodexCanonicalSetupContextPickerResponse,
  CodexCanonicalSetupCodexStepResponse,
  CodexBackgroundProcessRow,
  CodexBackgroundProcessRunActionInput,
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewWindow,
  CodexSelectedSubagentHydrateInput,
  CodexSelectedSubagentHydrateResult,
  CodexConversationSnapshot,
  CodexConnectionState,
  CodexDeveloperInstructionSettings,
  CodexGitSettings,
  CodexDictationStateSnapshot,
  CodexConversationImageAssetResolveInput,
  CodexConversationImageAssetResolveResult,
  ProtocolDynamicToolCallResponse,
  CodexCollaborationModePreset,
  CodexCollaborationModeKind,
  CodexCollaborationModeState,
  CodexConversationThreadSettings,
  CodexConversationThreadSettingsPatch,
  CodexPersonality,
  CodexEvent,
  CodexOwnerAppServerRequestInput,
  CodexAgentMode,
  CodexReviewStartParams,
  CodexReviewStartResponse,
  CodexRendererClientRequestMessage,
  CodexRendererClientResponseMessage,
  CodexRendererConversationResumeResult,
  CodexAutomationRunsInboxResponse,
  CodexAutomationRunArchiveInput,
  CodexAutomationRunDeleteInput,
  CodexAutomationRunsUpdatedEvent,
  CodexAutomationRunUnarchiveInput,
  CodexAutomationRunMarkAllReadInput,
  CodexAutomationRunMarkAllReadResponse,
  CodexAutomationRunMutationResponse,
  CodexAutomationRunReadStateInput,
  CodexAutomationInboxItem,
  CodexHeartbeatAutomationThreadStateChangedInput,
  CodexHeartbeatAutomationsEnabledChangedInput,
  CodexScheduledAutomationChangedEvent,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationDeleteInput,
  CodexScheduledAutomationDeleteResponse,
  CodexScheduledAutomationListResponse,
  CodexScheduledAutomationMutationResponse,
  CodexScheduledAutomationRunNowInput,
  CodexScheduledAutomationRunNowResponse,
  CodexScheduledAutomationUpdateInput,
  CodexThreadFollowerActionInput,
  CodexThreadFollowerSnapshotAppliedInput,
  CodexThreadOwnerNotificationAckInput,
  CodexThreadOwnerStreamStatePublishResult,
  CodexThreadOwnerStreamStatePublishInput,
  CodexThreadStreamResyncRequestInput,
  CodexSidebarRefreshPolicy,
  CodexSidebarRefreshReason,
  CodexSidebarSnapshot,
  CodexSidebarSyncResult,
  GitActionCancelInput,
  GitActionCancelResult,
  GitActionMutationResult,
  GitCommitMessageGenerateInput,
  GitCommitMessageGenerateResult,
  GitCommitInput,
  GitPullRequestMessageGenerateInput,
  GitPullRequestMessageGenerateResult,
  GitPushInput,
  GhCliStatusResult,
  GhPrChecksRequest,
  GhPrChecksResult,
  GhPrCommentInput,
  GhPrCommentResult,
  GhPrCommentsRequest,
  GhPrCommentsResult,
  GhPrCreateInput,
  GhPrDiffRequest,
  GhPrDiffResult,
  GhPrMergeInput,
  GhPrMutationResult,
  GhPrStatusRequest,
  GhPrStatusResult,
  GhPrUpdateInput,
  CodexComposerAppshotCaptureInput,
  CodexComposerAppshotContext,
  CodexComposerAppshotTargetResult,
  CodexComposerChatGptConversationListInput,
  CodexComposerChatGptConversationListResult,
  CodexComposerPlugin,
  CodexComposerPluginActivateInput,
  CodexComposerPluginListInput,
  CodexComposerSiteListResult,
  CodexComposerSkill,
  CodexComposerSkillListInput,
  CodexHostMessage,
  CodexModelOption,
  CodexMcpServerElicitationResponse,
  CodexPermissionMode,
  CodexPermissionRequestResponse,
  CodexProtocolRequestId,
  CodexPermissionState,
  CodexProjectlessThreadCwdInput,
  CodexProjectlessWorkspace,
  CodexSteerTurnInput,
  CodexSideChatStartInput,
  CodexSideChatStartResult,
  CodexThreadStartForSessionInput,
  CodexThreadStartForSessionResult,
  CodexThreadGoalDraftInput,
  CodexThreadGoalSetActionInput,
  CodexThreadGoalMaterializedDraft,
  CodexThreadSummary,
  CodexThreadSummaryWindow,
  CodexThreadSummaryWindowInput,
  ProtocolAppInfo,
  ProtocolExperimentalFeature,
  ProtocolMcpResourceReadParams,
  ProtocolMcpResourceReadResponse,
  ProtocolMcpServerToolCallParams,
  ProtocolMcpServerToolCallResponse,
  ProtocolListMcpServerStatusResponse,
  CodexTurnStartOptions,
  CodexTurnSummary,
  ManagedWorktreeRecord,
  ManagedWorktreeAvailability,
  ManagedWorktreeRestoreResult,
  ManagedWorktreeSettings,
  CodexExecutionHostSettings,
  WorktreeEnvironmentOption,
  WorktreeEnvironmentConfigRecord,
  WorktreeEnvironmentSaveResult,
  WorktreeEnvironmentSettingsSnapshot,
  UpdateWorktreeEnvironmentConfigInput,
  UpdateManagedWorktreeSettingsInput,
  UpdateCodexExecutionHostSettingsInput,
  UpdateCodexDeveloperInstructionSettingsInput,
  UpdateCodexGitSettingsInput,
  PageOccurrence,
  ClipboardPastePayload,
  PageOccurrenceActionInput,
  PageOccurrenceCompleteInput,
  PageOccurrenceMutationResult,
  PageOccurrenceUpdateInput,
  DatabasePage,
  DatabasePageSummary,
  PageSearchCommandResult,
  PageSearchFacets,
  PageSearchInput,
  PageSearchMetadataSnapshot,
  CommandPaletteThreadSearchInput,
  CommandPaletteThreadSearchResult,
  CommandPaletteThreadListInput,
  CommandPaletteThreadSummary,
  BackupJobStatus,
  BackupStartResult,
  CreateBackupCommandInput,
  Project,
  ProjectActivitySummaryResult,
  PageChatActivitySummaryInput,
  PageChatActivitySummaryResult,
  PageChatLinkInput,
  PageChatWindow,
  PageChatWindowInput,
  ProjectWindow,
  ProjectWindowInput,
  ProjectUpdateCommandInput,
  ProjectSession,
  ProjectSessionForkInput,
  ProjectSessionForkResult,
  ProjectSessionSummaryWindow,
  ProjectSessionSummaryWindowInput,
  ProjectSessionThreadLink,
  ProjectSessionThreadLinkInput,
  RestoreBackupInput,
  RestoreBackupResult,
  TelemetrySettings,
  TerminalAttachRequest,
  TerminalAttachedEvent,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalInitLogEvent,
  TerminalRunActionRequest,
  TerminalSessionSnapshot,
  TerminalSize,
  TerminalTakeOverViewRequest,
  TerminalViewLeaseRevokedEvent,
  TerminalViewLeaseResult,
  ThreadNotificationSettings,
  UpdateAcpAgentSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateTelemetrySettingsInput,
  UpdateBackupSettingsInput,
  UpdateAppUpdateSettingsInput,
  UpdateHistorySettingsInput,
  UpdateThreadNotificationSettingsInput,
  UpdateWindowRestoreSettingsInput,
  WindowRestoreSettings,
  DesktopNotificationActionInvocation,
  WorkspaceDirectoryEntriesInput,
  WorkspaceDirectoryEntriesResult,
  WorkspaceFileBinaryReadResult,
  WorkspaceFileMetadataInput,
  WorkspaceFileMetadata,
  WorkspaceFileReadResult,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
  WorkspaceFileSearchInput,
  WorkspaceFileSearchResult,
  WorkspaceFileWatchStartResult,
  WorkspaceFileWatchStopInput,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
} from "./types";
import type {
  ProjectCreateCommandInput,
  ProjectLifecycleCommandInput,
  ProjectLifecycleCommandRejected,
  ProjectLifecycleCommittedValue,
  ProjectPinnedCommandInput,
  ProjectPinnedOrderCommandInput,
  ProjectReorderCommandInput,
  ProjectSessionArchiveCommandInput,
  ProjectSessionCreateCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionEnsureDefaultDraftCommandInput,
  ProjectSessionPinnedCommandInput,
  ProjectSessionPinnedOrderCommandInput,
  ProjectSessionRenameCommandInput,
  ProjectSessionReorderCommandInput,
  ProjectSessionUnreadCommandInput,
  ProjectSessionUpdateCommandInput,
  SidebarSectionCreateCommandInput,
  SidebarSectionDeleteCommandInput,
  SidebarSectionMoveItemCommandInput,
  SidebarSectionRenameCommandInput,
  SidebarSectionReorderCommandInput,
  SidebarSectionRestoreCommandInput,
  SidebarSectionSessionCreateCommandInput,
  SidebarSectionSessionsArchiveCommandInput,
  SidebarSectionSessionsReorderCommandInput,
} from "./workspace-catalog-commands";
import type {
  DatabaseListWindowInput,
  DatabaseListWindowSnapshot,
  DatabaseViewGroupsInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewWindowInput,
  DatabaseViewWindowSnapshot,
  LibraryDatabaseListWindowSnapshot,
  LibraryDatabaseViewGroupsSnapshot,
  LibraryDatabaseViewWindowSnapshot,
} from "./database-views";
import type { CoreLocalCommitResult, CoreResult } from "./core-result";
import type { NativeContextMenuItem, NativeContextMenuOptions } from "./native-context-menu";
import type {
  CodexPendingWorktreeCreateInput,
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
  CodexPendingWorktreeWarningEvent,
  CodexPendingWorktreesChangedEvent,
} from "./codex-pending-worktree";
import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipRevisionEvent,
  RemoteHostedPipTaskStateSnapshot,
  RemoteHostedPipTaskVisibilityInput,
} from "./remote-hosted-pip";
import type {
  WindowSessionBootstrap,
  WindowSessionBounds,
  WindowSessionNewWindowRequest,
  WindowSessionSaveLayoutInput,
} from "./window-session";
import type { FileLinkOpenerId, FileLinkTarget } from "./file-link-openers";
import type {
  CommandKeybindingMutationResult,
  CommandKeybindingUpdate,
  CommandKeymapState,
  KeyboardLayoutSnapshot,
} from "./command-keybindings";
import type { GlobalDictationRendererEvent } from "./global-dictation";
import type {
  BrowserBrowsingDataClearResult,
  BrowserBrowsingDataKind,
  BrowserLocalServerPreferences,
  BrowserLocalServerPreferencesUpdate,
  BrowserSidebarBrowserUseCaptureSurfaceEvent,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarRuntimeSnapshot,
  BrowserSidebarContextMenuActionEvent,
  BrowserSidebarImageDragStateEvent,
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarBrowserUseStateSnapshot,
  BrowserSidebarCommand,
  BrowserSidebarCommandResult,
  BrowserSidebarLocalServersSnapshot,
  BrowserSidebarLocalServerThumbnailRequest,
  BrowserSidebarLocalServerThumbnailResult,
  BrowserSidebarOpenNewTabRequest,
  BrowserSidebarStateSnapshot,
  BrowserSidebarTabIdentity,
  BrowserUsePageClosedEvent,
  BrowserUsePresentationRequest,
  BrowserSidebarWebviewAttached,
  BrowserSidebarWebviewDestroyed,
  BrowserSidebarWebviewHostCreated,
  BrowserUseCursorState,
} from "./browser-sidebar";
import type {
  BrowserDownloadActionRequest,
  BrowserDownloadActionResult,
  BrowserDownloadsSnapshot,
} from "./browser-download";
import type {
  BrowserContactInfo,
  BrowserContactInfoFillInput,
  BrowserContactInfoUpsertInput,
  BrowserCredentialActionResult,
  BrowserCredentialCandidateActionInput,
  BrowserCredentialFillInput,
  BrowserCredentialGenerateInput,
  BrowserCredentialListInput,
  BrowserCredentialSaveCandidate,
  BrowserCredentialSummary,
  BrowserExtensionSummary,
  BrowserExtensionsSnapshot,
  BrowserHistoryListInput,
  BrowserHistorySnapshot,
  BrowserProfileCapabilities,
  BrowserProfileImportInput,
  BrowserProfileImportResult,
  BrowserSiteInfo,
  ImportableBrowserProfile,
} from "./browser-profile";
import type {
  BrowserAnnotationAttachmentEvidence,
  BrowserAnnotationRoutedAnchorUpdateEvent,
  BrowserAnnotationRoutedSelectionEvent,
} from "./browser-annotation";
import type {
  BrowserUseOriginRuleUpdate,
  BrowserUsePolicyModesUpdate,
  BrowserUsePolicySnapshot,
} from "./browser-use-policy";
import type { ComputerUseSettingsSnapshot, ComputerUseSoundMode } from "./computer-use-settings";
import type { ChromeControlRuntimeSnapshot } from "./chrome-control-settings";
import type {
  FeedbackUploadParams,
  FeedbackUploadResponse,
  ThreadGoal,
} from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import type {
  ClaimedClipboardPresentationWriteInput,
  ClaimedClipboardPresentationWriteResult,
  StructuralClipboardAwaitInput,
  StructuralClipboardBeginInput,
  StructuralClipboardLifecycleResult,
  StructuralClipboardResolution,
  StructuralClipboardSettleInput,
  StructuralClipboardWriteInput,
  StructuralClipboardWriteResult,
} from "./clipboard-paste";

export type ClipboardWriteImageResult = { ok: true } | { ok: false; message: string };

export interface ComposerPickedFile {
  label: string;
  path: string;
  bytes?: number;
  mimeType?: string;
  imageDataUrl?: string;
}

export interface BoardChangeEvent {
  projectId: string;
  storeEpoch?: string;
  commitSeq?: number;
  changeType: string;
  columnId: DatabasePage["status"];
  status: DatabasePage["status"];
  pageId?: string;
  summary?: DatabasePageSummary;
  mutationId?: string;
  metrics?: {
    workerDurationMs?: number;
    queueWaitMs?: number;
    transactionMs?: number;
  };
}

export type ProjectSessionChangeType =
  | "create"
  | "update"
  | "delete"
  | "move"
  | "reorder"
  | "pin"
  | "archive"
  | "unarchive"
  | "unread"
  | "link"
  | "thread";

export type ProjectSessionInvalidationScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "projectless" }
  | { readonly kind: "all" };

export type ProjectSessionDetailInvalidation =
  | { readonly kind: "sessions"; readonly sessionIds: readonly string[] }
  | { readonly kind: "all" };

export interface ProjectSessionsChangeEvent {
  readonly summaryScopes: readonly ProjectSessionInvalidationScope[];
  readonly detailInvalidation: ProjectSessionDetailInvalidation;
  readonly changeType: ProjectSessionChangeType;
}

export interface ProjectsChangeEvent {
  projectId?: string;
  changeType:
    | "create"
    | "update"
    | "metadata"
    | "sources"
    | "lifecycle"
    | "delete"
    | "reorder"
    | "pin";
}

export type PersistedAtomState = Record<string, unknown>;

/** Main-internal compatibility input for values that are not renderer mutations. */
export interface PersistedAtomUpdate {
  key: string;
  value: unknown;
}

export interface PersistedAtomSnapshot {
  revision: number;
  values: PersistedAtomState;
}

export interface PersistedAtomMutation extends PersistedAtomUpdate {
  mutationId: string;
}

export interface PersistedAtomEvent extends PersistedAtomMutation {
  revision: number;
  originRendererId: string | null;
}

export interface WorkspacePickDirectoryInput {
  title?: string;
  createDirectory?: boolean;
}

export interface RendererDiagnosticsLogInput {
  message: string;
  fields?: Record<string, unknown>;
}

export interface IpcApi {
  "avatar-overlay:event": {
    args: [event: import("./avatar-overlay").AvatarOverlayRendererEvent];
    result: boolean;
  };
  "avatar-overlay:toggle": { args: []; result: boolean };
  "remote-hosted-pip:host-layout:report": {
    args: [layout: RemoteHostedPipHostLayout | null];
    result: boolean;
  };
  "remote-hosted-pip:snapshot": { args: []; result: RemoteHostedPipTaskStateSnapshot };
  "remote-hosted-pip:task-visibility:set": {
    args: [input: RemoteHostedPipTaskVisibilityInput];
    result: RemoteHostedPipTaskStateSnapshot;
  };
  "app:runtime-capabilities:get": {
    args: [];
    result: AppRuntimeCapabilities;
  };
  "app:await-initialization": { args: []; result: void };
  "app:get-core-authority-status": {
    args: [];
    result: import("./core-authority-status").CoreAuthorityStatus;
  };
  "app:relaunch-for-core-authority": { args: []; result: void };
  "app:restart": { args: []; result: void };
  "app:retry-core-authority": { args: []; result: void };
  "git-worker:message-from-view": {
    args: [message: import("./git-worker-protocol").GitWorkerMessageFromView];
    result: void;
  };
  "local-commit-audience:subscribe": {
    args: [address: import("./recipient-delivery").DeliveryAddress];
    result: void;
  };
  "local-commit-audience:unsubscribe": {
    args: [address: import("./recipient-delivery").DeliveryAddress];
    result: void;
  };
  "recipient-delivery:admit": {
    args: [result: import("./recipient-delivery").RecipientAdmissionResult];
    result: boolean;
  };
  "pages:detail:get": {
    args: [projectId: string, pageId: string, minimumCommitSeq?: number];
    result: PageDetailResult;
  };
  "pages:history:list": {
    args: [request: ListPageHistoryRequest];
    result: PageHistoryCommandResult;
  };
  "block-documents:mutate": {
    args: [projectId: string, documentId: string, request: DocumentMutationRequest];
    result: DocumentOperationCommandResult;
  };
  "block-documents:command": {
    args: [projectId: string, request: PublicAdditionalDocumentCommandRequest];
    result: AdditionalDocumentCommandResult;
  };
  "block-documents:history:checkpoint": {
    args: [projectId: string, documentId: string, request: CreateDocumentVersionCheckpoint];
    result: DocumentHistoryCommandResult<CreatedDocumentVersionSummary>;
  };
  "document-recovery:read": {
    args: [request: import("./block-documents/document-recovery").DocumentRecoveryReadRequest];
    result: import("./block-documents/document-recovery").DocumentRecoveryReadResult;
  };
  "document-recovery:apply": {
    args: [request: import("./block-documents/document-recovery").DocumentRecoveryCommand];
    result: import("./block-documents/document-recovery").DocumentRecoveryCommandResult;
  };
  "block-documents:history:list": {
    args: [request: ListDocumentVersions];
    result: DocumentHistoryCommandResult<readonly DocumentVersionSummary[]>;
  };
  "block-documents:history:get": {
    args: [request: GetDocumentVersion];
    result: DocumentHistoryCommandResult<DocumentVersionDetail>;
  };
  "block-documents:history:restore": {
    args: [projectId: string, documentId: string, request: DocumentMutationRequest];
    result: DocumentOperationCommandResult;
  };
  "block-properties:mutate": {
    args: [projectId: string, request: BlockPropertyMutationRequestV2];
    result: BlockPropertyMutationCommandResultV2;
  };
  "library-block-properties:mutate": {
    args: [request: LibraryBlockPropertyMutationRequestV2];
    result: LibraryBlockPropertyMutationCommandResultV2;
  };
  "pages:lifecycle:preflight": {
    args: [projectId: string, pageId: string];
    result: PageLifecyclePreflightResultV2;
  };
  "pages:lifecycle:apply": {
    args: [projectId: string, request: PageLifecycleMutationRequestV2];
    result: PageLifecycleMutationCommandResultV2;
  };
  "database-module:read": {
    args: [projectId: string, request: DatabaseModuleReadRequestV2];
    result: DatabaseModuleReadResultV2;
  };
  "database-module:apply": {
    args: [projectId: string, request: DatabaseApplyV2];
    result: DatabaseApplyResultV2;
  };
  "library-module:read": {
    args: [accessContext: ContentAccessContext, request: LibraryModuleReadRequest];
    result: LibraryModuleReadResult;
  };
  "library-module:apply": {
    args: [accessContext: ContentAccessContext, request: LibraryModuleApplyRequest];
    result: LibraryModuleApplyResult;
  };
  "files:prepare": {
    args: [accessContext: ContentAccessContext, input: PrepareFileBlobInput];
    result: PreparedFileBlob;
  };
  "files:pick-and-prepare": {
    args: [accessContext: ContentAccessContext, input: PickFilesInput];
    result: PickFilesResult;
  };
  "files:prepare-local-drop": {
    args: [accessContext: ContentAccessContext, input: PrepareDroppedFilesInput];
    result: PrepareDroppedFilesResult;
  };
  "files:read": {
    args: [accessContext: ContentAccessContext, input: ReadFileBytesInput];
    result: FileBytes;
  };
  "files:materialize": {
    args: [accessContext: ContentAccessContext, input: SaveFileInput];
    result: string;
  };
  "files:save": {
    args: [accessContext: ContentAccessContext, input: SaveFileInput];
    result: SaveFileResult;
  };
  "library-database-module:read": {
    args: [request: LibraryDatabaseModuleReadRequestV2];
    result: LibraryDatabaseModuleReadResultV2;
  };
  "library-database-module:apply": {
    args: [request: LibraryDatabaseApplyV2];
    result: LibraryDatabaseApplyResultV2;
  };
  "library-pages:detail:get": {
    args: [pageId: string, minimumCommitSeq?: number];
    result: LibraryPageDetailResult;
  };
  "page-target:resolve": {
    args: [input: ResolvePageTargetInput];
    result: PageTargetReadModel | null;
  };
  "page-ownership-path:resolve": {
    args: [input: ResolvePageOwnershipPathInput];
    result: PageOwnershipPathReadModel | null;
  };
  "database-view:reference:get": {
    args: [input: ReadDatabaseViewReferenceInput];
    result: DatabaseViewReadModel | null;
  };
  "block-document:owned:get": {
    args: [projectId: string, ownerBlockId: string];
    result: ProjectAccessedDocumentDescriptor;
  };
  "block-document:owned:prepare": {
    args: [projectId: string, ownerBlockId: string];
    result: DocumentSyncCommandResult<ProjectAccessedDocumentDescriptor>;
  };
  "library-block-document:owned:prepare": {
    args: [ownerBlockId: string];
    result: DocumentSyncCommandResult<LibraryAccessedDocumentDescriptor>;
  };
  "document-sync:subscribe": {
    args: [request: ProjectScopedDocumentSyncSubscribeRequest];
    result: DocumentSyncCommandResult<DocumentSyncSubscriptionAck>;
  };
  "document-sync:unsubscribe": {
    args: [request: ProjectScopedDocumentSyncSubscribeRequest];
    result: DocumentSyncCommandResult<DocumentSyncUnsubscribeAck>;
  };
  "document-sync:sync": {
    args: [request: ProjectScopedDocumentSyncRequest];
    result: DocumentSyncCommandResult<DocumentSyncResponse>;
  };
  "document-sync:apply": {
    args: [request: ProjectScopedDocumentSyncApplyRequest];
    result: DocumentSyncApplyCommandResult;
  };
  "canvas-scene:subscribe": {
    args: [request: CanvasSceneSubscribeRequest];
    result: CanvasSceneSubscriptionCommandResult;
  };
  "canvas-scene:unsubscribe": {
    args: [request: CanvasSceneSubscribeRequest];
    result: CanvasSceneSubscriptionCommandResult;
  };
  "canvas-scene:sync": {
    args: [request: CanvasSceneSyncRequest];
    result: CanvasSceneSyncCommandResult;
  };
  "canvas-scene:apply": {
    args: [request: CanvasSceneMutationRequest];
    result: CanvasSceneMutationCommandResult;
  };
  "canvas-scene:presence:publish": {
    args: [request: CanvasPresencePublishRequest];
    result: CanvasPresenceCommandResult;
  };
  "canvas-scene:compaction:read": {
    args: [request: CanvasSceneCompactionReadRequest];
    result: CanvasSceneCompactionReadCommandResult;
  };
  "canvas-scene:compaction:apply": {
    args: [request: CanvasSceneCompactionRequest];
    result: CanvasSceneCompactionCommandResult;
  };
  "document-sync:awareness:publish": {
    args: [request: ProjectScopedDocumentAwarenessPublishRequest];
    result: DocumentSyncCommandResult<DocumentAwarenessPublishAck>;
  };
  "library-document-sync:subscribe": {
    args: [request: DocumentSyncSubscribeRequest];
    result: DocumentSyncCommandResult<DocumentSyncSubscriptionAck>;
  };
  "library-document-sync:unsubscribe": {
    args: [request: DocumentSyncSubscribeRequest];
    result: DocumentSyncCommandResult<DocumentSyncUnsubscribeAck>;
  };
  "library-document-sync:sync": {
    args: [request: DocumentSyncRequest];
    result: DocumentSyncCommandResult<DocumentSyncResponse>;
  };
  "library-document-sync:apply": {
    args: [request: DocumentSyncApplyRequest];
    result: DocumentSyncApplyCommandResult;
  };
  "library-document-sync:awareness:publish": {
    args: [request: DocumentAwarenessPublishRequest];
    result: DocumentSyncCommandResult<DocumentAwarenessPublishAck>;
  };
  "blocks:transfer": {
    args: [projectId: string, intent: PublicBlockTransferIntent];
    result: BlockTransferCommandResult;
  };
  "blocks:transfer:undo": {
    args: [projectId: string, intent: PublicBlockTransferUndoIntent];
    result: BlockTransferUndoCommandResult;
  };
  "diagnostics:renderer-log": {
    args: [input: RendererDiagnosticsLogInput];
    result: void;
  };
  "persisted-atom:sync-request": { args: []; result: PersistedAtomSnapshot };
  "persisted-atom:update": {
    args: [mutation: PersistedAtomMutation];
    result: PersistedAtomEvent;
  };
  "projects:list": { args: [input?: ProjectWindowInput]; result: ProjectWindow };
  "projects:get": { args: [projectId: string]; result: Project | null };
  "projects:activity-summaries": {
    args: [projectIds: string[]];
    result: ProjectActivitySummaryResult;
  };
  "page-chats:activity-summaries": {
    args: [input: PageChatActivitySummaryInput];
    result: PageChatActivitySummaryResult;
  };
  "page-chats:list": {
    args: [input: PageChatWindowInput];
    result: PageChatWindow;
  };
  "page-chats:link": {
    args: [sessionId: string, input: PageChatLinkInput];
    result: void;
  };
  "page-chats:unlink": {
    args: [sessionId: string, input: PageChatLinkInput];
    result: void;
  };
  "projects:create": {
    args: [command: ProjectCreateCommandInput];
    result: CoreLocalCommitResult<Project>;
  };
  "projects:update": {
    args: [input: ProjectUpdateCommandInput];
    result: CoreLocalCommitResult<Project>;
  };
  "projects:reorder": {
    args: [command: ProjectReorderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "projects:set-pinned": {
    args: [command: ProjectPinnedCommandInput];
    result: CoreLocalCommitResult<Project>;
  };
  "projects:set-pinned-order": {
    args: [command: ProjectPinnedOrderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "projects:pick-source-roots": { args: []; result: string[] };
  "workspace:pick-directory": {
    args: [input?: WorkspacePickDirectoryInput];
    result: string | null;
  };
  "projects:set-lifecycle": {
    args: [command: ProjectLifecycleCommandInput];
    result: CoreLocalCommitResult<ProjectLifecycleCommittedValue, ProjectLifecycleCommandRejected>;
  };
  "sidebar-sections:list": {
    args: [input?: SidebarSectionWindowInput];
    result: SidebarSectionWindow;
  };
  "sidebar-sections:items:list": {
    args: [sectionId: string, input?: SidebarSectionItemWindowInput];
    result: SidebarSectionItemWindow;
  };
  "sidebar-sections:item:placement": {
    args: [item: SidebarSectionItemRef];
    result: string | null;
  };
  "sidebar-sections:create": {
    args: [command: SidebarSectionCreateCommandInput];
    result: CoreLocalCommitResult<SidebarSectionSummary>;
  };
  "sidebar-sections:rename": {
    args: [command: SidebarSectionRenameCommandInput];
    result: CoreLocalCommitResult<SidebarSectionSummary>;
  };
  "sidebar-sections:delete": {
    args: [command: SidebarSectionDeleteCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "sidebar-sections:restore": {
    args: [command: SidebarSectionRestoreCommandInput];
    result: CoreLocalCommitResult<SidebarSectionSummary>;
  };
  "sidebar-sections:item:move": {
    args: [command: SidebarSectionMoveItemCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "sidebar-sections:reorder": {
    args: [command: SidebarSectionReorderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "sidebar-sections:sessions:reorder": {
    args: [command: SidebarSectionSessionsReorderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "sidebar-sections:sessions:archive-all": {
    args: [command: SidebarSectionSessionsArchiveCommandInput];
    result: CoreLocalCommitResult<ProjectSession | null>;
  };
  "sidebar-sections:sessions:create": {
    args: [command: SidebarSectionSessionCreateCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "workspace:tasks:list": {
    args: [projectId: string | null, input?: ProjectSessionSummaryWindowInput];
    result: ProjectSessionSummaryWindow;
  };
  "project-sessions:get": {
    args: [sessionId: string];
    result: ProjectSession | null;
  };
  "project-sessions:create": {
    args: [command: ProjectSessionCreateCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:ensure-default-draft": {
    args: [command: ProjectSessionEnsureDefaultDraftCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:update": {
    args: [command: ProjectSessionUpdateCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:rename": {
    args: [command: ProjectSessionRenameCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:delete": {
    args: [command: ProjectSessionDeleteCommandInput];
    result: CoreLocalCommitResult<boolean>;
  };
  "project-sessions:reorder": {
    args: [command: ProjectSessionReorderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "project-sessions:set-pinned": {
    args: [command: ProjectSessionPinnedCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:set-pinned-order": {
    args: [command: ProjectSessionPinnedOrderCommandInput];
    result: CoreLocalCommitResult<void>;
  };
  "project-sessions:archive": {
    args: [command: ProjectSessionArchiveCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:unarchive": {
    args: [command: ProjectSessionArchiveCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:mark-unread": {
    args: [command: ProjectSessionUnreadCommandInput];
    result: CoreLocalCommitResult<ProjectSession>;
  };
  "project-sessions:fork": {
    args: [
      sessionId: string,
      input: ProjectSessionForkInput,
      sourceSceneContext?: CodexForkBrowserSceneContext,
    ];
    result: ProjectSessionForkResult;
  };
  "project-session-threads:attach": {
    args: [input: ProjectSessionThreadLinkInput];
    result: ProjectSessionThreadLink;
  };
  "project-session-threads:detach": {
    args: [sessionId: string];
    result: boolean;
  };
  "database:view-window:get": {
    args: [projectId: string, input: DatabaseViewWindowInput];
    result: CoreResult<DatabaseViewWindowSnapshot>;
  };
  "database:list-window:get": {
    args: [projectId: string, input: DatabaseListWindowInput];
    result: CoreResult<DatabaseListWindowSnapshot>;
  };
  "database:view-groups:get": {
    args: [projectId: string, input: DatabaseViewGroupsInput];
    result: CoreResult<DatabaseViewGroupsSnapshot>;
  };
  "library-database:view-window:get": {
    args: [
      input: DatabaseViewWindowInput &
        ({ readonly databaseViewId: string } | { readonly databaseId: string }),
    ];
    result: CoreResult<LibraryDatabaseViewWindowSnapshot>;
  };
  "library-database:list-window:get": {
    args: [
      input: DatabaseListWindowInput &
        ({ readonly databaseViewId: string } | { readonly databaseId: string }),
    ];
    result: CoreResult<LibraryDatabaseListWindowSnapshot>;
  };
  "library-database:view-groups:get": {
    args: [
      input: DatabaseViewGroupsInput &
        ({ readonly databaseViewId: string } | { readonly databaseId: string }),
    ];
    result: CoreResult<LibraryDatabaseViewGroupsSnapshot>;
  };
  "pages:search": {
    args: [requestId: string, input: PageSearchInput];
    result: PageSearchCommandResult;
  };
  "pages:search:cancel": {
    args: [requestId: string];
    result: boolean;
  };
  "pages:search-metadata": {
    args: [projectIds: string[], pageIds?: string[]];
    result: PageSearchMetadataSnapshot;
  };
  "pages:search-facets": {
    args: [projectIds: string[]];
    result: PageSearchFacets;
  };
  "database-row:get": {
    args: [
      projectId: string,
      pageId: string,
      status?: DatabasePage["status"],
      minimumCommitCursor?: ProjectionCursor,
    ];
    result: DatabasePage | null;
  };
  "calendar:occurrences": {
    args: [
      projectId: string,
      windowStart: Date,
      windowEnd: Date,
      searchQuery?: string,
      after?: string | null,
    ];
    result: {
      occurrences: PageOccurrence[];
      nextCursor: string | null;
    };
  };
  "page:occurrence:complete": {
    args: [projectId: string, input: PageOccurrenceCompleteInput, sessionId?: string];
    result: PageOccurrenceMutationResult;
  };
  "page:occurrence:skip": {
    args: [projectId: string, input: PageOccurrenceActionInput, sessionId?: string];
    result: PageOccurrenceMutationResult;
  };
  "page:occurrence:update": {
    args: [projectId: string, input: PageOccurrenceUpdateInput, sessionId?: string];
    result: PageOccurrenceMutationResult;
  };
  "backup:list": { args: []; result: BackupRecord[] };
  "backup:capacity:get": { args: []; result: BackupCapacity };
  "backup:storage-optimization:get": { args: []; result: SnapshotStorageOptimization };
  "backup:create": { args: [command: CreateBackupCommandInput]; result: BackupStartResult };
  "backup:job:get": { args: [jobId?: string]; result: BackupJobStatus | null };
  "backup:cancel": { args: [jobId: string]; result: BackupJobStatus };
  "backup:delete": {
    args: [backupId: string];
    result: { success: true; deletedBackupId: string };
  };
  "backup:restore": {
    args: [input: RestoreBackupInput];
    result: RestoreBackupResult;
  };
  "settings:backup:get": { args: []; result: BackupSettings };
  "settings:backup:update": {
    args: [input: UpdateBackupSettingsInput];
    result: BackupSettings;
  };
  "settings:acp-agents:get": { args: []; result: AcpAgentSettings };
  "settings:acp-agents:update": {
    args: [input: UpdateAcpAgentSettingsInput];
    result: AcpAgentSettings;
  };
  "agent-backend:acp:session:open": {
    args: [input: AcpBackendSessionOpenInput];
    result: AcpBackendSessionPresentation;
  };
  "agent-backend:acp:thread:start": {
    args: [input: AcpBackendThreadStartInput];
    result: AcpBackendThreadStartResult;
  };
  "agent-backend:acp:session:read": {
    args: [threadId: string];
    result: AcpBackendSessionPresentation | null;
  };
  "agent-backend:acp:session:observe": {
    args: [threadId: string];
    result: void;
  };
  "agent-backend:acp:session:unobserve": {
    args: [threadId: string];
    result: void;
  };
  "agent-backend:acp:session:prompt": {
    args: [input: AcpBackendPromptInput];
    result: AcpBackendPromptResult;
  };
  "agent-backend:acp:session:cancel": {
    args: [threadId: string];
    result: AcpConversationSnapshot;
  };
  "agent-backend:acp:session:set-mode": {
    args: [input: AcpBackendModeInput];
    result: AcpConversationSnapshot;
  };
  "agent-backend:acp:session:set-config-option": {
    args: [input: AcpBackendConfigOptionInput];
    result: AcpBackendConfigOptionResult;
  };
  "agent-backend:acp:session:authenticate": {
    args: [input: AcpBackendAuthenticateInput];
    result: AcpBackendAuthenticateResult;
  };
  "agent-backend:acp:session:close": {
    args: [threadId: string];
    result: void;
  };
  "settings:history:get": { args: []; result: HistorySettings };
  "settings:history:update": {
    args: [input: UpdateHistorySettingsInput];
    result: HistorySettings;
  };
  "settings:diagnostics:get": { args: []; result: DiagnosticsSettings };
  "settings:diagnostics:update": {
    args: [input: UpdateDiagnosticsSettingsInput];
    result: DiagnosticsSettings;
  };
  "settings:telemetry:get": { args: []; result: TelemetrySettings };
  "settings:telemetry:update": {
    args: [input: UpdateTelemetrySettingsInput];
    result: TelemetrySettings;
  };
  "settings:thread-notifications:get": {
    args: [];
    result: ThreadNotificationSettings;
  };
  "settings:thread-notifications:update": {
    args: [input: UpdateThreadNotificationSettingsInput];
    result: ThreadNotificationSettings;
  };
  "electron-window:focus:get": { args: []; result: boolean };
  "native-context-menu:show": {
    args: [items: NativeContextMenuItem[], options?: NativeContextMenuOptions];
    result: string | null;
  };
  "shell:file-link-openers:list-available": { args: []; result: FileLinkOpenerId[] };
  "settings:app-updates:get": { args: []; result: AppUpdateSettings };
  "settings:app-updates:update": {
    args: [input: UpdateAppUpdateSettingsInput];
    result: AppUpdateSettings;
  };
  "settings:window-restore:get": { args: []; result: WindowRestoreSettings };
  "settings:window-restore:update": {
    args: [input: UpdateWindowRestoreSettingsInput];
    result: WindowRestoreSettings;
  };
  "settings:codex-developer:get": {
    args: [];
    result: CodexDeveloperInstructionSettings;
  };
  "settings:codex-developer:update": {
    args: [input: UpdateCodexDeveloperInstructionSettingsInput];
    result: CodexDeveloperInstructionSettings;
  };
  "settings:git:get": { args: []; result: CodexGitSettings };
  "settings:git:update": {
    args: [input: UpdateCodexGitSettingsInput];
    result: CodexGitSettings;
  };
  "settings:third-party-notices:get": {
    args: [];
    result: ThirdPartyNotices;
  };
  "codex-command-keymap-state": { args: []; result: CommandKeymapState };
  "set-codex-command-keybinding": {
    args: [commandId: string, update: CommandKeybindingUpdate];
    result: CommandKeybindingMutationResult;
  };
  "reset-codex-command-keybindings": { args: []; result: CommandKeybindingMutationResult };
  "global-dictation:keyboard-layout:update": {
    args: [snapshot: KeyboardLayoutSnapshot];
    result: boolean;
  };
  "global-dictation-capture-fn-hotkey": { args: []; result: "Fn" | null };
  "global-dictation:event": { args: [event: GlobalDictationRendererEvent]; result: boolean };
  "global-dictation:context-menu": {
    args: [];
    result: import("./global-dictation").GlobalDictationContextMenuAction;
  };
  "app:update:status": { args: []; result: AppUpdateStatus };
  "app:update:check": { args: []; result: AppUpdateStatus };
  "app:update:install": { args: []; result: boolean };
  "shell:open-file-link": {
    args: [target: FileLinkTarget, openerId: FileLinkOpenerId];
    result: boolean;
  };
  "shell:open-external-url": {
    args: [url: string];
    result: boolean;
  };
  "shell:open-path-default": {
    args: [path: string];
    result: boolean;
  };
  "shell:path-context:get": {
    args: [];
    result: LocalPathPresentationContext;
  };
  "workspace-directory-entries": {
    args: [input: WorkspaceDirectoryEntriesInput];
    result: WorkspaceDirectoryEntriesResult;
  };
  "workspace-file-search": {
    args: [input: WorkspaceFileSearchInput];
    result: WorkspaceFileSearchResult;
  };
  "read-file": {
    args: [input: WorkspaceFileTextReadInput];
    result: WorkspaceFileReadResult;
  };
  "read-file-metadata": {
    args: [input: WorkspaceFileMetadataInput];
    result: WorkspaceFileMetadata;
  };
  "read-file-binary": {
    args: [input: WorkspaceFileRequest];
    result: WorkspaceFileBinaryReadResult;
  };
  "write-file": {
    args: [input: WorkspaceFileWriteInput];
    result: WorkspaceFileWriteResult;
  };
  "workspace-file-watch:start": {
    args: [input: WorkspaceFileRequest];
    result: WorkspaceFileWatchStartResult;
  };
  "workspace-file-watch:stop": {
    args: [input: WorkspaceFileWatchStopInput];
    result: void;
  };
  "open-file": {
    args: [target: FileLinkTarget, openerId: FileLinkOpenerId];
    result: boolean;
  };
  "asset:resolve-path": { args: [source: string]; result: string | null };
  "asset:image:save": {
    args: [input: ManagedAssetUploadInput];
    result: ManagedImageSaveResult;
  };
  "asset:canvas-image:materialize": {
    args: [input: ManagedAssetUploadInput];
    result: ManagedCanvasImageMaterializationResult;
  };
  "asset:image:read": {
    args: [source: string];
    result: ManagedAssetImageBytes;
  };
  "asset:resource:save": {
    args: [input: ManagedAssetUploadInput];
    result: ManagedResourceSaveResult;
  };
  "asset:resource:materialize": {
    args: [localPath: string];
    result: ManagedResourceSaveResult;
  };
  "asset:preview:read": {
    args: [input: ManagedAssetPreviewInput];
    result: ManagedAssetPreview;
  };
  "clipboard:write-image": {
    args: [input: { source: string }];
    result: ClipboardWriteImageResult;
  };
  "clipboard:structural-begin": {
    args: [input: StructuralClipboardBeginInput];
    result: StructuralClipboardLifecycleResult;
  };
  "clipboard:structural-publish": {
    args: [input: StructuralClipboardWriteInput];
    result: StructuralClipboardWriteResult;
  };
  "clipboard:structural-settle": {
    args: [input: StructuralClipboardSettleInput];
    result: StructuralClipboardLifecycleResult;
  };
  "clipboard:structural-await": {
    args: [input: StructuralClipboardAwaitInput];
    result: StructuralClipboardResolution;
  };
  "clipboard:write-claimed-presentation": {
    args: [input: ClaimedClipboardPresentationWriteInput];
    result: ClaimedClipboardPresentationWriteResult;
  };
  "clipboard:read-paste": {
    args: [];
    result: ClipboardPastePayload;
  };
  "composer:pick-files": {
    args: [input: { imagesOnly: boolean; title: string }];
    result: ComposerPickedFile[];
  };
  "window:show-emoji-panel": { args: []; result: boolean };
  "window:new": { args: [request?: WindowSessionNewWindowRequest]; result: boolean };
  "window-sessions:bootstrap": { args: []; result: WindowSessionBootstrap };
  "window-sessions:save-layout": {
    args: [input: WindowSessionSaveLayoutInput];
    result: WindowSessionBootstrap;
  };
  "window-sessions:update-bounds": {
    args: [bounds: WindowSessionBounds];
    result: void;
  };
  // Internal app lifecycle handshake used to flush renderer state before window close.
  "app:flush-before-close:done": {
    args: [webContentsId: number];
    result: void;
  };

  // Browser sidebar
  "browser-sidebar-command": {
    args: [command: BrowserSidebarCommand];
    result: BrowserSidebarCommandResult;
  };
  "browser-sidebar-runtime-snapshot": {
    args: [];
    result: BrowserSidebarRuntimeSnapshot;
  };
  "browser-browsing-data-clear": {
    args: [kind: BrowserBrowsingDataKind];
    result: BrowserBrowsingDataClearResult;
  };
  "browser-sidebar-webview-host-created": {
    args: [event: BrowserSidebarWebviewHostCreated];
    result: BrowserSidebarCommandResult;
  };
  "browser-sidebar-webview-destroyed": {
    args: [event: BrowserSidebarWebviewDestroyed];
    result: BrowserSidebarCommandResult;
  };
  "browser-downloads-list": {
    args: [];
    result: BrowserDownloadsSnapshot;
  };
  "browser-download-action": {
    args: [request: BrowserDownloadActionRequest];
    result: BrowserDownloadActionResult;
  };
  "browser-download-history-clear": {
    args: [];
    result: BrowserDownloadActionResult;
  };
  "browser-profile-capabilities": {
    args: [];
    result: BrowserProfileCapabilities;
  };
  "browser-profile-import-profiles": {
    args: [];
    result: ImportableBrowserProfile[];
  };
  "browser-profile-import": {
    args: [input: BrowserProfileImportInput];
    result: BrowserProfileImportResult;
  };
  "browser-credentials-list": {
    args: [input: BrowserCredentialListInput];
    result: BrowserCredentialSummary[];
  };
  "browser-credentials-list-all": {
    args: [];
    result: BrowserCredentialSummary[];
  };
  "browser-credential-fill": {
    args: [input: BrowserCredentialFillInput];
    result: BrowserCredentialActionResult;
  };
  "browser-credential-generate-fill": {
    args: [input: BrowserCredentialGenerateInput];
    result: BrowserCredentialActionResult;
  };
  "browser-credential-candidate-action": {
    args: [input: BrowserCredentialCandidateActionInput];
    result: BrowserCredentialActionResult;
  };
  "browser-credential-remove": {
    args: [credentialId: string];
    result: BrowserCredentialActionResult;
  };
  "browser-contact-info-list": {
    args: [];
    result: BrowserContactInfo[];
  };
  "browser-contact-info-upsert": {
    args: [input: BrowserContactInfoUpsertInput];
    result: BrowserContactInfo;
  };
  "browser-contact-info-remove": {
    args: [contactInfoId: string];
    result: BrowserCredentialActionResult;
  };
  "browser-contact-info-fill": {
    args: [input: BrowserContactInfoFillInput];
    result: BrowserCredentialActionResult;
  };
  "browser-history-list": {
    args: [input?: BrowserHistoryListInput];
    result: BrowserHistorySnapshot;
  };
  "browser-history-delete": {
    args: [historyId: string];
    result: BrowserCredentialActionResult;
  };
  "browser-site-info": {
    args: [input: BrowserSidebarTabIdentity];
    result: BrowserSiteInfo;
  };
  "browser-extensions-list": {
    args: [];
    result: BrowserExtensionsSnapshot;
  };
  "browser-extension-load": {
    args: [];
    result: BrowserExtensionSummary | null;
  };
  "browser-extension-remove": {
    args: [extensionId: string];
    result: BrowserCredentialActionResult;
  };
  "browser-use-policy-get": {
    args: [];
    result: BrowserUsePolicySnapshot;
  };
  "browser-use-policy-update-modes": {
    args: [input: BrowserUsePolicyModesUpdate];
    result: BrowserUsePolicySnapshot;
  };
  "browser-use-policy-update-origin-rule": {
    args: [input: BrowserUseOriginRuleUpdate];
    result: BrowserUsePolicySnapshot;
  };
  "computer-use-settings-get": {
    args: [];
    result: ComputerUseSettingsSnapshot;
  };
  "chrome-control-settings-get": {
    args: [];
    result: ChromeControlRuntimeSnapshot;
  };
  "computer-use-settings-remove-app-approval": {
    args: [bundleIdentifier: string];
    result: ComputerUseSettingsSnapshot;
  };
  "computer-use-settings-remove-message-approval": {
    args: [chatGuid: string];
    result: ComputerUseSettingsSnapshot;
  };
  "computer-use-settings-set-always-hide-pip": {
    args: [alwaysHide: boolean];
    result: ComputerUseSettingsSnapshot;
  };
  "computer-use-settings-set-locked-use": {
    args: [enabled: boolean];
    result: ComputerUseSettingsSnapshot;
  };
  "computer-use-settings-set-sound-mode": {
    args: [soundMode: ComputerUseSoundMode];
    result: ComputerUseSettingsSnapshot;
  };
  "browser-annotation-capture-evidence": {
    args: [input: import("./browser-annotation").BrowserAnnotationEvidenceCaptureInput];
    result: BrowserAnnotationAttachmentEvidence;
  };
  "browser-local-server-thumbnail": {
    args: [input: BrowserSidebarLocalServerThumbnailRequest];
    result: BrowserSidebarLocalServerThumbnailResult;
  };
  "browser-local-server-preferences-get": {
    args: [];
    result: BrowserLocalServerPreferences;
  };
  "browser-local-server-preferences-update": {
    args: [input: BrowserLocalServerPreferencesUpdate];
    result: BrowserLocalServerPreferences;
  };

  // Git repository identity and orchestrated actions
  "git:repository:identity": {
    args: [cwd: string];
    result: GitRepositoryIdentity | null;
  };
  "git:action:commit-message:generate": {
    args: [input: GitCommitMessageGenerateInput];
    result: GitCommitMessageGenerateResult;
  };
  "git:action:pull-request-message:generate": {
    args: [input: GitPullRequestMessageGenerateInput];
    result: GitPullRequestMessageGenerateResult;
  };
  "git:action:commit": {
    args: [input: GitCommitInput];
    result: GitActionMutationResult;
  };
  "git:action:push": {
    args: [input: GitPushInput];
    result: GitActionMutationResult;
  };
  "git:action:cancel": {
    args: [input: GitActionCancelInput];
    result: GitActionCancelResult;
  };

  // GitHub pull request review
  "gh-cli-status": {
    args: [input: { cwd: string }];
    result: GhCliStatusResult;
  };
  "gh-pr-status": {
    args: [input: GhPrStatusRequest];
    result: GhPrStatusResult;
  };
  "gh-pr-checks": {
    args: [input: GhPrChecksRequest];
    result: GhPrChecksResult;
  };
  "gh-pr-comments": {
    args: [input: GhPrCommentsRequest];
    result: GhPrCommentsResult;
  };
  "gh-pr-diff": { args: [input: GhPrDiffRequest]; result: GhPrDiffResult };
  "gh-pr-comment": {
    args: [input: GhPrCommentInput];
    result: GhPrCommentResult;
  };
  "gh-pr-merge": { args: [input: GhPrMergeInput]; result: GhPrMutationResult };
  "gh-pr-update": {
    args: [input: GhPrUpdateInput];
    result: GhPrMutationResult;
  };
  "gh-pr-create": {
    args: [input: GhPrCreateInput];
    result: GhPrMutationResult;
  };

  // Terminal
  "terminal-create": {
    args: [input: TerminalCreateRequest];
    result: TerminalViewLeaseResult;
  };
  "terminal-acquire-view": {
    args: [input: TerminalAttachRequest];
    result: TerminalViewLeaseResult;
  };
  "terminal-take-over-view": {
    args: [input: TerminalTakeOverViewRequest];
    result: TerminalViewLeaseResult;
  };
  "terminal-release-view": { args: [sessionId: string]; result: void };
  "terminal-write": { args: [sessionId: string, data: string]; result: void };
  "terminal-run-action": {
    args: [input: TerminalRunActionRequest];
    result: void;
  };
  "terminal-session:snapshot": {
    args: [sessionId: string];
    result: TerminalSessionSnapshot | null;
  };
  "terminal-resize": {
    args: [sessionId: string, size: TerminalSize];
    result: void;
  };
  "terminal-kill": { args: [sessionId: string]; result: void };
  "thread-terminal-snapshot": {
    args: [threadId: string];
    result: TerminalSessionSnapshot | null;
  };

  // Codex
  "codex:connection:status": { args: []; result: CodexConnectionState };
  "codex:account:read": { args: []; result: CodexAccountSnapshot };
  "codex:account:rate-limit-reset:consume": {
    args: [input: CodexRateLimitResetInput];
    result: CodexRateLimitResetResult;
  };
  "codex:dictation:state:read": {
    args: [];
    result: CodexDictationStateSnapshot;
  };
  "codex:dictation:microphone-access:read": {
    args: [];
    result: MicrophoneAccessStatus;
  };
  "codex:dictation:microphone-access:request": {
    args: [];
    result: MicrophoneAccessResult;
  };
  "codex:dictation:microphone-lease:acquire": {
    args: [input: { readonly sessionId: string; readonly surface: DictationSurface }];
    result: boolean;
  };
  "codex:dictation:microphone-lease:release": {
    args: [sessionId: string];
    result: boolean;
  };
  "codex:dictation:microphone-access:open-settings": {
    args: [];
    result: void;
  };
  "codex:dictation:microphone-route-hint:read": {
    args: [];
    result: string | null;
  };
  "codex:dictation:global-permissions:read": {
    args: [];
    result: GlobalDictationPermissionSnapshot;
  };
  "codex:dictation:global-permissions:request-input-monitoring": {
    args: [];
    result: GlobalDictationPermissionSnapshot;
  };
  "codex:dictation:global-permissions:request-accessibility": {
    args: [];
    result: GlobalDictationPermissionSnapshot;
  };
  "codex:dictation:global-permissions:open-input-monitoring-settings": {
    args: [];
    result: void;
  };
  "codex:dictation:global-permissions:open-accessibility-settings": {
    args: [];
    result: void;
  };
  "codex:dictation:settings:read": {
    args: [];
    result: DictationSettings;
  };
  "codex:dictation:settings:update": {
    args: [patch: DictationSettingsPatch];
    result: DictationSettings;
  };
  "codex:dictation:settings:consume-global-shortcut-nudge": {
    args: [];
    result: boolean;
  };
  "codex:dictation:history:create": {
    args: [input: DictationRecordingCreateInput];
    result: DictationRecordingMetadata;
  };
  "codex:dictation:history:append": {
    args: [input: DictationRecordingAppendInput];
    result: DictationRecordingMetadata;
  };
  "codex:dictation:history:finalize": {
    args: [input: DictationRecordingFinalizeInput];
    result: DictationRecordingMetadata;
  };
  "codex:dictation:history:set-transcript": {
    args: [input: DictationRecordingSetTranscriptInput];
    result: DictationRecordingMetadata;
  };
  "codex:dictation:history:list": {
    args: [];
    result: DictationRecordingMetadata[];
  };
  "codex:dictation:history:read-audio": {
    args: [id: string];
    result: DictationRecordingAudio;
  };
  "codex:dictation:history:download": {
    args: [id: string];
    result: { readonly status: "cancelled" | "saved" };
  };
  "codex:dictation:history:delete": {
    args: [id: string];
    result: void;
  };
  "codex:dictation:transcribe": {
    args: [input: { contentType: string; base64Payload: string; requestId: string }];
    result: string;
  };
  "codex:dictation:cleanup": {
    args: [
      input: {
        transcript: string;
        surroundingText: string | null;
        requestId: string;
      },
    ];
    result: string;
  };
  "codex:dictation:transcribe:cancel": {
    args: [requestId: string];
    result: boolean;
  };
  "codex:conversation-image-asset:resolve": {
    args: [input: CodexConversationImageAssetResolveInput];
    result: CodexConversationImageAssetResolveResult;
  };
  "codex:account:login:start": {
    args: [input: { type: "chatgpt" } | { type: "apiKey"; apiKey: string }];
    result: { type: "apiKey" } | { type: "chatgpt"; loginId: string; authUrl: string };
  };
  "codex:account:login:cancel": {
    args: [loginId: string];
    result: { status: "canceled" | "notFound" };
  };
  "codex:account:logout": { args: []; result: boolean };
  "codex:threads:list": {
    args: [projectId: string, input?: CodexThreadSummaryWindowInput];
    result: CodexThreadSummaryWindow;
  };
  "codex:sidebar:snapshot": {
    args: [input?: { includeArchived?: boolean; refresh?: boolean }];
    result: CodexSidebarSnapshot;
  };
  "codex:sidebar:sync": {
    args: [
      input?: {
        includeArchived?: boolean;
        policy?: CodexSidebarRefreshPolicy;
        reason?: CodexSidebarRefreshReason;
      },
    ];
    result: CodexSidebarSyncResult;
  };
  "codex:sidebar:thread:move": {
    args: [input: CodexSidebarThreadMoveInput];
    result: CodexSidebarThreadMoveResult;
  };
  "codex:threads:pinned:list": {
    args: [];
    result: string[];
  };
  "codex:threads:pinned:set": {
    args: [threadId: string, input: { pinned: boolean }];
    result: CodexSidebarSnapshot;
  };
  "codex:threads:pinned:reorder": {
    args: [orderedThreadIds: string[]];
    result: CodexSidebarSnapshot;
  };
  "codex:thread:ensure-session": {
    args: [threadId: string];
    result: ProjectSession | null;
  };
  "codex:threads:palette:list": {
    args: [input: CommandPaletteThreadListInput];
    result: CommandPaletteThreadSummary[];
  };
  "codex:threads:palette:search": {
    args: [input: CommandPaletteThreadSearchInput];
    result: CommandPaletteThreadSearchResult[];
  };
  "codex:thread:summary:get": {
    args: [threadId: string];
    result: CodexThreadSummary | null;
  };
  "codex:scheduled-automations:list": {
    args: [];
    result: CodexScheduledAutomationListResponse;
  };
  "codex:scheduled-automations:create": {
    args: [input: CodexScheduledAutomationCreateInput];
    result: CodexScheduledAutomationMutationResponse;
  };
  "codex:scheduled-automations:update": {
    args: [input: CodexScheduledAutomationUpdateInput];
    result: CodexScheduledAutomationMutationResponse;
  };
  "codex:scheduled-automations:delete": {
    args: [input: CodexScheduledAutomationDeleteInput];
    result: CodexScheduledAutomationDeleteResponse;
  };
  "codex:scheduled-automations:run-now": {
    args: [input: CodexScheduledAutomationRunNowInput];
    result: CodexScheduledAutomationRunNowResponse;
  };
  "codex:scheduled-automations:heartbeat-enabled-changed": {
    args: [input: CodexHeartbeatAutomationsEnabledChangedInput];
    result: { success: boolean };
  };
  "codex:scheduled-automations:heartbeat-thread-state-changed": {
    args: [input: CodexHeartbeatAutomationThreadStateChangedInput];
    result: { success: boolean };
  };
  "codex:automation-runs:archive": {
    args: [input: CodexAutomationRunArchiveInput];
    result: CodexAutomationRunMutationResponse;
  };
  "codex:automation-runs:delete": {
    args: [input: CodexAutomationRunDeleteInput];
    result: CodexAutomationRunMutationResponse;
  };
  "codex:automation-runs:unarchive": {
    args: [input: CodexAutomationRunUnarchiveInput];
    result: CodexAutomationRunMutationResponse;
  };
  "codex:automation-runs:inbox-items": {
    args: [limit?: number];
    result: CodexAutomationRunsInboxResponse;
  };
  "codex:automation-runs:set-read-state": {
    args: [input: CodexAutomationRunReadStateInput];
    result: CodexAutomationInboxItem | null;
  };
  "codex:automation-runs:mark-all-read": {
    args: [input: CodexAutomationRunMarkAllReadInput];
    result: CodexAutomationRunMarkAllReadResponse;
  };
  "codex:model:list": {
    args: [];
    result: CodexModelOption[];
  };
  "codex:composer-plugins:list": {
    args: [input: CodexComposerPluginListInput];
    result: CodexComposerPlugin[];
  };
  "codex:composer-plugins:activate": {
    args: [input: CodexComposerPluginActivateInput];
    result: void;
  };
  "codex:composer-skills:list": {
    args: [input: CodexComposerSkillListInput];
    result: CodexComposerSkill[];
  };
  "codex:composer-sites:list": {
    args: [];
    result: CodexComposerSiteListResult;
  };
  "codex:composer-chatgpt-conversations:list": {
    args: [input: CodexComposerChatGptConversationListInput];
    result: CodexComposerChatGptConversationListResult;
  };
  "codex:composer-appshot:target": {
    args: [];
    result: CodexComposerAppshotTargetResult;
  };
  "codex:composer-appshot:capture": {
    args: [input: CodexComposerAppshotCaptureInput];
    result: CodexComposerAppshotContext;
  };
  "agent-import:scan": {
    args: [input: AgentImportScanInput];
    result: AgentImportScan;
  };
  "agent-import:scan-picked-home": {
    args: [input: AgentImportScanInput];
    result: AgentImportScan | null;
  };
  "agent-import:apply": {
    args: [input: AgentImportApplyInput];
    result: AgentImportResult;
  };
  "codex:hooks:list": {
    args: [input: CodexHooksListInput];
    result: CodexHooksListResponse;
  };
  "codex:hooks:state:update": {
    args: [input: CodexHooksStateUpdateInput];
    result: void;
  };
  "codex:collaboration-mode:list": {
    args: [];
    result: CodexCollaborationModePreset[];
  };
  "codex:projectless-thread-cwd": {
    args: [input: CodexProjectlessThreadCwdInput];
    result: CodexProjectlessWorkspace;
  };
  "codex:thread:start-for-session": {
    args: [CodexThreadStartForSessionInput];
    result: CodexThreadStartForSessionResult;
  };
  "codex:thread:side-chat:start": {
    args: [CodexSideChatStartInput];
    result: CodexSideChatStartResult;
  };
  "codex:thread:side-chat:discard": {
    args: [threadId: string];
    result: boolean;
  };
  "codex:renderer-client:id": {
    args: [];
    result: string | null;
  };
  "codex:renderer-client:response": {
    args: [response: CodexRendererClientResponseMessage];
    result: boolean;
  };
  "codex:thread-owner:stream-state:publish": {
    args: [input: CodexThreadOwnerStreamStatePublishInput];
    result: CodexThreadOwnerStreamStatePublishResult;
  };
  "codex:thread-follower:snapshot-applied": {
    args: [input: CodexThreadFollowerSnapshotAppliedInput];
    result: boolean;
  };
  "codex:thread:stream-resync:request": {
    args: [input: CodexThreadStreamResyncRequestInput];
    result: boolean;
  };
  "codex:thread:resume-buffer:release": {
    args: [threadId: string];
    result: boolean;
  };
  "codex:thread-owner:notification:ack": {
    args: [input: CodexThreadOwnerNotificationAckInput];
    result: boolean;
  };
  "codex:thread-owner:pending-requests:replay": {
    args: [threadId: string];
    result: number;
  };
  "codex:thread-owner:app-server-request": {
    args: [input: CodexOwnerAppServerRequestInput];
    result: unknown;
  };
  "codex:thread-follower:action": {
    args: [input: CodexThreadFollowerActionInput];
    result: unknown;
  };
  "codex:dynamic-tool-call:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      context: {
        permissionMode: CodexAgentMode;
        serviceTierSelector: { type: "standard" } | { type: "custom"; serviceTier: string };
      },
    ];
    result: ProtocolDynamicToolCallResponse | null;
  };
  "worktrees:list": { args: [hostId: string]; result: ManagedWorktreeRecord[] };
  "worktrees:settings:get": { args: []; result: ManagedWorktreeSettings };
  "worktrees:settings:update": {
    args: [input: UpdateManagedWorktreeSettingsInput];
    result: ManagedWorktreeSettings;
  };
  "worktrees:execution-hosts:get": { args: []; result: CodexExecutionHostSettings };
  "worktrees:execution-hosts:update": {
    args: [input: UpdateCodexExecutionHostSettingsInput];
    result: CodexExecutionHostSettings;
  };
  "worktrees:environments:list": {
    args: [projectId: string];
    result: WorktreeEnvironmentOption[];
  };
  "worktrees:environments:configs:list": {
    args: [projectId: string];
    result: WorktreeEnvironmentConfigRecord[];
  };
  "worktrees:environments:configs:list-for-workspace": {
    args: [hostId: string, workspaceRoot: string];
    result: WorktreeEnvironmentConfigRecord[];
  };
  "worktrees:environments:config:read": {
    args: [projectId: string, configPath?: string | null];
    result: WorktreeEnvironmentSettingsSnapshot;
  };
  "worktrees:environments:config:save": {
    args: [input: UpdateWorktreeEnvironmentConfigInput];
    result: WorktreeEnvironmentSaveResult;
  };
  "worktrees:delete": {
    args: [hostId: string, worktreePath: string];
    result: boolean;
  };
  "worktrees:thread:availability": {
    args: [threadId: string];
    result: ManagedWorktreeAvailability;
  };
  "worktrees:thread:restore": {
    args: [threadId: string];
    result: ManagedWorktreeRestoreResult;
  };
  "codex:pending-worktrees:list": {
    args: [];
    result: CodexPendingWorktreeEntry[];
  };
  "codex:pending-worktree:create": {
    args: [input: CodexPendingWorktreeCreateInput];
    result: CodexPendingWorktreeCreateResult;
  };
  "codex:pending-worktree:auto-fix": {
    args: [hostId: string, pendingWorktreeId: string, agentMode: CodexAgentMode];
    result: CodexPendingWorktreeCreateResult;
  };
  "codex:pending-worktree:retry": {
    args: [hostId: string, pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:work-locally": {
    args: [hostId: string, pendingWorktreeId: string];
    result: { readonly threadId: string };
  };
  "codex:pending-worktree:continue": {
    args: [hostId: string, pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:cancel": {
    args: [hostId: string, pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:dismiss": {
    args: [hostId: string, pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:rename": {
    args: [hostId: string, pendingWorktreeId: string, label: string];
    result: void;
  };
  "codex:pending-worktree:set-pinned": {
    args: [hostId: string, pendingWorktreeId: string, isPinned: boolean];
    result: void;
  };
  "codex:pending-worktree:set-pinned-before-thread": {
    args: [hostId: string, pendingWorktreeId: string, beforeThreadId: string | null];
    result: void;
  };
  "codex:pending-worktree:clear-attention": {
    args: [hostId: string, pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:discard-fork-side-panel-transfer": {
    args: [pendingWorktreeId: string];
    result: void;
  };
  "codex:pending-worktree:resolve-thread": {
    args: [clientThreadId: string];
    result: CodexPendingWorktreeThreadResolution | null;
  };
  "codex:fork-side-panel-transfer:consume": {
    args: [input: CodexForkBrowserTransferConsumeInput];
    result: CodexForkBrowserSidePanelSnapshot | null;
  };
  "codex:thread:snapshot:request": {
    args: [threadId: string];
    result: CodexConversationSnapshot | null;
  };
  "codex:thread:resume:request": {
    args: [threadId: string];
    result: CodexRendererConversationResumeResult | null;
  };
  "codex:thread:fresh-owner:adopt": {
    args: [threadId: string, launchId: string];
    result: Extract<CodexRendererConversationResumeResult, { role: "owner" }>;
  };
  "codex:subagents:overview:read": {
    args: [input: CodexSubagentOverviewReadInput];
    result: CodexSubagentOverviewWindow;
  };
  "codex:subagents:selected:hydrate": {
    args: [input: CodexSelectedSubagentHydrateInput];
    result: CodexSelectedSubagentHydrateResult;
  };
  "codex:thread:view-active:set": {
    args: [input: { threadId: string; active: boolean }];
    result: boolean;
  };
  "codex:thread:stream-following:set": {
    args: [input: { threadId: string; following: boolean; reannounce?: boolean }];
    result: boolean;
  };
  "codex:thread:presentation:set": {
    args: [input: { threadId: string; surfaceId: string; presented: boolean }];
    result: boolean;
  };
  "codex:user-input:auto-resolution:snapshot": {
    args: [];
    result: CodexUserInputAutoResolutionEntry[];
  };
  "codex:user-input:auto-resolution:activity": {
    args: [input: { conversationId: string }];
    result: boolean;
  };
  "codex:user-input:auto-resolution:snooze": {
    args: [input: CodexUserInputAutoResolutionTarget];
    result: boolean;
  };
  "codex:thread:history-page:load": {
    args: [request: CodexConversationHistoryPageRequest];
    result: CodexConversationHistoryPageResult;
  };
  "codex:thread:prompt-rail:index": {
    args: [request: CodexPromptRailIndexRequest];
    result: CodexPromptRailIndexCommandResult;
  };
  "codex:thread:prompt-rail:reveal": {
    args: [request: CodexPromptRailRevealRequest];
    result: CodexPromptRailRevealCommandResult;
  };
  "codex:thread:prompt-rail:cancel": {
    args: [requestId: string];
    result: boolean;
  };
  "codex:thread:history-residency-pins:set": {
    args: [input: CodexHistoryResidencyPinsInput];
    result: CodexHistoryResidencyPinsResult;
  };
  "codex:thread:history-search": {
    args: [threadId: string, query: string];
    result: CodexPersistedHistorySearchResult;
  };
  "codex:thread:history-search:hydrate": {
    args: [input: CodexPersistedHistoryOccurrenceHydrateRequest];
    result: CodexPersistedHistoryOccurrenceHydrateResult;
  };
  "codex:thread:history-export:start": {
    args: [threadId: string];
    result: import("./types").CodexConversationHistoryExportStartResult;
  };
  "codex:thread:history-export:next": {
    args: [jobId: string];
    result: import("./types").CodexConversationHistoryExportNextResult;
  };
  "codex:thread:history-export:cancel": {
    args: [jobId: string];
    result: boolean;
  };
  "codex:thread:name:set": {
    args: [threadId: string, name: string];
    result: boolean;
  };
  "codex:thread:name:set-generated": {
    args: [threadId: string, name: string];
    result: boolean;
  };
  "codex:thread:title:generate": {
    args: [input: { hostId: string; prompt: string; cwd: string | null }];
    result: { title: string | null };
  };
  "codex:thread:archive": { args: [threadId: string]; result: boolean };
  "codex:thread:delete-archived": { args: [threadId: string]; result: boolean };
  "codex:thread:unarchive": {
    args: [threadId: string];
    result: CodexThreadSummary | null;
  };
  "codex:thread:collaboration-mode:set": {
    args: [threadId: string, collaborationMode: CodexCollaborationModeKind];
    result: CodexCollaborationModeState;
  };
  "codex:personality:get": { args: []; result: CodexPersonality };
  "codex:personality:set": { args: [personality: CodexPersonality]; result: void };
  "codex:thread:settings:update": {
    args: [threadId: string, patch: CodexConversationThreadSettingsPatch];
    result: CodexConversationThreadSettings;
  };
  "codex:thread:plan-implementation:remove": {
    args: [threadId: string, turnId: string];
    result: boolean;
  };
  "codex:turn:start": {
    args: [threadId: string, prompt: string, opts?: CodexTurnStartOptions];
    result: CodexTurnSummary | null;
  };
  "codex:review:start": {
    args: [input: CodexReviewStartParams];
    result: CodexReviewStartResponse;
  };
  "codex:thread:follow-up:enqueue": {
    args: [threadId: string, prompt: string, opts?: CodexTurnStartOptions];
    result: void;
  };
  "codex:thread:follow-up:remove": {
    args: [threadId: string, followUpId: string];
    result: void;
  };
  "codex:thread:follow-up:replace": {
    args: [
      threadId: string,
      followUpId: string,
      expectedLedgerRevision: number,
      prompt: string,
      opts?: CodexTurnStartOptions,
    ];
    result: boolean;
  };
  "codex:thread:follow-up:reorder": {
    args: [threadId: string, orderedFollowUpIds: string[]];
    result: void;
  };
  "codex:thread:follow-up:resume": {
    args: [threadId: string];
    result: boolean;
  };
  "codex:thread:follow-up:resolve-after-fresh-start": {
    args: [threadId: string, expectedLedgerRevision: number, resolution: "resume" | "clear"];
    result: boolean;
  };
  "codex:thread:follow-up:send-now": {
    args: [threadId: string, followUpId: string];
    result: void;
  };
  "codex:thread:compact:start": {
    args: [threadId: string];
    result: void;
  };
  "codex:thread:goal:get": {
    args: [threadId: string];
    result: ThreadGoal | null;
  };
  "codex:thread:goal:set": {
    args: [params: CodexThreadGoalSetActionInput];
    result: ThreadGoal | null;
  };
  "codex:thread:goal:clear": {
    args: [threadId: string];
    result: void;
  };
  "codex:thread:goal:materialize-draft": {
    args: [draft: CodexThreadGoalDraftInput];
    result: CodexThreadGoalMaterializedDraft;
  };
  "codex:thread:goal:materialized-cleanup": {
    args: [attachmentDirectory: string | null];
    result: void;
  };
  "codex:thread:goal:editable-objective:read": {
    args: [objective: string];
    result: string;
  };
  "codex:pasted-text:create": {
    args: [input: CreatePastedTextAttachmentInput];
    result: CreatePastedTextAttachmentResult;
  };
  "codex:pasted-text:read": {
    args: [input: ReadPastedTextAttachmentInput];
    result: string;
  };
  "codex:pasted-text:remove": {
    args: [input: RemovePastedTextAttachmentInput];
    result: void;
  };
  "codex:thread:memory-mode:set": {
    args: [threadId: string, mode: ThreadMemoryMode];
    result: void;
  };
  "codex:feedback:upload": {
    args: [params: FeedbackUploadParams];
    result: FeedbackUploadResponse | void;
  };
  "codex:turn:steer": {
    args: [input: CodexSteerTurnInput];
    result: { turnId: string } | null;
  };
  "codex:turn:interrupt": {
    args: [threadId: string, turnId?: string];
    result: boolean;
  };
  "codex:thread:background-terminals:clean": {
    args: [threadId: string];
    result: boolean;
  };
  "codex:thread:background-terminals:clean-silent": {
    args: [threadId: string];
    result: boolean;
  };
  "codex:thread:background-terminals:list": {
    args: [threadId: string];
    result: ThreadBackgroundTerminal[];
  };
  "codex:thread:background-processes:list": {
    args: [
      input: {
        threadId: string;
        observedTerminals?: ThreadBackgroundTerminal[];
      },
    ];
    result: CodexBackgroundProcessRow[];
  };
  "codex:thread:background-processes:run-action": {
    args: [input: CodexBackgroundProcessRunActionInput];
    result: CodexBackgroundProcessRow[];
  };
  "codex:thread:background-terminals:terminate": {
    args: [input: { threadId: string; processId: string }];
    result: boolean;
  };
  "codex:mcp-resource:read": {
    args: [params: ProtocolMcpResourceReadParams];
    result: ProtocolMcpResourceReadResponse;
  };
  "codex:mcp-tool:call": {
    args: [params: ProtocolMcpServerToolCallParams];
    result: ProtocolMcpServerToolCallResponse;
  };
  "mcp-app:open-external": {
    args: [url: string];
    result: void;
  };
  "codex:mcp-apps:list": {
    args: [];
    result: ProtocolAppInfo[];
  };
  "codex:experimental-features:list": {
    args: [];
    result: ProtocolExperimentalFeature[];
  };
  "codex:mcp-server-statuses:list": {
    args: [threadId?: string];
    result: ProtocolListMcpServerStatusResponse;
  };
  "codex:approval:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexApprovalResponse,
    ];
    result: boolean;
  };
  "codex:user-input:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      answers: Record<string, string[]>,
    ];
    result: boolean;
  };
  "codex:mcp-elicitation:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexMcpServerElicitationResponse,
    ];
    result: boolean;
  };
  "codex:permission-request:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexPermissionRequestResponse,
    ];
    result: boolean;
  };
  "codex:option-picker:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalOptionPickerResponse,
    ];
    result: boolean;
  };
  "codex:setup-context-picker:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalSetupContextPickerResponse,
    ];
    result: boolean;
  };
  "codex:setup-codex-step:respond": {
    args: [
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalSetupCodexStepResponse,
    ];
    result: boolean;
  };
  "codex:conversation-unread:set": {
    args: [conversationId: string, hasUnreadTurn: boolean];
    result: boolean;
  };
  "codex:permission:mode:set": {
    args: [projectId: string | null, mode: CodexPermissionMode];
    result: CodexPermissionState;
  };
  "codex:permission:mode:get": {
    args: [projectId: string | null];
    result: CodexPermissionMode;
  };
  "codex:permission:state:get": {
    args: [projectId: string | null];
    result: CodexPermissionState;
  };
  "codex:permission:config-value:set": {
    args: [projectId: string | null, keyPath: string, value: unknown];
    result: CodexPermissionState;
  };
}

/** The endpoint table already guarantees argument tuples; avoid rediscovering them in callers. */
export type IpcArgs<Channel extends keyof IpcApi> = IpcApi[Channel]["args"];

export interface IpcEvents {
  "global-dictation:command": import("./global-dictation").GlobalDictationRendererCommand;
  "agent-import:progress": AgentImportProgress;
  "agent-backend:acp:session-changed": import("./agent-backend-api").AcpBackendSessionChangedEvent;
  "workspace-file:changed": import("./types").WorkspaceFileChangedEvent;
  "document-sync:event": DocumentSyncRealtimeEvent;
  "persisted-atom:updated": PersistedAtomEvent;
  "recipient-delivery:message": import("./recipient-delivery").RecipientDeliveryEnvelope;
  "board-changed": BoardChangeEvent;
  "page-ownership-paths-changed": import("./page-ownership-path-events").PageOwnershipPathsChangedEvent;
  "database-changed": DatabaseChangeEvent;
  "library-navigation-changed": import("./library-events").LibraryNavigationChangedEvent;
  "projects-changed": ProjectsChangeEvent;
  "project-sessions-changed": ProjectSessionsChangeEvent;
  "reminder:open": {
    projectId: string;
    pageId: string;
    occurrenceStart: string;
  };
  "terminal-data": TerminalDataEvent;
  "terminal-init-log": TerminalInitLogEvent;
  "terminal-attached": TerminalAttachedEvent;
  "terminal-error": TerminalErrorEvent;
  "terminal-exit": TerminalExitEvent;
  "terminal-view-lease-revoked": TerminalViewLeaseRevokedEvent;
  "codex:event": CodexEvent;
  "codex:host-message": CodexHostMessage;
  "codex:user-input:auto-resolution:changed": CodexUserInputAutoResolutionChange;
  "codex:renderer-client:request": CodexRendererClientRequestMessage;
  "codex:scheduled-automations:changed": CodexScheduledAutomationChangedEvent;
  "codex:automation-runs:updated": CodexAutomationRunsUpdatedEvent;
  "codex:hooks:changed": CodexHooksChangedEvent;
  "codex:pending-worktrees:changed": CodexPendingWorktreesChangedEvent;
  "codex:pending-worktree:warning": CodexPendingWorktreeWarningEvent;
  "browser-sidebar-state": BrowserSidebarStateSnapshot;
  "browser-sidebar-local-servers": BrowserSidebarLocalServersSnapshot;
  "browser-sidebar-browser-use-state": BrowserSidebarBrowserUseStateSnapshot;
  "browser-sidebar-browser-use-viewport": BrowserSidebarBrowserUseViewportEvent;
  "browser-sidebar-browser-use-capture-surface": BrowserSidebarBrowserUseCaptureSurfaceEvent;
  "browser-sidebar-browser-use-cursor-state": BrowserUseCursorState;
  "browser-sidebar-browser-use-page-released": BrowserSidebarTabIdentity;
  "browser-sidebar-browser-use-page-closed": BrowserUsePageClosedEvent;
  "browser-sidebar-browser-use-presentation-request": BrowserUsePresentationRequest;
  "browser-sidebar-open-new-tab": BrowserSidebarOpenNewTabRequest;
  "browser-sidebar-context-menu-action": BrowserSidebarContextMenuActionEvent;
  "browser-sidebar-image-drag-state": BrowserSidebarImageDragStateEvent;
  "browser-sidebar-webview-attached": BrowserSidebarWebviewAttached;
  "browser-sidebar-destroy-webview": BrowserSidebarDestroyWebviewRequest;
  "browser-downloads-state": BrowserDownloadsSnapshot;
  "browser-credential-save-candidate": BrowserCredentialSaveCandidate;
  "browser-annotation-selection": BrowserAnnotationRoutedSelectionEvent;
  "browser-annotation-anchor-update": BrowserAnnotationRoutedAnchorUpdateEvent;
  "browser-local-server-preferences-changed": BrowserLocalServerPreferences;
  "remote-hosted-pip:revision": RemoteHostedPipRevisionEvent;
  "chrome-control-settings-changed": ChromeControlRuntimeSnapshot;
  "desktop-notification:action": DesktopNotificationActionInvocation;
  "electron-window:focus-changed": { isFocused: boolean };
  "electron-window-opaque-surface-changed": {
    opaqueWindowSurfaceEnabled: boolean;
  };
}
