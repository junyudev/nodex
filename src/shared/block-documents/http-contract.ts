import { parseCoreFailureEvidence } from "../core-failure-evidence";
import { isDocumentHistoryFence } from "./document-history-fence";
import {
  MAX_BLOCK_ID_LENGTH,
  MAX_PAGE_DOCUMENT_STATE_BYTES,
  MAX_PAGE_DOCUMENT_UPDATE_BYTES,
  MAX_DOCUMENT_TOUCHED_BLOCK_IDS,
  type DocumentReadiness,
  type OwnedDocumentDescriptor,
  type LibraryAccessedDocumentDescriptor,
} from "./contracts";
import type { ContentAccessContext } from "../content-access-context";
import {
  MAX_DOCUMENT_AWARENESS_UPDATE_BYTES,
  type DocumentAwarenessPublishRequest,
  type DocumentSyncApplyAck,
  type DocumentSyncApplyRequest,
  type DocumentSyncCommandError,
  type DocumentSyncRealtimeEvent,
  type DocumentSyncRequest,
  type DocumentSyncResponse,
} from "./document-sync";
import {
  MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
  type CanvasSceneSyncRequest,
  type CanvasSceneSyncResponse,
} from "./canvas-scene-sync";
import { canonicalStringifyCanvasScene, parsePortableCanvasScene } from "./canvas-scene";
import {
  decodeDocumentHttpEnvelope,
  documentBytesFromBase64,
  documentBytesToBase64,
  encodeDocumentHttpEnvelope,
  DocumentHttpWireError,
} from "./http-wire";
import { parseAuthorizedDeliveryPacket as parseAuthorizedDeliveryPacketValue } from "../authorized-delivery-packet";
import type { components } from "@nodex/core-protocol";
import { parseAuthorizedReadStamp } from "../authorized-read-stamp";

export const DOCUMENT_HTTP_CONTENT_TYPE = "application/vnd.nodex.document-sync.v3+octet-stream";
const DOCUMENT_SYNC_ERROR_CODES = new Set<DocumentSyncCommandError["code"]>([
  "transport_unavailable",
  "request_cancelled",
  "request_timeout",
  "service_busy",
  "unauthorized",
  "store_not_initialized",
  "store_epoch_mismatch",
  "document_not_found",
  "document_not_ready",
  "document_generation_mismatch",
  "unsupported_document_schema",
  "future_base_head",
  "invalid_document_update",
  "invalid_awareness_update",
  "document_update_missing_dependencies",
  "protected_owner_mutation",
  "update_id_collision",
  "block_relocated",
  "recovery_required",
  "document_state_corrupt",
  "invalid_response",
  "unknown",
]);

interface VersionedMetadata {
  readonly version: 3;
  readonly engine: "yjs";
}

interface SyncRequestMetadata extends VersionedMetadata {
  readonly clientSessionId: string;
  readonly historyAfterHeadSeq?: number;
}

interface SyncResponseMetadata extends VersionedMetadata {
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly stateVector: string;
  readonly historyFence?: DocumentSyncResponse["historyFence"];
}

interface ApplyRequestMetadata extends VersionedMetadata {
  readonly storeEpoch: string;
  readonly generation: number;
  readonly updateId: string;
  readonly clientSessionId: string;
  readonly baseHeadSeq: number;
  readonly touchedBlockIds: readonly string[];
}

interface ApplyAckMetadataBase extends VersionedMetadata {
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly updateId: string;
  readonly committedSeq: number;
  readonly headSeq: number;
  readonly duplicate: boolean;
}

type AuthorizedDeliveryPacket = components["schemas"]["AuthorizedDeliveryPacket"];
type CommitIdentity = components["schemas"]["CommitIdentity"];
type StoreObservation = components["schemas"]["StoreObservation"];

type ApplyAckMetadata = ApplyAckMetadataBase &
  (
    | {
        readonly status: "committed";
        readonly commit: CommitIdentity;
        readonly delivery?: AuthorizedDeliveryPacket;
      }
    | {
        readonly status: "no_op";
        readonly observed: StoreObservation;
      }
  );

interface AwarenessRequestMetadata extends VersionedMetadata {
  readonly clientSessionId: string;
  readonly storeEpoch: string;
  readonly generation: number;
}

interface EncodedRealtimeEvent {
  readonly version: 1;
  readonly kind: DocumentSyncRealtimeEvent["kind"];
  readonly documentId: string;
  readonly state?: "connected" | "disconnected";
  readonly storeEpoch?: string;
  readonly generation?: number;
  readonly headSeq?: number;
  readonly updateId?: string;
  readonly clientSessionId?: string;
  readonly update?: string;
  readonly reason?: string;
}

