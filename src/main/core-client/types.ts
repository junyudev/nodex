import type { components } from "@nodex/core-protocol";
import type { LocalCommitApply } from "../../shared/local-commit-delivery";
import type { ProjectionImpact, ProjectionScope } from "../../shared/projection-stream";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
} from "../../shared/block-documents/document-sync";
import type {
  CanvasSceneSyncRequest,
  CanvasSceneSyncResponse,
} from "../../shared/block-documents/canvas-scene-sync";

export type CoreRuntimeDescriptor = components["schemas"]["RuntimeDescriptor"];
export type CoreHandshakeResponse = components["schemas"]["HandshakeResponse"];
export type CoreEventEnvelope = components["schemas"]["EventEnvelope"];
export type CoreAuthorizedDeliveryPacket = CoreEventEnvelope["packet"];
export type CoreAuthorizedDeliveryAtom = CoreAuthorizedDeliveryPacket["atoms"][number];
export type CoreModuleEventPayload = CoreAuthorizedDeliveryAtom["payload"];
export type CoreEventReplayRequired = components["schemas"]["EventReplayRequired"];
export type CoreStreamCheckpoint = components["schemas"]["StreamCheckpoint"];
export type CoreModuleError = components["schemas"]["CoreError"];
export type CoreLocalMutationResolveRequest = components["schemas"]["LocalMutationResolveRequest"];
export type CoreLocalMutationResolveResponse =
  components["schemas"]["LocalMutationResolveResponse"];

export type CoreApplyCoordinate =
  | {
      readonly status: "committed";
      readonly commit: components["schemas"]["CommitIdentity"];
      readonly delivery?: null | CoreAuthorizedDeliveryPacket;
    }
  | {
      readonly status: "no_op";
      readonly observed: components["schemas"]["StoreObservation"];
    };

/** Semantic commit cursor, or the exact store cursor observed by a no-op. */
export const applyResultCursor = (result: CoreApplyCoordinate): number =>
  result.status === "committed" ? result.commit.commit_seq : result.observed.commit_head;

export const applyResultStoreEpoch = (result: CoreApplyCoordinate): string =>
  result.status === "committed" ? result.commit.store_epoch : result.observed.store_epoch;

/** Post-state-authorized fast-path packet. No-op commands never fabricate one. */
export const applyResultDelivery = (
  result: CoreApplyCoordinate,
): CoreAuthorizedDeliveryPacket | undefined =>
  result.status === "committed" ? (result.delivery ?? undefined) : undefined;

/** Projects a Core command response into renderer-safe causal evidence. */
export const rendererLocalCommitApply = (result: CoreApplyCoordinate): LocalCommitApply =>
  result.status === "committed"
    ? {
        status: "committed",
        commit: result.commit,
        delivery: result.delivery ?? null,
      }
    : {
        status: "no_op",
        observed: result.observed,
      };

export const findCoreModulePayload = (
  envelope: CoreEventEnvelope,
  module: CoreModuleEventPayload["module"],
): CoreModuleEventPayload | undefined =>
  envelope.packet.atoms.find((atom) => atom.payload.module === module)?.payload;

export type LibraryReadRequest = components["schemas"]["LibraryReadRequest"];
export type LibraryRead = LibraryReadRequest["read"];
export type LibraryReadResponse = components["schemas"]["LibraryReadResponse"];
export type LibraryApplyRequest = components["schemas"]["LibraryApplyRequest"];
export type LibraryIntent = LibraryApplyRequest["intent"];
export type LibraryApplyResponse = components["schemas"]["LibraryApplyResponse"];

type SuccessfulPayload<Response> = Response extends {
  readonly status: "ok";
  readonly payload: infer Payload;
}
  ? Payload
  : never;

export type LibraryReadSnapshot = SuccessfulPayload<LibraryReadResponse>;
export type LibraryApplyResult = SuccessfulPayload<LibraryApplyResponse>;
export type PreparedPageFileBlob = components["schemas"]["LibraryPreparedPageFileBlob"];

export interface PageFileBlobBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly etag: string;
}

export type DatabaseReadRequest = components["schemas"]["DatabaseReadRequest"];
export type DatabaseRead = DatabaseReadRequest["read"];
export type DatabaseReadResponse = components["schemas"]["DatabaseReadResponse"];
export type DatabaseApplyRequest = components["schemas"]["DatabaseApplyRequest"];
export type DatabaseIntent = DatabaseApplyRequest["intent"];
export type DatabaseApplyResponse = components["schemas"]["DatabaseApplyResponse"];
export type DatabaseReadSnapshot = SuccessfulPayload<DatabaseReadResponse>;
export type DatabaseApplyResult = SuccessfulPayload<DatabaseApplyResponse>;
export type CoreDatabaseRowSummary = components["schemas"]["DatabaseRowSummary"];
export type CoreDatabaseRowDetail = components["schemas"]["DatabaseRowDetail"];
export type CoreDatabaseViewWindow = components["schemas"]["DatabaseViewWindow"];

