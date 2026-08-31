import { resolveRendererTransport } from "./renderer-transport";
import type { IpcApi } from "../../shared/ipc-api";
import type {
  ContentAccessContext,
  ContentAccessIdentity,
} from "../../shared/content-access-context";
import type { CoreResult } from "../../shared/core-result";
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
  PrepareDroppedPageFilesInput,
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
import {
  defineRendererCommand,
  invokeLocalCommitCommandResult,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";
import {
  additionalDocumentCommand,
  blockTransferCommand,
  blockTransferUndoCommand,
  documentMutationCommand,
  documentVersionRestoreCommand,
} from "./document-local-replica-commands";
import { canvasSceneCompactionCommand } from "./canvas-local-scene-commands";
import {
  assertBlockPropertyMutation,
  blockPropertyMutationCommand,
  databaseSettingsApplyCommand,
  libraryBlockPropertyMutationCommand,
  libraryCommandFor,
  libraryDatabaseCommandFor,
  pageLifecycleCommandFor,
  projectDatabaseCommandFor,
} from "./core-projection-commands";
import { CoreApiError } from "./core-api-error";
export { CoreApiError } from "./core-api-error";
import type { PageSearchInput, PageSearchSnapshot } from "../../shared/types";
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

const requestMicrophoneAccessCommand = defineRendererCommand({
  key: "dictation.request_microphone_access",
  channel: "codex:dictation:microphone-access:request",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const openMicrophoneSettingsCommand = defineRendererCommand({
  key: "dictation.open_microphone_settings",
  channel: "codex:dictation:microphone-access:open-settings",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const requestInputMonitoringCommand = defineRendererCommand({
  key: "dictation.request_input_monitoring",
  channel: "codex:dictation:global-permissions:request-input-monitoring",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const requestAccessibilityCommand = defineRendererCommand({
  key: "dictation.request_accessibility",
  channel: "codex:dictation:global-permissions:request-accessibility",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const openInputMonitoringSettingsCommand = defineRendererCommand({
  key: "dictation.open_input_monitoring_settings",
  channel: "codex:dictation:global-permissions:open-input-monitoring-settings",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const openAccessibilitySettingsCommand = defineRendererCommand({
  key: "dictation.open_accessibility_settings",
  channel: "codex:dictation:global-permissions:open-accessibility-settings",
  authority: "external",
  owner: "DictationPermissions",
  protocol: { kind: "pending_operation" },
});

const updateDictationSettingsCommand = defineRendererCommand({
  key: "dictation.update_settings",
  channel: "codex:dictation:settings:update",
  authority: "main",
  owner: "DictationSettings",
  protocol: { kind: "returned_value" },
});

const consumeDictationNudgeCommand = defineRendererCommand({
  key: "dictation.consume_shortcut_nudge",
  channel: "codex:dictation:settings:consume-global-shortcut-nudge",
  authority: "main",
  owner: "DictationSettings",
  protocol: { kind: "returned_value" },
});

const createDictationRecordingCommand = defineRendererCommand({
  key: "dictation_history.create",
  channel: "codex:dictation:history:create",
  authority: "main",
  owner: "DictationHistory",
  protocol: { kind: "returned_value" },
});

const setDictationTranscriptCommand = defineRendererCommand({
  key: "dictation_history.set_transcript",
  channel: "codex:dictation:history:set-transcript",
  authority: "main",
  owner: "DictationHistory",
  protocol: { kind: "returned_value" },
});

const downloadDictationRecordingCommand = defineRendererCommand({
  key: "dictation_history.download",
  channel: "codex:dictation:history:download",
  authority: "external",
  owner: "DictationHistory",
  protocol: { kind: "pending_operation" },
});

const deleteDictationRecordingCommand = defineRendererCommand({
  key: "dictation_history.delete",
  channel: "codex:dictation:history:delete",
  authority: "main",
  owner: "DictationHistory",
  protocol: { kind: "returned_value" },
});

const createPastedTextCommand = defineRendererCommand({
  key: "pasted_text.create",
  channel: "codex:pasted-text:create",
  authority: "main",
  owner: "PastedTextAttachments",
  protocol: { kind: "returned_value" },
});

const removePastedTextCommand = defineRendererCommand({
  key: "pasted_text.remove",
  channel: "codex:pasted-text:remove",
  authority: "main",
  owner: "PastedTextAttachments",
  protocol: { kind: "returned_value" },
});

const pickAndPreparePageFilesCommand = defineRendererCommand({
  key: "page_files.pick_and_prepare",
  channel: "page-files:pick-and-prepare",
  authority: "external",
  owner: "PageFiles",
  protocol: { kind: "returned_value" },
});

const prepareDroppedPageFilesCommand = defineRendererCommand({
  key: "page_files.prepare_dropped",
  channel: "page-files:prepare-local-drop",
  authority: "external",
  owner: "PageFiles",
  protocol: { kind: "returned_value" },
});

const preparePageFileCommand = defineRendererCommand({
  key: "page_files.prepare",
  channel: "page-files:prepare",
  authority: "external",
  owner: "PageFiles",
  protocol: { kind: "returned_value" },
});

const savePageFileCommand = defineRendererCommand({
  key: "page_files.save",
  channel: "page-files:save",
  authority: "external",
  owner: "PageFiles",
  protocol: { kind: "returned_value" },
});

const prepareOwnedBlockDocumentCommand = defineRendererCommand({
  key: "document.prepare_owned_project_document",
  channel: "block-document:owned:prepare",
  authority: "core",
  owner: "OwnedBlockDocument",
  protocol: { kind: "pending_operation" },
});

const prepareLibraryOwnedBlockDocumentCommand = defineRendererCommand({
  key: "document.prepare_owned_library_document",
  channel: "library-block-document:owned:prepare",
  authority: "core",
  owner: "OwnedBlockDocument",
  protocol: { kind: "pending_operation" },
});

const createDocumentVersionCheckpointCommand = defineRendererCommand({
  key: "document_history.create_checkpoint",
  channel: "block-documents:history:checkpoint",
  authority: "core",
  owner: "DocumentHistory",
  protocol: { kind: "pending_operation" },
});

export function getGitWorkerClient(): GitWorkerClient {
  if (gitWorkerClient) return gitWorkerClient;
  const transport = resolveRendererTransport();
  gitWorkerClient = new GitWorkerClient({
    send: async (message) => await transport.sendGitWorkerMessage(message),
    subscribe: (listener) => transport.subscribeGitWorkerMessages(listener),
  });
  return gitWorkerClient;
}

export function searchCodexPersistedHistory(threadId: string, query: string) {
  return invokeRendererQuery("codex:thread:history-search", threadId, query);
}

function invokeCancellableCodexPromptRail<
  Channel extends "codex:thread:prompt-rail:index" | "codex:thread:prompt-rail:reveal",
>(
  channel: Channel,
  request: IpcApi[Channel]["args"][0],
  signal?: AbortSignal,
): Promise<IpcApi[Channel]["result"]> {
  const requestId = (request as { readonly requestId: string }).requestId;
  if (signal?.aborted) {
    return Promise.resolve({ status: "cancelled", requestId } as IpcApi[Channel]["result"]);
  }

  const cancel = () => {
    void invokeRendererControl("codex:thread:prompt-rail:cancel", requestId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const invocation = Reflect.apply(invokeRendererControl, undefined, [channel, request]) as Promise<
    IpcApi[Channel]["result"]
  >;
  return invocation.finally(() => {
    signal?.removeEventListener("abort", cancel);
  });
}

export function loadCodexPromptRailIndex(
  request: import("../../shared/codex-prompt-rail-history").CodexPromptRailIndexRequest,
  options: { readonly signal?: AbortSignal } = {},
) {
  return invokeCancellableCodexPromptRail(
    "codex:thread:prompt-rail:index",
    request,
    options.signal,
  );
}

export function revealCodexPromptRailTurn(
  request: import("../../shared/codex-prompt-rail-history").CodexPromptRailRevealRequest,
  options: { readonly signal?: AbortSignal } = {},
) {
  return invokeCancellableCodexPromptRail(
    "codex:thread:prompt-rail:reveal",
    request,
    options.signal,
  );
}

export function readMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
  return invokeRendererQuery("codex:dictation:microphone-access:read");
}

export function readDictationCapabilityState() {
  return invokeRendererQuery("codex:dictation:state:read");
}

export function requestMicrophoneAccess(): Promise<MicrophoneAccessResult> {
  return invokePlainCommand(requestMicrophoneAccessCommand);
}

export function acquireDictationMicrophoneLease(
  sessionId: string,
  surface: import("../../shared/dictation").DictationSurface,
): Promise<boolean> {
  return invokeRendererControl("codex:dictation:microphone-lease:acquire", {
    sessionId,
    surface,
  });
}

export function releaseDictationMicrophoneLease(sessionId: string): Promise<boolean> {
  return invokeRendererControl("codex:dictation:microphone-lease:release", sessionId);
}

export function openMicrophoneSettings(): Promise<void> {
  return invokePlainCommand(openMicrophoneSettingsCommand);
}

export function readBuiltInMicrophoneRouteHint(): Promise<string | null> {
  return invokeRendererQuery("codex:dictation:microphone-route-hint:read");
}

export function readGlobalDictationPermissions(): Promise<GlobalDictationPermissionSnapshot> {
  return invokeRendererQuery("codex:dictation:global-permissions:read");
}

export function requestGlobalDictationInputMonitoring(): Promise<GlobalDictationPermissionSnapshot> {
  return invokePlainCommand(requestInputMonitoringCommand);
}

export function requestGlobalDictationAccessibility(): Promise<GlobalDictationPermissionSnapshot> {
  return invokePlainCommand(requestAccessibilityCommand);
}

export function openGlobalDictationInputMonitoringSettings(): Promise<void> {
  return invokePlainCommand(openInputMonitoringSettingsCommand);
}

export function openGlobalDictationAccessibilitySettings(): Promise<void> {
  return invokePlainCommand(openAccessibilitySettingsCommand);
}

export function readDictationSettings(): Promise<DictationSettings> {
  return invokeRendererQuery("codex:dictation:settings:read");
}

export function updateDictationSettings(patch: DictationSettingsPatch): Promise<DictationSettings> {
  return invokePlainCommand(updateDictationSettingsCommand, patch);
}

export function consumeGlobalDictationShortcutNudge(): Promise<boolean> {
  return invokePlainCommand(consumeDictationNudgeCommand);
}

export function createDictationRecording(
  input: DictationRecordingCreateInput,
): Promise<DictationRecordingMetadata> {
  return invokePlainCommand(createDictationRecordingCommand, input);
}

export function appendDictationRecording(
  input: DictationRecordingAppendInput,
): Promise<DictationRecordingMetadata> {
  return invokeRendererControl("codex:dictation:history:append", input);
}

export function finalizeDictationRecording(
  input: DictationRecordingFinalizeInput,
): Promise<DictationRecordingMetadata> {
  return invokeRendererControl("codex:dictation:history:finalize", input);
}

export function setDictationRecordingTranscript(
  input: DictationRecordingSetTranscriptInput,
): Promise<DictationRecordingMetadata> {
  return invokePlainCommand(setDictationTranscriptCommand, input);
}

export function listDictationRecordings(): Promise<DictationRecordingMetadata[]> {
  return invokeRendererQuery("codex:dictation:history:list");
}

export function readDictationRecordingAudio(id: string): Promise<DictationRecordingAudio> {
  return invokeRendererQuery("codex:dictation:history:read-audio", id);
}

export function downloadDictationRecording(
  id: string,
): Promise<{ readonly status: "cancelled" | "saved" }> {
  return invokePlainCommand(downloadDictationRecordingCommand, id);
}

export function deleteDictationRecording(id: string): Promise<void> {
  return invokePlainCommand(deleteDictationRecordingCommand, id);
}

export function beginStructuralClipboard(
  input: StructuralClipboardBeginInput,
): Promise<StructuralClipboardLifecycleResult> {
  return invokeRendererControl("clipboard:structural-begin", input);
}

export function publishStructuralClipboard(
  input: StructuralClipboardWriteInput,
): Promise<StructuralClipboardWriteResult> {
  return invokeRendererControl("clipboard:structural-publish", input);
}

export function settleStructuralClipboard(
  input: StructuralClipboardSettleInput,
): Promise<StructuralClipboardLifecycleResult> {
  return invokeRendererControl("clipboard:structural-settle", input);
}

export function awaitStructuralClipboard(
  input: StructuralClipboardAwaitInput,
): Promise<StructuralClipboardResolution> {
  return invokeRendererControl("clipboard:structural-await", input);
}

export function writeClaimedClipboardPresentation(
  input: ClaimedClipboardPresentationWriteInput,
): Promise<ClaimedClipboardPresentationWriteResult> {
  return invokeRendererControl("clipboard:write-claimed-presentation", input);
}

export async function searchPages(
  input: PageSearchInput,
  signal?: AbortSignal,
): Promise<PageSearchSnapshot> {
  if (signal?.aborted) throw new DOMException("Page search was aborted", "AbortError");
  const requestId = globalThis.crypto.randomUUID();
  const cancel = (): void => {
    void invokeRendererControl("pages:search:cancel", requestId).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invokeRendererQuery("pages:search", requestId, input);
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
  return invokeRendererQuery("canvas-scene:compaction:read", request);
}

export function compactCanvasScene(
  request: CanvasSceneCompactionRequest,
): Promise<CanvasSceneCompactionCommandResult> {
  return invokeLocalCommitCommandResult(canvasSceneCompactionCommand, request);
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
  return invokePlainCommand(prepareOwnedBlockDocumentCommand, projectId, ownerBlockId);
}

export function prepareLibraryOwnedBlockDocument(
  ownerBlockId: string,
): Promise<DocumentSyncCommandResult<LibraryAccessedDocumentDescriptor>> {
  return invokePlainCommand(prepareLibraryOwnedBlockDocumentCommand, ownerBlockId);
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
  return await invokeLocalCommitCommandResult(
    documentMutationCommand,
    projectId,
    documentId,
    request,
  );
}

export async function applyAdditionalDocumentCommand(
  projectId: string,
  request: PublicAdditionalDocumentCommandRequest,
): Promise<AdditionalDocumentCommandResult> {
  return await invokeLocalCommitCommandResult(additionalDocumentCommand, projectId, request);
}

export async function transferBlocks(
  projectId: string,
  intent: PublicBlockTransferIntent,
): Promise<BlockTransferCommandResult> {
  return await invokeLocalCommitCommandResult(blockTransferCommand, projectId, intent);
}

export async function undoBlockTransfer(
  projectId: string,
  intent: PublicBlockTransferUndoIntent,
): Promise<BlockTransferUndoCommandResult> {
  return await invokeLocalCommitCommandResult(blockTransferUndoCommand, projectId, intent);
}

export function createPastedTextAttachment(
  input: CreatePastedTextAttachmentInput,
): Promise<CreatePastedTextAttachmentResult> {
  return invokePlainCommand(createPastedTextCommand, input);
}

export function readPastedTextAttachment(input: ReadPastedTextAttachmentInput): Promise<string> {
  return invokeRendererQuery("codex:pasted-text:read", input);
}

export function removePastedTextAttachment(input: RemovePastedTextAttachmentInput): Promise<void> {
  return invokePlainCommand(removePastedTextCommand, input);
}

export function createDocumentVersionCheckpoint(
  projectId: string,
  documentId: string,
  request: CreateDocumentVersionCheckpoint,
): Promise<DocumentHistoryCommandResult<CreatedDocumentVersionSummary>> {
  return invokePlainCommand(createDocumentVersionCheckpointCommand, projectId, documentId, request);
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
  return await invokeLocalCommitCommandResult(
    documentVersionRestoreCommand,
    projectId,
    documentId,
    request,
  );
}

export function resolvePageTarget(
  input: ResolvePageTargetInput,
): Promise<PageTargetReadModel | null> {
  return invokeRendererQuery("page-target:resolve", input);
}

export function resolvePageOwnershipPath(
  input: ResolvePageOwnershipPathInput,
): Promise<PageOwnershipPathReadModel | null> {
  return invokeRendererQuery("page-ownership-path:resolve", input);
}

export function readDatabaseViewReference(
  input: ReadDatabaseViewReferenceInput,
): Promise<DatabaseViewReadModel | null> {
  return invokeRendererQuery("database-view:reference:get", input);
}

export async function mutateBlockProperties(
  projectId: string,
  request: BlockPropertyMutationRequestV2,
): Promise<BlockPropertyMutationCommandResultV2> {
  assertBlockPropertyMutation(request);
  return await invokeLocalCommitCommandResult(blockPropertyMutationCommand, projectId, request);
}

export async function mutateLibraryBlockProperties(
  request: LibraryBlockPropertyMutationRequestV2,
): Promise<LibraryBlockPropertyMutationCommandResultV2> {
  if (request.fields.length === 0) {
    throw new TypeError("Library Block property mutation requires at least one field");
  }
  return await invokeLocalCommitCommandResult(libraryBlockPropertyMutationCommand, request);
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
  const definition = pageLifecycleCommandFor(request);
  return await invokeLocalCommitCommandResult(definition, projectId, request);
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

function unwrapCoreResult<Value>(result: CoreResult<Value>): Value {
  if (result.ok) return result.value;
  throw new CoreApiError(result.error);
}

export function readDatabaseViewWindow(
  projectId: string,
  input: DatabaseViewWindowInput,
): Promise<DatabaseViewWindowSnapshot> {
  return invokeRendererQuery("database:view-window:get", projectId, input).then(unwrapCoreResult);
}

export function readDatabaseListWindow(
  projectId: string,
  input: DatabaseListWindowInput,
): Promise<DatabaseListWindowSnapshot> {
  return invokeRendererQuery("database:list-window:get", projectId, input).then(unwrapCoreResult);
}

export function readDatabaseViewGroups(
  projectId: string,
  input: DatabaseViewGroupsInput,
): Promise<DatabaseViewGroupsSnapshot> {
  return invokeRendererQuery("database:view-groups:get", projectId, input).then(unwrapCoreResult);
}

export function readLibraryDatabaseViewWindow(
  input: DatabaseViewWindowInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseViewWindowSnapshot> {
  return invokeRendererQuery("library-database:view-window:get", input).then(unwrapCoreResult);
}

export function readLibraryDatabaseListWindow(
  input: DatabaseListWindowInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseListWindowSnapshot> {
  return invokeRendererQuery("library-database:list-window:get", input).then(unwrapCoreResult);
}

export function readLibraryDatabaseViewGroups(
  input: DatabaseViewGroupsInput &
    ({ readonly databaseViewId: string } | { readonly databaseId: string }),
): Promise<LibraryDatabaseViewGroupsSnapshot> {
  return invokeRendererQuery("library-database:view-groups:get", input).then(unwrapCoreResult);
}

export function readDatabaseModule(
  projectId: string,
  request: DatabaseModuleReadRequestV2,
): Promise<DatabaseModuleReadResultV2> {
  return invokeRendererQuery("database-module:read", projectId, request);
}

export async function applyDatabaseModule(
  projectId: string,
  request: DatabaseApplyV2,
): Promise<DatabaseApplyResultV2> {
  const definition = projectDatabaseCommandFor(request);
  return await invokeLocalCommitCommandResult(definition, projectId, request);
}

export async function applyDatabaseSettingsModule(
  projectId: string,
  request: DatabaseApplyV2,
): Promise<DatabaseApplyResultV2> {
  return await invokeLocalCommitCommandResult(databaseSettingsApplyCommand, projectId, request);
}

export function readLibraryModule(
  accessContext: ContentAccessContext,
  request: LibraryModuleReadRequest,
): Promise<LibraryModuleReadResult> {
  return invokeRendererQuery("library-module:read", accessContext, request);
}

export async function applyLibraryModule(
  accessContext: ContentAccessContext,
  request: LibraryModuleApplyRequest,
): Promise<LibraryModuleApplyResult> {
  const definition = libraryCommandFor(request);
  return await invokeLocalCommitCommandResult(definition, accessContext, request);
}

export function pickAndPreparePageFiles(
  accessContext: ContentAccessContext,
  input: PickPageFilesInput,
): Promise<PickPageFilesResult> {
  return invokePlainCommand(pickAndPreparePageFilesCommand, accessContext, input);
}

export async function prepareDroppedPageFiles(
  accessContext: ContentAccessContext,
  operationId: string,
  files: readonly File[],
): Promise<readonly PreparedPickedPageFile[]> {
  const getPathForFile = window.api?.getPathForFile;
  if (!getPathForFile) throw new Error("Native file drop is unavailable");
  const localPaths = Array.from(files, (file) => getPathForFile(file));
  if (localPaths.length === 0 || localPaths.some((localPath) => !localPath)) {
    throw new Error("Dropped files are unavailable to the desktop host");
  }
  const input: PrepareDroppedPageFilesInput = { operationId, localPaths };
  const result = await invokePlainCommand(prepareDroppedPageFilesCommand, accessContext, input);
  return result.files;
}

export function preparePageFile(
  accessContext: ContentAccessContext,
  input: PreparePageFileInput,
): Promise<PreparedPickedPageFile> {
  return invokePlainCommand(preparePageFileCommand, accessContext, input);
}

export function readPageFileBytes(
  accessContext: ContentAccessContext,
  input: ReadPageFileBytesInput,
): Promise<PageFileBytes> {
  return invokeRendererQuery("page-files:read", accessContext, input);
}

export function savePageFile(
  accessContext: ContentAccessContext,
  input: SavePageFileInput,
): Promise<SavePageFileResult> {
  return invokePlainCommand(savePageFileCommand, accessContext, input);
}

export function readLibraryDatabaseModule(
  request: import("../../shared/database-module-v2").LibraryDatabaseModuleReadRequestV2,
): Promise<import("../../shared/database-module-v2").LibraryDatabaseModuleReadResultV2> {
  return invokeRendererQuery("library-database-module:read", request);
}

export async function applyLibraryDatabaseModule(
  request: import("../../shared/database-module-v2").LibraryDatabaseApplyV2,
): Promise<import("../../shared/database-module-v2").LibraryDatabaseApplyResultV2> {
  const definition = libraryDatabaseCommandFor(request);
  return await invokeLocalCommitCommandResult(definition, request);
}

export function readPageDetail(
  projectId: string,
  pageId: string,
  minimumCommitSeq?: number,
): Promise<PageDetailResult> {
  return invokeRendererQuery("pages:detail:get", projectId, pageId, minimumCommitSeq);
}

export function readLibraryPageDetail(
  pageId: string,
  minimumCommitSeq?: number,
): Promise<LibraryPageDetailResult> {
  return invokeRendererQuery("library-pages:detail:get", pageId, minimumCommitSeq);
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