interface CanvasSyncRequestMetadata {
  readonly version: 3;
  readonly engine: "canvas_scene";
  readonly syncRequestId: string;
  readonly clientSessionId: string;
  readonly knownStoreEpoch?: string;
  readonly knownGeneration?: number;
  readonly knownHeadSeq?: number;
  readonly knownSceneHash?: string;
}

interface CanvasSyncResponseMetadata {
  readonly version: 3;
  readonly engine: "canvas_scene";
  readonly kind: "up_to_date" | "snapshot";
  readonly syncRequestId: string;
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly sceneHash: string;
}

type EncodedOwnedDocumentSyncEngine =
  | {
      readonly kind: "yjs";
      readonly stateVector: string;
    }
  | {
      readonly kind: "canvas_scene";
    };

interface EncodedOwnedDocumentDescriptor {
  readonly version: 3;
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly ownerBlockId: string;
  readonly ownerType: string;
  readonly ownerLifecycle: OwnedDocumentDescriptor["ownerLifecycle"];
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly readiness: DocumentReadiness;
  readonly authorization: OwnedDocumentDescriptor["authorization"];
  readonly sync: EncodedOwnedDocumentSyncEngine;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new DocumentHttpWireError("Document HTTP metadata must be an object");
};

const assertExactKeys = (
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void => {
  const expectedKeys = new Set(expected);
  if (
    Object.keys(record).length === expectedKeys.size &&
    Object.keys(record).every((key) => expectedKeys.has(key))
  ) {
    return;
  }
  throw new DocumentHttpWireError(`${label} has unsupported fields`);
};

const readWireVersion = (record: Readonly<Record<string, unknown>>): 3 => {
  if (record.version === 3) return 3;
  throw new DocumentHttpWireError("Unsupported Document HTTP contract version");
};

const readEventVersion = (record: Readonly<Record<string, unknown>>): 1 => {
  if (record.version === 1) return 1;
  throw new DocumentHttpWireError("Unsupported Document event contract version");
};

const readString = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  if (typeof value === "string" && value.length > 0 && value === value.trim()) {
    return value;
  }
  throw new DocumentHttpWireError(`${key} must be a non-empty string`);
};

const readOptionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  if (record[key] === undefined) return undefined;
  return readString(record, key);
};

const readInteger = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
): number => {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum) {
    return value;
  }
  throw new DocumentHttpWireError(`${key} must be an integer >= ${minimum}`);
};

const readOptionalInteger = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
): number | undefined => {
  if (record[key] === undefined) return undefined;
  return readInteger(record, key, minimum);
};

const readHash = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
  throw new DocumentHttpWireError(`${key} must be a lowercase SHA-256 hash`);
};

const readOptionalHash = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  if (record[key] === undefined) return undefined;
  return readHash(record, key);
};

const readBoolean = (record: Readonly<Record<string, unknown>>, key: string): boolean => {
  const value = record[key];
  if (typeof value === "boolean") return value;
  throw new DocumentHttpWireError(`${key} must be a boolean`);
};

const readEnum = <Value extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  values: readonly Value[],
): Value => {
  const value = record[key];
  if (typeof value === "string" && values.includes(value as Value)) {
    return value as Value;
  }
  throw new DocumentHttpWireError(`${key} has an unsupported value`);
};

const readTouchedBlockIds = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const value = record.touchedBlockIds;
  if (!Array.isArray(value) || value.length > MAX_DOCUMENT_TOUCHED_BLOCK_IDS) {
    throw new DocumentHttpWireError("touchedBlockIds is invalid or too large");
  }
  const ids = value.map((entry) => {
    if (
      typeof entry === "string" &&
      entry.length > 0 &&
      entry.length <= MAX_BLOCK_ID_LENGTH &&
      entry === entry.trim()
    ) {
      return entry;
    }
    throw new DocumentHttpWireError("touchedBlockIds contains an invalid ID");
  });
  if (new Set(ids).size !== ids.length) {
    throw new DocumentHttpWireError("touchedBlockIds contains a duplicate ID");
  }
  return ids;
};

const assertRouteDocument = (routeDocumentId: string): string => {
  if (routeDocumentId.length > 0 && routeDocumentId === routeDocumentId.trim()) {
    return routeDocumentId;
  }
  throw new DocumentHttpWireError("route documentId must be non-empty");
};

