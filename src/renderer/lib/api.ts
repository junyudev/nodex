import { resolveInvokeTransport, resolveRendererTransport } from "./renderer-transport";
import type { IpcApi } from "../../shared/ipc-api";
import type {
  ContentAccessContext,
  ContentAccessIdentity,
} from "../../shared/content-access-context";
import {
  isCursorRejectionCode,
  type CoreErrorDetail,
  type CoreResult,
} from "../../shared/core-result";
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
} from "../../shared/database-views";
import type { DocumentSyncAdapter } from "./nodex-y-provider";
import type { CanvasSceneSyncAdapter } from "./canvas-scene-provider";
import type {
  CanvasSceneCompactionCommandResult,
  CanvasSceneCompactionReadCommandResult,
  CanvasSceneCompactionReadRequest,
  CanvasSceneCompactionRequest,
} from "../../shared/block-documents/canvas-scene-maintenance";
import type {
  LibraryAccessedDocumentDescriptor,
  ProjectAccessedDocumentDescriptor,
} from "../../shared/block-documents/contracts";
import type { DocumentSyncCommandResult } from "../../shared/block-documents/document-sync";
import type { PageTargetReadModel, ResolvePageTargetInput } from "../../shared/page-targets";
import type {
  PageOwnershipPathReadModel,
  ResolvePageOwnershipPathInput,
} from "../../shared/page-ownership-paths";
import type {
  DatabaseViewReadModel,
  ReadDatabaseViewReferenceInput,
} from "../../shared/database-views";
import type {
  BlockPropertyMutationCommandResultV2,
  BlockPropertyMutationRequestV2,
  LibraryBlockPropertyMutationCommandResultV2,
  LibraryBlockPropertyMutationRequestV2,
} from "../../shared/block-property-mutations-v2";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
} from "../../shared/database-module-v2";
import type {
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
  LibraryModuleReadRequest,
  LibraryModuleReadResult,
} from "../../shared/library-module";
import type {
  PageFileBytes,
  PickPageFilesInput,
  PickPageFilesResult,
  PreparedPickedPageFile,
  PreparePageFileInput,
  ReadPageFileBytesInput,
  SavePageFileInput,
  SavePageFileResult,
} from "../../shared/page-files";
import type { LibraryPageDetailResult, PageDetailResult } from "../../shared/page-detail";
import type {
  DocumentMutationRequest,
  DocumentOperationCommandResult,
} from "../../shared/block-documents/document-operations";
import type {
  CreateDocumentVersionCheckpoint,
  CreatedDocumentVersionSummary,
  DocumentVersionDetail,
  DocumentVersionSummary,
  GetDocumentVersion,
  ListDocumentVersions,
  PrepareDocumentVersionRestore,
} from "../../shared/block-documents/document-history";
import type { DocumentHistoryCommandResult } from "../../shared/block-documents/document-history-transport";
import type {
  PageLifecycleMutationCommandResultV2,
  PageLifecycleMutationRequestV2,
} from "../../shared/page-lifecycle-v2";
import type {
  PageLifecycleExecutionResultV2,
  PageLifecycleIntentV2,
  PageLifecyclePreflightResultV2,
} from "../../shared/page-lifecycle-v2-runtime";
import type { ListPageHistoryRequest } from "../../shared/page-history";
import type { PageHistoryCommandResult } from "../../shared/page-history-transport";
import type { AdditionalDocumentCommandResult } from "../../shared/additional-document-commands";
import type { PublicAdditionalDocumentCommandRequest } from "../../shared/additional-document-command-transport";
import type {
  BlockTransferCommandResult,
  BlockTransferUndoCommandResult,
} from "../../shared/block-transfer";
import type {
  PublicBlockTransferIntent,
  PublicBlockTransferUndoIntent,
} from "../../shared/block-transfer-transport";
import type {
  CreatePastedTextAttachmentInput,
  CreatePastedTextAttachmentResult,
  ReadPastedTextAttachmentInput,
  RemovePastedTextAttachmentInput,
} from "../../shared/pasted-text-attachments";
import { GitWorkerClient } from "./git-worker-client";
import { admitLocalCommitApply } from "./local-commit-ingress";
import type { PageSearchInput, PageSearchSnapshot } from "../../shared/types";
import type {
  ClaimedClipboardPresentationWriteInput,
  ClaimedClipboardPresentationWriteResult,
  StructuralClipboardWriteInput,
  StructuralClipboardWriteResult,
} from "../../shared/clipboard-paste";
import type {
  DictationSettings,
  DictationSettingsPatch,
  GlobalDictationPermissionSnapshot,
  MicrophoneAccessResult,
  MicrophoneAccessStatus,
} from "../../shared/dictation";
import type {
  DictationRecordingAppendInput,
  DictationRecordingAudio,
  DictationRecordingCreateInput,
  DictationRecordingFinalizeInput,
  DictationRecordingMetadata,
  DictationRecordingSetTranscriptInput,
} from "../../shared/dictation-history";

