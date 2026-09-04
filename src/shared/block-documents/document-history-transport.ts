import { stableStringifyBlockPropertyJson } from "../block-property-mutations";
import type {
  BlockDocumentAssetReference,
  BlockDocumentReference,
  BlockTreeNode,
  BlockTreeValue,
} from "./block-document-codec";
import { parsePortableCanvasScene } from "./canvas-scene";
import type { RegisteredOwnedDocumentMaterialization } from "./document-schema-adapters";
import {
  MAX_DOCUMENT_VERSION_CAUSE_LENGTH,
  MAX_DOCUMENT_VERSION_HISTORY_LIMIT,
  MAX_DOCUMENT_VERSION_LABEL_LENGTH,
  type CreateDocumentVersionCheckpoint,
  type DocumentVersionActor,
  type DocumentVersionDetail,
  type DocumentVersionSummary,
  type GetDocumentVersion,
  type ListDocumentVersions,
} from "./document-history";
import { canonicalizePortableRichText } from "./portable-rich-text";

const MAX_SCOPE_ID_LENGTH = 512;

export type DocumentHistoryCommandErrorCode =
  | "invalid_document_history_request"
  | "store_epoch_mismatch"
  | "document_not_found"
  | "document_not_ready"
  | "project_scope_mismatch"
  | "document_generation_conflict"
  | "document_head_conflict"
  | "document_version_not_found"
  | "document_version_schema_mismatch"
  | "document_history_corrupt"
  | "unknown";

export interface DocumentHistoryCommandError {
  readonly code: DocumentHistoryCommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly expectedGeneration?: number;
  readonly actualGeneration?: number;
  readonly expectedHeadSeq?: number;
  readonly actualHeadSeq?: number;
}

export type DocumentHistoryCommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DocumentHistoryCommandError };

export class DocumentHistoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentHistoryContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new DocumentHistoryContractError(`${label} must be an object`);
};

const assertExactKeys = (
  record: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (Object.hasOwn(record, key)) continue;
    throw new DocumentHistoryContractError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    throw new DocumentHistoryContractError(`${label}.${key} is not supported`);
  }
};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  maximumLength = MAX_SCOPE_ID_LENGTH,
): string => {
  const value = record[key];
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  ) {
    return value;
  }
  throw new DocumentHistoryContractError(`${label}.${key} must be a non-empty bounded string`);
};

const readInteger = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const value = record[key];
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {
    return value;
  }
  throw new DocumentHistoryContractError(`${label}.${key} must be a safe integer in range`);
};