const parseSyncRequestMetadata = (value: unknown): SyncRequestMetadata => {
  const record = readRecord(value);
  assertExactKeys(
    record,
    [
      "version",
      "engine",
      "clientSessionId",
      ...(record.historyAfterHeadSeq === undefined ? [] : ["historyAfterHeadSeq"]),
    ],
    "Yjs sync request",
  );
  if (record.engine !== "yjs") {
    throw new DocumentHttpWireError("Yjs sync request has the wrong engine");
  }
  return {
    version: readWireVersion(record),
    engine: "yjs",
    clientSessionId: readString(record, "clientSessionId"),
    ...(record.historyAfterHeadSeq === undefined
      ? {}
      : {
          historyAfterHeadSeq: readInteger(record, "historyAfterHeadSeq", 0),
        }),
  };
};

const parseSyncResponseMetadata = (value: unknown): SyncResponseMetadata => {
  const record = readRecord(value);
  assertExactKeys(
    record,
    [
      "version",
      "engine",
      "documentId",
      "storeEpoch",
      "generation",
      "headSeq",
      "stateVector",
      ...(record.historyFence === undefined ? [] : ["historyFence"]),
    ],
    "Yjs sync response",
  );
  if (record.engine !== "yjs") {
    throw new DocumentHttpWireError("Yjs sync response has the wrong engine");
  }
  return {
    version: readWireVersion(record),
    engine: "yjs",
    documentId: readString(record, "documentId"),
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
    headSeq: readInteger(record, "headSeq", 0),
    stateVector: readString(record, "stateVector"),
    ...(record.historyFence === undefined
      ? {}
      : {
          historyFence: parseHistoryFence(record.historyFence, readInteger(record, "headSeq", 0)),
        }),
  };
};

const parseHistoryFence = (
  value: unknown,
  headSeq: number,
): NonNullable<DocumentSyncResponse["historyFence"]> => {
  if (!isDocumentHistoryFence(value, headSeq)) {
    throw new DocumentHttpWireError("History fence is invalid or exceeds its bound");
  }
  return value;
};

const parseApplyRequestMetadata = (value: unknown): ApplyRequestMetadata => {
  const record = readRecord(value);
  if (record.engine !== "yjs") {
    throw new DocumentHttpWireError("Yjs update request has the wrong engine");
  }
  return {
    version: readWireVersion(record),
    engine: "yjs",
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
    updateId: readString(record, "updateId"),
    clientSessionId: readString(record, "clientSessionId"),
    baseHeadSeq: readInteger(record, "baseHeadSeq", 0),
    touchedBlockIds: readTouchedBlockIds(record),
  };
};

const parseApplyAckMetadata = (value: unknown): ApplyAckMetadata => {
  const record = readRecord(value);
  if (record.engine !== "yjs") {
    throw new DocumentHttpWireError("Yjs update ACK has the wrong engine");
  }
  const common: ApplyAckMetadataBase = {
    version: readWireVersion(record),
    engine: "yjs",
    documentId: readString(record, "documentId"),
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
    updateId: readString(record, "updateId"),
    committedSeq: readInteger(record, "committedSeq", 1),
    headSeq: readInteger(record, "headSeq", 1),
    duplicate: readBoolean(record, "duplicate"),
  };
  if (record.status === "committed") {
    return {
      ...common,
      status: "committed",
      commit: parseCommitIdentity(record.commit),
      ...(record.delivery === undefined
        ? {}
        : { delivery: parseAuthorizedDeliveryPacket(record.delivery) }),
    };
  }
  if (record.status === "no_op") {
    return {
      ...common,
      status: "no_op",
      observed: parseStoreObservation(record.observed),
    };
  }
  throw new DocumentHttpWireError("Yjs update ACK has an invalid status");
};

const parseCommitIdentity = (value: unknown): CommitIdentity => {
  const record = readRecord(value);
  assertExactKeys(
    record,
    ["store_epoch", "commit_seq", "manifest_hash"],
    "Document update commit identity",
  );
  return {
    store_epoch: readString(record, "store_epoch"),
    commit_seq: readInteger(record, "commit_seq", 1),
    manifest_hash: readHash(record, "manifest_hash"),
  };
};

const parseStoreObservation = (value: unknown): StoreObservation => {
  const record = readRecord(value);
  assertExactKeys(record, ["store_epoch", "commit_head"], "Document update store observation");
  return {
    store_epoch: readString(record, "store_epoch"),
    commit_head: readInteger(record, "commit_head", 0),
  };
};

const parseAuthorizedDeliveryPacket = (value: unknown): AuthorizedDeliveryPacket => {
  try {
    return parseAuthorizedDeliveryPacketValue(value);
  } catch {
    throw new DocumentHttpWireError("Document update ACK delivery is invalid");
  }
};

const parseAwarenessRequestMetadata = (value: unknown): AwarenessRequestMetadata => {
  const record = readRecord(value);
  if (record.engine !== "yjs") {
    throw new DocumentHttpWireError("Yjs Awareness request has the wrong engine");
  }
  return {
    version: readWireVersion(record),
    engine: "yjs",
    clientSessionId: readString(record, "clientSessionId"),
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
  };
};

