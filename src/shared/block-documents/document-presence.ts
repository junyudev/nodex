import { parseContentRoutingContext, type ContentRoutingContext } from "../content-routing-context";

export const MAX_DOCUMENT_PRESENCE_BYTES = 64 * 1024;
const MAX_CANVAS_PRESENCE_PUBLICATION_BYTES = 56 * 1024;
export const MAX_CANVAS_PRESENCE_SELECTION_IDS = 256;
export const CANVAS_PRESENCE_POINTER_INTERVAL_MS = 50;
export const CANVAS_PRESENCE_HEARTBEAT_MS = 15_000;
export const CANVAS_PRESENCE_TTL_MS = 30_000;
export const CANVAS_PRESENCE_SWEEP_MS = 3_000;

export type CanvasPresenceIdleState = "active" | "idle" | "away";

export interface CanvasPresenceValue {
  readonly pointer?: {
    readonly x: number;
    readonly y: number;
    readonly button: "up" | "down";
    readonly tool: "pointer" | "laser";
  };
  readonly selectedElementIds: readonly string[];
  readonly idle: CanvasPresenceIdleState;
}

/**
 * Semantic, best-effort publication. Session and user identity deliberately
 * live outside this value and are bound by the trusted Host subscription.
 */
export interface CanvasPresencePublication {
  readonly engine: "canvas_scene";
  readonly documentId: string;
  readonly generation: number;
  readonly clock: number;
  readonly state: CanvasPresenceValue | null;
}

export interface CanvasPresenceUser {
  readonly id: string;
  readonly displayName: string;
  readonly color: string;
}

export interface CanvasPresenceEvent extends CanvasPresencePublication {
  readonly clientSessionId: string;
  readonly user: CanvasPresenceUser;
}

/** Delivery identity is checked against the renderer's active subscription. */
export interface CanvasPresencePublishRequest {
  readonly routingContext: ContentRoutingContext;
  readonly clientSessionId: string;
  readonly publication: CanvasPresencePublication;
}

export interface CanvasPresencePublishAck {
  readonly accepted: true;
  /** False means a delayed or duplicate clock was safely ignored. */
  readonly applied: boolean;
}

export type CanvasPresenceCommandErrorCode =
  | "invalid_session"
  | "invalid_presence"
  | "generation_mismatch"
  | "transport_unavailable";

export type CanvasPresenceCommandResult =
  | { readonly ok: true; readonly value: CanvasPresencePublishAck }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: CanvasPresenceCommandErrorCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly resetRequired: boolean;
      };
    };

export type CanvasPresenceRealtimeEvent =
  | {
      readonly type: "canvas_presence_snapshot";
      readonly libraryId: string;
      readonly routingContext: ContentRoutingContext;
      readonly documentId: string;
      readonly generation: number;
      readonly presences: readonly CanvasPresenceEvent[];
    }
  | {
      readonly type: "canvas_presence_updated";
      readonly libraryId: string;
      readonly routingContext: ContentRoutingContext;
      readonly presence: CanvasPresenceEvent;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
};

const readIdentity = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be an exact bounded identity`);
  }
  return value;
};

const readSafeInteger = (value: unknown, label: string, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer at least ${minimum}`);
  }
  return value;
};

const assertEncodedBound = <Value>(value: Value, maximumBytes: number, label: string): Value => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) {
    throw new TypeError(`${label} exceeds its byte bound`);
  }
  return value;
};

const parsePointer = (value: unknown): NonNullable<CanvasPresenceValue["pointer"]> | undefined => {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["x", "y", "button", "tool"]) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    (value.button !== "up" && value.button !== "down") ||
    (value.tool !== "pointer" && value.tool !== "laser")
  ) {
    throw new TypeError("Canvas presence pointer is invalid");
  }
  return {
    x: value.x,
    y: value.y,
    button: value.button,
    tool: value.tool,
  };
};

export const canonicalizeCanvasPresenceValue = (value: unknown): CanvasPresenceValue => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["pointer", "selectedElementIds", "idle"]) ||
    !Array.isArray(value.selectedElementIds) ||
    value.selectedElementIds.length > MAX_CANVAS_PRESENCE_SELECTION_IDS ||
    (value.idle !== "active" && value.idle !== "idle" && value.idle !== "away")
  ) {
    throw new TypeError("Canvas presence state is invalid");
  }
  const selectedElementIds = value.selectedElementIds.map((id) =>
    readIdentity(id, "Canvas selected element"),
  );
  const canonicalSelection = [...new Set(selectedElementIds)].sort();
  if (
    canonicalSelection.length !== selectedElementIds.length ||
    canonicalSelection.some((id, index) => id !== selectedElementIds[index])
  ) {
    throw new TypeError("Canvas selected element identities must be sorted and unique");
  }
  const pointer = parsePointer(value.pointer);
  return {
    ...(pointer ? { pointer } : {}),
    selectedElementIds: canonicalSelection,
    idle: value.idle,
  };
};

