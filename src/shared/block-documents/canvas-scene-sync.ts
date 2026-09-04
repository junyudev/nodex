import {
  DURABLE_CANVAS_SCENE_APP_STATE_KEYS,
  MAX_CANVAS_SCENE_ELEMENTS,
  MAX_CANVAS_SCENE_FILES,
  CanvasSceneContractError,
  canonicalStringifyCanvasScene,
  canonicalizeCanvasSceneElement,
  canonicalizeCanvasSceneFile,
  pickPortableCanvasSceneAppState,
  requireCanvasSceneIdentity,
  type CanvasSceneAppState,
  type CanvasSceneElement,
  type CanvasSceneFile,
  type CanvasSceneJsonValue,
  type PortableCanvasScene,
} from "./canvas-scene";
import type { LocalCommitCommandSuccess } from "../local-commit-delivery";
import type { CoreFailureEvidence } from "../core-failure-evidence";
import { parseContentAccessContext, type ContentAccessContext } from "../content-access-context";

export const MAX_CANVAS_SCENE_MUTATION_BYTES = 2 * 1024 * 1024;
export const MAX_CANVAS_SCENE_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type CanvasSceneOptionalJson =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: CanvasSceneJsonValue };

export interface CanvasSceneAppStateIntent {
  readonly expected: CanvasSceneOptionalJson;
  readonly value: CanvasSceneOptionalJson;
}

export type CanvasSceneAppStateIntents = Readonly<Record<string, CanvasSceneAppStateIntent>>;

export interface CanvasSceneMutationIntent {
  readonly mutationId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly baseHeadSeq: number;
  readonly elementCandidates: readonly CanvasSceneElement[];
  readonly appStateIntents: CanvasSceneAppStateIntents;
  readonly fileAdditions: Readonly<Record<string, CanvasSceneFile>>;
}

export interface CanvasSceneMutationDelivery {
  readonly clientSessionId: string;
  readonly intent: CanvasSceneMutationIntent;
}

/** Flat process/Core boundary retained while renderer storage uses semantic intent. */
export interface CanvasSceneMutationRequest extends CanvasSceneMutationIntent {
  readonly clientSessionId: string;
}

export interface CanvasSceneMutationResult {
  readonly mutationId: string;
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly baseHeadSeq: number;
  readonly headSeq: number;
  readonly duplicate: boolean;
  readonly outcome: "committed" | "no_change";
  readonly sceneHash: string;
  readonly changedElementIds: readonly string[];
  readonly appliedAppStateKeys: readonly string[];
  readonly skippedAppStateKeys: readonly string[];
  readonly addedFileIds: readonly string[];
  readonly removedFileIds: readonly string[];
  readonly committedAt: string;
  readonly committedDelta?: CanvasSceneCommittedDelta;
}

export interface CanvasSceneCommittedDelta {
  readonly elementUpdates: readonly CanvasSceneElement[];
  readonly appState: CanvasSceneAppState;
  readonly fileAdditions: Readonly<Record<string, CanvasSceneFile>>;
  readonly removedFileIds: readonly string[];
}

export type CanvasSceneMutationErrorCode =
  | "transport_unavailable"
  | "request_cancelled"
  | "request_timeout"
  | "service_busy"
  | "invalid_response"
  | "invalid_canvas_scene_mutation"
  | "store_epoch_mismatch"
  | "access_scope_mismatch"
  | "document_not_found"
  | "document_not_ready"
  | "document_engine_mismatch"
  | "document_generation_mismatch"
  | "future_base_head"
  | "mutation_id_collision"
  | "canvas_scene_corrupt"
  | "unknown";

export interface CanvasSceneMutationError {
  readonly core?: CoreFailureEvidence;
  readonly code: CanvasSceneMutationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly resetRequired: boolean;
  readonly mutationId?: string;
}

export type CanvasSceneMutationCommandResult =
  | (LocalCommitCommandSuccess<CanvasSceneMutationResult> & {
      /** Present only for a first effective commit; safe to fan out after ACK. */
      readonly event?: CanvasSceneCommittedEvent;
    })
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

export type CanvasSceneSyncCommandResult =
  | { readonly ok: true; readonly value: CanvasSceneSyncResponse }
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