const parseCanvasSyncRequestMetadata = (value: unknown): CanvasSyncRequestMetadata => {
  const record = readRecord(value);
  const allowed = [
    "version",
    "engine",
    "syncRequestId",
    "clientSessionId",
    "knownStoreEpoch",
    "knownGeneration",
    "knownHeadSeq",
    "knownSceneHash",
  ];
  const present = allowed.filter((key) => record[key] !== undefined);
  assertExactKeys(record, present, "Canvas sync request");
  if (record.engine !== "canvas_scene") {
    throw new DocumentHttpWireError("Canvas sync request has the wrong engine");
  }
  const knownStoreEpoch = readOptionalString(record, "knownStoreEpoch");
  const knownGeneration = readOptionalInteger(record, "knownGeneration", 1);
  const knownHeadSeq = readOptionalInteger(record, "knownHeadSeq", 0);
  const knownSceneHash = readOptionalHash(record, "knownSceneHash");
  return {
    version: readWireVersion(record),
    engine: "canvas_scene",
    syncRequestId: readString(record, "syncRequestId"),
    clientSessionId: readString(record, "clientSessionId"),
    ...(knownStoreEpoch === undefined ? {} : { knownStoreEpoch }),
    ...(knownGeneration === undefined ? {} : { knownGeneration }),
    ...(knownHeadSeq === undefined ? {} : { knownHeadSeq }),
    ...(knownSceneHash === undefined ? {} : { knownSceneHash }),
  };
};

const parseCanvasSyncResponseMetadata = (value: unknown): CanvasSyncResponseMetadata => {
  const record = readRecord(value);
  if (record.engine !== "canvas_scene") {
    throw new DocumentHttpWireError("Canvas sync response has the wrong engine");
  }
  assertExactKeys(
    record,
    [
      "version",
      "engine",
      "kind",
      "syncRequestId",
      "libraryId",
      "accessContext",
      "documentId",
      "storeEpoch",
      "generation",
      "headSeq",
      "sceneHash",
    ],
    "Canvas sync response",
  );
  return {
    version: readWireVersion(record),
    engine: "canvas_scene",
    kind: readEnum(record, "kind", ["up_to_date", "snapshot"] as const),
    syncRequestId: readString(record, "syncRequestId"),
    libraryId: readString(record, "libraryId"),
    accessContext: parseOwnedDocumentAccessContext(record.accessContext),
    documentId: readString(record, "documentId"),
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
    headSeq: readInteger(record, "headSeq", 0),
    sceneHash: readHash(record, "sceneHash"),
  };
};

const parseOwnedDocumentSyncEngine = (value: unknown): EncodedOwnedDocumentSyncEngine => {
  const record = readRecord(value);
  const kind = readEnum(record, "kind", ["yjs", "canvas_scene"] as const);
  if (kind === "canvas_scene") {
    assertExactKeys(record, ["kind"], "Canvas scene sync descriptor");
    return { kind };
  }
  assertExactKeys(record, ["kind", "stateVector"], "Yjs sync descriptor");
  const stateVector = record.stateVector;
  if (typeof stateVector !== "string") {
    throw new DocumentHttpWireError("stateVector must be base64 text");
  }
  return { kind, stateVector };
};

const parseOwnedDocumentAccessContext = (value: unknown): ContentAccessContext => {
  const record = readRecord(value);
  if (record.kind === "library") {
    assertExactKeys(record, ["kind"], "Owned Document access context");
    return { kind: "library" };
  }
  if (record.kind === "project") {
    assertExactKeys(record, ["kind", "projectId"], "Owned Document access context");
    return { kind: "project", projectId: readString(record, "projectId") };
  }
  throw new DocumentHttpWireError("Owned Document access context has an unsupported kind");
};

