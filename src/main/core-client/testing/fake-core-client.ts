import type { ReadFileBytesInput } from "../../../shared/library-files";
import type {
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationRead,
  AutomationReadSnapshot,
  CoreClientPort,
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreEventSubscription,
  CoreDocumentEventSubscription,
  CoreProjectionEventSubscription,
  CoreRequestOptions,
  CoreStreamCheckpoint,
  DatabaseApplyInput,
  DatabaseApplyResult,
  DatabaseRead,
  DatabaseReadSnapshot,
  DocumentLiveRepair,
  ProjectionLiveRepair,
  LibraryApplyInput,
  LibraryApplyResult,
  LibraryRead,
  LibraryReadSnapshot,
  ManagedBlobBytes,
  PreparedBlobReceipt,
  OwnedDocumentApplyInput,
  OwnedDocumentApplyResult,
  OwnedDocumentRead,
  OwnedDocumentReadSnapshot,
  ProjectWorkspaceRead,
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceReadSnapshot,
  StoreAdministrationApplyInput,
  StoreAdministrationApplyResult,
  StoreAdministrationRead,
  StoreAdministrationReadSnapshot,
  CoreHandshakeResponse,
  CoreLocalMutationResolveRequest,
  CoreLocalMutationResolveResponse,
} from "../types";
import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
} from "../../../shared/block-documents/document-sync";
import type {
  CanvasSceneSyncRequest,
  CanvasSceneSyncResponse,
} from "../../../shared/block-documents/canvas-scene-sync";
import type { ProjectionImpact, ProjectionScope } from "../../../shared/projection-stream";

type ApplyOutcome<Result> = Result extends { readonly outcome: infer Outcome } ? Outcome : never;
type ApplyReceipt<Result> = Result extends { readonly receipt: infer Receipt } ? Receipt : never;
type ApplyFixtureInput<Result> =
  | Result
  | {
      readonly value: ApplyOutcome<Result>;
      readonly receipt: ApplyReceipt<Result>;
      readonly store_epoch: string;
      readonly event_sequence: number;
      readonly commit_seq?: number;
      readonly delivery?: Result extends { readonly delivery?: infer Delivery } ? Delivery : never;
    };

const fixtureReceiptCommitSeq = (receipt: unknown): number | undefined => {
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const value = Reflect.get(receipt, "commit_seq");
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
};

/** Test-only builder boundary for concise command-result fixtures. */
const normalizeApplyFixture = <
  Result extends {
    readonly status: "committed" | "no_op";
    readonly outcome: unknown;
    readonly receipt: unknown;
  },
>(
  input: ApplyFixtureInput<Result>,
): Result => {
  if ("status" in input) return input;
  const commitSeq =
    input.commit_seq ?? fixtureReceiptCommitSeq(input.receipt) ?? input.event_sequence;
  if (commitSeq < 1) {
    return {
      status: "no_op",
      outcome: input.value,
      receipt: input.receipt,
      observed: {
        store_epoch: input.store_epoch,
        commit_head: 0,
      },
    } as unknown as Result;
  }
  const delivery = input.delivery;
  const identity =
    delivery && typeof delivery === "object" && "manifest" in delivery
      ? (
          delivery as {
            readonly manifest: {
              readonly identity: {
                readonly store_epoch: string;
                readonly commit_seq: number;
                readonly manifest_hash: string;
              };
            };
          }
        ).manifest.identity
      : {
          store_epoch: input.store_epoch,
          commit_seq: commitSeq,
          manifest_hash: "f".repeat(64),
        };
  return {
    status: "committed",
    outcome: input.value,
    receipt: input.receipt,
    commit: identity,
    ...(delivery === undefined || delivery === null ? {} : { delivery }),
  } as unknown as Result;
};

export interface FakeCoreHandshakeInput {
  readonly profileId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly eventHead?: number;
  readonly connectionBinding?: string;
}