let gitWorkerClient: GitWorkerClient | null = null;

export function getGitWorkerClient(): GitWorkerClient {
  if (gitWorkerClient) return gitWorkerClient;
  const transport = resolveRendererTransport();
  gitWorkerClient = new GitWorkerClient({
    send: async (message) => await transport.sendGitWorkerMessage(message),
    subscribe: (listener) => transport.subscribeGitWorkerMessages(listener),
  });
  return gitWorkerClient;
}

export async function invoke<Channel extends keyof IpcApi>(
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]>;
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown>;
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const transport = resolveInvokeTransport();
  return transport.invoke(channel, ...args);
}

export function readMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
  return invoke("codex:dictation:microphone-access:read");
}

export function readDictationCapabilityState() {
  return invoke("codex:dictation:state:read");
}

export function requestMicrophoneAccess(): Promise<MicrophoneAccessResult> {
  return invoke("codex:dictation:microphone-access:request");
}

export function acquireDictationMicrophoneLease(
  sessionId: string,
  surface: import("../../shared/dictation").DictationSurface,
): Promise<boolean> {
  return invoke("codex:dictation:microphone-lease:acquire", { sessionId, surface });
}

export function releaseDictationMicrophoneLease(sessionId: string): Promise<boolean> {
  return invoke("codex:dictation:microphone-lease:release", sessionId);
}

export function openMicrophoneSettings(): Promise<void> {
  return invoke("codex:dictation:microphone-access:open-settings");
}

export function readBuiltInMicrophoneRouteHint(): Promise<string | null> {
  return invoke("codex:dictation:microphone-route-hint:read");
}

export function readGlobalDictationPermissions(): Promise<GlobalDictationPermissionSnapshot> {
  return invoke("codex:dictation:global-permissions:read");
}

export function requestGlobalDictationInputMonitoring(): Promise<GlobalDictationPermissionSnapshot> {
  return invoke("codex:dictation:global-permissions:request-input-monitoring");
}

export function requestGlobalDictationAccessibility(): Promise<GlobalDictationPermissionSnapshot> {
  return invoke("codex:dictation:global-permissions:request-accessibility");
}

export function openGlobalDictationInputMonitoringSettings(): Promise<void> {
  return invoke("codex:dictation:global-permissions:open-input-monitoring-settings");
}

export function openGlobalDictationAccessibilitySettings(): Promise<void> {
  return invoke("codex:dictation:global-permissions:open-accessibility-settings");
}

export function readDictationSettings(): Promise<DictationSettings> {
  return invoke("codex:dictation:settings:read");
}

export function updateDictationSettings(patch: DictationSettingsPatch): Promise<DictationSettings> {
  return invoke("codex:dictation:settings:update", patch);
}

export function consumeGlobalDictationShortcutNudge(): Promise<boolean> {
  return invoke("codex:dictation:settings:consume-global-shortcut-nudge");
}

export function createDictationRecording(
  input: DictationRecordingCreateInput,
): Promise<DictationRecordingMetadata> {
  return invoke("codex:dictation:history:create", input);
}

