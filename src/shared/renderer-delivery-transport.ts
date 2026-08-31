export const RENDERER_DELIVERY_WIRE_VERSION = 1 as const;
export const RENDERER_DELIVERY_INLINE_MAX_BYTES = 4 * 1024 * 1024;
export const RENDERER_DELIVERY_CHUNK_BYTES = 2 * 1024 * 1024;
export const RENDERER_DELIVERY_MAX_ENCODED_BYTES = 16 * 1024 * 1024;
export const RENDERER_DELIVERY_MAX_CHUNKS = Math.ceil(
  RENDERER_DELIVERY_MAX_ENCODED_BYTES / RENDERER_DELIVERY_CHUNK_BYTES,
);
export const RENDERER_DELIVERY_MAX_ACTIVE_TRANSFERS = 8;
export const RENDERER_DELIVERY_MAX_REASSEMBLY_BYTES = 16 * 1024 * 1024;
export const RENDERER_DELIVERY_MAX_JSON_DEPTH = 64;
export const RENDERER_DELIVERY_MAX_JSON_NODES = 1_000_000;

const MAX_ID_LENGTH = 512;
const MAX_ABORT_REASON_LENGTH = 256;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type RendererDeliveryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RendererDeliveryJsonValue[]
  | { readonly [key: string]: RendererDeliveryJsonValue };

interface RendererDeliveryEnvelopeBase {
  readonly version: typeof RENDERER_DELIVERY_WIRE_VERSION;
  readonly targetId: string;
  readonly generation: number;
}

export interface RendererDeliveryInlineEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "inline";
  readonly encodedBytes: number;
  readonly payloadUtf8: Uint8Array;
}

export interface RendererDeliveryTransferStartEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "transferStart";
  readonly transferId: string;
  readonly sequence: 0;
  readonly encodedBytes: number;
  readonly chunkCount: number;
}

export interface RendererDeliveryTransferChunkEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "transferChunk";
  readonly transferId: string;
  readonly sequence: number;
  readonly payloadUtf8: Uint8Array;
}

export interface RendererDeliveryTransferEndEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "transferEnd";
  readonly transferId: string;
  readonly sequence: number;
}

export interface RendererDeliveryTransferAckEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "transferAck";
  readonly transferId: string;
  readonly sequence: number;
}

export interface RendererDeliveryTransferAbortEnvelope extends RendererDeliveryEnvelopeBase {
  readonly kind: "transferAbort";
  readonly transferId: string;
  readonly reason: string;
}

export type RendererDeliveryEnvelope =
  | RendererDeliveryInlineEnvelope
  | RendererDeliveryTransferStartEnvelope
  | RendererDeliveryTransferChunkEnvelope
  | RendererDeliveryTransferEndEnvelope
  | RendererDeliveryTransferAckEnvelope
  | RendererDeliveryTransferAbortEnvelope;

export type RendererDeliveryDataEnvelope = Exclude<
  RendererDeliveryEnvelope,
  RendererDeliveryTransferAckEnvelope | RendererDeliveryTransferAbortEnvelope
>;

export type RendererDeliveryDispatch =
  | {
      readonly kind: "inline";
      readonly envelopes: readonly [RendererDeliveryInlineEnvelope];
      readonly acknowledgment: null;
    }
  | {
      readonly kind: "transfer";
      readonly envelopes: readonly RendererDeliveryDataEnvelope[];
      readonly acknowledgment: RendererDeliveryAcknowledgmentState;
    };

export interface RendererDeliveryAcknowledgmentState {
  readonly targetId: string;
  readonly generation: number;
  readonly transferId: string;
  readonly expectedSequence: number;
  readonly finalSequence: number;
}

export interface RendererDeliveryTarget {
  readonly targetId: string;
  readonly generation: number;
}

export interface RendererDeliveryCompletedPayload extends RendererDeliveryTarget {
  readonly transferId: string | null;
  readonly payload: RendererDeliveryJsonValue;
}

interface ActiveRendererDeliveryTransfer extends RendererDeliveryTarget {
  readonly transferId: string;
  readonly encodedBytes: number;
  readonly chunkCount: number;
  readonly expectedSequence: number;
  readonly receivedBytes: number;
  readonly chunks: readonly Uint8Array[];
}

