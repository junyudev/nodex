import { parseCoreFailureEvidence } from "../core-failure-evidence";
import {
  MAX_CANVAS_SCENE_MUTATION_BYTES,
  MAX_CANVAS_SCENE_SNAPSHOT_BYTES,
  canonicalizeCanvasSceneMutationRequest,
  canonicalizeCanvasSceneMutationResult,
  type CanvasSceneMutationCommandResult,
  type CanvasSceneMutationError,
  type CanvasSceneMutationRequest,
  type CanvasSceneRealtimeEvent,
  type CanvasSceneSyncCommandResult,
  type CanvasSceneSyncRequest,
} from "./canvas-scene-sync";
import { parseLocalCommitApply } from "../local-commit-delivery";
import {
  contentAccessContextKey,
  parseContentAccessContext,
  type ContentAccessContext,
} from "../content-access-context";
import {
  canonicalizeCanvasSceneElement,
  canonicalizeCanvasSceneFile,
  parsePortableCanvasScene,
  pickPortableCanvasSceneAppState,
  requireCanvasSceneIdentity,
} from "./canvas-scene";

export const CANVAS_SCENE_HTTP_CONTENT_TYPE = "application/vnd.nodex.canvas-scene.v1+json";
export const MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES = MAX_CANVAS_SCENE_SNAPSHOT_BYTES + 64 * 1024;

const encoder = new TextEncoder();