export function appendDictationRecording(
  input: DictationRecordingAppendInput,
): Promise<DictationRecordingMetadata> {
  return invoke("codex:dictation:history:append", input);
}

export function finalizeDictationRecording(
  input: DictationRecordingFinalizeInput,
): Promise<DictationRecordingMetadata> {
  return invoke("codex:dictation:history:finalize", input);
}

export function setDictationRecordingTranscript(
  input: DictationRecordingSetTranscriptInput,
): Promise<DictationRecordingMetadata> {
  return invoke("codex:dictation:history:set-transcript", input);
}

export function listDictationRecordings(): Promise<DictationRecordingMetadata[]> {
  return invoke("codex:dictation:history:list");
}

export function readDictationRecordingAudio(id: string): Promise<DictationRecordingAudio> {
  return invoke("codex:dictation:history:read-audio", id);
}

export function downloadDictationRecording(
  id: string,
): Promise<{ readonly status: "cancelled" | "saved" }> {
  return invoke("codex:dictation:history:download", id);
}

export function deleteDictationRecording(id: string): Promise<void> {
  return invoke("codex:dictation:history:delete", id);
}

export function writeStructuralClipboard(
  input: StructuralClipboardWriteInput,
): Promise<StructuralClipboardWriteResult> {
  return invoke("clipboard:write-structural", input);
}

export function writeClaimedClipboardPresentation(
  input: ClaimedClipboardPresentationWriteInput,
): Promise<ClaimedClipboardPresentationWriteResult> {
  return invoke("clipboard:write-claimed-presentation", input);
}

