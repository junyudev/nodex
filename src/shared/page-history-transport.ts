import {
  MAX_PAGE_HISTORY_PAGE_SIZE,
  type PageBlockMutationHistoryEntry,
  type PageBlockRelocationHistoryEntry,
  type PageDocumentVersionHistoryEntry,
  type PageHistoryCategory,
  type PageHistoryCursor,
  type PageHistoryDisplay,
  type PageHistoryEntry,
  type PageHistoryEvidence,
  type PageHistoryPage,
  type PageHistoryRecovery,
  type ListPageHistoryRequest,
} from "./page-history";

const MAX_ID_LENGTH = 512;
const MAX_ENTRY_ID_LENGTH = 1_024;
const MAX_ERROR_MESSAGE_LENGTH = 4_096;
const MAX_DISPLAY_TITLE_LENGTH = 256;
const MAX_DISPLAY_DETAIL_LENGTH = 512;
const MAX_ACTOR_LABEL_LENGTH = 256;

const HISTORY_CATEGORIES = new Set<PageHistoryCategory>([
  "checkpoint",
  "content",
  "property",
  "database",
  "lifecycle",
  "location",
  "unknown",
]);

const HISTORY_ERROR_CODES = new Set<PageHistoryCommandErrorCode>([
  "invalid_page_history_request",
  "page_not_found",
  "page_history_corrupt",
  "unknown",
]);

export type PageHistoryCommandErrorCode =
  | "invalid_page_history_request"
  | "page_not_found"
  | "page_history_corrupt"
  | "unknown";

export interface PageHistoryCommandError {
  readonly code: PageHistoryCommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type PageHistoryCommandResult =
  | { readonly ok: true; readonly value: PageHistoryPage }
  | { readonly ok: false; readonly error: PageHistoryCommandError };

export class PageHistoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageHistoryContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new PageHistoryContractError(`${label} must be an object`);
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
    throw new PageHistoryContractError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    throw new PageHistoryContractError(`${label}.${key} is not supported`);
  }
};

const readStringValue = (value: unknown, label: string, maximumLength = MAX_ID_LENGTH): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  ) {
    return value;
  }
  throw new PageHistoryContractError(`${label} must be a non-empty bounded string`);
};

const readNullableStringValue = (
  value: unknown,
  label: string,
  maximumLength: number,
): string | null => {
  if (value === null) return null;
  return readStringValue(value, label, maximumLength);
};

const readSafeIntegerValue = (
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {
    return value;
  }
  throw new PageHistoryContractError(`${label} must be a safe integer in range`);
};

const readNullableSafeIntegerValue = (
  value: unknown,
  label: string,
  minimum: number,
): number | null => {
  if (value === null) return null;
  return readSafeIntegerValue(value, label, minimum);
};

const readCanonicalTimestamp = (value: unknown, label: string): string => {
  const timestamp = readStringValue(value, label, 256);
  if (Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp) {
    return timestamp;
  }
  throw new PageHistoryContractError(`${label} must be a canonical ISO timestamp`);
};

const readHash = (value: unknown, label: string): string => {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) return value;
  throw new PageHistoryContractError(`${label} must be a SHA-256 digest`);
};

export const parsePageHistoryCursor = (
  value: unknown,
  label = "pageHistoryCursor",
): PageHistoryCursor => {
  const record = readRecord(value, label);
  if (record.source === "document_version") {
    assertExactKeys(record, label, ["occurredAt", "source", "versionId"]);
    return {
      occurredAt: readCanonicalTimestamp(record.occurredAt, `${label}.occurredAt`),
      source: "document_version",
      versionId: readStringValue(record.versionId, `${label}.versionId`),
    };
  }
  if (record.source === "change_log") {
    assertExactKeys(record, label, ["occurredAt", "source", "changeSeq"]);
    return {
      occurredAt: readCanonicalTimestamp(record.occurredAt, `${label}.occurredAt`),
      source: "change_log",
      changeSeq: readSafeIntegerValue(record.changeSeq, `${label}.changeSeq`, 1),
    };
  }
  throw new PageHistoryContractError(`${label}.source is unsupported`);
};

export const parseListPageHistoryRequest = (value: unknown): ListPageHistoryRequest => {
  const label = "listPageHistory";
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["requestingProjectId", "pageId"], ["before", "pageSize"]);
  const before =
    record.before === undefined
      ? undefined
      : parsePageHistoryCursor(record.before, `${label}.before`);
  const pageSize =
    record.pageSize === undefined
      ? undefined
      : readSafeIntegerValue(record.pageSize, `${label}.pageSize`, 1, MAX_PAGE_HISTORY_PAGE_SIZE);
  return {
    requestingProjectId: readStringValue(
      record.requestingProjectId,
      `${label}.requestingProjectId`,
    ),
    pageId: readStringValue(record.pageId, `${label}.pageId`),
    ...(before === undefined ? {} : { before }),
    ...(pageSize === undefined ? {} : { pageSize }),
  };
};