export const createFakeCoreHandshake = ({
  profileId,
  libraryId,
  storeEpoch,
  eventHead = 0,
  connectionBinding = "fake-core-connection",
}: FakeCoreHandshakeInput): CoreHandshakeResponse => {
  const actualStoreFormat = CORE_CLIENT_REQUIREMENTS.accepted_store_formats[0];
  const artifactSha256 = "a".repeat(64);
  const manifestDigest = "b".repeat(64);
  return {
    actual_store_format: actualStoreFormat,
    artifact: {
      build_id: "fake-core-test",
      sha256: artifactSha256,
    },
    connection_binding: connectionBinding,
    commit_head: eventHead,
    generation: {
      artifact_sha256: artifactSha256,
      manifest_digest: manifestDigest,
      pid: 1,
      profile_id: profileId,
      readiness_generation: 1,
      start_nonce: "fake-core-start",
      store_epoch: storeEpoch,
    },
    library_id: libraryId,
    manifest_digest: manifestDigest,
    schema_version: actualStoreFormat.version,
    selected_event_version: CORE_CLIENT_REQUIREMENTS.event_version,
    selected_module_versions: CORE_CLIENT_REQUIREMENTS.modules,
    selected_transport_version: CORE_CLIENT_REQUIREMENTS.transport.max,
    store_epoch: storeEpoch,
  };
};

export class FakeCoreClient implements CoreClientPort {
  readonly readFileBlobs: ReadFileBytesInput[] = [];
  readonly automationReads: AutomationRead[] = [];
  readonly automationReadOptions: Array<CoreRequestOptions | undefined> = [];
  readonly automationApplies: AutomationApplyInput[] = [];
  readonly automationApplyOptions: Array<CoreRequestOptions | undefined> = [];
  readonly reads: LibraryRead[] = [];
  readonly applies: LibraryApplyInput[] = [];
  readonly preparedFileBlobs: Array<{
    readonly operationId: string;
    readonly bytes: Uint8Array;
  }> = [];
  readonly readThreadAssetBlobs: Array<{
    readonly threadId: string;
    readonly contentHash: string;
  }> = [];
  readonly databaseReads: DatabaseRead[] = [];
  readonly databaseApplies: DatabaseApplyInput[] = [];
  readonly workspaceReads: ProjectWorkspaceRead[] = [];
  readonly workspaceReadOptions: Array<CoreRequestOptions | undefined> = [];
  readonly workspaceApplies: ProjectWorkspaceApplyInput[] = [];
  readonly workspaceApplyOptions: Array<CoreRequestOptions | undefined> = [];
  readonly administrationReads: StoreAdministrationRead[] = [];
  readonly administrationApplies: StoreAdministrationApplyInput[] = [];
  readonly documentReads: Array<{
    readonly clientSessionId: string;
    readonly read: OwnedDocumentRead;
  }> = [];
  readonly documentReadOptions: Array<CoreRequestOptions | undefined> = [];
  readonly documentApplies: OwnedDocumentApplyInput[] = [];
  readonly documentApplyOptions: Array<CoreRequestOptions | undefined> = [];
  readonly documentSyncs: DocumentSyncRequest[] = [];
  readonly documentCanvasSyncs: CanvasSceneSyncRequest[] = [];
  readonly documentUpdateApplies: DocumentSyncApplyRequest[] = [];
  readonly awarenessPublishes: DocumentAwarenessPublishRequest[] = [];
  readonly #readResults: LibraryReadSnapshot[] = [];
  readonly #automationReadResults: AutomationReadSnapshot[] = [];
  readonly #automationApplyResults: AutomationApplyResult[] = [];
  readonly #applyResults: LibraryApplyResult[] = [];
  readonly #preparedFileBlobResults: PreparedBlobReceipt[] = [];
  readonly #fileBlobReadResults: ManagedBlobBytes[] = [];
  readonly #databaseReadResults: DatabaseReadSnapshot[] = [];
  readonly #databaseApplyResults: DatabaseApplyResult[] = [];
  readonly #workspaceReadResults: ProjectWorkspaceReadSnapshot[] = [];
  readonly #workspaceApplyResults: ProjectWorkspaceApplyResult[] = [];
  readonly #administrationReadResults: StoreAdministrationReadSnapshot[] = [];
  readonly #administrationApplyResults: StoreAdministrationApplyResult[] = [];
  readonly #documentReadResults: OwnedDocumentReadSnapshot[] = [];
  readonly #documentApplyResults: OwnedDocumentApplyResult[] = [];
  readonly #documentSyncResults: DocumentSyncResponse[] = [];
  readonly #documentCanvasSyncResults: CanvasSceneSyncResponse[] = [];
  readonly #documentUpdateApplyResults: DocumentSyncApplyAck[] = [];
  readonly #awarenessResults: DocumentAwarenessPublishAck[] = [];
  readonly #localMutationResolveResults: CoreLocalMutationResolveResponse[] = [];
  readonly #eventConsumers = new Set<(event: CoreEventEnvelope) => void>();
  readonly #documentEventConsumers = new Map<string, Set<(event: CoreEventEnvelope) => void>>();
  readonly #documentRepairConsumers = new Map<string, Set<(repair: DocumentLiveRepair) => void>>();