export interface CanvasSceneSubscribeRequest {
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly clientSessionId: string;
}

export interface CanvasSceneSubscriptionAck {
  readonly subscribed: true;
}

export interface CanvasSceneUnsubscribeAck {
  readonly unsubscribed: true;
}

export type CanvasSceneSubscriptionCommandResult =
  | {
      readonly ok: true;
      readonly value: CanvasSceneSubscriptionAck | CanvasSceneUnsubscribeAck;
    }
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

export interface CanvasSceneSyncRequest {
  readonly syncRequestId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly clientSessionId: string;
  readonly knownStoreEpoch?: string;
  readonly knownGeneration?: number;
  readonly knownHeadSeq?: number;
  readonly knownSceneHash?: string;
}

interface CanvasSceneSyncResponseBase {
  readonly syncRequestId: string;
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly sceneHash: string;
}

export type CanvasSceneSyncResponse =
  | (CanvasSceneSyncResponseBase & {
      readonly kind: "up_to_date";
    })
  | (CanvasSceneSyncResponseBase & {
      readonly kind: "snapshot";
      readonly scene: PortableCanvasScene;
    });

export interface CanvasSceneCommittedEvent {
  readonly type: "canvas_scene_committed";
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly mutationId: string;
  readonly baseHeadSeq: number;
  readonly headSeq: number;
  readonly sceneHash: string;
  readonly elementUpdates: readonly CanvasSceneElement[];
  readonly appState: CanvasSceneAppState;
  readonly fileAdditions: Readonly<Record<string, CanvasSceneFile>>;
  readonly removedFileIds: readonly string[];
}

export interface CanvasSceneResyncRequiredEvent {
  readonly type: "canvas_scene_resync_required";
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly headSeq: number;
}

export type CanvasSceneSessionEvent = {
  readonly type: "canvas_scene_session";
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
  readonly documentId: string;
  readonly clientSessionId: string;
} & (
  | { readonly state: "connected" | "disconnected" }
  | { readonly state: "terminated"; readonly error: CanvasSceneMutationError }
);

export type CanvasSceneRealtimeEvent =
  | CanvasSceneCommittedEvent
  | CanvasSceneResyncRequiredEvent
  | CanvasSceneSessionEvent;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireSafeInteger = (value: unknown, field: string, minimum: number): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
    return value;
  }
  throw new CanvasSceneContractError(`${field} must be a safe integer >= ${minimum}`);
};