const parseDisplay = (value: unknown, label: string): PageHistoryDisplay => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["category", "title", "detail", "actorLabel"]);
  if (
    typeof record.category !== "string" ||
    !HISTORY_CATEGORIES.has(record.category as PageHistoryCategory)
  ) {
    throw new PageHistoryContractError(`${label}.category is unsupported`);
  }
  return {
    category: record.category as PageHistoryCategory,
    title: readStringValue(record.title, `${label}.title`, MAX_DISPLAY_TITLE_LENGTH),
    detail: readNullableStringValue(record.detail, `${label}.detail`, MAX_DISPLAY_DETAIL_LENGTH),
    actorLabel: readNullableStringValue(
      record.actorLabel,
      `${label}.actorLabel`,
      MAX_ACTOR_LABEL_LENGTH,
    ),
  };
};

const parseEvidence = (value: unknown, label: string): PageHistoryEvidence => {
  const record = readRecord(value, label);
  if (record.status === "verified") {
    assertExactKeys(record, label, ["status"]);
    return { status: "verified" };
  }
  if (record.status === "unavailable") {
    assertExactKeys(record, label, ["status", "reason"]);
    if (
      record.reason === "missing_ledger" ||
      record.reason === "malformed_evidence" ||
      record.reason === "unsupported_evidence"
    ) {
      return { status: "unavailable", reason: record.reason };
    }
  }
  throw new PageHistoryContractError(`${label} is invalid`);
};

const parseRecovery = (value: unknown, label: string): PageHistoryRecovery => {
  const record = readRecord(value, label);
  if (record.kind === "restore_document_version") {
    assertExactKeys(record, label, ["kind", "documentId", "versionId"]);
    return {
      kind: "restore_document_version",
      documentId: readStringValue(record.documentId, `${label}.documentId`),
      versionId: readStringValue(record.versionId, `${label}.versionId`),
    };
  }
  if (record.kind === "unavailable") {
    assertExactKeys(record, label, ["kind", "reason"]);
    if (
      record.reason === "document_generation_changed" ||
      record.reason === "insufficient_evidence" ||
      record.reason === "no_inverse_contract"
    ) {
      return { kind: "unavailable", reason: record.reason };
    }
  }
  throw new PageHistoryContractError(`${label} is invalid`);
};

interface ParsedEntryBase {
  readonly id: string;
  readonly libraryId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly occurredAt: string;
  readonly display: PageHistoryDisplay;
  readonly evidence: PageHistoryEvidence;
  readonly recovery: PageHistoryRecovery;
}

const parseEntryBase = (
  record: Readonly<Record<string, unknown>>,
  label: string,
): ParsedEntryBase => ({
  id: readStringValue(record.id, `${label}.id`, MAX_ENTRY_ID_LENGTH),
  libraryId: readStringValue(record.libraryId, `${label}.libraryId`),
  pageId: readStringValue(record.pageId, `${label}.pageId`),
  documentId: readStringValue(record.documentId, `${label}.documentId`),
  occurredAt: readCanonicalTimestamp(record.occurredAt, `${label}.occurredAt`),
  display: parseDisplay(record.display, `${label}.display`),
  evidence: parseEvidence(record.evidence, `${label}.evidence`),
  recovery: parseRecovery(record.recovery, `${label}.recovery`),
});

const ENTRY_BASE_KEYS = [
  "id",
  "kind",
  "libraryId",
  "pageId",
  "documentId",
  "occurredAt",
  "display",
  "evidence",
  "recovery",
] as const;