const parseOwnedDocumentDescriptor = (value: unknown): EncodedOwnedDocumentDescriptor => {
  const record = readRecord(value);
  assertExactKeys(
    record,
    [
      "version",
      "libraryId",
      "accessContext",
      "ownerBlockId",
      "ownerType",
      "ownerLifecycle",
      "documentId",
      "storeEpoch",
      "generation",
      "headSeq",
      "schemaKey",
      "schemaVersion",
      "readiness",
      "authorization",
      "sync",
    ],
    "Owned Document descriptor",
  );
  if (record.version !== 3) {
    throw new DocumentHttpWireError("Unsupported Owned Document descriptor version");
  }
  return {
    version: 3,
    libraryId: readString(record, "libraryId"),
    accessContext: parseOwnedDocumentAccessContext(record.accessContext),
    ownerBlockId: readString(record, "ownerBlockId"),
    ownerType: readString(record, "ownerType"),
    ownerLifecycle: readEnum(record, "ownerLifecycle", ["active", "archived", "deleted"] as const),
    documentId: readString(record, "documentId"),
    storeEpoch: readString(record, "storeEpoch"),
    generation: readInteger(record, "generation", 1),
    headSeq: readInteger(record, "headSeq", 0),
    schemaKey: readString(record, "schemaKey"),
    schemaVersion: readInteger(record, "schemaVersion", 1),
    readiness: readEnum(record, "readiness", ["pending_genesis", "ready", "failed"] as const),
    authorization:
      record.authorization === null ? null : parseAuthorizedReadStamp(record.authorization),
    sync: parseOwnedDocumentSyncEngine(record.sync),
  };
};

export const encodeOwnedDocumentDescriptorHttp = (descriptor: OwnedDocumentDescriptor): string => {
  const sync: EncodedOwnedDocumentSyncEngine =
    descriptor.sync.kind === "yjs"
      ? {
          kind: "yjs",
          stateVector: documentBytesToBase64(descriptor.sync.stateVector),
        }
      : { kind: "canvas_scene" };
  return JSON.stringify({
    version: 3,
    libraryId: descriptor.libraryId,
    accessContext: descriptor.accessContext,
    ownerBlockId: descriptor.ownerBlockId,
    ownerType: descriptor.ownerType,
    ownerLifecycle: descriptor.ownerLifecycle,
    documentId: descriptor.documentId,
    storeEpoch: descriptor.storeEpoch,
    generation: descriptor.generation,
    headSeq: descriptor.headSeq,
    schemaKey: descriptor.schemaKey,
    schemaVersion: descriptor.schemaVersion,
    readiness: descriptor.readiness,
    authorization: descriptor.authorization ?? null,
    sync,
  } satisfies EncodedOwnedDocumentDescriptor);
};

export const decodeOwnedDocumentDescriptorHttp = (serialized: string): OwnedDocumentDescriptor => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new DocumentHttpWireError("Owned Document descriptor is not valid JSON", {
      cause: error,
    });
  }
  const descriptor = parseOwnedDocumentDescriptor(decoded);
  const sync =
    descriptor.sync.kind === "yjs"
      ? {
          kind: "yjs" as const,
          stateVector: documentBytesFromBase64(
            descriptor.sync.stateVector,
            MAX_PAGE_DOCUMENT_STATE_BYTES,
          ),
        }
      : { kind: "canvas_scene" as const };
  return {
    libraryId: descriptor.libraryId,
    accessContext: descriptor.accessContext,
    ownerBlockId: descriptor.ownerBlockId,
    ownerType: descriptor.ownerType,
    ownerLifecycle: descriptor.ownerLifecycle,
    documentId: descriptor.documentId,
    storeEpoch: descriptor.storeEpoch,
    generation: descriptor.generation,
    headSeq: descriptor.headSeq,
    schemaKey: descriptor.schemaKey,
    schemaVersion: descriptor.schemaVersion,
    readiness: descriptor.readiness,
    authorization: descriptor.authorization ?? null,
    sync,
  };
};

export const encodeLibraryAccessedDocumentDescriptorHttp = (
  descriptor: LibraryAccessedDocumentDescriptor,
): string => encodeOwnedDocumentDescriptorHttp(descriptor);

export const decodeLibraryAccessedDocumentDescriptorHttp = (
  serialized: string,
): LibraryAccessedDocumentDescriptor => {
  const descriptor = decodeOwnedDocumentDescriptorHttp(serialized);
  if (descriptor.accessContext.kind !== "library") {
    throw new DocumentHttpWireError("Library-accessed Document context must be library");
  }
  return { ...descriptor, accessContext: descriptor.accessContext };
};

export const encodeDocumentSyncHttpRequest = (request: DocumentSyncRequest): Uint8Array =>
  encodeDocumentHttpEnvelope<SyncRequestMetadata>(
    {
      version: 3,
      engine: "yjs",
      clientSessionId: request.clientSessionId,
      ...(request.historyAfterHeadSeq === undefined
        ? {}
        : { historyAfterHeadSeq: request.historyAfterHeadSeq }),
    },
    request.stateVector,
  );

export const decodeDocumentSyncHttpRequest = (
  routeDocumentId: string,
  bytes: Uint8Array,
): DocumentSyncRequest => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseSyncRequestMetadata,
    MAX_PAGE_DOCUMENT_STATE_BYTES,
  );
  return {
    documentId: assertRouteDocument(routeDocumentId),
    clientSessionId: envelope.metadata.clientSessionId,
    stateVector: envelope.payload,
    ...(envelope.metadata.historyAfterHeadSeq === undefined
      ? {}
      : { historyAfterHeadSeq: envelope.metadata.historyAfterHeadSeq }),
  };
};