const requireAccessContext = (value: unknown, field: string): ContentAccessContext => {
  try {
    return parseContentAccessContext(value);
  } catch (error) {
    throw new CanvasSceneContractError(`${field} is invalid`, { cause: error });
  }
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  field: string,
  required: readonly string[],
): void => {
  const allowed = new Set(required);
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(value, key)) continue;
    throw new CanvasSceneContractError(`${field}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new CanvasSceneContractError(`${field}.${key} is not supported`);
  }
};

const canonicalOptionalJson = (
  value: unknown,
  field: string,
  appStateKey: string,
): CanvasSceneOptionalJson => {
  if (!isRecord(value)) {
    throw new CanvasSceneContractError(`${field} must be an object`);
  }
  if (value.kind === "absent") {
    exactKeys(value, field, ["kind"]);
    return { kind: "absent" };
  }
  if (value.kind !== "value") {
    throw new CanvasSceneContractError(`${field}.kind must be absent or value`);
  }
  exactKeys(value, field, ["kind", "value"]);
  const parsed = pickPortableCanvasSceneAppState({
    [appStateKey]: value.value,
  })[appStateKey];
  if (parsed === undefined) {
    throw new CanvasSceneContractError(`${field}.value is invalid`);
  }
  return { kind: "value", value: parsed };
};

export const canonicalizeCanvasSceneMutationIntent = (
  input: unknown,
): CanvasSceneMutationIntent => {
  if (!isRecord(input)) {
    throw new CanvasSceneContractError("Canvas scene mutation intent must be an object");
  }
  exactKeys(input, "Canvas scene mutation intent", [
    "mutationId",
    "accessContext",
    "documentId",
    "storeEpoch",
    "generation",
    "baseHeadSeq",
    "elementCandidates",
    "appStateIntents",
    "fileAdditions",
  ]);
  if (!Array.isArray(input.elementCandidates)) {
    throw new CanvasSceneContractError("Canvas scene mutation.elementCandidates must be an array");
  }
  if (input.elementCandidates.length > MAX_CANVAS_SCENE_ELEMENTS) {
    throw new CanvasSceneContractError(
      `Canvas scene mutation exceeds ${MAX_CANVAS_SCENE_ELEMENTS} element candidates`,
    );
  }
  const elementCandidates = input.elementCandidates.map((element) =>
    canonicalizeCanvasSceneElement(element, { runtime: true }),
  );
  const elementIds = elementCandidates.map((element) => element.id as string);
  if (new Set(elementIds).size !== elementIds.length) {
    throw new CanvasSceneContractError("Canvas scene mutation repeats an element id");
  }
  if (!isRecord(input.appStateIntents)) {
    throw new CanvasSceneContractError("Canvas scene mutation.appStateIntents must be an object");
  }
  const appStateIntents: Record<string, CanvasSceneAppStateIntent> = {};
  const allowedAppStateKeys = new Set<string>(DURABLE_CANVAS_SCENE_APP_STATE_KEYS);
  for (const [key, intent] of Object.entries(input.appStateIntents)) {
    if (!allowedAppStateKeys.has(key)) {
      throw new CanvasSceneContractError(
        `Canvas scene mutation contains non-durable appState key ${key}`,
      );
    }
    if (!isRecord(intent)) {
      throw new CanvasSceneContractError(
        `Canvas scene mutation.appStateIntents.${key} must be an object`,
      );
    }
    exactKeys(intent, `Canvas scene mutation.appStateIntents.${key}`, ["expected", "value"]);
    appStateIntents[key] = {
      expected: canonicalOptionalJson(
        intent.expected,
        `Canvas scene mutation.appStateIntents.${key}.expected`,
        key,
      ),
      value: canonicalOptionalJson(
        intent.value,
        `Canvas scene mutation.appStateIntents.${key}.value`,
        key,
      ),
    };
  }
  if (!isRecord(input.fileAdditions)) {
    throw new CanvasSceneContractError("Canvas scene mutation.fileAdditions must be an object");
  }
  const fileEntries = Object.entries(input.fileAdditions);
  if (fileEntries.length > MAX_CANVAS_SCENE_FILES) {
    throw new CanvasSceneContractError(
      `Canvas scene mutation exceeds ${MAX_CANVAS_SCENE_FILES} file additions`,
    );
  }
  const fileAdditions = Object.fromEntries(
    fileEntries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileId, file]) => [fileId, canonicalizeCanvasSceneFile(file, fileId)]),
  );
  const intent: CanvasSceneMutationIntent = {
    mutationId: requireCanvasSceneIdentity(input.mutationId, "mutationId"),
    accessContext: requireAccessContext(input.accessContext, "accessContext"),
    documentId: requireCanvasSceneIdentity(input.documentId, "documentId"),
    storeEpoch: requireCanvasSceneIdentity(input.storeEpoch, "storeEpoch"),
    generation: requireSafeInteger(input.generation, "generation", 1),
    baseHeadSeq: requireSafeInteger(input.baseHeadSeq, "baseHeadSeq", 0),
    elementCandidates,
    appStateIntents,
    fileAdditions,
  };
  const byteLength = new TextEncoder().encode(
    encodeCanonicalCanvasSceneMutationIntent(intent),
  ).byteLength;
  if (byteLength <= MAX_CANVAS_SCENE_MUTATION_BYTES) return intent;
  throw new CanvasSceneContractError(
    `Canvas scene mutation exceeds ${MAX_CANVAS_SCENE_MUTATION_BYTES} bytes`,
  );
};

export const encodeCanonicalCanvasSceneMutationIntent = (
  intent: CanvasSceneMutationIntent,
): string => canonicalStringifyCanvasScene(intent);

export const canonicalizeCanvasSceneMutationRequest = (
  input: unknown,
): CanvasSceneMutationRequest => {
  if (!isRecord(input)) {
    throw new CanvasSceneContractError("Canvas scene mutation must be an object");
  }
  exactKeys(input, "Canvas scene mutation", [
    "mutationId",
    "accessContext",
    "documentId",
    "storeEpoch",
    "generation",
    "baseHeadSeq",
    "clientSessionId",
    "elementCandidates",
    "appStateIntents",
    "fileAdditions",
  ]);
  const intent = canonicalizeCanvasSceneMutationIntent(
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== "clientSessionId")),
  );
  const request = {
    ...intent,
    clientSessionId: requireCanvasSceneIdentity(input.clientSessionId, "clientSessionId"),
  };
  const byteLength = new TextEncoder().encode(
    encodeCanonicalCanvasSceneMutationRequest(request),
  ).byteLength;
  if (byteLength <= MAX_CANVAS_SCENE_MUTATION_BYTES) return request;
  throw new CanvasSceneContractError(
    `Canvas scene mutation exceeds ${MAX_CANVAS_SCENE_MUTATION_BYTES} bytes`,
  );
};

export const encodeCanonicalCanvasSceneMutationRequest = (
  request: CanvasSceneMutationRequest,
): string => canonicalStringifyCanvasScene(request);

const canonicalResultIds = (value: unknown, field: string, maximum: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new CanvasSceneContractError(`${field} must be a bounded identity array`);
  }
  const ids = value.map((entry, index) => requireCanvasSceneIdentity(entry, `${field}[${index}]`));
  const canonical = [...new Set(ids)].sort();
  if (canonical.length !== ids.length || canonical.some((id, index) => id !== ids[index])) {
    throw new CanvasSceneContractError(`${field} must be sorted and unique`);
  }
  return canonical;
};

export const canonicalizeCanvasSceneMutationResult = (
  input: unknown,
): CanvasSceneMutationResult => {
  if (!isRecord(input)) {
    throw new CanvasSceneContractError("Canvas scene mutation result must be an object");
  }
  const outcome = input.outcome;
  exactKeys(input, "Canvas scene mutation result", [
    "mutationId",
    "libraryId",
    "accessContext",
    "documentId",
    "storeEpoch",
    "generation",
    "baseHeadSeq",
    "headSeq",
    "duplicate",
    "outcome",
    "sceneHash",
    "changedElementIds",
    "appliedAppStateKeys",
    "skippedAppStateKeys",
    "addedFileIds",
    "removedFileIds",
    "committedAt",
    ...(outcome === "committed" ? ["committedDelta"] : []),
  ]);
  if (typeof input.duplicate !== "boolean") {
    throw new CanvasSceneContractError("Canvas scene mutation result.duplicate must be boolean");
  }
  if (outcome !== "committed" && outcome !== "no_change") {
    throw new CanvasSceneContractError("Canvas scene mutation result.outcome is invalid");
  }
  if (typeof input.sceneHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.sceneHash)) {
    throw new CanvasSceneContractError(
      "Canvas scene mutation result.sceneHash must be lowercase SHA-256",
    );
  }
  if (typeof input.committedAt !== "string") {
    throw new CanvasSceneContractError(
      "Canvas scene mutation result.committedAt must be canonical ISO time",
    );
  }
  const committedDate = new Date(input.committedAt);
  if (Number.isNaN(committedDate.getTime()) || committedDate.toISOString() !== input.committedAt) {
    throw new CanvasSceneContractError(
      "Canvas scene mutation result.committedAt must be canonical ISO time",
    );
  }
  const appliedAppStateKeys = canonicalResultIds(
    input.appliedAppStateKeys,
    "Canvas scene mutation result.appliedAppStateKeys",
    DURABLE_CANVAS_SCENE_APP_STATE_KEYS.length,
  );
  const skippedAppStateKeys = canonicalResultIds(
    input.skippedAppStateKeys,
    "Canvas scene mutation result.skippedAppStateKeys",
    DURABLE_CANVAS_SCENE_APP_STATE_KEYS.length,
  );
  const allowedAppStateKeys = new Set<string>(DURABLE_CANVAS_SCENE_APP_STATE_KEYS);
  if (
    [...appliedAppStateKeys, ...skippedAppStateKeys].some((key) => !allowedAppStateKeys.has(key))
  ) {
    throw new CanvasSceneContractError(
      "Canvas scene mutation result contains a non-durable appState key",
    );
  }
  const changedElementIds = canonicalResultIds(
    input.changedElementIds,
    "Canvas scene mutation result.changedElementIds",
    MAX_CANVAS_SCENE_ELEMENTS,
  );
  const addedFileIds = canonicalResultIds(
    input.addedFileIds,
    "Canvas scene mutation result.addedFileIds",
    MAX_CANVAS_SCENE_FILES,
  );
  const removedFileIds = canonicalResultIds(
    input.removedFileIds,
    "Canvas scene mutation result.removedFileIds",
    MAX_CANVAS_SCENE_FILES,
  );
  let committedDelta: CanvasSceneCommittedDelta | undefined;
  if (outcome === "committed") {
    if (!isRecord(input.committedDelta)) {
      throw new CanvasSceneContractError(
        "Canvas scene mutation result.committedDelta must be an object",
      );
    }
    exactKeys(input.committedDelta, "Canvas scene mutation result.committedDelta", [
      "elementUpdates",
      "appState",
      "fileAdditions",
      "removedFileIds",
    ]);
    if (
      !Array.isArray(input.committedDelta.elementUpdates) ||
      !isRecord(input.committedDelta.appState) ||
      !isRecord(input.committedDelta.fileAdditions)
    ) {
      throw new CanvasSceneContractError(
        "Canvas scene mutation result.committedDelta has invalid fields",
      );
    }
    const elementUpdates = input.committedDelta.elementUpdates.map((element) =>
      canonicalizeCanvasSceneElement(element),
    );
    const fileAdditions = Object.fromEntries(
      Object.entries(input.committedDelta.fileAdditions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fileId, file]) => [fileId, canonicalizeCanvasSceneFile(file, fileId)]),
    );
    const deltaRemovedFileIds = canonicalResultIds(
      input.committedDelta.removedFileIds,
      "Canvas scene mutation result.committedDelta.removedFileIds",
      MAX_CANVAS_SCENE_FILES,
    );
    const deltaElementIds = [...elementUpdates].map((element) => element.id as string).sort();
    const deltaFileIds = Object.keys(fileAdditions).sort();
    if (
      canonicalStringifyCanvasScene(deltaElementIds) !==
        canonicalStringifyCanvasScene(changedElementIds) ||
      canonicalStringifyCanvasScene(deltaFileIds) !== canonicalStringifyCanvasScene(addedFileIds) ||
      canonicalStringifyCanvasScene(deltaRemovedFileIds) !==
        canonicalStringifyCanvasScene(removedFileIds)
    ) {
      throw new CanvasSceneContractError(
        "Canvas scene mutation result.committedDelta disagrees with its summaries",
      );
    }
    committedDelta = {
      elementUpdates,
      appState: pickPortableCanvasSceneAppState(input.committedDelta.appState),
      fileAdditions,
      removedFileIds: deltaRemovedFileIds,
    };
  }
  return {
    mutationId: requireCanvasSceneIdentity(input.mutationId, "mutationId"),
    libraryId: requireCanvasSceneIdentity(input.libraryId, "libraryId"),
    accessContext: requireAccessContext(input.accessContext, "accessContext"),
    documentId: requireCanvasSceneIdentity(input.documentId, "documentId"),
    storeEpoch: requireCanvasSceneIdentity(input.storeEpoch, "storeEpoch"),
    generation: requireSafeInteger(input.generation, "generation", 1),
    baseHeadSeq: requireSafeInteger(input.baseHeadSeq, "baseHeadSeq", 0),
    headSeq: requireSafeInteger(input.headSeq, "headSeq", 0),
    duplicate: input.duplicate,
    outcome,
    sceneHash: input.sceneHash,
    changedElementIds,
    appliedAppStateKeys,
    skippedAppStateKeys,
    addedFileIds,
    removedFileIds,
    committedAt: input.committedAt,
    ...(committedDelta ? { committedDelta } : {}),
  };
};

export const encodeCanonicalCanvasSceneMutationResult = (
  result: CanvasSceneMutationResult,
): string => canonicalStringifyCanvasScene(result);