export const canonicalizeCanvasPresencePublication = (
  value: unknown,
): CanvasPresencePublication => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["engine", "documentId", "generation", "clock", "state"]) ||
    value.engine !== "canvas_scene"
  ) {
    throw new TypeError("Canvas presence publication is invalid");
  }
  const publication: CanvasPresencePublication = {
    engine: "canvas_scene",
    documentId: readIdentity(value.documentId, "Canvas presence Document"),
    generation: readSafeInteger(value.generation, "Canvas presence generation", 1),
    clock: readSafeInteger(value.clock, "Canvas presence clock", 0),
    state: value.state === null ? null : canonicalizeCanvasPresenceValue(value.state),
  };
  return assertEncodedBound(
    publication,
    MAX_CANVAS_PRESENCE_PUBLICATION_BYTES,
    "Canvas presence publication",
  );
};

export const canonicalizeCanvasPresencePublishRequest = (
  value: unknown,
): CanvasPresencePublishRequest => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["routingContext", "clientSessionId", "publication"])
  ) {
    throw new TypeError("Canvas presence publish request is invalid");
  }
  return {
    routingContext: parseContentRoutingContext(value.routingContext),
    clientSessionId: readIdentity(value.clientSessionId, "Canvas presence client session"),
    publication: canonicalizeCanvasPresencePublication(value.publication),
  };
};

export const canonicalizeCanvasPresenceUser = (value: unknown): CanvasPresenceUser => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "displayName", "color"])) {
    throw new TypeError("Canvas presence user is invalid");
  }
  const displayName = readIdentity(value.displayName, "Canvas presence display name");
  if (displayName.length > 128) {
    throw new TypeError("Canvas presence display name is too long");
  }
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/u.test(value.color)) {
    throw new TypeError("Canvas presence color is invalid");
  }
  return {
    id: readIdentity(value.id, "Canvas presence user"),
    displayName,
    color: value.color,
  };
};

export const canonicalizeCanvasPresenceEvent = (value: unknown): CanvasPresenceEvent => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "engine",
      "documentId",
      "generation",
      "clock",
      "state",
      "clientSessionId",
      "user",
    ])
  ) {
    throw new TypeError("Canvas presence event is invalid");
  }
  return {
    ...canonicalizeCanvasPresencePublication({
      engine: value.engine,
      documentId: value.documentId,
      generation: value.generation,
      clock: value.clock,
      state: value.state,
    }),
    clientSessionId: readIdentity(value.clientSessionId, "Canvas presence client session"),
    user: canonicalizeCanvasPresenceUser(value.user),
  };
};

export const canonicalizeCanvasPresenceRealtimeEvent = (
  value: unknown,
): CanvasPresenceRealtimeEvent => {
  if (!isRecord(value)) {
    throw new TypeError("Canvas presence realtime event is invalid");
  }
  if (value.type === "canvas_presence_updated") {
    if (!hasOnlyKeys(value, ["type", "libraryId", "routingContext", "presence"])) {
      throw new TypeError("Canvas presence update event is invalid");
    }
    return assertEncodedBound(
      {
        type: value.type,
        libraryId: readIdentity(value.libraryId, "Canvas presence Library"),
        routingContext: parseContentRoutingContext(value.routingContext),
        presence: canonicalizeCanvasPresenceEvent(value.presence),
      },
      MAX_DOCUMENT_PRESENCE_BYTES,
      "Canvas presence update event",
    );
  }
  if (
    value.type !== "canvas_presence_snapshot" ||
    !hasOnlyKeys(value, [
      "type",
      "libraryId",
      "routingContext",
      "documentId",
      "generation",
      "presences",
    ]) ||
    !Array.isArray(value.presences)
  ) {
    throw new TypeError("Canvas presence snapshot event is invalid");
  }
  const documentId = readIdentity(value.documentId, "Canvas presence Document");
  const generation = readSafeInteger(value.generation, "Canvas presence generation", 1);
  const presences = value.presences.map(canonicalizeCanvasPresenceEvent);
  const sessionIds = new Set(presences.map((presence) => presence.clientSessionId));
  if (
    sessionIds.size !== presences.length ||
    presences.some(
      (presence) =>
        presence.documentId !== documentId ||
        presence.generation !== generation ||
        presence.state === null,
    )
  ) {
    throw new TypeError("Canvas presence snapshot crossed its boundary");
  }
  return assertEncodedBound(
    {
      type: value.type,
      libraryId: readIdentity(value.libraryId, "Canvas presence Library"),
      routingContext: parseContentRoutingContext(value.routingContext),
      documentId,
      generation,
      presences,
    },
    MAX_DOCUMENT_PRESENCE_BYTES,
    "Canvas presence snapshot event",
  );
};