const parseBoundedJson = (serialized: string, maxBytes: number): unknown => {
  if (encoder.encode(serialized).byteLength > maxBytes) {
    throw new TypeError(`Canvas scene JSON exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new TypeError("Canvas scene JSON is invalid", { cause: error });
  }
};

const encodeBoundedJson = (value: unknown, maxBytes: number): string => {
  const serialized = JSON.stringify(value);
  if (encoder.encode(serialized).byteLength <= maxBytes) return serialized;
  throw new TypeError(`Canvas scene JSON exceeds ${maxBytes} bytes`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireInteger = (value: unknown, field: string, minimum = 0): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
    return value;
  }
  throw new TypeError(`${field} is invalid`);
};

const requireHash = (value: unknown, field: string): string => {
  if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
  throw new TypeError(`${field} is invalid`);
};

const requireStringArray = (value: unknown, field: string): readonly string[] => {
  if (Array.isArray(value)) {
    return value.map((entry, index) => requireCanvasSceneIdentity(entry, `${field}[${index}]`));
  }
  throw new TypeError(`${field} is invalid`);
};

export const requireCanvasSceneError = (value: unknown): CanvasSceneMutationError => {
  if (!isRecord(value)) throw new TypeError("Canvas scene error is invalid");
  const codes = new Set([
    "transport_unavailable",
    "request_cancelled",
    "request_timeout",
    "service_busy",
    "invalid_response",
    "invalid_canvas_scene_mutation",
    "store_epoch_mismatch",
    "access_scope_mismatch",
    "document_not_found",
    "document_not_ready",
    "document_engine_mismatch",
    "document_generation_mismatch",
    "future_base_head",
    "mutation_id_collision",
    "canvas_scene_corrupt",
    "unknown",
  ]);
  if (
    typeof value.code !== "string" ||
    !codes.has(value.code) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    typeof value.resetRequired !== "boolean"
  )
    throw new TypeError("Canvas scene error is invalid");
  return {
    ...(value.core === undefined ? {} : { core: parseCoreFailureEvidence(value.core) }),
    code: value.code as CanvasSceneMutationError["code"],
    message: value.message,
    retryable: value.retryable,
    resetRequired: value.resetRequired,
    ...(value.mutationId === undefined
      ? {}
      : {
          mutationId: requireCanvasSceneIdentity(value.mutationId, "mutationId"),
        }),
  };
};

export const parseCanvasSceneRealtimeEvent = (value: unknown): CanvasSceneRealtimeEvent => {
  if (!isRecord(value)) {
    throw new TypeError("Canvas scene realtime event is invalid");
  }
  const identity = {
    libraryId: requireCanvasSceneIdentity(value.libraryId, "libraryId"),
    accessContext: parseContentAccessContext(value.accessContext),
    documentId: requireCanvasSceneIdentity(value.documentId, "documentId"),
  };
  if (value.type === "canvas_scene_session") {
    const session = {
      ...identity,
      type: value.type,
      clientSessionId: requireCanvasSceneIdentity(value.clientSessionId, "clientSessionId"),
    } as const;
    if (value.state === "terminated")
      return { ...session, state: value.state, error: requireCanvasSceneError(value.error) };
    if (value.state === "connected" || value.state === "disconnected")
      return { ...session, state: value.state };
    throw new TypeError("Canvas scene session state is invalid");
  }
  const common = {
    ...identity,
    storeEpoch: requireCanvasSceneIdentity(value.storeEpoch, "storeEpoch"),
    generation: requireInteger(value.generation, "generation", 1),
    headSeq: requireInteger(value.headSeq, "headSeq"),
  };
  if (value.type === "canvas_scene_resync_required") {
    return { type: value.type, ...common };
  }
  if (
    value.type !== "canvas_scene_committed" ||
    !Array.isArray(value.elementUpdates) ||
    !isRecord(value.fileAdditions)
  ) {
    throw new TypeError("Canvas scene realtime event is invalid");
  }
  return {
    type: value.type,
    ...common,
    mutationId: requireCanvasSceneIdentity(value.mutationId, "mutationId"),
    baseHeadSeq: requireInteger(value.baseHeadSeq, "baseHeadSeq"),
    sceneHash: requireHash(value.sceneHash, "sceneHash"),
    elementUpdates: value.elementUpdates.map((element) => canonicalizeCanvasSceneElement(element)),
    appState: pickPortableCanvasSceneAppState(value.appState as Readonly<Record<string, unknown>>),
    fileAdditions: Object.fromEntries(
      Object.entries(value.fileAdditions).map(([fileId, file]) => [
        fileId,
        canonicalizeCanvasSceneFile(file, fileId),
      ]),
    ),
    removedFileIds: requireStringArray(value.removedFileIds, "removedFileIds"),
  };
};

const requireResultEnvelope = <T>(value: unknown, label: string): T => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError(`${label} is not a command result`);
  }
  if (value.ok && isRecord(value.value)) return value as T;
  if (!value.ok && isRecord(value.error)) return value as T;
  throw new TypeError(`${label} has an invalid result envelope`);
};

export const encodeCanvasSceneSyncRequestHttp = (request: CanvasSceneSyncRequest): string =>
  encodeBoundedJson(request, MAX_CANVAS_SCENE_MUTATION_BYTES);

export const decodeCanvasSceneSyncRequestHttp = (
  serialized: string,
  routeAccessContext: ContentAccessContext,
  routeDocumentId: string,
): CanvasSceneSyncRequest => {
  const value = parseBoundedJson(serialized, MAX_CANVAS_SCENE_MUTATION_BYTES);
  if (!isRecord(value)) {
    throw new TypeError("Canvas scene sync request is invalid");
  }
  const accessContext = parseContentAccessContext(value.accessContext);
  const documentId = requireCanvasSceneIdentity(value.documentId, "documentId");
  if (
    contentAccessContextKey(accessContext) !== contentAccessContextKey(routeAccessContext) ||
    documentId !== routeDocumentId
  ) {
    throw new TypeError("Canvas scene sync request does not match its route");
  }
  const clientSessionId = requireCanvasSceneIdentity(value.clientSessionId, "clientSessionId");
  const optionalInteger = (field: string, minimum: number): number | undefined => {
    const candidate = value[field];
    if (candidate === undefined) return undefined;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= minimum) {
      return candidate;
    }
    throw new TypeError(`${field} is invalid`);
  };
  const knownStoreEpoch =
    value.knownStoreEpoch === undefined
      ? undefined
      : requireCanvasSceneIdentity(value.knownStoreEpoch, "knownStoreEpoch");
  const knownSceneHash =
    value.knownSceneHash === undefined
      ? undefined
      : requireHash(value.knownSceneHash, "knownSceneHash");
  return {
    syncRequestId: requireCanvasSceneIdentity(value.syncRequestId, "syncRequestId"),
    accessContext,
    documentId,
    clientSessionId,
    ...(knownStoreEpoch ? { knownStoreEpoch } : {}),
    ...(optionalInteger("knownGeneration", 1) === undefined
      ? {}
      : { knownGeneration: optionalInteger("knownGeneration", 1) }),
    ...(optionalInteger("knownHeadSeq", 0) === undefined
      ? {}
      : { knownHeadSeq: optionalInteger("knownHeadSeq", 0) }),
    ...(knownSceneHash ? { knownSceneHash } : {}),
  };
};

export const encodeCanvasSceneMutationRequestHttp = (request: CanvasSceneMutationRequest): string =>
  encodeBoundedJson(
    canonicalizeCanvasSceneMutationRequest(request),
    MAX_CANVAS_SCENE_MUTATION_BYTES,
  );

export const decodeCanvasSceneMutationRequestHttp = (
  serialized: string,
  routeAccessContext: ContentAccessContext,
  routeDocumentId: string,
): CanvasSceneMutationRequest => {
  const request = canonicalizeCanvasSceneMutationRequest(
    parseBoundedJson(serialized, MAX_CANVAS_SCENE_MUTATION_BYTES),
  );
  if (
    contentAccessContextKey(request.accessContext) ===
      contentAccessContextKey(routeAccessContext) &&
    request.documentId === routeDocumentId
  ) {
    return request;
  }
  throw new TypeError("Canvas scene mutation does not match its route");
};

export const encodeCanvasSceneSyncResultHttp = (result: CanvasSceneSyncCommandResult): string =>
  encodeBoundedJson(result, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES);

export const decodeCanvasSceneSyncResultHttp = (
  serialized: string,
): CanvasSceneSyncCommandResult => {
  const envelope = requireResultEnvelope<Readonly<Record<string, unknown>>>(
    parseBoundedJson(serialized, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES),
    "Canvas scene sync result",
  );
  if (envelope.ok === false) return { ok: false, error: requireCanvasSceneError(envelope.error) };
  if (!isRecord(envelope.value)) throw new TypeError("Canvas scene sync result is invalid");
  const common = {
    syncRequestId: requireCanvasSceneIdentity(envelope.value.syncRequestId, "syncRequestId"),
    libraryId: requireCanvasSceneIdentity(envelope.value.libraryId, "libraryId"),
    accessContext: parseContentAccessContext(envelope.value.accessContext),
    documentId: requireCanvasSceneIdentity(envelope.value.documentId, "documentId"),
    storeEpoch: requireCanvasSceneIdentity(envelope.value.storeEpoch, "storeEpoch"),
    generation: requireInteger(envelope.value.generation, "generation", 1),
    headSeq: requireInteger(envelope.value.headSeq, "headSeq"),
    sceneHash: requireHash(envelope.value.sceneHash, "sceneHash"),
  };
  if (envelope.value.kind === "up_to_date") {
    if (envelope.value.scene !== undefined) {
      throw new TypeError("Canvas up-to-date sync result cannot contain a scene");
    }
    return { ok: true, value: { kind: "up_to_date", ...common } };
  }
  if (envelope.value.kind !== "snapshot") {
    throw new TypeError("Canvas scene sync result kind is invalid");
  }
  return {
    ok: true,
    value: {
      kind: "snapshot",
      ...common,
      scene: parsePortableCanvasScene(envelope.value.scene),
    },
  };
};

export const encodeCanvasSceneMutationResultHttp = (
  result: CanvasSceneMutationCommandResult,
): string => encodeBoundedJson(result, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES);

export const decodeCanvasSceneMutationResultHttp = (
  serialized: string,
): CanvasSceneMutationCommandResult => {
  const envelope = requireResultEnvelope<Readonly<Record<string, unknown>>>(
    parseBoundedJson(serialized, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES),
    "Canvas scene mutation result",
  );
  if (envelope.ok === false) return { ok: false, error: requireCanvasSceneError(envelope.error) };
  if (!isRecord(envelope.value)) throw new TypeError("Canvas scene mutation result is invalid");
  const result: CanvasSceneMutationCommandResult = {
    ok: true,
    localCommit: parseLocalCommitApply(envelope.localCommit),
    value: canonicalizeCanvasSceneMutationResult(envelope.value),
  };
  if (envelope.event !== undefined) {
    const event = parseCanvasSceneRealtimeEvent(envelope.event);
    if (event.type !== "canvas_scene_committed") {
      throw new TypeError("Canvas mutation event must be a committed event");
    }
    return { ...result, event };
  }
  return result;
};

export const encodeCanvasSceneSseEvent = (event: CanvasSceneRealtimeEvent): string =>
  encodeBoundedJson(event, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES);

export const decodeCanvasSceneSseEvent = (serialized: string): CanvasSceneRealtimeEvent => {
  return parseCanvasSceneRealtimeEvent(
    parseBoundedJson(serialized, MAX_CANVAS_SCENE_HTTP_RESPONSE_BYTES),
  );
};