const parseVersionEntry = (
  record: Readonly<Record<string, unknown>>,
  label: string,
): PageDocumentVersionHistoryEntry => {
  assertExactKeys(record, label, [...ENTRY_BASE_KEYS, "versionMetadata"]);
  const metadataLabel = `${label}.versionMetadata`;
  const metadata = readRecord(record.versionMetadata, metadataLabel);
  assertExactKeys(metadata, metadataLabel, [
    "versionId",
    "generation",
    "baseHeadSeq",
    "schemaKey",
    "schemaVersion",
    "cause",
    "label",
    "revisionKind",
    "sourceMutationId",
    "sourceChangeSeq",
    "pinned",
    "checkpointHash",
    "byteLength",
  ]);
  const base = parseEntryBase(record, label);
  const revisionKind = metadata.revisionKind;
  if (
    revisionKind !== "automatic" &&
    revisionKind !== "manual" &&
    revisionKind !== "operation" &&
    revisionKind !== "restore" &&
    revisionKind !== "safety"
  ) {
    throw new PageHistoryContractError(`${metadataLabel}.revisionKind is not supported`);
  }
  if (typeof metadata.pinned !== "boolean") {
    throw new PageHistoryContractError(`${metadataLabel}.pinned must be boolean`);
  }
  return {
    ...base,
    kind: "document_version",
    versionMetadata: {
      versionId: readStringValue(metadata.versionId, `${metadataLabel}.versionId`),
      generation: readSafeIntegerValue(metadata.generation, `${metadataLabel}.generation`, 1),
      baseHeadSeq: readSafeIntegerValue(metadata.baseHeadSeq, `${metadataLabel}.baseHeadSeq`, 0),
      schemaKey: readStringValue(metadata.schemaKey, `${metadataLabel}.schemaKey`, 128),
      schemaVersion: readSafeIntegerValue(
        metadata.schemaVersion,
        `${metadataLabel}.schemaVersion`,
        1,
      ),
      cause: readStringValue(metadata.cause, `${metadataLabel}.cause`, 128),
      label: readNullableStringValue(metadata.label, `${metadataLabel}.label`, 512),
      revisionKind,
      sourceMutationId: readNullableStringValue(
        metadata.sourceMutationId,
        `${metadataLabel}.sourceMutationId`,
        MAX_ID_LENGTH,
      ),
      sourceChangeSeq: readNullableSafeIntegerValue(
        metadata.sourceChangeSeq,
        `${metadataLabel}.sourceChangeSeq`,
        1,
      ),
      pinned: metadata.pinned,
      checkpointHash: readHash(metadata.checkpointHash, `${metadataLabel}.checkpointHash`),
      byteLength: readSafeIntegerValue(metadata.byteLength, `${metadataLabel}.byteLength`, 1),
    },
  };
};

const parseMutationEntry = (
  record: Readonly<Record<string, unknown>>,
  label: string,
): PageBlockMutationHistoryEntry => {
  assertExactKeys(record, label, [
    ...ENTRY_BASE_KEYS,
    "changeSeq",
    "mutationId",
    "mutationKind",
    "affectedBlockCount",
    "fieldIntentCount",
  ]);
  return {
    ...parseEntryBase(record, label),
    kind: "block_mutation",
    changeSeq: readSafeIntegerValue(record.changeSeq, `${label}.changeSeq`, 1),
    mutationId: readNullableStringValue(record.mutationId, `${label}.mutationId`, MAX_ID_LENGTH),
    mutationKind: readNullableStringValue(record.mutationKind, `${label}.mutationKind`, 128),
    affectedBlockCount: readNullableSafeIntegerValue(
      record.affectedBlockCount,
      `${label}.affectedBlockCount`,
      0,
    ),
    fieldIntentCount: readNullableSafeIntegerValue(
      record.fieldIntentCount,
      `${label}.fieldIntentCount`,
      0,
    ),
  };
};

const parseRelocationEntry = (
  record: Readonly<Record<string, unknown>>,
  label: string,
): PageBlockRelocationHistoryEntry => {
  assertExactKeys(record, label, [
    ...ENTRY_BASE_KEYS,
    "changeSeq",
    "relocationId",
    "direction",
    "movedBlockCount",
  ]);
  if (
    record.direction !== "into_page" &&
    record.direction !== "out_of_page" &&
    record.direction !== "within_page" &&
    record.direction !== "unknown"
  ) {
    throw new PageHistoryContractError(`${label}.direction is unsupported`);
  }
  return {
    ...parseEntryBase(record, label),
    kind: "block_relocation",
    changeSeq: readSafeIntegerValue(record.changeSeq, `${label}.changeSeq`, 1),
    relocationId: readNullableStringValue(
      record.relocationId,
      `${label}.relocationId`,
      MAX_ID_LENGTH,
    ),
    direction: record.direction,
    movedBlockCount: readNullableSafeIntegerValue(
      record.movedBlockCount,
      `${label}.movedBlockCount`,
      0,
    ),
  };
};