  enqueueRead(result: LibraryReadSnapshot): void {
    this.#readResults.push(result);
  }

  async filterProjectionImpactForProject(
    projectId: string,
    impact: ProjectionImpact,
  ): Promise<ProjectionImpact> {
    const snapshot = await this.libraryRead({
      kind: "filter_projection_impact_for_project",
      project_id: projectId,
      impact,
    });
    if (snapshot.value.kind !== "projection_impact") {
      throw new Error("Fake Core returned the wrong Projection impact read");
    }
    return snapshot.value.impact;
  }

  enqueueAutomationRead(result: AutomationReadSnapshot): void {
    this.#automationReadResults.push(result);
  }

  enqueueAutomationApply(result: ApplyFixtureInput<AutomationApplyResult>): void {
    this.#automationApplyResults.push(normalizeApplyFixture(result));
  }

  enqueueApply(result: ApplyFixtureInput<LibraryApplyResult>): void {
    this.#applyResults.push(normalizeApplyFixture(result));
  }

  enqueuePreparedBlobReceipt(result: PreparedBlobReceipt): void {
    this.#preparedFileBlobResults.push(result);
  }

  enqueueFileBlobRead(result: ManagedBlobBytes): void {
    this.#fileBlobReadResults.push(result);
  }

  enqueueDatabaseRead(result: DatabaseReadSnapshot): void {
    this.#databaseReadResults.push(result);
  }

  enqueueDatabaseApply(result: ApplyFixtureInput<DatabaseApplyResult>): void {
    this.#databaseApplyResults.push(normalizeApplyFixture(result));
  }

  enqueueWorkspaceRead(result: ProjectWorkspaceReadSnapshot): void {
    this.#workspaceReadResults.push(result);
  }

  enqueueWorkspaceApply(result: ApplyFixtureInput<ProjectWorkspaceApplyResult>): void {
    this.#workspaceApplyResults.push(normalizeApplyFixture(result));
  }

  enqueueAdministrationRead(result: StoreAdministrationReadSnapshot): void {
    this.#administrationReadResults.push(result);
  }

  enqueueAdministrationApply(result: ApplyFixtureInput<StoreAdministrationApplyResult>): void {
    this.#administrationApplyResults.push(normalizeApplyFixture(result));
  }

  enqueueDocumentRead(result: OwnedDocumentReadSnapshot): void {
    this.#documentReadResults.push(result);
  }

  enqueueDocumentApply(result: ApplyFixtureInput<OwnedDocumentApplyResult>): void {
    this.#documentApplyResults.push(normalizeApplyFixture(result));
  }

  enqueueDocumentSync(result: DocumentSyncResponse): void {
    this.#documentSyncResults.push(result);
  }

  enqueueDocumentCanvasSync(result: CanvasSceneSyncResponse): void {
    this.#documentCanvasSyncResults.push(result);
  }

  enqueueDocumentUpdateApply(result: DocumentSyncApplyAck): void {
    this.#documentUpdateApplyResults.push(result);
  }

  enqueueAwareness(result: DocumentAwarenessPublishAck): void {
    this.#awarenessResults.push(result);
  }

  enqueueLocalMutationResolve(result: CoreLocalMutationResolveResponse): void {
    this.#localMutationResolveResults.push(result);
  }

  async resolveLocalMutation(
    input: CoreLocalMutationResolveRequest,
  ): Promise<CoreLocalMutationResolveResponse> {
    void input;
    const result = this.#localMutationResolveResults.shift();
    if (!result) throw new Error("Fake Core client has no queued mutation resolve");
    return result;
  }

  async libraryRead(
    read: LibraryRead,
    options?: import("../types").CoreRequestOptions,
  ): Promise<LibraryReadSnapshot> {
    void options;
    this.reads.push(read);
    const result = this.#readResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Library read");
    return result;
  }

