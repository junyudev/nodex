import type { ReadFileBytesInput } from "../../shared/library-files";
import { readFileBytesSchema } from "../../shared/library-files-transport";
import { randomUUID } from "node:crypto";

import { CORE_CLIENT_REQUIREMENTS, CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";
import type { components } from "@nodex/core-protocol";
import type { ProjectionImpact, ProjectionScope } from "../../shared/projection-stream";
import {
  decodeCanvasSceneSyncHttpResponse,
  decodeDocumentApplyHttpAck,
  decodeDocumentSyncHttpResponse,
  encodeCanvasSceneSyncHttpRequest,
  encodeDocumentApplyHttpRequest,
  encodeDocumentAwarenessHttpRequest,
  encodeDocumentSyncHttpRequest,
} from "../../shared/block-documents/http-contract";
import {
  MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
  type CanvasSceneSyncRequest,
  type CanvasSceneSyncResponse,
} from "../../shared/block-documents/canvas-scene-sync";
import { MAX_PAGE_DOCUMENT_STATE_BYTES } from "../../shared/block-documents/contracts";
import {
  MAX_DOCUMENT_AWARENESS_UPDATE_BYTES,
  type DocumentAwarenessPublishAck,
  type DocumentAwarenessPublishRequest,
  type DocumentSyncApplyAck,
  type DocumentSyncApplyRequest,
  type DocumentSyncRealtimeEvent,
  type DocumentSyncRequest,
  type DocumentSyncResponse,
} from "../../shared/block-documents/document-sync";
import { MAX_DOCUMENT_HTTP_METADATA_BYTES } from "../../shared/block-documents/http-wire";

import { readCoreRuntimeConnection } from "./runtime-descriptor";
import { decodeBoundedJson } from "./codec";
import type {
  CoreClientPort,
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreEventSubscription,
  CoreProjectionEventSubscription,
  CoreDocumentEventSubscription,
  CoreStreamCheckpoint,
  CoreHandshakeResponse,
  CoreLocalMutationResolveRequest,
  CoreLocalMutationResolveResponse,
  CoreModuleError,
  CoreRequestOptions,
  AutomationApplyInput,
  AutomationApplyResponse,
  AutomationApplyResult,
  AutomationRead,
  AutomationReadResponse,
  AutomationReadSnapshot,
  DatabaseApplyInput,
  DatabaseApplyResponse,
  DatabaseApplyResult,
  DatabaseRead,
  DatabaseReadResponse,
  DatabaseReadSnapshot,
  LibraryApplyInput,
  LibraryApplyResponse,
  LibraryApplyResult,
  LibraryRead,
  LibraryReadResponse,
  LibraryReadSnapshot,
  ManagedBlobBytes,
  PreparedBlobReceipt,
  DocumentLiveRepair,
  ProjectionLiveRepair,
  OwnedDocumentApplyInput,
  OwnedDocumentApplyResponse,
  OwnedDocumentApplyResult,
  OwnedDocumentRead,
  OwnedDocumentReadResponse,
  OwnedDocumentReadSnapshot,
  ProjectWorkspaceRead,
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResponse,
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceReadResponse,
  ProjectWorkspaceReadSnapshot,
  StoreAdministrationApplyInput,
  StoreAdministrationApplyResponse,
  StoreAdministrationApplyResult,
  StoreAdministrationRead,
  StoreAdministrationReadResponse,
  StoreAdministrationReadSnapshot,
} from "./types";
import { CoreEventCompatibilityError, UdsHttpTransport } from "./uds-http";

const DOCUMENT_FRAME_OVERHEAD_BYTES = MAX_DOCUMENT_HTTP_METADATA_BYTES + 8;

type ModuleName = components["schemas"]["ModuleName"];

const contractVersion = (module: ModuleName): number => {
  const entry = CORE_CLIENT_REQUIREMENTS.modules.find((candidate) => candidate.module === module);
  if (entry) return entry.contract_version;
  throw new Error(`Core client requirements omit ${module}`);
};

const MODULE_CONTRACT_VERSIONS = {
  library: contractVersion("library"),
  database: contractVersion("database"),
  ownedDocument: contractVersion("owned_document"),
  projectWorkspace: contractVersion("project_workspace"),
  automation: contractVersion("automation"),
  storeAdministration: contractVersion("store_administration"),
} as const;

type ClientKind = components["schemas"]["ClientKind"];
type HealthResponse = components["schemas"]["HealthResponse"];
type ShutdownResponse = components["schemas"]["ShutdownResponse"];

export interface ConnectCoreClientInput {
  readonly nodexHome: string;
  readonly clientKind: ClientKind;
  readonly buildId: string;
  readonly connectionId?: string;
  readonly projectId?: string;
  readonly maximumJsonResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class CoreModuleResponseError extends Error {
  constructor(readonly coreError: CoreModuleError) {
    super(coreError.message);
    this.name = "CoreModuleResponseError";
  }
}

export class CoreClient implements CoreClientPort {
  readonly #transport: UdsHttpTransport;
  readonly #projectId: string | undefined;
  readonly #connectionId: string;
  readonly handshake: CoreHandshakeResponse;

  private constructor(
    transport: UdsHttpTransport,
    handshake: CoreHandshakeResponse,
    projectId: string | undefined,
    connectionId: string,
  ) {
    this.#transport = transport;
    this.handshake = handshake;
    this.#projectId = projectId;
    this.#connectionId = connectionId;
  }

  static async connect(input: ConnectCoreClientInput): Promise<CoreClient> {
    const connectionId = input.connectionId ?? randomUUID();
    if (!connectionId || connectionId !== connectionId.trim() || connectionId.length > 512) {
      throw new Error("Core connection identity is invalid");
    }
    const runtime = readCoreRuntimeConnection(input.nodexHome);
    const transport = new UdsHttpTransport(runtime.descriptor.socket_path, runtime.authCapability, {
      maximumJsonResponseBytes: input.maximumJsonResponseBytes,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    const handshake = await transport.requestJson<CoreHandshakeResponse>(
      "POST",
      "/core/v1/handshake",
      {
        requirements: CORE_CLIENT_REQUIREMENTS,
        client: {
          kind: input.clientKind,
          build_id: input.buildId,
        },
        connection_id: connectionId,
        expected_generation: {
          manifest_digest: runtime.descriptor.manifest_digest,
          artifact_sha256: runtime.descriptor.artifact.sha256,
          pid: runtime.descriptor.pid,
          start_nonce: runtime.descriptor.start_nonce,
          profile_id: runtime.descriptor.profile_id,
          store_epoch: runtime.descriptor.store_epoch,
          readiness_generation: runtime.descriptor.readiness_generation,
        },
      },
      {},
      { signal: input.signal },
    );
    assertHandshake(runtime.descriptor, handshake);
    transport.configureEventContract({
      transportVersion: handshake.selected_transport_version,
      eventVersion: handshake.selected_event_version,
      libraryId: handshake.library_id,
      storeEpoch: handshake.store_epoch,
      coreGeneration: handshake.generation.start_nonce,
    });
    return new CoreClient(transport, handshake, input.projectId, connectionId);
  }

  forProject(projectId: string): CoreClient {
    const normalized = projectId.trim();
    if (!normalized || normalized !== projectId || normalized.length > 512) {
      throw new Error("Core Project binding is invalid");
    }
    if (normalized === this.#projectId) return this;
    return new CoreClient(this.#transport, this.handshake, normalized, this.#connectionId);
  }

  health(): Promise<HealthResponse> {
    return this.#transport.requestJson("GET", "/core/v1/health");
  }

  async resolveLocalMutation(
    input: CoreLocalMutationResolveRequest,
  ): Promise<CoreLocalMutationResolveResponse> {
    return await this.#transport.requestJson<CoreLocalMutationResolveResponse>(
      "POST",
      "/core/v1/local-mutations/resolve",
      input,
      this.#moduleHeaders(),
    );
  }

  async libraryRead(
    read: LibraryRead,
    options: CoreRequestOptions = {},
  ): Promise<LibraryReadSnapshot> {
    const response = await this.#transport.requestJson<LibraryReadResponse>(
      "POST",
      "/core/v1/modules/library/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.library, read },
      this.#moduleHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async libraryApply(
    input: LibraryApplyInput,
    options: CoreRequestOptions = {},
  ): Promise<LibraryApplyResult> {
    const response = await this.#transport.requestJson<LibraryApplyResponse>(
      "POST",
      "/core/v1/modules/library/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.library,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      { ...this.#moduleHeaders(), ...this.#historyOwnerHeaders(options.editorHistoryOwnerId) },
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async prepareFileBlob(
    input: {
      readonly operationId: string;
      readonly idempotencySlot?: string;
      readonly bytes: Uint8Array;
    },
    options: CoreRequestOptions = {},
  ): Promise<PreparedBlobReceipt> {
    if (input.bytes.byteLength > CORE_TRANSPORT_BUDGETS.file_blob_bytes) {
      throw new Error("File upload exceeds its byte limit");
    }
    return this.#prepareBlob("/core/v1/files/blobs/prepare", input, options);
  }

  async prepareBlob(
    input: {
      readonly operationId: string;
      readonly idempotencySlot?: string;
      readonly bytes: Uint8Array;
    },
    options: CoreRequestOptions = {},
  ): Promise<PreparedBlobReceipt> {
    if (input.bytes.byteLength > CORE_TRANSPORT_BUDGETS.managed_blob_bytes) {
      throw new Error("Blob publication exceeds its byte limit");
    }
    return this.#prepareBlob("/core/v1/blobs/prepare", input, options);
  }

  async #prepareBlob(
    endpoint: string,
    input: {
      readonly operationId: string;
      readonly idempotencySlot?: string;
      readonly bytes: Uint8Array;
    },
    options: CoreRequestOptions,
  ): Promise<PreparedBlobReceipt> {
    const query = new URLSearchParams({
      operation_id: input.operationId,
      store_epoch: this.handshake.store_epoch,
    });
    if (input.idempotencySlot) query.set("idempotency_slot", input.idempotencySlot);
    const response = await this.#transport.requestBoundedBytes(
      "POST",
      `${endpoint}?${query.toString()}`,
      input.bytes,
      this.#moduleHeaders(),
      CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes,
      options,
    );
    if (response.contentType !== "application/json") {
      throw new Error("Core prepared Blob response has an invalid Content-Type");
    }
    return decodeBoundedJson<PreparedBlobReceipt>(
      response.bytes,
      CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes,
      "Core prepared Blob response",
    );
  }

  async readThreadAssetBlob(
    input: { readonly threadId: string; readonly contentHash: string },
    options: CoreRequestOptions = {},
  ): Promise<ManagedBlobBytes> {
    const response = await this.#transport.requestBoundedBytes(
      "GET",
      `/core/v1/threads/${encodeURIComponent(input.threadId)}/blobs/${encodeURIComponent(input.contentHash)}`,
      undefined,
      this.#moduleHeaders(),
      CORE_TRANSPORT_BUDGETS.managed_blob_bytes,
      options,
    );
    if (!response.contentType || !response.etag) {
      throw new Error("Core Thread Blob response omitted its content evidence");
    }
    return {
      bytes: response.bytes,
      mimeType: response.contentType,
      etag: response.etag.replace(/^"|"$/gu, ""),
    };
  }

  async readFileBlob(
    input: ReadFileBytesInput,
    options: CoreRequestOptions = {},
  ): Promise<ManagedBlobBytes> {
    const checked = readFileBytesSchema.parse(input);
    const query = new URLSearchParams(checked.source);
    if (checked.version !== undefined) query.set("version", String(checked.version));
    const response = await this.#transport.requestBoundedBytes(
      "GET",
      `/core/v1/files/blobs/${encodeURIComponent(checked.fileId)}?${query.toString()}`,
      undefined,
      this.#moduleHeaders(),
      CORE_TRANSPORT_BUDGETS.file_blob_bytes,
      options,
    );
    if (!response.contentType || !response.etag)
      throw new Error("Core File response omitted its content evidence");
    return {
      bytes: response.bytes,
      mimeType: response.contentType,
      etag: response.etag.replace(/^"|"$/gu, ""),
    };
  }

  async filterProjectionImpactForProject(
    projectId: string,
    impact: ProjectionImpact,
  ): Promise<ProjectionImpact> {
    const snapshot = await this.forProject(projectId).libraryRead({
      kind: "filter_projection_impact_for_project",
      project_id: projectId,
      impact,
    });
    if (snapshot.value.kind === "projection_impact") {
      return snapshot.value.impact;
    }
    throw new Error("Core returned an invalid Projection impact authorization result");
  }

  async databaseRead(
    read: DatabaseRead,
    options: CoreRequestOptions = {},
  ): Promise<DatabaseReadSnapshot> {
    const response = await this.#transport.requestJson<DatabaseReadResponse>(
      "POST",
      "/core/v1/modules/database/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.database, read },
      this.#databaseHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async databaseApply(
    input: DatabaseApplyInput,
    options: CoreRequestOptions = {},
  ): Promise<DatabaseApplyResult> {
    const response = await this.#transport.requestJson<DatabaseApplyResponse>(
      "POST",
      "/core/v1/modules/database/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.database,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      this.#databaseHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async workspaceRead(
    read: ProjectWorkspaceRead,
    options: CoreRequestOptions = {},
  ): Promise<ProjectWorkspaceReadSnapshot> {
    const response = await this.#transport.requestJson<ProjectWorkspaceReadResponse>(
      "POST",
      "/core/v1/modules/workspace/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.projectWorkspace, read },
      this.#moduleHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async workspaceApply(
    input: ProjectWorkspaceApplyInput,
    options: CoreRequestOptions = {},
  ): Promise<ProjectWorkspaceApplyResult> {
    const response = await this.#transport.requestJson<ProjectWorkspaceApplyResponse>(
      "POST",
      "/core/v1/modules/workspace/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.projectWorkspace,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      this.#moduleHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async automationRead(
    read: AutomationRead,
    options: CoreRequestOptions = {},
  ): Promise<AutomationReadSnapshot> {
    const response = await this.#transport.requestJson<AutomationReadResponse>(
      "POST",
      "/core/v1/modules/automation/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.automation, read },
      this.#moduleHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async automationApply(
    input: AutomationApplyInput,
    options: CoreRequestOptions = {},
  ): Promise<AutomationApplyResult> {
    const response = await this.#transport.requestJson<AutomationApplyResponse>(
      "POST",
      "/core/v1/modules/automation/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.automation,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      this.#moduleHeaders(),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async administrationRead(
    read: StoreAdministrationRead,
  ): Promise<StoreAdministrationReadSnapshot> {
    const response = await this.#transport.requestJson<StoreAdministrationReadResponse>(
      "POST",
      "/core/v1/modules/administration/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.storeAdministration, read },
      this.#moduleHeaders(),
      { class: "background" },
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async administrationApply(
    input: StoreAdministrationApplyInput,
  ): Promise<StoreAdministrationApplyResult> {
    const response = await this.#transport.requestJson<StoreAdministrationApplyResponse>(
      "POST",
      "/core/v1/modules/administration/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.storeAdministration,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      this.#moduleHeaders(),
      // Coalescence is a short receipt write that must remain admissible while
      // the long-running snapshot owns the maintenance execution lane.
      { class: input.intent.kind === "coalesce_backup" ? "background" : "maintenance" },
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async documentRead(
    clientSessionId: string,
    read: OwnedDocumentRead,
    options: CoreRequestOptions = {},
  ): Promise<OwnedDocumentReadSnapshot> {
    const response = await this.#transport.requestJson<OwnedDocumentReadResponse>(
      "POST",
      "/core/v1/modules/document/read",
      { contract_version: MODULE_CONTRACT_VERSIONS.ownedDocument, read },
      this.#documentHeaders(clientSessionId),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async documentApply(
    input: OwnedDocumentApplyInput,
    options: CoreRequestOptions = {},
  ): Promise<OwnedDocumentApplyResult> {
    const response = await this.#transport.requestJson<OwnedDocumentApplyResponse>(
      "POST",
      "/core/v1/modules/document/apply",
      {
        contract_version: MODULE_CONTRACT_VERSIONS.ownedDocument,
        operation_id: input.operationId,
        store_epoch: this.handshake.store_epoch,
        intent: input.intent,
      },
      this.#documentHeaders(input.clientSessionId),
      options,
    );
    if (response.status === "ok") return response.payload;
    throw new CoreModuleResponseError(response.payload);
  }

  async documentSync(
    input: DocumentSyncRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentSyncResponse> {
    const response = await this.#transport.requestDocumentFrame<OwnedDocumentReadResponse>(
      "/core/v1/modules/document/read",
      encodeDocumentSyncHttpRequest(input),
      this.#documentHeaders(input.clientSessionId, input.documentId),
      DOCUMENT_FRAME_OVERHEAD_BYTES + MAX_PAGE_DOCUMENT_STATE_BYTES,
      options,
    );
    if (response.kind === "binary") {
      return decodeDocumentSyncHttpResponse(response.bytes);
    }
    if (response.value.status === "error") {
      throw new CoreModuleResponseError(response.value.payload);
    }
    throw new Error("Core returned JSON for a successful binary Document sync");
  }

  async documentCanvasSync(
    input: CanvasSceneSyncRequest,
    options?: CoreRequestOptions,
  ): Promise<CanvasSceneSyncResponse> {
    const response = await this.#transport.requestDocumentFrame<OwnedDocumentReadResponse>(
      "/core/v1/modules/document/read",
      encodeCanvasSceneSyncHttpRequest(input),
      this.#documentHeaders(input.clientSessionId, input.documentId),
      DOCUMENT_FRAME_OVERHEAD_BYTES + MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
      options,
    );
    if (response.kind === "binary") {
      return decodeCanvasSceneSyncHttpResponse(response.bytes);
    }
    if (response.value.status === "error") {
      throw new CoreModuleResponseError(response.value.payload);
    }
    throw new Error("Core returned JSON for a successful binary Canvas sync");
  }

  async documentApplyUpdate(
    input: DocumentSyncApplyRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentSyncApplyAck> {
    const response = await this.#transport.requestDocumentFrame<OwnedDocumentApplyResponse>(
      "/core/v1/modules/document/apply",
      encodeDocumentApplyHttpRequest(input),
      this.#documentHeaders(input.clientSessionId, input.documentId),
      DOCUMENT_FRAME_OVERHEAD_BYTES + MAX_PAGE_DOCUMENT_STATE_BYTES,
      options,
    );
    if (response.kind === "binary") {
      return decodeDocumentApplyHttpAck(response.bytes);
    }
    if (response.value.status === "error") {
      throw new CoreModuleResponseError(response.value.payload);
    }
    throw new Error("Core returned JSON for a successful binary Document update");
  }

  async documentPublishAwareness(
    input: DocumentAwarenessPublishRequest,
    options?: CoreRequestOptions,
  ): Promise<DocumentAwarenessPublishAck> {
    const response = await this.#transport.requestDocumentFrame<
      DocumentAwarenessPublishAck | OwnedDocumentApplyResponse
    >(
      "/core/v1/modules/document/apply",
      encodeDocumentAwarenessHttpRequest(input),
      this.#documentHeaders(input.clientSessionId, input.documentId),
      DOCUMENT_FRAME_OVERHEAD_BYTES + MAX_DOCUMENT_AWARENESS_UPDATE_BYTES,
      options,
    );
    if (response.kind === "binary") {
      throw new Error("Core returned a binary Awareness acknowledgement");
    }
    if ("status" in response.value) {
      if (response.value.status === "error") {
        throw new CoreModuleResponseError(response.value.payload);
      }
      throw new Error("Core returned an invalid Awareness response");
    }
    if (response.value.accepted) return response.value;
    throw new Error("Core rejected an invalid Awareness acknowledgement");
  }

  openDocumentEventStream(
    input: {
      readonly documentId: string;
      readonly clientSessionId: string;
      readonly signal?: AbortSignal;
    },
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    onRealtimeEvent: (event: DocumentSyncRealtimeEvent) => void,
  ): Promise<CoreDocumentEventSubscription> {
    return this.#transport
      .openDocumentLiveStream(
        {
          ...this.#documentHeaders(input.clientSessionId),
          "x-nodex-document-id": input.documentId,
        },
        onEvent,
        onRepair,
        onRealtimeEvent,
        input.signal,
      )
      .then((subscription) => {
        if (subscription.barrier.document_id !== input.documentId) {
          subscription.close();
          throw new CoreEventCompatibilityError(
            "Core Document live barrier does not match the requested Document",
          );
        }
        return subscription;
      });
  }

  openEventStream(
    after: number,
    onEvent: (event: CoreEventEnvelope) => void,
    onCheckpoint: (checkpoint: CoreStreamCheckpoint) => void,
    onResyncRequired?: (event: CoreEventReplayRequired) => void,
    signal?: AbortSignal,
  ): Promise<CoreEventSubscription> {
    return this.#transport.openEventStream(
      after,
      onEvent,
      this.#moduleHeaders(),
      undefined,
      onResyncRequired,
      onCheckpoint,
      signal,
    );
  }

  openProjectionEventStream(
    scopes: readonly ProjectionScope[],
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: ProjectionLiveRepair) => void,
    signal?: AbortSignal,
  ): Promise<CoreProjectionEventSubscription> {
    return this.#transport.openProjectionLiveStream(
      scopes,
      this.#moduleHeaders(),
      onEvent,
      onRepair,
      signal,
    );
  }

  shutdown(): Promise<ShutdownResponse> {
    return this.#transport.requestJson(
      "POST",
      "/core/v1/admin/shutdown",
      { kind: "shutdown" },
      this.#moduleHeaders(),
    );
  }

  #documentHeaders(clientSessionId: string, documentId?: string): Readonly<Record<string, string>> {
    if (!clientSessionId || clientSessionId.length > 512) {
      throw new Error("Owned Document client session identity is invalid");
    }
    return {
      ...this.#moduleHeaders(),
      ...(!this.#projectId ? { "x-nodex-document-scope": "library" } : {}),
      "x-nodex-client-session-id": clientSessionId,
      ...(documentId ? { "x-nodex-document-id": documentId } : {}),
    };
  }

  #historyOwnerHeaders(ownerId: string | undefined): Readonly<Record<string, string>> {
    if (ownerId === undefined) return {};
    if (!ownerId || ownerId !== ownerId.trim() || ownerId.length > 512) {
      throw new Error("Editor history lifetime identity is invalid");
    }
    return { "x-nodex-editor-history-owner": ownerId };
  }

  #databaseHeaders(): Readonly<Record<string, string>> {
    return {
      ...this.#moduleHeaders(),
      ...(!this.#projectId ? { "x-nodex-database-scope": "library" } : {}),
    };
  }

  #moduleHeaders(requireProject = false): Readonly<Record<string, string>> {
    if (requireProject && !this.#projectId) {
      throw new Error("CoreClient requires a Project binding for this Module access");
    }
    return {
      "x-nodex-connection-id": this.#connectionId,
      "x-nodex-connection-binding": this.handshake.connection_binding,
      ...(this.#projectId ? { "x-nodex-project-id": this.#projectId } : {}),
    };
  }
}