export const encodeDocumentSyncHttpResponse = (response: DocumentSyncResponse): Uint8Array =>
  encodeDocumentHttpEnvelope<SyncResponseMetadata>(
    {
      version: 3,
      engine: "yjs",
      documentId: response.documentId,
      storeEpoch: response.storeEpoch,
      generation: response.generation,
      headSeq: response.headSeq,
      stateVector: documentBytesToBase64(response.stateVector),
      ...(response.historyFence ? { historyFence: response.historyFence } : {}),
    },
    response.update,
  );

export const decodeDocumentSyncHttpResponse = (bytes: Uint8Array): DocumentSyncResponse => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseSyncResponseMetadata,
    MAX_PAGE_DOCUMENT_STATE_BYTES,
  );
  return {
    documentId: envelope.metadata.documentId,
    storeEpoch: envelope.metadata.storeEpoch,
    generation: envelope.metadata.generation,
    headSeq: envelope.metadata.headSeq,
    stateVector: documentBytesFromBase64(
      envelope.metadata.stateVector,
      MAX_PAGE_DOCUMENT_STATE_BYTES,
    ),
    update: envelope.payload,
    ...(envelope.metadata.historyFence ? { historyFence: envelope.metadata.historyFence } : {}),
  };
};

export const encodeCanvasSceneSyncHttpRequest = (request: CanvasSceneSyncRequest): Uint8Array =>
  encodeDocumentHttpEnvelope<CanvasSyncRequestMetadata>(
    {
      version: 3,
      engine: "canvas_scene",
      syncRequestId: request.syncRequestId,
      clientSessionId: request.clientSessionId,
      ...(request.knownStoreEpoch === undefined
        ? {}
        : { knownStoreEpoch: request.knownStoreEpoch }),
      ...(request.knownGeneration === undefined
        ? {}
        : { knownGeneration: request.knownGeneration }),
      ...(request.knownHeadSeq === undefined ? {} : { knownHeadSeq: request.knownHeadSeq }),
      ...(request.knownSceneHash === undefined ? {} : { knownSceneHash: request.knownSceneHash }),
    },
    new Uint8Array(),
  );

export const decodeCanvasSceneSyncHttpRequest = (
  routeDocumentId: string,
  accessContext: ContentAccessContext,
  bytes: Uint8Array,
): CanvasSceneSyncRequest => {
  const envelope = decodeDocumentHttpEnvelope(bytes, parseCanvasSyncRequestMetadata, 0);
  return {
    syncRequestId: envelope.metadata.syncRequestId,
    accessContext,
    documentId: assertRouteDocument(routeDocumentId),
    clientSessionId: envelope.metadata.clientSessionId,
    ...(envelope.metadata.knownStoreEpoch === undefined
      ? {}
      : { knownStoreEpoch: envelope.metadata.knownStoreEpoch }),
    ...(envelope.metadata.knownGeneration === undefined
      ? {}
      : { knownGeneration: envelope.metadata.knownGeneration }),
    ...(envelope.metadata.knownHeadSeq === undefined
      ? {}
      : { knownHeadSeq: envelope.metadata.knownHeadSeq }),
    ...(envelope.metadata.knownSceneHash === undefined
      ? {}
      : { knownSceneHash: envelope.metadata.knownSceneHash }),
  };
};

export const encodeCanvasSceneSyncHttpResponse = (
  response: CanvasSceneSyncResponse,
): Uint8Array => {
  const payload =
    response.kind === "snapshot"
      ? new TextEncoder().encode(canonicalStringifyCanvasScene(response.scene))
      : new Uint8Array();
  if (payload.byteLength > MAX_CANVAS_SCENE_SNAPSHOT_BYTES) {
    throw new DocumentHttpWireError(
      `Canvas snapshot exceeds ${MAX_CANVAS_SCENE_SNAPSHOT_BYTES} bytes`,
    );
  }
  return encodeDocumentHttpEnvelope<CanvasSyncResponseMetadata>(
    {
      version: 3,
      engine: "canvas_scene",
      kind: response.kind,
      syncRequestId: response.syncRequestId,
      libraryId: response.libraryId,
      accessContext: response.accessContext,
      documentId: response.documentId,
      storeEpoch: response.storeEpoch,
      generation: response.generation,
      headSeq: response.headSeq,
      sceneHash: response.sceneHash,
    },
    payload,
  );
};