  async automationRead(
    read: AutomationRead,
    options?: CoreRequestOptions,
  ): Promise<AutomationReadSnapshot> {
    this.automationReads.push(read);
    this.automationReadOptions.push(options);
    const result = this.#automationReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Automation read");
    return result;
  }

  async automationApply(
    input: AutomationApplyInput,
    options?: CoreRequestOptions,
  ): Promise<AutomationApplyResult> {
    this.automationApplies.push(input);
    this.automationApplyOptions.push(options);
    const result = this.#automationApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Automation apply");
    return result;
  }

  async libraryApply(input: LibraryApplyInput): Promise<LibraryApplyResult> {
    this.applies.push(input);
    const result = this.#applyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Library apply");
    return result;
  }

  async prepareBlob(input: {
    readonly operationId: string;
    readonly idempotencySlot?: string;
    readonly bytes: Uint8Array;
  }): Promise<PreparedBlobReceipt> {
    return this.prepareFileBlob(input);
  }

  async readThreadAssetBlob(input: {
    readonly threadId: string;
    readonly contentHash: string;
  }): Promise<ManagedBlobBytes> {
    this.readThreadAssetBlobs.push(input);
    const result = this.#fileBlobReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Thread Blob read");
    return result;
  }

  async prepareFileBlob(input: {
    readonly operationId: string;
    readonly idempotencySlot?: string;
    readonly bytes: Uint8Array;
  }): Promise<PreparedBlobReceipt> {
    this.preparedFileBlobs.push(input);
    const result = this.#preparedFileBlobResults.shift();
    if (!result) throw new Error("Fake Core client has no queued prepared File Blob");
    return result;
  }

  async readFileBlob(input: ReadFileBytesInput): Promise<ManagedBlobBytes> {
    this.readFileBlobs.push(input);
    const result = this.#fileBlobReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued File Blob read");
    return result;
  }

  async databaseRead(read: DatabaseRead): Promise<DatabaseReadSnapshot> {
    this.databaseReads.push(read);
    const result = this.#databaseReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Database read");
    return result;
  }

  async databaseApply(input: DatabaseApplyInput): Promise<DatabaseApplyResult> {
    this.databaseApplies.push(input);
    const result = this.#databaseApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Database apply");
    return result;
  }

  async workspaceRead(
    read: ProjectWorkspaceRead,
    options?: CoreRequestOptions,
  ): Promise<ProjectWorkspaceReadSnapshot> {
    this.workspaceReads.push(read);
    this.workspaceReadOptions.push(options);
    const result = this.#workspaceReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Project Workspace read");
    return result;
  }

  async workspaceApply(
    input: ProjectWorkspaceApplyInput,
    options?: CoreRequestOptions,
  ): Promise<ProjectWorkspaceApplyResult> {
    this.workspaceApplies.push(input);
    this.workspaceApplyOptions.push(options);
    const result = this.#workspaceApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Project Workspace apply");
    return result;
  }

  async administrationRead(
    read: StoreAdministrationRead,
  ): Promise<StoreAdministrationReadSnapshot> {
    this.administrationReads.push(read);
    const result = this.#administrationReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Store Administration read");
    return result;
  }

  async administrationApply(
    input: StoreAdministrationApplyInput,
  ): Promise<StoreAdministrationApplyResult> {
    this.administrationApplies.push(input);
    const result = this.#administrationApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Store Administration apply");
    return result;
  }

  async documentRead(
    clientSessionId: string,
    read: OwnedDocumentRead,
    options?: CoreRequestOptions,
  ): Promise<OwnedDocumentReadSnapshot> {
    this.documentReads.push({ clientSessionId, read });
    this.documentReadOptions.push(options);
    const result = this.#documentReadResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Document read");
    return result;
  }

  async documentApply(
    input: OwnedDocumentApplyInput,
    options?: CoreRequestOptions,
  ): Promise<OwnedDocumentApplyResult> {
    this.documentApplies.push(input);
    this.documentApplyOptions.push(options);
    const result = this.#documentApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Document apply");
    return result;
  }

  async documentSync(input: DocumentSyncRequest): Promise<DocumentSyncResponse> {
    this.documentSyncs.push(input);
    const result = this.#documentSyncResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Document sync");
    return result;
  }