const parseEntry = (value: unknown, label: string): PageHistoryEntry => {
  const record = readRecord(value, label);
  if (record.kind === "document_version") {
    return parseVersionEntry(record, label);
  }
  if (record.kind === "block_mutation") {
    return parseMutationEntry(record, label);
  }
  if (record.kind === "block_relocation") {
    return parseRelocationEntry(record, label);
  }
  throw new PageHistoryContractError(`${label}.kind is unsupported`);
};

const cursorForEntry = (entry: PageHistoryEntry): PageHistoryCursor =>
  entry.kind === "document_version"
    ? {
        occurredAt: entry.occurredAt,
        source: "document_version",
        versionId: entry.versionMetadata.versionId,
      }
    : {
        occurredAt: entry.occurredAt,
        source: "change_log",
        changeSeq: entry.changeSeq,
      };

const sameCursor = (left: PageHistoryCursor, right: PageHistoryCursor): boolean => {
  if (left.source !== right.source || left.occurredAt !== right.occurredAt) {
    return false;
  }
  if (left.source === "document_version" && right.source === "document_version") {
    return left.versionId === right.versionId;
  }
  return (
    left.source === "change_log" &&
    right.source === "change_log" &&
    left.changeSeq === right.changeSeq
  );
};

export const parsePageHistoryPage = (value: unknown): PageHistoryPage => {
  const label = "pageHistoryPage";
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["libraryId", "pageId", "documentId", "entries", "nextCursor"]);
  if (!Array.isArray(record.entries)) {
    throw new PageHistoryContractError(`${label}.entries must be an array`);
  }
  if (record.entries.length > MAX_PAGE_HISTORY_PAGE_SIZE) {
    throw new PageHistoryContractError(`${label}.entries exceeds the page budget`);
  }
  const libraryId = readStringValue(record.libraryId, `${label}.libraryId`);
  const pageId = readStringValue(record.pageId, `${label}.pageId`);
  const documentId = readStringValue(record.documentId, `${label}.documentId`);
  const entries = record.entries.map((entry, index) =>
    parseEntry(entry, `${label}.entries[${index}]`),
  );
  const entryIds = new Set(entries.map((entry) => entry.id));
  if (entryIds.size !== entries.length) {
    throw new PageHistoryContractError(`${label}.entries contains duplicate ids`);
  }
  if (
    !entries.every(
      (entry) =>
        entry.libraryId === libraryId && entry.pageId === pageId && entry.documentId === documentId,
    )
  ) {
    throw new PageHistoryContractError(`${label}.entries escaped their scope`);
  }
  const nextCursor =
    record.nextCursor === null
      ? null
      : parsePageHistoryCursor(record.nextCursor, `${label}.nextCursor`);
  const lastEntry = entries.at(-1);
  if (nextCursor && (!lastEntry || !sameCursor(nextCursor, cursorForEntry(lastEntry)))) {
    throw new PageHistoryContractError(`${label}.nextCursor must identify the final entry`);
  }
  return {
    libraryId,
    pageId,
    documentId,
    entries,
    nextCursor,
  };
};

export const pageHistoryFailure = (
  code: PageHistoryCommandErrorCode,
  message: string,
  retryable = false,
): PageHistoryCommandError => ({ code, message, retryable });

const parseCommandError = (value: unknown): PageHistoryCommandError => {
  const label = "pageHistoryError";
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["code", "message", "retryable"]);
  if (
    typeof record.code !== "string" ||
    !HISTORY_ERROR_CODES.has(record.code as PageHistoryCommandErrorCode)
  ) {
    throw new PageHistoryContractError(`${label}.code is unsupported`);
  }
  if (typeof record.retryable !== "boolean") {
    throw new PageHistoryContractError(`${label}.retryable must be boolean`);
  }
  return {
    code: record.code as PageHistoryCommandErrorCode,
    message: readStringValue(record.message, `${label}.message`, MAX_ERROR_MESSAGE_LENGTH),
    retryable: record.retryable,
  };
};

export const parsePageHistoryCommandResult = (value: unknown): PageHistoryCommandResult => {
  const label = "pageHistoryResult";
  const record = readRecord(value, label);
  if (record.ok === true) {
    assertExactKeys(record, label, ["ok", "value"]);
    return { ok: true, value: parsePageHistoryPage(record.value) };
  }
  if (record.ok === false) {
    assertExactKeys(record, label, ["ok", "error"]);
    return { ok: false, error: parseCommandError(record.error) };
  }
  throw new PageHistoryContractError(`${label}.ok must be boolean`);
};

export const pageHistoryTransportFailure = (): PageHistoryCommandResult => ({
  ok: false,
  error: pageHistoryFailure("unknown", "The durable Page history reader is unavailable", true),
});