const ACTIVE_TRANSFERS: unique symbol = Symbol("rendererDeliveryActiveTransfers");

export interface RendererDeliveryAssemblerState {
  readonly activeTransferCount: number;
  readonly reassemblyBytes: number;
  readonly [ACTIVE_TRANSFERS]: ReadonlyMap<string, ActiveRendererDeliveryTransfer>;
}

export type RendererDeliveryAssemblyTransition =
  | {
      readonly kind: "accepted";
      readonly state: RendererDeliveryAssemblerState;
      readonly acknowledgment: RendererDeliveryTransferAckEnvelope;
    }
  | {
      readonly kind: "complete";
      readonly state: RendererDeliveryAssemblerState;
      readonly acknowledgment: RendererDeliveryTransferAckEnvelope | null;
      readonly delivery: RendererDeliveryCompletedPayload;
    }
  | {
      readonly kind: "aborted";
      readonly state: RendererDeliveryAssemblerState;
      readonly transferId: string;
      readonly reason: string;
    };

export interface RendererDeliveryTargetRelease {
  readonly state: RendererDeliveryAssemblerState;
  readonly releasedTransferIds: readonly string[];
}

export type RendererDeliveryTransportErrorCode =
  | "invalidPayload"
  | "payloadTooLarge"
  | "invalidEnvelope"
  | "activeTransferLimit"
  | "reassemblyLimit"
  | "duplicateTransfer"
  | "unknownTransfer"
  | "unexpectedSequence"
  | "chunkLengthMismatch"
  | "incompleteTransfer"
  | "invalidUtf8"
  | "invalidJson"
  | "acknowledgmentMismatch";

export class RendererDeliveryTransportError extends Error {
  readonly code: RendererDeliveryTransportErrorCode;

  constructor(code: RendererDeliveryTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RendererDeliveryTransportError";
    this.code = code;
  }
}

interface JsonInspectionState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function fail(
  code: RendererDeliveryTransportErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new RendererDeliveryTransportError(code, message, options);
}

function inspectJsonValue(value: unknown, depth: number, state: JsonInspectionState): void {
  state.nodes += 1;
  if (state.nodes > RENDERER_DELIVERY_MAX_JSON_NODES) {
    fail("invalidPayload", "Renderer delivery payload exceeds the JSON node limit");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    fail("invalidPayload", "Renderer delivery payload must contain only JSON values");
  }
  if (depth >= RENDERER_DELIVERY_MAX_JSON_DEPTH) {
    fail("invalidPayload", "Renderer delivery payload exceeds the JSON depth limit");
  }
  if (state.ancestors.has(value)) {
    fail("invalidPayload", "Renderer delivery payload must not be cyclic");
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  const isArray = Array.isArray(value);
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    fail("invalidPayload", "Renderer delivery payload must contain only plain JSON containers");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalidPayload", "Renderer delivery payload must not contain symbol properties");
  }

  state.ancestors.add(value);
  try {
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("invalidPayload", "Renderer delivery payload must not contain sparse arrays");
        }
        inspectJsonValue(descriptor.value, depth + 1, state);
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail("invalidPayload", "Renderer delivery arrays must not contain named properties");
      }
      return;
    }

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("invalidPayload", "Renderer delivery payload must not contain accessors");
      }
      inspectJsonValue(descriptor.value, depth + 1, state);
    }
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      fail("invalidPayload", "Renderer delivery payload must not contain hidden properties");
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function assertJsonPayload(value: unknown): asserts value is RendererDeliveryJsonValue {
  inspectJsonValue(value, 0, { ancestors: new WeakSet(), nodes: 0 });
}

function readRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalidEnvelope", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalidEnvelope", `${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalidEnvelope", `${label} must not contain symbol fields`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail("invalidEnvelope", `${label} must contain only enumerable data fields`);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  label: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).toSorted();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail("invalidEnvelope", `${label} contains unexpected or missing fields`);
  }
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    fail("invalidEnvelope", `${label} must be a bounded non-empty string`);
  }
  return value;
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("invalidEnvelope", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function readBase(record: Readonly<Record<string, unknown>>): RendererDeliveryEnvelopeBase {
  if (record.version !== RENDERER_DELIVERY_WIRE_VERSION) {
    fail("invalidEnvelope", "Renderer delivery envelope has an unsupported wire version");
  }
  return {
    version: RENDERER_DELIVERY_WIRE_VERSION,
    targetId: readId(record.targetId, "Renderer delivery targetId"),
    generation: readInteger(
      record.generation,
      "Renderer delivery generation",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function readPayloadBytes(value: unknown, maximum: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    fail("invalidEnvelope", `${label} must be a bounded non-empty Uint8Array`);
  }
  return value;
}

export function parseRendererDeliveryEnvelope(value: unknown): RendererDeliveryEnvelope {
  const record = readRecord(value, "Renderer delivery envelope");
  const base = readBase(record);
  switch (record.kind) {
    case "inline": {
      exactKeys(record, "Renderer delivery inline envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "encodedBytes",
        "payloadUtf8",
      ]);
      const payloadUtf8 = readPayloadBytes(
        record.payloadUtf8,
        RENDERER_DELIVERY_INLINE_MAX_BYTES,
        "Renderer delivery inline payload",
      );
      const encodedBytes = readInteger(
        record.encodedBytes,
        "Renderer delivery encodedBytes",
        1,
        RENDERER_DELIVERY_INLINE_MAX_BYTES,
      );
      if (encodedBytes !== payloadUtf8.byteLength) {
        fail("invalidEnvelope", "Renderer delivery inline byte length does not match its metadata");
      }
      return { ...base, kind: "inline", encodedBytes, payloadUtf8 };
    }
    case "transferStart": {
      exactKeys(record, "Renderer delivery transfer start envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "transferId",
        "sequence",
        "encodedBytes",
        "chunkCount",
      ]);
      if (record.sequence !== 0) {
        fail("invalidEnvelope", "Renderer delivery transfer start sequence must be zero");
      }
      const encodedBytes = readInteger(
        record.encodedBytes,
        "Renderer delivery encodedBytes",
        RENDERER_DELIVERY_INLINE_MAX_BYTES + 1,
        RENDERER_DELIVERY_MAX_ENCODED_BYTES,
      );
      const chunkCount = readInteger(
        record.chunkCount,
        "Renderer delivery chunkCount",
        1,
        RENDERER_DELIVERY_MAX_CHUNKS,
      );
      if (chunkCount !== Math.ceil(encodedBytes / RENDERER_DELIVERY_CHUNK_BYTES)) {
        fail("invalidEnvelope", "Renderer delivery chunkCount is not canonical for encodedBytes");
      }
      return {
        ...base,
        kind: "transferStart",
        transferId: readId(record.transferId, "Renderer delivery transferId"),
        sequence: 0,
        encodedBytes,
        chunkCount,
      };
    }
    case "transferChunk":
      exactKeys(record, "Renderer delivery transfer chunk envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "transferId",
        "sequence",
        "payloadUtf8",
      ]);
      return {
        ...base,
        kind: "transferChunk",
        transferId: readId(record.transferId, "Renderer delivery transferId"),
        sequence: readInteger(
          record.sequence,
          "Renderer delivery sequence",
          1,
          RENDERER_DELIVERY_MAX_CHUNKS,
        ),
        payloadUtf8: readPayloadBytes(
          record.payloadUtf8,
          RENDERER_DELIVERY_CHUNK_BYTES,
          "Renderer delivery transfer chunk",
        ),
      };
    case "transferEnd":
      exactKeys(record, "Renderer delivery transfer end envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "transferId",
        "sequence",
      ]);
      return {
        ...base,
        kind: "transferEnd",
        transferId: readId(record.transferId, "Renderer delivery transferId"),
        sequence: readInteger(
          record.sequence,
          "Renderer delivery sequence",
          2,
          RENDERER_DELIVERY_MAX_CHUNKS + 1,
        ),
      };
    case "transferAck":
      exactKeys(record, "Renderer delivery transfer acknowledgment envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "transferId",
        "sequence",
      ]);
      return {
        ...base,
        kind: "transferAck",
        transferId: readId(record.transferId, "Renderer delivery transferId"),
        sequence: readInteger(
          record.sequence,
          "Renderer delivery sequence",
          0,
          RENDERER_DELIVERY_MAX_CHUNKS + 1,
        ),
      };
    case "transferAbort": {
      exactKeys(record, "Renderer delivery transfer abort envelope", [
        "version",
        "kind",
        "targetId",
        "generation",
        "transferId",
        "reason",
      ]);
      if (
        typeof record.reason !== "string" ||
        record.reason.length === 0 ||
        record.reason.length > MAX_ABORT_REASON_LENGTH
      ) {
        fail(
          "invalidEnvelope",
          "Renderer delivery abort reason must be a bounded non-empty string",
        );
      }
      return {
        ...base,
        kind: "transferAbort",
        transferId: readId(record.transferId, "Renderer delivery transferId"),
        reason: record.reason,
      };
    }
    default:
      fail("invalidEnvelope", "Renderer delivery envelope has an unknown kind");
  }
}

function validateTarget(target: RendererDeliveryTarget): void {
  readId(target.targetId, "Renderer delivery targetId");
  readInteger(target.generation, "Renderer delivery generation", 0, Number.MAX_SAFE_INTEGER);
}

/**
 * Validates JSON shape before serializing, then performs exactly one stringify
 * and one UTF-8 encode for both inline and chunked delivery.
 */
export function encodeRendererDelivery(input: {
  readonly target: RendererDeliveryTarget;
  readonly transferId: string;
  readonly payload: unknown;
}): RendererDeliveryDispatch {
  validateTarget(input.target);
  const transferId = readId(input.transferId, "Renderer delivery transferId");
  assertJsonPayload(input.payload);

  let json: string;
  try {
    json = JSON.stringify(input.payload);
  } catch (cause) {
    fail("invalidPayload", "Renderer delivery payload could not be serialized", { cause });
  }
  const encoded = UTF8_ENCODER.encode(json);
  if (encoded.byteLength > RENDERER_DELIVERY_MAX_ENCODED_BYTES) {
    fail(
      "payloadTooLarge",
      `Renderer delivery payload exceeds ${RENDERER_DELIVERY_MAX_ENCODED_BYTES} encoded bytes`,
    );
  }
  const base = {
    version: RENDERER_DELIVERY_WIRE_VERSION,
    targetId: input.target.targetId,
    generation: input.target.generation,
  } as const;
  if (encoded.byteLength <= RENDERER_DELIVERY_INLINE_MAX_BYTES) {
    return {
      kind: "inline",
      envelopes: [
        {
          ...base,
          kind: "inline",
          encodedBytes: encoded.byteLength,
          payloadUtf8: encoded,
        },
      ],
      acknowledgment: null,
    };
  }

  const chunkCount = Math.ceil(encoded.byteLength / RENDERER_DELIVERY_CHUNK_BYTES);
  if (chunkCount > RENDERER_DELIVERY_MAX_CHUNKS) {
    fail("payloadTooLarge", "Renderer delivery payload exceeds the transfer chunk limit");
  }
  const envelopes: RendererDeliveryDataEnvelope[] = [
    {
      ...base,
      kind: "transferStart",
      transferId,
      sequence: 0,
      encodedBytes: encoded.byteLength,
      chunkCount,
    },
  ];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * RENDERER_DELIVERY_CHUNK_BYTES;
    envelopes.push({
      ...base,
      kind: "transferChunk",
      transferId,
      sequence: chunkIndex + 1,
      payloadUtf8: encoded.slice(start, start + RENDERER_DELIVERY_CHUNK_BYTES),
    });
  }
  const finalSequence = chunkCount + 1;
  envelopes.push({ ...base, kind: "transferEnd", transferId, sequence: finalSequence });
  return {
    kind: "transfer",
    envelopes,
    acknowledgment: {
      targetId: base.targetId,
      generation: base.generation,
      transferId,
      expectedSequence: 0,
      finalSequence,
    },
  };
}

function transferKey(targetId: string, generation: number, transferId: string): string {
  return JSON.stringify([targetId, generation, transferId]);
}

function createAssemblerState(
  transfers: ReadonlyMap<string, ActiveRendererDeliveryTransfer>,
  reassemblyBytes: number,
): RendererDeliveryAssemblerState {
  return {
    activeTransferCount: transfers.size,
    reassemblyBytes,
    [ACTIVE_TRANSFERS]: transfers,
  };
}

export function createRendererDeliveryAssemblerState(): RendererDeliveryAssemblerState {
  return createAssemblerState(new Map(), 0);
}

function acknowledgmentFor(
  envelope:
    | RendererDeliveryTransferStartEnvelope
    | RendererDeliveryTransferChunkEnvelope
    | RendererDeliveryTransferEndEnvelope,
): RendererDeliveryTransferAckEnvelope {
  return {
    version: RENDERER_DELIVERY_WIRE_VERSION,
    kind: "transferAck",
    targetId: envelope.targetId,
    generation: envelope.generation,
    transferId: envelope.transferId,
    sequence: envelope.sequence,
  };
}

function parsePayloadBytes(payloadUtf8: Uint8Array): RendererDeliveryJsonValue {
  let json: string;
  try {
    json = UTF8_DECODER.decode(payloadUtf8);
  } catch (cause) {
    fail("invalidUtf8", "Renderer delivery payload is not valid UTF-8", { cause });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch (cause) {
    fail("invalidJson", "Renderer delivery payload is not valid JSON", { cause });
  }
  assertJsonPayload(payload);
  return payload;
}

function findActiveTransfer(
  state: RendererDeliveryAssemblerState,
  envelope: { readonly targetId: string; readonly generation: number; readonly transferId: string },
): { readonly key: string; readonly transfer: ActiveRendererDeliveryTransfer } {
  const key = transferKey(envelope.targetId, envelope.generation, envelope.transferId);
  const transfer = state[ACTIVE_TRANSFERS].get(key);
  if (!transfer) {
    fail("unknownTransfer", "Renderer delivery envelope does not match an active transfer");
  }
  return { key, transfer };
}

export function advanceRendererDeliveryAssembler(
  state: RendererDeliveryAssemblerState,
  value: unknown,
): RendererDeliveryAssemblyTransition {
  const envelope = parseRendererDeliveryEnvelope(value);
  if (envelope.kind === "inline") {
    return {
      kind: "complete",
      state,
      acknowledgment: null,
      delivery: {
        targetId: envelope.targetId,
        generation: envelope.generation,
        transferId: null,
        payload: parsePayloadBytes(envelope.payloadUtf8),
      },
    };
  }
  if (envelope.kind === "transferAck") {
    fail("invalidEnvelope", "A transfer acknowledgment cannot be assembled as payload data");
  }
  if (envelope.kind === "transferAbort") {
    const { key, transfer } = findActiveTransfer(state, envelope);
    const transfers = new Map(state[ACTIVE_TRANSFERS]);
    transfers.delete(key);
    return {
      kind: "aborted",
      state: createAssemblerState(transfers, state.reassemblyBytes - transfer.receivedBytes),
      transferId: envelope.transferId,
      reason: envelope.reason,
    };
  }
  if (envelope.kind === "transferStart") {
    const key = transferKey(envelope.targetId, envelope.generation, envelope.transferId);
    if (state[ACTIVE_TRANSFERS].has(key)) {
      fail("duplicateTransfer", "Renderer delivery transfer is already active");
    }
    if (state.activeTransferCount >= RENDERER_DELIVERY_MAX_ACTIVE_TRANSFERS) {
      fail("activeTransferLimit", "Renderer delivery active transfer limit is exhausted");
    }
    const transfers = new Map(state[ACTIVE_TRANSFERS]);
    transfers.set(key, {
      targetId: envelope.targetId,
      generation: envelope.generation,
      transferId: envelope.transferId,
      encodedBytes: envelope.encodedBytes,
      chunkCount: envelope.chunkCount,
      expectedSequence: 1,
      receivedBytes: 0,
      chunks: [],
    });
    return {
      kind: "accepted",
      state: createAssemblerState(transfers, state.reassemblyBytes),
      acknowledgment: acknowledgmentFor(envelope),
    };
  }

  const { key, transfer } = findActiveTransfer(state, envelope);
  if (envelope.sequence !== transfer.expectedSequence) {
    fail(
      "unexpectedSequence",
      `Renderer delivery expected sequence ${transfer.expectedSequence}, received ${envelope.sequence}`,
    );
  }
  if (envelope.kind === "transferChunk") {
    if (envelope.sequence > transfer.chunkCount) {
      fail("unexpectedSequence", "Renderer delivery received an extra transfer chunk");
    }
    const expectedChunkBytes = Math.min(
      RENDERER_DELIVERY_CHUNK_BYTES,
      transfer.encodedBytes - transfer.receivedBytes,
    );
    if (envelope.payloadUtf8.byteLength !== expectedChunkBytes) {
      fail(
        "chunkLengthMismatch",
        `Renderer delivery expected ${expectedChunkBytes} chunk bytes, received ${envelope.payloadUtf8.byteLength}`,
      );
    }
    if (
      state.reassemblyBytes + envelope.payloadUtf8.byteLength >
      RENDERER_DELIVERY_MAX_REASSEMBLY_BYTES
    ) {
      fail("reassemblyLimit", "Renderer delivery reassembly byte limit is exhausted");
    }
    const installedChunk = envelope.payloadUtf8.slice();
    const transfers = new Map(state[ACTIVE_TRANSFERS]);
    transfers.set(key, {
      ...transfer,
      expectedSequence: transfer.expectedSequence + 1,
      receivedBytes: transfer.receivedBytes + installedChunk.byteLength,
      chunks: [...transfer.chunks, installedChunk],
    });
    return {
      kind: "accepted",
      state: createAssemblerState(transfers, state.reassemblyBytes + installedChunk.byteLength),
      acknowledgment: acknowledgmentFor(envelope),
    };
  }

  if (
    transfer.expectedSequence !== transfer.chunkCount + 1 ||
    transfer.chunks.length !== transfer.chunkCount ||
    transfer.receivedBytes !== transfer.encodedBytes
  ) {
    fail("incompleteTransfer", "Renderer delivery transfer ended before every chunk arrived");
  }
  const payloadUtf8 = new Uint8Array(transfer.encodedBytes);
  let offset = 0;
  for (const chunk of transfer.chunks) {
    payloadUtf8.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = parsePayloadBytes(payloadUtf8);
  const transfers = new Map(state[ACTIVE_TRANSFERS]);
  transfers.delete(key);
  return {
    kind: "complete",
    state: createAssemblerState(transfers, state.reassemblyBytes - transfer.receivedBytes),
    acknowledgment: acknowledgmentFor(envelope),
    delivery: {
      targetId: envelope.targetId,
      generation: envelope.generation,
      transferId: envelope.transferId,
      payload,
    },
  };
}

export function advanceRendererDeliveryAcknowledgment(
  state: RendererDeliveryAcknowledgmentState,
  value: unknown,
): { readonly state: RendererDeliveryAcknowledgmentState | null; readonly complete: boolean } {
  const envelope = parseRendererDeliveryEnvelope(value);
  if (envelope.kind !== "transferAck") {
    fail("acknowledgmentMismatch", "Renderer delivery sender expected a transfer acknowledgment");
  }
  if (
    envelope.targetId !== state.targetId ||
    envelope.generation !== state.generation ||
    envelope.transferId !== state.transferId ||
    envelope.sequence !== state.expectedSequence
  ) {
    fail(
      "acknowledgmentMismatch",
      "Renderer delivery acknowledgment does not match the sender state",
    );
  }
  if (envelope.sequence === state.finalSequence) {
    return { state: null, complete: true };
  }
  return {
    state: { ...state, expectedSequence: state.expectedSequence + 1 },
    complete: false,
  };
}

export function releaseRendererDeliveryTarget(
  state: RendererDeliveryAssemblerState,
  target: RendererDeliveryTarget,
): RendererDeliveryTargetRelease {
  validateTarget(target);
  const transfers = new Map(state[ACTIVE_TRANSFERS]);
  const releasedTransferIds: string[] = [];
  let releasedBytes = 0;
  for (const [key, transfer] of state[ACTIVE_TRANSFERS]) {
    if (transfer.targetId !== target.targetId || transfer.generation !== target.generation)
      continue;
    transfers.delete(key);
    releasedTransferIds.push(transfer.transferId);
    releasedBytes += transfer.receivedBytes;
  }
  if (releasedTransferIds.length === 0) return { state, releasedTransferIds };
  return {
    state: createAssemblerState(transfers, state.reassemblyBytes - releasedBytes),
    releasedTransferIds,
  };
}