export type ProjectWorkspaceReadRequest = components["schemas"]["ProjectWorkspaceReadRequest"];
export type ProjectWorkspaceRead = ProjectWorkspaceReadRequest["read"];
export type ProjectWorkspaceReadResponse = components["schemas"]["ProjectWorkspaceReadResponse"];
export type ProjectWorkspaceReadSnapshot = SuccessfulPayload<ProjectWorkspaceReadResponse>;
export type ProjectWorkspaceApplyRequest = components["schemas"]["ProjectWorkspaceApplyRequest"];
export type ProjectWorkspaceIntent = ProjectWorkspaceApplyRequest["intent"];
export type ProjectWorkspaceApplyResponse = components["schemas"]["ProjectWorkspaceApplyResponse"];
export type ProjectWorkspaceApplyResult = SuccessfulPayload<ProjectWorkspaceApplyResponse>;

export type AutomationReadRequest = components["schemas"]["AutomationReadRequest"];
export type AutomationRead = AutomationReadRequest["read"];
export type AutomationReadResponse = components["schemas"]["AutomationReadResponse"];
export type AutomationReadSnapshot = SuccessfulPayload<AutomationReadResponse>;
export type AutomationApplyRequest = components["schemas"]["AutomationApplyRequest"];
export type AutomationIntent = AutomationApplyRequest["intent"];
export type AutomationApplyResponse = components["schemas"]["AutomationApplyResponse"];
export type AutomationApplyResult = SuccessfulPayload<AutomationApplyResponse>;

export type StoreAdministrationReadRequest =
  components["schemas"]["StoreAdministrationReadRequest"];
export type StoreAdministrationRead = StoreAdministrationReadRequest["read"];
export type StoreAdministrationReadResponse =
  components["schemas"]["StoreAdministrationReadResponse"];
export type StoreAdministrationReadSnapshot = SuccessfulPayload<StoreAdministrationReadResponse>;
export type StoreAdministrationApplyRequest =
  components["schemas"]["StoreAdministrationApplyRequest"];
export type StoreAdministrationIntent = StoreAdministrationApplyRequest["intent"];
export type StoreAdministrationApplyResponse =
  components["schemas"]["StoreAdministrationApplyResponse"];
export type StoreAdministrationApplyResult = SuccessfulPayload<StoreAdministrationApplyResponse>;

export interface ProjectWorkspaceApplyInput {
  readonly operationId: string;
  readonly intent: ProjectWorkspaceIntent;
}

export interface AutomationApplyInput {
  readonly operationId: string;
  readonly intent: AutomationIntent;
}

export interface StoreAdministrationApplyInput {
  readonly operationId: string;
  readonly intent: StoreAdministrationIntent;
}

export type OwnedDocumentReadRequest = components["schemas"]["OwnedDocumentReadRequest"];
export type OwnedDocumentRead = OwnedDocumentReadRequest["read"];
export type OwnedDocumentReadResponse = components["schemas"]["OwnedDocumentReadResponse"];
export type OwnedDocumentApplyRequest = components["schemas"]["OwnedDocumentApplyRequest"];
export type OwnedDocumentIntent = OwnedDocumentApplyRequest["intent"];
export type OwnedDocumentApplyResponse = components["schemas"]["OwnedDocumentApplyResponse"];
export type OwnedDocumentReadSnapshot = SuccessfulPayload<OwnedDocumentReadResponse>;
export type OwnedDocumentApplyResult = SuccessfulPayload<OwnedDocumentApplyResponse>;

export interface LibraryApplyInput {
  readonly operationId: string;
  readonly intent: LibraryIntent;
}

export interface DatabaseApplyInput {
  readonly operationId: string;
  readonly intent: DatabaseIntent;
}

export interface OwnedDocumentApplyInput {
  readonly operationId: string;
  readonly clientSessionId: string;
  readonly intent: OwnedDocumentIntent;
}

export interface DocumentLiveBarrier {
  readonly store_epoch: string;
  readonly core_generation: string;
  readonly document_id: string;
  readonly document_generation: number;
  readonly head_seq: number;
  readonly commit_head: number;
  readonly engine: "yjs" | "canvas_scene";
}

export interface DocumentLiveRepair {
  readonly document_id: string;
  readonly store_epoch: string;
  readonly document_generation: number;
  readonly head_seq: number;
  readonly commit_head: number;
  readonly reason:
    | "receiver_lagged"
    | "payload_unavailable"
    | "identity_changed"
    | "access_revoked"
    | "event_gap";
}