export const decodeCanvasSceneSyncHttpResponse = (bytes: Uint8Array): CanvasSceneSyncResponse => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseCanvasSyncResponseMetadata,
    MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
  );
  const common = {
    syncRequestId: envelope.metadata.syncRequestId,
    libraryId: envelope.metadata.libraryId,
    accessContext: envelope.metadata.accessContext,
    documentId: envelope.metadata.documentId,
    storeEpoch: envelope.metadata.storeEpoch,
    generation: envelope.metadata.generation,
    headSeq: envelope.metadata.headSeq,
    sceneHash: envelope.metadata.sceneHash,
  };
  if (envelope.metadata.kind === "up_to_date") {
    if (envelope.payload.byteLength !== 0) {
      throw new DocumentHttpWireError("Canvas up-to-date response must have an empty payload");
    }
    return { kind: "up_to_date", ...common };
  }
  if (envelope.payload.byteLength === 0) {
    throw new DocumentHttpWireError("Canvas snapshot response must have a payload");
  }
  let parsed: unknown;
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(envelope.payload);
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new DocumentHttpWireError("Canvas snapshot payload is not valid UTF-8 JSON", {
      cause: error,
    });
  }
  const scene = parsePortableCanvasScene(parsed);
  return { kind: "snapshot", ...common, scene };
};

export const encodeDocumentApplyHttpRequest = (request: DocumentSyncApplyRequest): Uint8Array =>
  encodeDocumentHttpEnvelope<ApplyRequestMetadata>(
    {
      version: 3,
      engine: "yjs",
      storeEpoch: request.storeEpoch,
      generation: request.generation,
      updateId: request.updateId,
      clientSessionId: request.clientSessionId,
      baseHeadSeq: request.baseHeadSeq,
      touchedBlockIds: request.touchedBlockIds,
    },
    request.update,
  );

export const decodeDocumentApplyHttpRequest = (
  routeDocumentId: string,
  bytes: Uint8Array,
): DocumentSyncApplyRequest => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseApplyRequestMetadata,
    MAX_PAGE_DOCUMENT_UPDATE_BYTES,
  );
  return {
    documentId: assertRouteDocument(routeDocumentId),
    storeEpoch: envelope.metadata.storeEpoch,
    generation: envelope.metadata.generation,
    updateId: envelope.metadata.updateId,
    clientSessionId: envelope.metadata.clientSessionId,
    baseHeadSeq: envelope.metadata.baseHeadSeq,
    touchedBlockIds: envelope.metadata.touchedBlockIds,
    update: envelope.payload,
  };
};

export const encodeDocumentApplyHttpAck = (ack: DocumentSyncApplyAck): Uint8Array =>
  encodeDocumentHttpEnvelope<ApplyAckMetadata>(
    {
      version: 3,
      engine: "yjs",
      documentId: ack.documentId,
      storeEpoch: ack.storeEpoch,
      generation: ack.generation,
      updateId: ack.updateId,
      committedSeq: ack.committedSeq,
      headSeq: ack.headSeq,
      duplicate: ack.duplicate,
      ...(ack.status === "committed"
        ? {
            status: "committed" as const,
            commit: ack.commit,
            ...(ack.delivery ? { delivery: ack.delivery } : {}),
          }
        : { status: "no_op" as const, observed: ack.observed }),
    },
    ack.stateVector,
  );

export const decodeDocumentApplyHttpAck = (bytes: Uint8Array): DocumentSyncApplyAck => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseApplyAckMetadata,
    MAX_PAGE_DOCUMENT_STATE_BYTES,
  );
  const common = {
    documentId: envelope.metadata.documentId,
    storeEpoch: envelope.metadata.storeEpoch,
    generation: envelope.metadata.generation,
    updateId: envelope.metadata.updateId,
    committedSeq: envelope.metadata.committedSeq,
    headSeq: envelope.metadata.headSeq,
    stateVector: envelope.payload,
    duplicate: envelope.metadata.duplicate,
  };
  return envelope.metadata.status === "committed"
    ? {
        ...common,
        status: "committed",
        commit: envelope.metadata.commit,
        ...(envelope.metadata.delivery ? { delivery: envelope.metadata.delivery } : {}),
      }
    : {
        ...common,
        status: "no_op",
        observed: envelope.metadata.observed,
      };
};

export const encodeDocumentAwarenessHttpRequest = (
  request: DocumentAwarenessPublishRequest,
): Uint8Array =>
  encodeDocumentHttpEnvelope<AwarenessRequestMetadata>(
    {
      version: 3,
      engine: "yjs",
      clientSessionId: request.clientSessionId,
      storeEpoch: request.storeEpoch,
      generation: request.generation,
    },
    request.update,
  );