  async documentCanvasSync(input: CanvasSceneSyncRequest): Promise<CanvasSceneSyncResponse> {
    this.documentCanvasSyncs.push(input);
    const result = this.#documentCanvasSyncResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Canvas sync");
    return result;
  }

  async documentApplyUpdate(input: DocumentSyncApplyRequest): Promise<DocumentSyncApplyAck> {
    this.documentUpdateApplies.push(input);
    const result = this.#documentUpdateApplyResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Document update apply");
    return result;
  }

  async documentPublishAwareness(
    input: DocumentAwarenessPublishRequest,
  ): Promise<DocumentAwarenessPublishAck> {
    this.awarenessPublishes.push(input);
    const result = this.#awarenessResults.shift();
    if (!result) throw new Error("Fake Core client has no queued Awareness result");
    return result;
  }

  openDocumentEventStream(
    _input: {
      readonly documentId: string;
      readonly clientSessionId: string;
    },
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    _onRealtimeEvent: (event: DocumentSyncRealtimeEvent) => void,
  ): Promise<CoreDocumentEventSubscription> {
    void _onRealtimeEvent;
    const consumers =
      this.#documentEventConsumers.get(_input.documentId) ??
      new Set<(event: CoreEventEnvelope) => void>();
    consumers.add(onEvent);
    this.#documentEventConsumers.set(_input.documentId, consumers);
    const repairConsumers =
      this.#documentRepairConsumers.get(_input.documentId) ??
      new Set<(repair: DocumentLiveRepair) => void>();
    repairConsumers.add(onRepair);
    this.#documentRepairConsumers.set(_input.documentId, repairConsumers);
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return Promise.resolve({
      barrier: {
        store_epoch: "epoch:test",
        core_generation: "fake-core-start",
        document_id: _input.documentId,
        document_generation: 1,
        head_seq: 0,
        commit_head: 0,
        engine: _input.documentId.includes("canvas") ? "canvas_scene" : "yjs",
      },
      done,
      close: () => {
        consumers.delete(onEvent);
        if (consumers.size === 0) {
          this.#documentEventConsumers.delete(_input.documentId);
        }
        repairConsumers.delete(onRepair);
        if (repairConsumers.size === 0) {
          this.#documentRepairConsumers.delete(_input.documentId);
        }
        finish?.();
      },
    });
  }

  async openEventStream(
    _after: number,
    onEvent: (event: CoreEventEnvelope) => void,
    _onCheckpoint: (checkpoint: CoreStreamCheckpoint) => void,
    _onResyncRequired?: (event: CoreEventReplayRequired) => void,
    _signal?: AbortSignal,
  ): Promise<CoreEventSubscription> {
    void _onResyncRequired;
    void _onCheckpoint;
    void _signal;
    this.#eventConsumers.add(onEvent);
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      done,
      close: () => {
        this.#eventConsumers.delete(onEvent);
        finish?.();
      },
    };
  }

  async openProjectionEventStream(
    scopes: readonly ProjectionScope[],
    _onEvent: (event: CoreEventEnvelope) => void,
    _onRepair: (repair: ProjectionLiveRepair) => void,
    _signal?: AbortSignal,
  ): Promise<CoreProjectionEventSubscription> {
    void _onEvent;
    void _onRepair;
    void _signal;
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      barrier: {
        store_epoch: "epoch:test",
        core_generation: "fake-core-start",
        commit_head: 0,
        recipient_leases: scopes.map((scope, index) => {
          const address =
            scope.kind === "library"
              ? { kind: "library" as const, library_id: scope.libraryId }
              : {
                  kind: "project" as const,
                  library_id: scope.libraryId,
                  project_id: scope.projectId,
                };
          return {
            lease_id: String(index + 1)
              .padStart(64, "a")
              .slice(-64),
            delivery_address: address,
            authorization_scope: address,
          };
        }),
      },
      done,
      close: () => finish?.(),
    };
  }

  emit(event: CoreEventEnvelope): void {
    for (const consumer of this.#eventConsumers) consumer(event);
  }

  emitDocument(documentId: string, event: CoreEventEnvelope): void {
    for (const consumer of this.#documentEventConsumers.get(documentId) ?? []) {
      consumer(event);
    }
  }

  emitDocumentRepair(documentId: string, repair: DocumentLiveRepair): void {
    for (const consumer of this.#documentRepairConsumers.get(documentId) ?? []) {
      consumer(repair);
    }
  }
}
