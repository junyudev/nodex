import { CORE_TRANSPORT_BUDGETS, type components } from "@nodex/core-protocol";
import {
  decodeDocumentHttpEnvelope,
  encodeDocumentHttpEnvelope,
  DocumentHttpWireError,
} from "./http-wire";

type Schemas = components["schemas"];
type Metadata = Schemas["DocumentModuleFrameMetadata"];
type Read = Schemas["OwnedDocumentReadRequest"]["read"];
type Intent = Schemas["OwnedDocumentApplyRequest"]["intent"];
type BinaryRead = Extract<Read, { kind: "sync_yjs" | "fetch_update" | "recovery_artifact" }>;
type BinaryIntent = Extract<Intent, { kind: "apply_yjs_update" | "apply_canvas_mutation" }>;
const empty = new Uint8Array();
const utf8 = new TextEncoder();
const contentBytes = CORE_TRANSPORT_BUDGETS.document_content_bytes;
const vectorBytes = CORE_TRANSPORT_BUDGETS.document_state_vector_bytes;

export const isBinaryDocumentRead = (read: Read): read is BinaryRead =>
  read.kind === "sync_yjs" || read.kind === "fetch_update" || read.kind === "recovery_artifact";
export const isBinaryDocumentIntent = (intent: Intent): intent is BinaryIntent =>
  intent.kind === "apply_yjs_update" || intent.kind === "apply_canvas_mutation";

const encode = (metadata: Metadata, payload: Uint8Array, limit: number): Uint8Array => {
  if (payload.length > limit) throw new DocumentHttpWireError("Document payload exceeds its bound");
  const frame = encodeDocumentHttpEnvelope(metadata, payload);
  if (frame.length > CORE_TRANSPORT_BUDGETS.document_response_bytes)
    throw new DocumentHttpWireError("Document frame exceeds its bound");
  return frame;
};

/** The generated semantic request retains its original operation and live-session coordinates. */
export const encodeDocumentModuleRead = (
  request: Schemas["OwnedDocumentReadRequest"],
): Uint8Array => {
  const read = request.read;
  if (!isBinaryDocumentRead(read))
    throw new DocumentHttpWireError("This read uses Document control transport");
  return encode(
    {
      kind: "module_read",
      request: {
        ...request,
        read: read.kind === "sync_yjs" ? { ...read, state_vector: [] } : read,
      },
    },
    read.kind === "sync_yjs" ? Uint8Array.from(read.state_vector) : empty,
    vectorBytes,
  );
};

export const encodeDocumentModuleApply = (
  request: Schemas["OwnedDocumentApplyRequest"],
): Uint8Array => {
  const intent = request.intent;
  if (!isBinaryDocumentIntent(intent))
    throw new DocumentHttpWireError("This command uses Document control transport");
  return encode(
    {
      kind: "module_apply",
      request: {
        ...request,
        intent:
          intent.kind === "apply_yjs_update"
            ? { ...intent, update: [] }
            : { ...intent, mutation: null },
      },
    },
    intent.kind === "apply_yjs_update"
      ? Uint8Array.from(intent.update)
      : utf8.encode(JSON.stringify(intent.mutation)),
    intent.kind === "apply_yjs_update"
      ? CORE_TRANSPORT_BUDGETS.document_update_bytes
      : contentBytes,
  );
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const metadata = (value: unknown): Metadata => {
  if (
    !record(value) ||
    !["module_read_response", "module_apply_response"].includes(String(value.kind)) ||
    !record(value.response) ||
    !["ok", "error"].includes(String(value.response.status)) ||
    !record(value.response.payload)
  )
    throw new DocumentHttpWireError("Invalid Document Module response");
  if (
    value.kind === "module_read_response" &&
    (!Number.isSafeInteger(value.state_vector_bytes) || Number(value.state_vector_bytes) < 0)
  )
    throw new DocumentHttpWireError("Invalid Document state vector length");
  if (value.kind === "module_apply_response" && typeof value.has_canvas !== "boolean")
    throw new DocumentHttpWireError("Invalid Document Canvas payload descriptor");
  return value as Metadata;
};

export const decodeDocumentModuleRead = (
  bytes: Uint8Array,
): Schemas["OwnedDocumentReadResponse"] => {
  const frame = decodeDocumentHttpEnvelope(bytes, metadata, contentBytes + vectorBytes);
  if (frame.metadata.kind !== "module_read_response")
    throw new DocumentHttpWireError("Expected Document read response");
  const { response, state_vector_bytes: length } = frame.metadata;
  if (length > vectorBytes || length > frame.payload.length)
    throw new DocumentHttpWireError("Invalid Document state vector length");
  if (response.status === "error") {
    if (frame.payload.length) throw new DocumentHttpWireError("Unexpected Document error payload");
    return response;
  }
  const update = frame.payload.subarray(0, frame.payload.length - length);
  const value = response.payload.value;
  if (
    value.kind === "yjs_sync" &&
    value.update.length === 0 &&
    update.length <= contentBytes &&
    value.descriptor.sync.kind === "yjs" &&
    value.descriptor.sync.stateVector.length === 0
  ) {
    return {
      ...response,
      payload: {
        ...response.payload,
        value: {
          ...value,
          update: Array.from(update),
          descriptor: {
            ...value.descriptor,
            sync: { kind: "yjs", stateVector: Array.from(frame.payload.subarray(update.length)) },
          },
        },
      },
    };
  }
  if (length || update.length > CORE_TRANSPORT_BUDGETS.document_update_bytes)
    throw new DocumentHttpWireError("Invalid Document update response length");
  if (value.kind === "recovery_artifact" && value.artifact.update.length === 0)
    return {
      ...response,
      payload: {
        ...response.payload,
        value: { ...value, artifact: { ...value.artifact, update: Array.from(update) } },
      },
    };
  if (value.kind === "update_resource" && value.resource.update.length === 0)
    return {
      ...response,
      payload: {
        ...response.payload,
        value: { ...value, resource: { ...value.resource, update: Array.from(update) } },
      },
    };
  if (value.kind === "update_resource_unavailable" && !frame.payload.length) return response;
  throw new DocumentHttpWireError("Unexpected Document byte response");
};

export const decodeDocumentModuleApply = (
  bytes: Uint8Array,
): Schemas["OwnedDocumentApplyResponse"] => {
  const frame = decodeDocumentHttpEnvelope(bytes, metadata, contentBytes);
  if (frame.metadata.kind !== "module_apply_response")
    throw new DocumentHttpWireError("Expected Document apply response");
  const { response, has_canvas } = frame.metadata;
  if (!has_canvas) {
    if (frame.payload.length)
      throw new DocumentHttpWireError("Unexpected Document apply response payload");
    return response;
  }
  if (response.status !== "ok" || response.payload.outcome.canvas != null)
    throw new DocumentHttpWireError("Unexpected Canvas response");
  const canvas: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(frame.payload),
  );
  return {
    ...response,
    payload: { ...response.payload, outcome: { ...response.payload.outcome, canvas } },
  };
};