export const decodeDocumentAwarenessHttpRequest = (
  routeDocumentId: string,
  bytes: Uint8Array,
): DocumentAwarenessPublishRequest => {
  const envelope = decodeDocumentHttpEnvelope(
    bytes,
    parseAwarenessRequestMetadata,
    MAX_DOCUMENT_AWARENESS_UPDATE_BYTES,
  );
  return {
    documentId: assertRouteDocument(routeDocumentId),
    clientSessionId: envelope.metadata.clientSessionId,
    storeEpoch: envelope.metadata.storeEpoch,
    generation: envelope.metadata.generation,
    update: envelope.payload,
  };
};

export const encodeDocumentRealtimeSseEvent = (event: DocumentSyncRealtimeEvent): string => {
  const encoded: EncodedRealtimeEvent =
    event.kind === "connection"
      ? { version: 1, ...event }
      : event.kind === "document-update" || event.kind === "awareness"
        ? {
            version: 1,
            ...event,
            update: documentBytesToBase64(event.update),
          }
        : { version: 1, ...event };
  return JSON.stringify(encoded);
};

export const decodeDocumentRealtimeSseEvent = (serialized: string): DocumentSyncRealtimeEvent => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new DocumentHttpWireError("Document SSE event is invalid JSON", {
      cause: error,
    });
  }
  const record = readRecord(value);
  readEventVersion(record);
  const kind = readString(record, "kind");
  const documentId = readString(record, "documentId");
  if (kind === "terminated") {
    return {
      kind,
      documentId,
      clientSessionId: readString(record, "clientSessionId"),
      error: decodeDocumentHttpError(JSON.stringify({ ok: false, error: record.error })),
    };
  }
  if (kind === "connection") {
    const state = readString(record, "state");
    if (state !== "connected" && state !== "disconnected") {
      throw new DocumentHttpWireError("Document connection state is invalid");
    }
    return {
      kind,
      documentId,
      clientSessionId: readString(record, "clientSessionId"),
      state,
    };
  }
  const storeEpoch = readString(record, "storeEpoch");
  if (kind === "store-reset") {
    return { kind, documentId, storeEpoch };
  }
  const generation = readInteger(record, "generation", 1);
  if (kind === "awareness") {
    return {
      kind,
      documentId,
      storeEpoch,
      generation,
      clientSessionId: readString(record, "clientSessionId"),
      update: documentBytesFromBase64(
        readString(record, "update"),
        MAX_DOCUMENT_AWARENESS_UPDATE_BYTES,
      ),
    };
  }
  const headSeq = readInteger(record, "headSeq", 0);
  if (kind === "document-update") {
    return {
      kind,
      documentId,
      storeEpoch,
      generation,
      headSeq,
      updateId: readString(record, "updateId"),
      clientSessionId: readString(record, "clientSessionId"),
      update: documentBytesFromBase64(readString(record, "update"), MAX_PAGE_DOCUMENT_UPDATE_BYTES),
    };
  }
  if (kind === "resync-required") {
    const reason = readString(record, "reason");
    if (
      reason !== "event-gap" &&
      reason !== "history-compacted" &&
      reason !== "transport-reconnected" &&
      reason !== "resource-integrity-failure" &&
      reason !== "identity-boundary-changed" &&
      reason !== "access-revoked"
    ) {
      throw new DocumentHttpWireError("Document resync reason is invalid");
    }
    return {
      kind,
      documentId,
      storeEpoch,
      generation,
      headSeq,
      reason,
    };
  }
  throw new DocumentHttpWireError(`Unsupported Document SSE event kind: ${kind}`);
};

export const encodeDocumentHttpError = (error: DocumentSyncCommandError): string =>
  JSON.stringify({ ok: false, error });

export const decodeDocumentHttpError = (serialized: string): DocumentSyncCommandError => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new DocumentHttpWireError("Document HTTP error is invalid JSON", {
      cause: error,
    });
  }
  const root = readRecord(value);
  const error = readRecord(root.error);
  const code = readString(error, "code") as DocumentSyncCommandError["code"];
  if (!DOCUMENT_SYNC_ERROR_CODES.has(code)) {
    throw new DocumentHttpWireError("Document HTTP error code is invalid");
  }
  const relocationId = readOptionalString(error, "relocationId");
  const recoveryArtifactId = readOptionalString(error, "recoveryArtifactId");
  return {
    ...(error.core === undefined ? {} : { core: parseCoreFailureEvidence(error.core) }),
    code,
    message: readString(error, "message"),
    retryable: readBoolean(error, "retryable"),
    resetRequired: readBoolean(error, "resetRequired"),
    ...(relocationId ? { relocationId } : {}),
    ...(recoveryArtifactId ? { recoveryArtifactId } : {}),
  };
};