const assertHandshake = (
  descriptor: components["schemas"]["RuntimeDescriptor"],
  handshake: CoreHandshakeResponse,
): void => {
  if (
    handshake.selected_transport_version < CORE_CLIENT_REQUIREMENTS.transport.min ||
    handshake.selected_transport_version > CORE_CLIENT_REQUIREMENTS.transport.max
  ) {
    throw new Error("Core selected an unsupported transport version");
  }
  if (
    handshake.selected_event_version !== CORE_CLIENT_REQUIREMENTS.event_version ||
    handshake.selected_module_versions.length !== CORE_CLIENT_REQUIREMENTS.modules.length ||
    handshake.selected_module_versions.some((selected, index) => {
      const required = CORE_CLIENT_REQUIREMENTS.modules[index];
      return (
        required === undefined ||
        selected.module !== required.module ||
        selected.contract_version !== required.contract_version
      );
    })
  ) {
    throw new Error("Core selected unsupported event or Module contracts");
  }
  if (
    handshake.generation.pid !== descriptor.pid ||
    handshake.generation.start_nonce !== descriptor.start_nonce ||
    handshake.generation.profile_id !== descriptor.profile_id ||
    handshake.generation.manifest_digest !== descriptor.manifest_digest ||
    handshake.generation.artifact_sha256 !== descriptor.artifact.sha256 ||
    handshake.generation.store_epoch !== descriptor.store_epoch ||
    handshake.generation.readiness_generation !== descriptor.readiness_generation ||
    handshake.manifest_digest !== descriptor.manifest_digest ||
    handshake.artifact.sha256 !== descriptor.artifact.sha256 ||
    handshake.artifact.build_id !== descriptor.artifact.build_id ||
    handshake.actual_store_format.lineage !== descriptor.actual_store_format.lineage ||
    handshake.actual_store_format.version !== descriptor.actual_store_format.version ||
    handshake.actual_store_format.schema_fingerprint !==
      descriptor.actual_store_format.schema_fingerprint ||
    handshake.store_epoch !== descriptor.store_epoch ||
    handshake.schema_version !== descriptor.actual_store_format.version ||
    !handshake.library_id ||
    !handshake.connection_binding ||
    !Number.isSafeInteger(handshake.commit_head) ||
    handshake.commit_head < 0
  ) {
    throw new Error("Core handshake does not match the validated runtime descriptor");
  }
};