export interface CoreEventSubscription {
  readonly done: Promise<void>;
  close(): void;
}

export interface CoreDocumentEventSubscription extends CoreEventSubscription {
  readonly barrier: DocumentLiveBarrier;
}

export interface ProjectionLiveBarrier {
  readonly store_epoch: string;
  readonly core_generation: string;
  readonly commit_head: number;
  readonly recipient_leases: readonly components["schemas"]["AuthorizedRecipientLease"][];
}

export interface ProjectionLiveRepair {
  readonly store_epoch: string;
  readonly commit_head: number;
  readonly reason: "receiver_lagged" | "payload_unavailable" | "identity_changed";
}

export interface CoreProjectionEventSubscription extends CoreEventSubscription {
  readonly barrier: ProjectionLiveBarrier;
}

export type CoreRequestClass = components["schemas"]["CoreRequestClass"];

export interface CoreRequestOptions {
  readonly class?: CoreRequestClass;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface CoreClientPort {
  resolveLocalMutation(
    input: CoreLocalMutationResolveRequest,
  ): Promise<CoreLocalMutationResolveResponse>;
  libraryRead(read: LibraryRead, options?: CoreRequestOptions): Promise<LibraryReadSnapshot>;
  libraryApply(input: LibraryApplyInput, options?: CoreRequestOptions): Promise<LibraryApplyResult>;
  preparePageFileBlob(
    input: {
      readonly operationId: string;
      readonly idempotencySlot?: string;
      readonly bytes: Uint8Array;
    },
    options?: CoreRequestOptions,
  ): Promise<PreparedPageFileBlob>;
  readPageFileBlob(
    input: {
      readonly pageId: string;
      readonly fileId: string;
      readonly version?: number;
    },
    options?: CoreRequestOptions,
  ): Promise<PageFileBlobBytes>;
  filterProjectionImpactForProject(
    projectId: string,
    impact: ProjectionImpact,
  ): Promise<ProjectionImpact>;
  databaseRead(read: DatabaseRead, options?: CoreRequestOptions): Promise<DatabaseReadSnapshot>;
  databaseApply(
    input: DatabaseApplyInput,
    options?: CoreRequestOptions,
  ): Promise<DatabaseApplyResult>;
  workspaceRead(
    read: ProjectWorkspaceRead,
    options?: CoreRequestOptions,
  ): Promise<ProjectWorkspaceReadSnapshot>;
  workspaceApply(
    input: ProjectWorkspaceApplyInput,
    options?: CoreRequestOptions,
  ): Promise<ProjectWorkspaceApplyResult>;
  automationRead(
    read: AutomationRead,
    options?: CoreRequestOptions,
  ): Promise<AutomationReadSnapshot>;
  automationApply(
    input: AutomationApplyInput,
    options?: CoreRequestOptions,
  ): Promise<AutomationApplyResult>;
  administrationRead(read: StoreAdministrationRead): Promise<StoreAdministrationReadSnapshot>;
  administrationApply(
    input: StoreAdministrationApplyInput,
  ): Promise<StoreAdministrationApplyResult>;
  documentRead(
    clientSessionId: string,
    read: OwnedDocumentRead,
    options?: CoreRequestOptions,
  ): Promise<OwnedDocumentReadSnapshot>;
  documentApply(
    input: OwnedDocumentApplyInput,
    options?: CoreRequestOptions,
  ): Promise<OwnedDocumentApplyResult>;
  documentSync(
    input: DocumentSyncRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentSyncResponse>;
  documentCanvasSync(
    input: CanvasSceneSyncRequest,
    options?: CoreRequestOptions,
  ): Promise<CanvasSceneSyncResponse>;
  documentApplyUpdate(
    input: DocumentSyncApplyRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentSyncApplyAck>;
  documentPublishAwareness(
    input: DocumentAwarenessPublishRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentAwarenessPublishAck>;
  openDocumentEventStream(
    input: {
      readonly documentId: string;
      readonly clientSessionId: string;
      readonly signal?: AbortSignal;
    },
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    onRealtimeEvent: (event: DocumentSyncRealtimeEvent) => void,
  ): Promise<CoreDocumentEventSubscription>;
  openEventStream(
    after: number,
    onEvent: (event: CoreEventEnvelope) => void,
    onCheckpoint: (checkpoint: CoreStreamCheckpoint) => void,
    onResyncRequired?: (event: CoreEventReplayRequired) => void,
    signal?: AbortSignal,
  ): Promise<CoreEventSubscription>;
  openProjectionEventStream(
    scopes: readonly ProjectionScope[],
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: ProjectionLiveRepair) => void,
    signal?: AbortSignal,
  ): Promise<CoreProjectionEventSubscription>;
}