const readActor = (value: unknown, label: string): DocumentVersionActor => {
  if (!isRecord(value)) {
    throw new DocumentHistoryContractError(`${label} must be an object`);
  }
  try {
    return JSON.parse(stableStringifyBlockPropertyJson(value)) as Readonly<
      Record<string, BlockTreeValue>
    >;
  } catch (error) {
    throw new DocumentHistoryContractError(
      `${label} must be bounded portable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const parseCreateDocumentVersionCheckpoint = (
  value: unknown,
): CreateDocumentVersionCheckpoint => {
  const label = "createDocumentVersionCheckpoint";
  const record = readRecord(value, label);
  assertExactKeys(
    record,
    label,
    [
      "operationId",
      "projectId",
      "storeEpoch",
      "documentId",
      "expectedGeneration",
      "expectedHeadSeq",
      "cause",
      "actor",
    ],
    ["label", "revisionKind", "sourceMutationId", "sourceChangeSeq"],
  );
  const optionalLabel =
    record.label === undefined
      ? undefined
      : readString(record, "label", label, MAX_DOCUMENT_VERSION_LABEL_LENGTH);
  const revisionKind = record.revisionKind;
  if (
    revisionKind !== undefined &&
    revisionKind !== "automatic" &&
    revisionKind !== "manual" &&
    revisionKind !== "operation" &&
    revisionKind !== "restore" &&
    revisionKind !== "safety"
  ) {
    throw new DocumentHistoryContractError(`${label}.revisionKind is not supported`);
  }
  const sourceMutationId =
    record.sourceMutationId === undefined
      ? undefined
      : readString(record, "sourceMutationId", label);
  const sourceChangeSeq =
    record.sourceChangeSeq === undefined
      ? undefined
      : readInteger(record, "sourceChangeSeq", label, 1);
  const effectiveRevisionKind = revisionKind ?? "manual";
  const linksMutation =
    effectiveRevisionKind === "operation" || effectiveRevisionKind === "restore";
  if (sourceChangeSeq !== undefined && sourceMutationId === undefined) {
    throw new DocumentHistoryContractError(`${label}.sourceChangeSeq requires sourceMutationId`);
  }
  if (linksMutation && sourceMutationId === undefined) {
    throw new DocumentHistoryContractError(
      `${label}.${effectiveRevisionKind} requires sourceMutationId`,
    );
  }
  if (!linksMutation && sourceMutationId !== undefined) {
    throw new DocumentHistoryContractError(
      `${label}.${effectiveRevisionKind} cannot link mutation evidence`,
    );
  }
  return {
    operationId: readString(record, "operationId", label),
    projectId: readString(record, "projectId", label),
    storeEpoch: readString(record, "storeEpoch", label),
    documentId: readString(record, "documentId", label),
    expectedGeneration: readInteger(record, "expectedGeneration", label, 1),
    expectedHeadSeq: readInteger(record, "expectedHeadSeq", label, 0),
    cause: readString(record, "cause", label, MAX_DOCUMENT_VERSION_CAUSE_LENGTH),
    ...(optionalLabel === undefined ? {} : { label: optionalLabel }),
    actor: readActor(record.actor, `${label}.actor`),
    ...(revisionKind === undefined ? {} : { revisionKind }),
    ...(sourceMutationId === undefined ? {} : { sourceMutationId }),
    ...(sourceChangeSeq === undefined ? {} : { sourceChangeSeq }),
  };
};

export const parseListDocumentVersions = (value: unknown): ListDocumentVersions => {
  const label = "listDocumentVersions";
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["projectId", "documentId"], ["before", "limit"]);
  const limit =
    record.limit === undefined
      ? undefined
      : readInteger(record, "limit", label, 1, MAX_DOCUMENT_VERSION_HISTORY_LIMIT);
  let before: ListDocumentVersions["before"];
  if (record.before !== undefined) {
    const cursor = readRecord(record.before, `${label}.before`);
    assertExactKeys(cursor, `${label}.before`, ["baseHeadSeq", "createdAt", "versionId"]);
    before = {
      baseHeadSeq: readInteger(cursor, "baseHeadSeq", `${label}.before`, 0),
      createdAt: readString(cursor, "createdAt", `${label}.before`, 256),
      versionId: readString(cursor, "versionId", `${label}.before`),
    };
  }
  return {
    projectId: readString(record, "projectId", label),
    documentId: readString(record, "documentId", label),
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  };
};

export const parseGetDocumentVersion = (value: unknown): GetDocumentVersion => {
  const label = "getDocumentVersion";
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["projectId", "documentId", "versionId"]);
  return {
    projectId: readString(record, "projectId", label),
    documentId: readString(record, "documentId", label),
    versionId: readString(record, "versionId", label),
  };
};

const readNullableString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  allowEmpty = false,
): string | null => {
  if (record[key] === null) return null;
  if (allowEmpty) return readPossiblyEmptyString(record, key, label);
  return readString(record, key, label, 2_000_000);
};

const readPossiblyEmptyString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string => {
  const value = record[key];
  if (typeof value === "string" && value.length <= 2_000_000) return value;
  throw new DocumentHistoryContractError(`${label}.${key} must be a bounded string`);
};

const readNullableInteger = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number | null => {
  if (record[key] === null) return null;
  return readInteger(record, key, label, 1);
};

export const parseDocumentVersionSummary = (value: unknown): DocumentVersionSummary => {
  const label = "documentVersionSummary";
  const summary = readRecord(value, label);
  assertExactKeys(summary, label, [
    "versionId",
    "documentId",
    "projectId",
    "generation",
    "baseHeadSeq",
    "schemaKey",
    "schemaVersion",
    "cause",
    "label",
    "actor",
    "revisionKind",
    "sourceMutationId",
    "sourceChangeSeq",
    "pinned",
    "checkpointHash",
    "materializationHash",
    "byteLength",
    "materializationKind",
    "title",
    "preview",
    "blockCount",
    "createdAt",
    "checkpointMetadata",
  ]);
  const revisionKind = summary.revisionKind;
  if (
    revisionKind !== "automatic" &&
    revisionKind !== "manual" &&
    revisionKind !== "operation" &&
    revisionKind !== "restore" &&
    revisionKind !== "safety"
  ) {
    throw new DocumentHistoryContractError(`${label}.revisionKind is not supported`);
  }
  const materializationKind = summary.materializationKind;
  if (
    materializationKind !== "page" &&
    materializationKind !== "synced_block" &&
    materializationKind !== "reusable_template" &&
    materializationKind !== "canvas_scene"
  ) {
    throw new DocumentHistoryContractError(`${label}.materializationKind is not supported`);
  }
  const pinned = summary.pinned;
  if (typeof pinned !== "boolean") {
    throw new DocumentHistoryContractError(`${label}.pinned must be a boolean`);
  }
  const checkpointHash = readString(summary, "checkpointHash", label, 64);
  const materializationHash = readString(summary, "materializationHash", label, 64);
  for (const [key, hash] of [
    ["checkpointHash", checkpointHash],
    ["materializationHash", materializationHash],
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new DocumentHistoryContractError(`${label}.${key} must be lowercase SHA-256 hex`);
    }
  }
  const checkpointMetadata = readRecord(summary.checkpointMetadata, `${label}.checkpointMetadata`);
  let parsedCheckpointMetadata: DocumentVersionSummary["checkpointMetadata"];
  if (checkpointMetadata.format === "yjs_update_v1") {
    assertExactKeys(checkpointMetadata, `${label}.checkpointMetadata`, [
      "format",
      "stateVectorHash",
    ]);
    if (
      typeof checkpointMetadata.stateVectorHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(checkpointMetadata.stateVectorHash)
    ) {
      throw new DocumentHistoryContractError(
        `${label}.checkpointMetadata.stateVectorHash must be lowercase SHA-256 hex`,
      );
    }
    parsedCheckpointMetadata = {
      format: "yjs_update_v1",
      stateVectorHash: checkpointMetadata.stateVectorHash,
    };
  } else if (checkpointMetadata.format === "block_tree_snapshot_v2") {
    assertExactKeys(checkpointMetadata, `${label}.checkpointMetadata`, ["format"]);
    parsedCheckpointMetadata = { format: "block_tree_snapshot_v2" };
  } else if (checkpointMetadata.format === "canvas_scene_json_v1") {
    assertExactKeys(checkpointMetadata, `${label}.checkpointMetadata`, ["format"]);
    parsedCheckpointMetadata = { format: "canvas_scene_json_v1" };
  } else {
    throw new DocumentHistoryContractError(`${label}.checkpointMetadata.format is not supported`);
  }
  const sourceMutationId = readNullableString(summary, "sourceMutationId", label);
  const sourceChangeSeq = readNullableInteger(summary, "sourceChangeSeq", label);
  const linksMutation = revisionKind === "operation" || revisionKind === "restore";
  if (sourceChangeSeq !== null && sourceMutationId === null) {
    throw new DocumentHistoryContractError(`${label}.sourceChangeSeq requires sourceMutationId`);
  }
  if (linksMutation !== (sourceMutationId !== null)) {
    throw new DocumentHistoryContractError(
      `${label}.revisionKind and sourceMutationId do not agree`,
    );
  }
  const title = readNullableString(summary, "title", label, true);
  if ((materializationKind === "page") !== (title !== null)) {
    throw new DocumentHistoryContractError(
      `${label}.title does not agree with materializationKind`,
    );
  }
  if (
    (materializationKind === "canvas_scene") !==
    (parsedCheckpointMetadata.format === "canvas_scene_json_v1")
  ) {
    throw new DocumentHistoryContractError(
      `${label}.checkpointMetadata does not agree with materializationKind`,
    );
  }
  const versionId = readString(summary, "versionId", label);
  if (!/^document-version:[a-f0-9]{64}$/u.test(versionId)) {
    throw new DocumentHistoryContractError(
      `${label}.versionId must be a canonical Document version identity`,
    );
  }
  const createdAt = readString(summary, "createdAt", label, 256);
  const parsedCreatedAt = new Date(createdAt);
  if (Number.isNaN(parsedCreatedAt.valueOf()) || parsedCreatedAt.toISOString() !== createdAt) {
    throw new DocumentHistoryContractError(`${label}.createdAt must be a canonical ISO timestamp`);
  }
  return {
    versionId,
    documentId: readString(summary, "documentId", label),
    projectId: readString(summary, "projectId", label),
    generation: readInteger(summary, "generation", label, 1),
    baseHeadSeq: readInteger(summary, "baseHeadSeq", label, 0),
    schemaKey: readString(summary, "schemaKey", label),
    schemaVersion: readInteger(summary, "schemaVersion", label, 1),
    cause: readString(summary, "cause", label, MAX_DOCUMENT_VERSION_CAUSE_LENGTH),
    label: readNullableString(summary, "label", label),
    actor: readActor(summary.actor, `${label}.actor`),
    revisionKind,
    sourceMutationId,
    sourceChangeSeq,
    pinned,
    checkpointHash,
    materializationHash,
    byteLength: readInteger(summary, "byteLength", label, 1),
    materializationKind,
    title,
    preview: readPossiblyEmptyString(summary, "preview", label),
    blockCount: readInteger(summary, "blockCount", label, 0),
    createdAt,
    checkpointMetadata: parsedCheckpointMetadata,
  };
};

export const parseDocumentVersionDetail = (value: unknown): DocumentVersionDetail => {
  const label = "documentVersionDetail";
  const detail = readRecord(value, label);
  assertExactKeys(detail, label, ["summary", "materialization"]);
  const summary = parseDocumentVersionSummary(detail.summary);
  const materialization = readRecord(detail.materialization, `${label}.materialization`);
  if (materialization.kind !== summary.materializationKind) {
    throw new DocumentHistoryContractError(
      `${label}.materialization.kind does not match its summary`,
    );
  }
  let parsedMaterialization: RegisteredOwnedDocumentMaterialization;
  if (summary.materializationKind === "canvas_scene") {
    try {
      parsedMaterialization = parsePortableCanvasScene(materialization);
    } catch (error) {
      throw new DocumentHistoryContractError(
        `${label}.materialization is not a canonical Canvas scene: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    const portableArray = <Value>(key: string): readonly Value[] => {
      const candidate = materialization[key];
      if (!Array.isArray(candidate)) {
        throw new DocumentHistoryContractError(`${label}.materialization.${key} must be an array`);
      }
      try {
        return JSON.parse(stableStringifyBlockPropertyJson(candidate)) as readonly Value[];
      } catch (error) {
        throw new DocumentHistoryContractError(
          `${label}.materialization.${key} must be bounded portable JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const common = {
      schemaVersion: readInteger(materialization, "schemaVersion", `${label}.materialization`, 1),
      blockTree: portableArray<BlockTreeNode>("blockTree"),
      nfm: readPossiblyEmptyString(materialization, "nfm", `${label}.materialization`),
      plainText: readPossiblyEmptyString(materialization, "plainText", `${label}.materialization`),
      preview: readPossiblyEmptyString(materialization, "preview", `${label}.materialization`),
      references: portableArray<BlockDocumentReference>("references"),
      assetRefs: portableArray<BlockDocumentAssetReference>("assetRefs"),
    };
    if (summary.materializationKind === "page") {
      let richTitle;
      try {
        richTitle = canonicalizePortableRichText(materialization.richTitle);
      } catch (error) {
        throw new DocumentHistoryContractError(
          `${label}.materialization.richTitle is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        stableStringifyBlockPropertyJson(richTitle) !==
        stableStringifyBlockPropertyJson(materialization.richTitle)
      ) {
        throw new DocumentHistoryContractError(
          `${label}.materialization.richTitle is not canonical`,
        );
      }
      parsedMaterialization = {
        kind: "page",
        title: readPossiblyEmptyString(materialization, "title", `${label}.materialization`),
        richTitle,
        ...common,
      };
    } else {
      parsedMaterialization = {
        kind: summary.materializationKind,
        ...common,
      };
    }
  }
  const countBlockTree = (nodes: readonly unknown[]): number =>
    nodes.reduce<number>((count, node, index) => {
      const record = readRecord(node, `${label}.materialization.blockTree[${index}]`);
      if (
        typeof record.id !== "string" ||
        typeof record.type !== "string" ||
        !isRecord(record.props) ||
        !Array.isArray(record.children)
      ) {
        throw new DocumentHistoryContractError(
          `${label}.materialization.blockTree[${index}] has invalid field shapes`,
        );
      }
      return count + 1 + countBlockTree(record.children);
    }, 0);
  const parsedBlockCount =
    parsedMaterialization.kind === "canvas_scene"
      ? parsedMaterialization.elements.length
      : countBlockTree(parsedMaterialization.blockTree);
  if (
    parsedMaterialization.preview !== summary.preview ||
    parsedBlockCount !== summary.blockCount ||
    (parsedMaterialization.kind === "page" && parsedMaterialization.title !== summary.title)
  ) {
    throw new DocumentHistoryContractError(
      `${label}.materialization does not match its summary projection`,
    );
  }
  return {
    summary,
    materialization: parsedMaterialization,
  };
};

export const bindTrustedDocumentVersionCheckpoint = (
  rawRequest: unknown,
  projectId: string,
  documentId: string,
  actor: DocumentVersionActor,
): CreateDocumentVersionCheckpoint => {
  const request = parseCreateDocumentVersionCheckpoint(rawRequest);
  if (request.projectId !== projectId || request.documentId !== documentId) {
    throw new DocumentHistoryContractError(
      "Document checkpoint does not match its Project and Document scope",
    );
  }
  return parseCreateDocumentVersionCheckpoint({
    ...request,
    projectId,
    documentId,
    actor,
  });
};

export const documentHistoryFailure = (
  code: DocumentHistoryCommandErrorCode,
  message: string,
  options: Omit<Partial<DocumentHistoryCommandError>, "code" | "message" | "retryable"> & {
    readonly retryable?: boolean;
  } = {},
): DocumentHistoryCommandError => {
  const { retryable = false, ...details } = options;
  return { code, message, retryable, ...details };
};

export const documentHistoryHttpStatus = (
  error: DocumentHistoryCommandError,
): 400 | 404 | 409 | 500 | 503 => {
  if (error.code === "document_not_found" || error.code === "document_version_not_found") {
    return 404;
  }
  if (
    error.code === "store_epoch_mismatch" ||
    error.code === "document_not_ready" ||
    error.code === "document_generation_conflict" ||
    error.code === "document_head_conflict" ||
    error.code === "document_version_schema_mismatch"
  ) {
    return 409;
  }
  if (error.code === "unknown" && error.retryable) return 503;
  if (error.code === "unknown" || error.code === "document_history_corrupt") {
    return 500;
  }
  return 400;
};