export async function searchPages(
  input: PageSearchInput,
  signal?: AbortSignal,
): Promise<PageSearchSnapshot> {
  if (signal?.aborted) throw new DOMException("Page search was aborted", "AbortError");
  const requestId = globalThis.crypto.randomUUID();
  const cancel = (): void => {
    void invoke("pages:search:cancel", requestId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke("pages:search", requestId, input);
    if (signal?.aborted || result.status === "cancelled") {
      throw new DOMException("Page search was aborted", "AbortError");
    }
    return result.snapshot;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function createDocumentSyncAdapter(projectId: string): DocumentSyncAdapter {
  const transport = resolveRendererTransport();
  const createAdapter = transport.createDocumentSyncAdapter;
  if (createAdapter) {
    return createAdapter(projectId);
  }
  throw new Error("Document sync is unavailable for this renderer transport");
}

export function createLibraryDocumentSyncAdapter(): DocumentSyncAdapter {
  const createAdapter = resolveRendererTransport().createLibraryDocumentSyncAdapter;
  if (createAdapter) return createAdapter();
  throw new Error("Library Document sync is unavailable for this renderer transport");
}

export function createDocumentSyncAdapterForContentAccess(
  accessContext: ContentAccessContext,
): DocumentSyncAdapter {
  return accessContext.kind === "project"
    ? createDocumentSyncAdapter(accessContext.projectId)
    : createLibraryDocumentSyncAdapter();
}

export function createCanvasSceneSyncAdapter(
  identity: ContentAccessIdentity,
): CanvasSceneSyncAdapter {
  const transport = resolveRendererTransport();
  const createAdapter = transport.createCanvasSceneSyncAdapter;
  if (createAdapter) return createAdapter(identity);
  throw new Error("Canvas scene sync is unavailable for this renderer transport");
}

export function readCanvasSceneCompaction(
  request: CanvasSceneCompactionReadRequest,
): Promise<CanvasSceneCompactionReadCommandResult> {
  return invoke("canvas-scene:compaction:read", request);
}

export function compactCanvasScene(
  request: CanvasSceneCompactionRequest,
): Promise<CanvasSceneCompactionCommandResult> {
  return invoke("canvas-scene:compaction:apply", request).then(async (result) => {
    if (result.ok) await admitLocalCommitApply(result.localCommit);
    return result;
  });
}

export function getOwnedDocumentDescriptor(
  projectId: string,
  ownerBlockId: string,
): Promise<ProjectAccessedDocumentDescriptor> {
  return resolveRendererTransport().getOwnedDocumentDescriptor(projectId, ownerBlockId);
}

export function prepareOwnedBlockDocument(
  projectId: string,
  ownerBlockId: string,
): Promise<DocumentSyncCommandResult<ProjectAccessedDocumentDescriptor>> {
  return resolveRendererTransport().prepareOwnedBlockDocument(projectId, ownerBlockId);
}

export function prepareLibraryOwnedBlockDocument(
  ownerBlockId: string,
): Promise<DocumentSyncCommandResult<LibraryAccessedDocumentDescriptor>> {
  return resolveRendererTransport().prepareLibraryOwnedBlockDocument(ownerBlockId);
}

export function prepareOwnedBlockDocumentForContentAccess(
  accessContext: ContentAccessContext,
  ownerBlockId: string,
): Promise<
  DocumentSyncCommandResult<ProjectAccessedDocumentDescriptor | LibraryAccessedDocumentDescriptor>
> {
  return accessContext.kind === "project"
    ? prepareOwnedBlockDocument(accessContext.projectId, ownerBlockId)
    : prepareLibraryOwnedBlockDocument(ownerBlockId);
}

export async function mutateDocument(
  projectId: string,
  documentId: string,
  request: DocumentMutationRequest,
): Promise<DocumentOperationCommandResult> {
  const result = await resolveRendererTransport().mutateDocument(projectId, documentId, request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export async function applyAdditionalDocumentCommand(
  projectId: string,
  request: PublicAdditionalDocumentCommandRequest,
): Promise<AdditionalDocumentCommandResult> {
  const result = await resolveRendererTransport().applyAdditionalDocumentCommand(
    projectId,
    request,
  );
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export async function transferBlocks(
  projectId: string,
  intent: PublicBlockTransferIntent,
): Promise<BlockTransferCommandResult> {
  const result = await resolveRendererTransport().transferBlocks(projectId, intent);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export async function undoBlockTransfer(
  projectId: string,
  intent: PublicBlockTransferUndoIntent,
): Promise<BlockTransferUndoCommandResult> {
  const result = await resolveRendererTransport().undoBlockTransfer(projectId, intent);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function createPastedTextAttachment(
  input: CreatePastedTextAttachmentInput,
): Promise<CreatePastedTextAttachmentResult> {
  return invoke("codex:pasted-text:create", input);
}

export function readPastedTextAttachment(input: ReadPastedTextAttachmentInput): Promise<string> {
  return invoke("codex:pasted-text:read", input);
}

export function removePastedTextAttachment(input: RemovePastedTextAttachmentInput): Promise<void> {
  return invoke("codex:pasted-text:remove", input);
}

export function createDocumentVersionCheckpoint(
  projectId: string,
  documentId: string,
  request: CreateDocumentVersionCheckpoint,
): Promise<DocumentHistoryCommandResult<CreatedDocumentVersionSummary>> {
  return resolveRendererTransport().createDocumentVersionCheckpoint(projectId, documentId, request);
}

export function listDocumentVersions(
  request: ListDocumentVersions,
): Promise<DocumentHistoryCommandResult<readonly DocumentVersionSummary[]>> {
  return resolveRendererTransport().listDocumentVersions(request);
}

export function getDocumentVersion(
  request: GetDocumentVersion,
): Promise<DocumentHistoryCommandResult<DocumentVersionDetail>> {
  return resolveRendererTransport().getDocumentVersion(request);
}

export async function restoreDocumentVersion(
  projectId: string,
  documentId: string,
  request: PrepareDocumentVersionRestore,
): Promise<DocumentOperationCommandResult> {
  const result = await resolveRendererTransport().restoreDocumentVersion(
    projectId,
    documentId,
    request,
  );
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function resolvePageTarget(
  input: ResolvePageTargetInput,
): Promise<PageTargetReadModel | null> {
  return invoke("page-target:resolve", input);
}

export function resolvePageOwnershipPath(
  input: ResolvePageOwnershipPathInput,
): Promise<PageOwnershipPathReadModel | null> {
  return invoke("page-ownership-path:resolve", input);
}

export function readDatabaseViewReference(
  input: ReadDatabaseViewReferenceInput,
): Promise<DatabaseViewReadModel | null> {
  return invoke("database-view:reference:get", input);
}

export async function mutateBlockProperties(
  projectId: string,
  request: BlockPropertyMutationRequestV2,
): Promise<BlockPropertyMutationCommandResultV2> {
  const result = await invoke("block-properties:mutate", projectId, request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export async function mutateLibraryBlockProperties(
  request: LibraryBlockPropertyMutationRequestV2,
): Promise<LibraryBlockPropertyMutationCommandResultV2> {
  const result = await invoke("library-block-properties:mutate", request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function readPageLifecyclePreflight(
  projectId: string,
  pageId: string,
): Promise<PageLifecyclePreflightResultV2> {
  return resolveRendererTransport().readPageLifecyclePreflight(projectId, pageId);
}

export async function mutatePageLifecycle(
  projectId: string,
  request: PageLifecycleMutationRequestV2,
): Promise<PageLifecycleMutationCommandResultV2> {
  const result = await resolveRendererTransport().mutatePageLifecycle(projectId, request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

/**
 * Run the renderer-owned Page lifecycle workflow behind the transport API.
 * The lazy import keeps the workflow's dependency on this module acyclic.
 */
export async function commitPageLifecycleIntent(
  intent: PageLifecycleIntentV2,
): Promise<PageLifecycleExecutionResultV2> {
  const runtime = await import("./page-lifecycle-runtime");
  return runtime.commitPageLifecycleIntent(intent);
}

export function listPageHistory(
  request: ListPageHistoryRequest,
): Promise<PageHistoryCommandResult> {
  return resolveRendererTransport().listPageHistory(request);
}

/**
 * Typed failure of a Core-backed read channel. `code` is the Core error code
 * (`revision_conflict`, `invalid_input`, …); consumers classify with it and
 * with `isCursorRejection`, never by matching message text.
 */
export class CoreApiError extends Error {
  constructor(readonly detail: CoreErrorDetail) {
    super(detail.message);
    this.name = "CoreApiError";
  }

  get code(): string {
    return this.detail.code;
  }

  get retryable(): boolean {
    return this.detail.retryable;
  }

  get recovery(): CoreErrorDetail["recovery"] {
    return this.detail.recovery;
  }

  isCursorRejection(options: { readonly requestHadCursor: boolean }): boolean {
    return isCursorRejectionCode(this.detail.code, options);
  }
}

type CoreResultChannel = {
  [Channel in keyof IpcApi]: IpcApi[Channel]["result"] extends CoreResult<unknown>
    ? Channel
    : never;
}[keyof IpcApi];

type CoreResultChannelValue<Channel extends CoreResultChannel> =
  IpcApi[Channel]["result"] extends CoreResult<infer Value> ? Value : never;

/** Invokes a Core-backed read channel and unwraps its typed error envelope. */
export async function invokeCoreResult<Channel extends CoreResultChannel>(
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<CoreResultChannelValue<Channel>> {
  const result = (await invoke(channel, ...args)) as CoreResult<CoreResultChannelValue<Channel>>;
  if (result.ok) return result.value;
  throw new CoreApiError(result.error);
}

export function readDatabaseViewWindow(
  projectId: string,
  input: DatabaseViewWindowInput,
): Promise<DatabaseViewWindowSnapshot> {
  return invokeCoreResult("database:view-window:get", projectId, input);
}

export function readDatabaseListWindow(
  projectId: string,
  input: DatabaseListWindowInput,
): Promise<DatabaseListWindowSnapshot> {
  return invokeCoreResult("database:list-window:get", projectId, input);
}

export function readDatabaseViewGroups(
  projectId: string,
  input: DatabaseViewGroupsInput,
): Promise<DatabaseViewGroupsSnapshot> {
  return invokeCoreResult("database:view-groups:get", projectId, input);
}

export function readLibraryDatabaseViewWindow(
  input: DatabaseViewWindowInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseViewWindowSnapshot> {
  return invokeCoreResult("library-database:view-window:get", input);
}

export function readLibraryDatabaseListWindow(
  input: DatabaseListWindowInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseListWindowSnapshot> {
  return invokeCoreResult("library-database:list-window:get", input);
}

export function readLibraryDatabaseViewGroups(
  input: DatabaseViewGroupsInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseViewGroupsSnapshot> {
  return invokeCoreResult("library-database:view-groups:get", input);
}

export function readDatabaseModule(
  projectId: string,
  request: DatabaseModuleReadRequestV2,
): Promise<DatabaseModuleReadResultV2> {
  return invoke("database-module:read", projectId, request);
}

export async function applyDatabaseModule(
  projectId: string,
  request: DatabaseApplyV2,
): Promise<DatabaseApplyResultV2> {
  const result = await invoke("database-module:apply", projectId, request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function readLibraryModule(
  accessContext: ContentAccessContext,
  request: LibraryModuleReadRequest,
): Promise<LibraryModuleReadResult> {
  return invoke("library-module:read", accessContext, request);
}

export async function applyLibraryModule(
  accessContext: ContentAccessContext,
  request: LibraryModuleApplyRequest,
): Promise<LibraryModuleApplyResult> {
  const result = await invoke("library-module:apply", accessContext, request);
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function pickAndPreparePageFiles(
  accessContext: ContentAccessContext,
  input: PickPageFilesInput,
): Promise<PickPageFilesResult> {
  return invoke("page-files:pick-and-prepare", accessContext, input);
}

export async function prepareDroppedPageFiles(
  accessContext: ContentAccessContext,
  operationId: string,
  files: readonly File[],
): Promise<readonly PreparedPickedPageFile[]> {
  const prepare = window.api?.prepareDroppedPageFiles;
  if (!prepare) throw new Error("Native file drop is unavailable");
  const result = await prepare(accessContext, operationId, files);
  return result.files;
}

export function preparePageFile(
  accessContext: ContentAccessContext,
  input: PreparePageFileInput,
): Promise<PreparedPickedPageFile> {
  return invoke("page-files:prepare", accessContext, input);
}

export function readPageFileBytes(
  accessContext: ContentAccessContext,
  input: ReadPageFileBytesInput,
): Promise<PageFileBytes> {
  return invoke("page-files:read", accessContext, input);
}

export function savePageFile(
  accessContext: ContentAccessContext,
  input: SavePageFileInput,
): Promise<SavePageFileResult> {
  return invoke("page-files:save", accessContext, input);
}

export function readLibraryDatabaseModule(
  request: import("../../shared/database-module-v2").LibraryDatabaseModuleReadRequestV2,
): Promise<import("../../shared/database-module-v2").LibraryDatabaseModuleReadResultV2> {
  return invoke("library-database-module:read", request) as Promise<
    import("../../shared/database-module-v2").LibraryDatabaseModuleReadResultV2
  >;
}

export async function applyLibraryDatabaseModule(
  request: import("../../shared/database-module-v2").LibraryDatabaseApplyV2,
): Promise<import("../../shared/database-module-v2").LibraryDatabaseApplyResultV2> {
  const result = (await invoke(
    "library-database-module:apply",
    request,
  )) as import("../../shared/database-module-v2").LibraryDatabaseApplyResultV2;
  if (result.ok) await admitLocalCommitApply(result.localCommit);
  return result;
}

export function readPageDetail(
  projectId: string,
  pageId: string,
  minimumCommitSeq?: number,
): Promise<PageDetailResult> {
  return invoke("pages:detail:get", projectId, pageId, minimumCommitSeq);
}

export function readLibraryPageDetail(
  pageId: string,
  minimumCommitSeq?: number,
): Promise<LibraryPageDetailResult> {
  return invoke("library-pages:detail:get", pageId, minimumCommitSeq);
}

export function subscribeBoardChanges(
  projectId: string,
  callback: (event: import("../../shared/ipc-api").BoardChangeEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeBoardChanges(projectId, callback);
}

export function subscribeDatabaseChanges(
  projectId: string,
  callback: (event: import("../../shared/database-events").DatabaseChangeEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeDatabaseChanges(projectId, callback);
}

export function subscribeLibraryChanges(
  callback: (event: import("../../shared/library-events").LibraryNavigationChangedEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeLibraryChanges?.(callback) ?? (() => {});
}

export function subscribeProjectSessionChanges(
  callback: (event: import("../../shared/ipc-api").ProjectSessionsChangeEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeProjectSessionChanges(callback);
}

export function subscribeProjectChanges(
  callback: (event: import("../../shared/ipc-api").ProjectsChangeEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeProjectChanges(callback);
}

export function subscribeCodexHostMessages(
  callback: (message: import("./types").CodexHostMessage) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexHostMessages(callback);
}

export function subscribeCodexEvents(
  callback: (event: import("./types").CodexEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexEvents(callback);
}

export function subscribeCodexRendererClientRequests(
  callback: (message: import("./types").CodexRendererClientRequestMessage) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexRendererClientRequests(callback);
}

export function subscribeDesktopNotificationActions(
  callback: (payload: import("./types").DesktopNotificationActionInvocation) => void,
): () => void {
  return resolveRendererTransport().subscribeDesktopNotificationActions(callback);
}

export function subscribeWorkspaceFileChanges(
  callback: (event: import("../../shared/types").WorkspaceFileChangedEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeWorkspaceFileChanges(callback);
}

export function subscribeAppUpdateStatus(
  callback: (status: import("./types").AppUpdateStatus) => void,
): () => void {
  return resolveRendererTransport().subscribeAppUpdateStatus(callback);
}

export function subscribeCommandKeymapChanges(
  callback: (state: import("../../shared/command-keybindings").CommandKeymapState) => void,
): () => void {
  return resolveRendererTransport().subscribeCommandKeymapChanges(callback);
}

export function subscribeCodexScheduledAutomationChanges(
  callback: (event: import("./types").CodexScheduledAutomationChangedEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexScheduledAutomationChanges(callback);
}

export function subscribeCodexAutomationRunsUpdates(
  callback: (event: import("./types").CodexAutomationRunsUpdatedEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexAutomationRunsUpdates(callback);
}

export function subscribeCodexHooksChanged(
  callback: (event: import("../../shared/codex-hooks").CodexHooksChangedEvent) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexHooksChanged(callback);
}

export function subscribeCodexPendingWorktreesChanged(
  callback: (
    event: import("../../shared/codex-pending-worktree").CodexPendingWorktreesChangedEvent,
  ) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexPendingWorktreesChanged(callback);
}

export function subscribeCodexPendingWorktreeWarnings(
  callback: (
    event: import("../../shared/codex-pending-worktree").CodexPendingWorktreeWarningEvent,
  ) => void,
): () => void {
  return resolveRendererTransport().subscribeCodexPendingWorktreeWarnings(callback);
}

export function getWindowFocusState(): Promise<boolean> {
  return resolveRendererTransport().getWindowFocusState();
}

export function subscribeWindowFocusChanges(callback: (isFocused: boolean) => void): () => void {
  return resolveRendererTransport().subscribeWindowFocusChanges(callback);
}

export function getUserInputAutoResolutionSnapshot(): Promise<
  import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionEntry[]
> {
  return resolveRendererTransport().getUserInputAutoResolutionSnapshot();
}

export function recordUserInputAutoResolutionActivity(conversationId: string): Promise<boolean> {
  return resolveRendererTransport().recordUserInputAutoResolutionActivity(conversationId);
}

export function snoozeUserInputAutoResolution(
  target: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionTarget,
): Promise<boolean> {
  return resolveRendererTransport().snoozeUserInputAutoResolution(target);
}

export function subscribeUserInputAutoResolutionChanges(
  callback: (
    change: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionChange,
  ) => void,
): () => void {
  return resolveRendererTransport().subscribeUserInputAutoResolutionChanges(callback);
}
