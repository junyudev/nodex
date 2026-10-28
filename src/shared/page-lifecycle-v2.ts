import {
  canonicalizeTagName,
  parseDataSourceId,
  parseDataSourceOptionId,
  type DataSourceId,
  type DataSourceOptionId,
} from "./database-identities";
import {
  stableStringifyBlockPropertyJson,
  type BlockPropertyJsonValue,
} from "./block-property-mutations";
import {
  MAX_PAGE_ASSIGNEE_LENGTH,
  MAX_PAGE_DESCRIPTION_LENGTH,
  MAX_PAGE_TAG_COUNT,
  MAX_PAGE_TAG_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
} from "./page-limits";
import { isWorkflowStatus, type WorkflowStatus } from "./workflow-status";
import { isPriority } from "./priority";
import { isFractionalRankKey } from "./fractional-rank";
import { parseLocalCommitApply, type LocalCommitCommandSuccess } from "./local-commit-delivery";
import type {
  Estimate,
  PageRunInTarget,
  Priority,
  RecurrenceConfig,
  ReminderConfig,
} from "./types";
import {
  canonicalizePortableRichText,
  PortableRichTextError,
  portableRichTextPlainText,
  type PortableRichText,
} from "./block-documents/portable-rich-text";

const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 32_768;
const MAX_TIMEZONE_LENGTH = 256;
const MAX_ACTOR_JSON_LENGTH = 1_000_000;
const MAX_CANONICAL_REQUEST_LENGTH = 2_000_000;
const MAX_REMINDERS = 10_000;
const ESTIMATES = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);
const RUN_TARGETS = new Set<PageRunInTarget>(["localProject", "newWorktree", "cloud"]);
const RECURRENCE_FREQUENCIES = new Set<RecurrenceConfig["frequency"]>([
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);
const CREATE_PAGE_V2_REQUIRED_KEYS = [
  "kind",
  "pageId",
  "title",
  "markdown",
  "status",
  "viewPlacement",
  "dataSourceId",
  "tagOptionIds",
  "newTagOptions",
  "expectedTagsPropertyRevision",
] as const;
const CREATE_PAGE_V2_OPTIONAL_KEYS = [
  "priority",
  "estimate",
  "dueDate",
  "scheduledStart",
  "scheduledEnd",
  "isAllDay",
  "recurrence",
  "reminders",
  "scheduleTimezone",
  "assignee",
  "agentBlocked",
  "agentStatus",
  "runInTarget",
  "runInLocalPath",
  "runInBaseBranch",
  "runInWorktreePath",
  "runInEnvironmentPath",
  "beforeBlockId",
  "richTitle",
] as const;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class PageLifecycleV2ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageLifecycleV2ContractError";
  }
}

export interface CreatePageTagOptionV2 {
  readonly optionId: DataSourceOptionId;
  readonly name: string;
}

export type CreatePageViewPlacementV2 =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly pageId: string };

/**
 * Authority-ready Page creation. Names exist only for options created by this
 * exact request; persisted values always use owner-scoped option identities.
 */
export interface CreatePageOperationV2 {
  readonly kind: "create_page";
  readonly pageId: string;
  readonly title: string;
  readonly richTitle?: PortableRichText;
  readonly markdown: string;
  readonly status: WorkflowStatus;
  readonly priority: Priority | null;
  readonly estimate: Estimate | null;
  readonly dueDate: string | null;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly isAllDay: boolean;
  readonly recurrence: RecurrenceConfig | null;
  readonly reminders: readonly ReminderConfig[];
  readonly scheduleTimezone: string | null;
  readonly assignee: string | null;
  readonly runInTarget: PageRunInTarget;
  readonly runInLocalPath: string | null;
  readonly runInBaseBranch: string | null;
  readonly runInWorktreePath: string | null;
  readonly runInEnvironmentPath: string | null;
  readonly beforeBlockId?: string;
  readonly viewPlacement: CreatePageViewPlacementV2;
  readonly dataSourceId: DataSourceId;
  readonly tagOptionIds: readonly DataSourceOptionId[];
  readonly newTagOptions: readonly CreatePageTagOptionV2[];
  readonly expectedTagsPropertyRevision: number;
}

export interface ArchivePageOperationV2 {
  readonly kind: "archive_page";
  readonly pageId: string;
  readonly expectedMetadataRevision: number;
}

export interface UnarchivePageOperationV2 {
  readonly kind: "unarchive_page";
  readonly pageId: string;
  readonly expectedMetadataRevision: number;
}

export interface PageLifecycleDocumentHeadV2 {
  readonly documentId: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
}

export interface DeletePageOperationV2 {
  readonly kind: "delete_page";
  readonly pageId: string;
  readonly expectedMetadataRevision: number;
  readonly expectedParentRevision: number;
  readonly parentDocumentHead?: PageLifecycleDocumentHeadV2;
}

export interface RestorePageOperationV2 {
  readonly kind: "restore_page";
  readonly pageId: string;
  readonly deleteOperationId: string;
  readonly expectedMetadataRevision: number;
  readonly expectedParentRevision: number;
  readonly membership: null | Readonly<{
    membershipId: string;
    databaseId: string;
    dataSourceId: string;
    status: WorkflowStatus;
    position: null | Readonly<{
      viewId: string;
      beforeViewPageId?: string;
    }>;
  }>;
  readonly beforeBlockId?: string;
  readonly parentDocumentHead?: PageLifecycleDocumentHeadV2;
}

export interface MovePageInLibraryOperationV2 {
  readonly kind: "move_page_in_library";
  readonly pageId: string;
  readonly expectedParentRevision: number;
  readonly beforeBlockId?: string;
}

export type PageLifecycleOperationV2 =
  | CreatePageOperationV2
  | ArchivePageOperationV2
  | UnarchivePageOperationV2
  | DeletePageOperationV2
  | RestorePageOperationV2
  | MovePageInLibraryOperationV2;

export interface PageLifecycleMutationRequestV2 {
  readonly operationId: string;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly clientSessionId?: string;
  readonly actor: Readonly<Record<string, BlockPropertyJsonValue>>;
  readonly operation: PageLifecycleOperationV2;
}

export interface PageLifecycleMutationReceiptV2 {
  readonly operationKind: PageLifecycleOperationV2["kind"];
  readonly operationId: string;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly pageId: string;
  readonly duplicate: boolean;
  readonly metadataRevision: number;
  readonly parentRevision: number;
  readonly lifecycle: "active" | "archived" | "deleted";
  readonly documentId: string;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly databaseId: string | null;
  readonly dataSourceId: DataSourceId | null;
  readonly membershipId: string | null;
  readonly viewId: string | null;
  readonly libraryRankKey: string | null;
  readonly viewRankKey: string | null;
  readonly createdBlockIds: readonly string[];
  readonly createdTagOptionIds: readonly DataSourceOptionId[];
  readonly commitSeq: number;
  readonly committedAt: string;
}

export type PageLifecycleMutationErrorCodeV2 =
  | "invalid_page_lifecycle_request"
  | "store_epoch_mismatch"
  | "operation_id_collision"
  | "operation_receipt_corrupt"
  | "project_not_found"
  | "page_identity_collision"
  | "page_not_found"
  | "page_type_mismatch"
  | "page_lifecycle_conflict"
  | "metadata_revision_conflict"
  | "parent_revision_conflict"
  | "page_parent_invalid"
  | "position_anchor_not_found"
  | "position_anchor_group_mismatch"
  | "database_schema_invalid"
  | "database_property_value_invalid"
  | "membership_not_found"
  | "view_not_found"
  | "delete_evidence_invalid"
  | "document_state_corrupt"
  | "unknown"
  | "data_source_not_found"
  | "tags_property_not_found"
  | "tags_property_revision_conflict"
  | "tag_option_identity_conflict"
  | "tag_name_conflict";

export interface PageLifecycleMutationCommandErrorV2 {
  readonly code: PageLifecycleMutationErrorCodeV2;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly pageId?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
}

export type PageLifecycleMutationCommandResultV2 =
  | LocalCommitCommandSuccess<PageLifecycleMutationReceiptV2>
  | { readonly ok: false; readonly error: PageLifecycleMutationCommandErrorV2 };

const readRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new PageLifecycleV2ContractError(`${label} must be an object`);
};

const assertExactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PageLifecycleV2ContractError(
      `${label} contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
  const missing = required.filter((key) => value[key] === undefined);
  if (missing.length > 0) {
    throw new PageLifecycleV2ContractError(
      `${label} is missing required fields: ${missing.join(", ")}`,
    );
  }
};

const readId = (value: Readonly<Record<string, unknown>>, key: string, label: string): string => {
  const candidate = value[key];
  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_ID_LENGTH &&
    candidate === candidate.trim()
  ) {
    return candidate;
  }
  throw new PageLifecycleV2ContractError(`${label}.${key} must be a canonical non-empty identity`);
};

const readNonNegativeRevision = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number => {
  const revision = value[key];
  if (Number.isSafeInteger(revision) && (revision as number) >= 0) {
    return revision as number;
  }
  throw new PageLifecycleV2ContractError(`${label}.${key} must be a non-negative safe integer`);
};
const readPositiveRevision = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number => {
  const revision = value[key];
  if (Number.isSafeInteger(revision) && (revision as number) >= 1) {
    return revision as number;
  }
  throw new PageLifecycleV2ContractError(`${label}.${key} must be a safe integer >= 1`);
};

const readString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  maximum: number,
  options: { readonly allowEmpty?: boolean; readonly trim?: boolean } = {},
): string => {
  const candidate = value[key];
  if (
    typeof candidate === "string" &&
    candidate.length <= maximum &&
    (options.allowEmpty === true || candidate.length > 0) &&
    (options.trim !== true || candidate === candidate.trim())
  ) {
    return candidate;
  }
  throw new PageLifecycleV2ContractError(
    `${label}.${key} must be a bounded${options.allowEmpty ? "" : " non-empty"} string`,
  );
};

const readOptionalId = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | undefined => (value[key] === undefined ? undefined : readId(value, key, label));

const readOptionalDocumentHead = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): PageLifecycleDocumentHeadV2 | undefined => {
  if (value[key] === undefined) return undefined;
  const head = readRecord(value[key], `${label}.${key}`);
  assertExactKeys(head, `${label}.${key}`, ["documentId", "generation", "expectedHeadSeq"]);
  return {
    documentId: readId(head, "documentId", `${label}.${key}`),
    generation: readPositiveRevision(head, "generation", `${label}.${key}`),
    expectedHeadSeq: readNonNegativeRevision(head, "expectedHeadSeq", `${label}.${key}`),
  };
};

const readNullableString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  maximum: number,
): string | null => {
  if (value[key] === undefined || value[key] === null || value[key] === "") {
    return null;
  }
  return readString(value, key, label, maximum);
};

const readCanonicalDate = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return value;
    }
  }
  throw new PageLifecycleV2ContractError(`${label} must be YYYY-MM-DD or null`);
};

const readCanonicalDateTime = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) {
      return value;
    }
  }
  throw new PageLifecycleV2ContractError(`${label} must be a canonical ISO timestamp or null`);
};

const readRecurrence = (value: unknown): RecurrenceConfig | null => {
  if (value === undefined || value === null) return null;
  const label = "pageLifecycleV2.operation.recurrence";
  const recurrence = readRecord(value, label);
  assertExactKeys(recurrence, label, ["frequency", "interval"], ["byWeekdays", "endCondition"]);
  if (!RECURRENCE_FREQUENCIES.has(recurrence.frequency as RecurrenceConfig["frequency"])) {
    throw new PageLifecycleV2ContractError(`${label}.frequency is invalid`);
  }
  if (!Number.isSafeInteger(recurrence.interval) || (recurrence.interval as number) < 1) {
    throw new PageLifecycleV2ContractError(`${label}.interval must be an integer >= 1`);
  }
  let byWeekdays: number[] | undefined;
  if (recurrence.byWeekdays !== undefined) {
    if (
      !Array.isArray(recurrence.byWeekdays) ||
      recurrence.byWeekdays.length < 1 ||
      !recurrence.byWeekdays.every(
        (day) => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6,
      )
    ) {
      throw new PageLifecycleV2ContractError(`${label}.byWeekdays must contain weekdays 0-6`);
    }
    byWeekdays = [...new Set(recurrence.byWeekdays as number[])].sort(
      (left, right) => left - right,
    );
    if (byWeekdays.length !== recurrence.byWeekdays.length) {
      throw new PageLifecycleV2ContractError(`${label}.byWeekdays must be unique`);
    }
  }
  if (recurrence.frequency === "weekly" && byWeekdays === undefined) {
    throw new PageLifecycleV2ContractError("weekly recurrence requires byWeekdays");
  }
  let endCondition: RecurrenceConfig["endCondition"];
  if (recurrence.endCondition !== undefined) {
    const condition = readRecord(recurrence.endCondition, `${label}.endCondition`);
    if (condition.type === "never") {
      assertExactKeys(condition, `${label}.endCondition`, ["type"]);
      endCondition = { type: "never" };
    } else if (condition.type === "untilDate") {
      assertExactKeys(condition, `${label}.endCondition`, ["type", "untilDate"]);
      const untilDate = readCanonicalDate(condition.untilDate, `${label}.endCondition.untilDate`);
      if (untilDate === null) {
        throw new PageLifecycleV2ContractError("untilDate recurrence requires a date");
      }
      endCondition = { type: "untilDate", untilDate };
    } else {
      throw new PageLifecycleV2ContractError(`${label}.endCondition.type is invalid`);
    }
  }
  return {
    frequency: recurrence.frequency as RecurrenceConfig["frequency"],
    interval: recurrence.interval as number,
    ...(byWeekdays === undefined ? {} : { byWeekdays }),
    ...(endCondition === undefined ? {} : { endCondition }),
  };
};

const readReminders = (value: unknown): readonly ReminderConfig[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REMINDERS) {
    throw new PageLifecycleV2ContractError(
      `pageLifecycleV2.operation.reminders must be an array with at most ${MAX_REMINDERS} items`,
    );
  }
  const offsets = value.map((entry, index) => {
    const label = `pageLifecycleV2.operation.reminders[${index}]`;
    const reminder = readRecord(entry, label);
    assertExactKeys(reminder, label, ["offsetMinutes"]);
    if (
      Number.isSafeInteger(reminder.offsetMinutes) &&
      (reminder.offsetMinutes as number) >= 0 &&
      (reminder.offsetMinutes as number) <= 365 * 24 * 60
    ) {
      return reminder.offsetMinutes as number;
    }
    throw new PageLifecycleV2ContractError(`${label}.offsetMinutes is invalid`);
  });
  if (new Set(offsets).size !== offsets.length) {
    throw new PageLifecycleV2ContractError(
      "pageLifecycleV2.operation.reminders must have unique offsets",
    );
  }
  return offsets.sort((left, right) => left - right).map((offsetMinutes) => ({ offsetMinutes }));
};

const readActor = (value: unknown): Readonly<Record<string, BlockPropertyJsonValue>> => {
  const actor = readRecord(value, "pageLifecycleV2.actor");
  let canonical: string;
  try {
    canonical = stableStringifyBlockPropertyJson(actor);
  } catch (error) {
    throw new PageLifecycleV2ContractError(
      `pageLifecycleV2.actor must contain bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonical.length > MAX_ACTOR_JSON_LENGTH) {
    throw new PageLifecycleV2ContractError("pageLifecycleV2.actor exceeds the JSON size limit");
  }
  return JSON.parse(canonical) as Readonly<Record<string, BlockPropertyJsonValue>>;
};

const parseTagOptionId = (value: unknown, label: string): DataSourceOptionId => {
  try {
    return parseDataSourceOptionId({ propertyId: "tags", value });
  } catch (error) {
    throw new PageLifecycleV2ContractError(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const parseTagName = (value: unknown, label: string): string => {
  try {
    return canonicalizeTagName(value, { maxLength: MAX_PAGE_TAG_LENGTH });
  } catch (error) {
    throw new PageLifecycleV2ContractError(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const parseTagOptionIds = (value: unknown): readonly DataSourceOptionId[] => {
  if (!Array.isArray(value) || value.length > MAX_PAGE_TAG_COUNT) {
    throw new PageLifecycleV2ContractError(
      `pageLifecycleV2.operation.tagOptionIds must contain at most ${MAX_PAGE_TAG_COUNT} identities`,
    );
  }
  const ids = value.map((candidate, index) =>
    parseTagOptionId(candidate, `pageLifecycleV2.operation.tagOptionIds[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new PageLifecycleV2ContractError("pageLifecycleV2.operation.tagOptionIds must be unique");
  }
  return [...ids].sort(compareStrings);
};

const parseNewTagOptions = (
  value: unknown,
  selectedIds: ReadonlySet<string>,
): readonly CreatePageTagOptionV2[] => {
  if (!Array.isArray(value) || value.length > MAX_PAGE_TAG_COUNT) {
    throw new PageLifecycleV2ContractError(
      `pageLifecycleV2.operation.newTagOptions must contain at most ${MAX_PAGE_TAG_COUNT} options`,
    );
  }
  const options = value.map((candidate, index) => {
    const label = `pageLifecycleV2.operation.newTagOptions[${index}]`;
    const option = readRecord(candidate, label);
    assertExactKeys(option, label, ["optionId", "name"]);
    const optionId = parseTagOptionId(option.optionId, `${label}.optionId`);
    if (!selectedIds.has(optionId)) {
      throw new PageLifecycleV2ContractError(`${label}.optionId must also appear in tagOptionIds`);
    }
    return {
      optionId,
      name: parseTagName(option.name, `${label}.name`),
    };
  });
  if (new Set(options.map((option) => option.optionId)).size !== options.length) {
    throw new PageLifecycleV2ContractError(
      "pageLifecycleV2.operation.newTagOptions repeats an option identity",
    );
  }
  if (new Set(options.map((option) => option.name)).size !== options.length) {
    throw new PageLifecycleV2ContractError(
      "pageLifecycleV2.operation.newTagOptions repeats a canonical tag name",
    );
  }
  return [...options].sort((left, right) => compareStrings(left.optionId, right.optionId));
};

const parseCreateOperationV2 = (value: unknown): CreatePageOperationV2 => {
  const operation = readRecord(value, "pageLifecycleV2.operation");
  assertExactKeys(
    operation,
    "pageLifecycleV2.operation",
    CREATE_PAGE_V2_REQUIRED_KEYS,
    CREATE_PAGE_V2_OPTIONAL_KEYS,
  );
  if (operation.kind !== "create_page") {
    throw new PageLifecycleV2ContractError("pageLifecycleV2.operation.kind must be create_page");
  }

  const label = "pageLifecycleV2.operation";
  const title = readString(operation, "title", label, MAX_PAGE_TITLE_LENGTH);
  if (!title.trim()) {
    throw new PageLifecycleV2ContractError(`${label}.title cannot be blank`);
  }
  const markdown = readString(operation, "markdown", label, MAX_PAGE_DESCRIPTION_LENGTH, {
    allowEmpty: true,
  });
  let richTitle: PortableRichText | undefined;
  if (operation.richTitle !== undefined) {
    try {
      richTitle = canonicalizePortableRichText(operation.richTitle);
    } catch (error) {
      if (!(error instanceof PortableRichTextError)) throw error;
      throw new PageLifecycleV2ContractError(`${label}.richTitle is invalid: ${error.message}`);
    }
    if (portableRichTextPlainText(richTitle) !== title) {
      throw new PageLifecycleV2ContractError(
        `${label}.title must equal the richTitle plain-text projection`,
      );
    }
  }
  if (!isWorkflowStatus(operation.status)) {
    throw new PageLifecycleV2ContractError(`${label}.status is invalid`);
  }
  if (
    operation.priority !== undefined &&
    operation.priority !== null &&
    !isPriority(operation.priority)
  ) {
    throw new PageLifecycleV2ContractError(`${label}.priority is invalid`);
  }
  if (
    operation.estimate !== undefined &&
    operation.estimate !== null &&
    !ESTIMATES.has(operation.estimate as Estimate)
  ) {
    throw new PageLifecycleV2ContractError(`${label}.estimate is invalid`);
  }
  const scheduledStart = readCanonicalDateTime(operation.scheduledStart, `${label}.scheduledStart`);
  const scheduledEnd = readCanonicalDateTime(operation.scheduledEnd, `${label}.scheduledEnd`);
  if ((scheduledStart === null) !== (scheduledEnd === null)) {
    throw new PageLifecycleV2ContractError(
      `${label}.scheduledStart and scheduledEnd must be set together`,
    );
  }
  if (scheduledStart !== null && scheduledEnd !== null && scheduledEnd <= scheduledStart) {
    throw new PageLifecycleV2ContractError(`${label}.scheduledEnd must be after scheduledStart`);
  }
  const isAllDay = operation.isAllDay ?? false;
  if (typeof isAllDay !== "boolean") {
    throw new PageLifecycleV2ContractError(`${label}.isAllDay must be a boolean`);
  }
  if (isAllDay && scheduledStart === null) {
    throw new PageLifecycleV2ContractError(`${label}.isAllDay requires a scheduled range`);
  }
  const scheduleTimezone = readNullableString(
    operation,
    "scheduleTimezone",
    label,
    MAX_TIMEZONE_LENGTH,
  );
  if (scheduleTimezone !== null) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: scheduleTimezone });
    } catch {
      throw new PageLifecycleV2ContractError(`${label}.scheduleTimezone is invalid`);
    }
  }
  const runInTarget = operation.runInTarget ?? "localProject";
  if (!RUN_TARGETS.has(runInTarget as PageRunInTarget)) {
    throw new PageLifecycleV2ContractError(`${label}.runInTarget is invalid`);
  }

  let dataSourceId: DataSourceId;
  try {
    dataSourceId = parseDataSourceId(operation.dataSourceId);
  } catch (error) {
    throw new PageLifecycleV2ContractError(
      `pageLifecycleV2.operation.dataSourceId is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tagOptionIds = parseTagOptionIds(operation.tagOptionIds);
  const newTagOptions = parseNewTagOptions(operation.newTagOptions, new Set(tagOptionIds));
  const beforeBlockId = readOptionalId(operation, "beforeBlockId", label);
  const placement = readRecord(operation.viewPlacement, `${label}.viewPlacement`);
  const viewPlacement = (() => {
    if (placement.kind === "start" || placement.kind === "end") {
      assertExactKeys(placement, `${label}.viewPlacement`, ["kind"], []);
      return { kind: placement.kind } as const;
    }
    if (placement.kind === "before") {
      assertExactKeys(placement, `${label}.viewPlacement`, ["kind", "pageId"], []);
      return {
        kind: "before" as const,
        pageId: readId(placement, "pageId", `${label}.viewPlacement`),
      };
    }
    throw new PageLifecycleV2ContractError(`${label}.viewPlacement.kind is invalid`);
  })();
  return {
    kind: "create_page",
    pageId: readId(operation, "pageId", label),
    title,
    ...(richTitle === undefined ? {} : { richTitle }),
    markdown,
    status: operation.status,
    priority: (operation.priority as Priority | null | undefined) ?? null,
    estimate: (operation.estimate as Estimate | null | undefined) ?? null,
    dueDate: readCanonicalDate(operation.dueDate, `${label}.dueDate`),
    scheduledStart,
    scheduledEnd,
    isAllDay,
    recurrence: readRecurrence(operation.recurrence),
    reminders: readReminders(operation.reminders),
    scheduleTimezone,
    assignee: readNullableString(operation, "assignee", label, MAX_PAGE_ASSIGNEE_LENGTH),
    runInTarget: runInTarget as PageRunInTarget,
    runInLocalPath: readNullableString(operation, "runInLocalPath", label, MAX_PATH_LENGTH),
    runInBaseBranch: readNullableString(operation, "runInBaseBranch", label, MAX_PATH_LENGTH),
    runInWorktreePath: readNullableString(operation, "runInWorktreePath", label, MAX_PATH_LENGTH),
    runInEnvironmentPath: readNullableString(
      operation,
      "runInEnvironmentPath",
      label,
      MAX_PATH_LENGTH,
    ),
    ...(beforeBlockId === undefined ? {} : { beforeBlockId }),
    viewPlacement,
    dataSourceId,
    tagOptionIds,
    newTagOptions,
    expectedTagsPropertyRevision: readNonNegativeRevision(
      operation,
      "expectedTagsPropertyRevision",
      label,
    ),
  };
};

const parseOperationV2 = (value: unknown): PageLifecycleOperationV2 => {
  const operation = readRecord(value, "pageLifecycleV2.operation");
  if (operation.kind === "create_page") {
    return parseCreateOperationV2(operation);
  }
  const label = "pageLifecycleV2.operation";
  if (operation.kind === "archive_page" || operation.kind === "unarchive_page") {
    assertExactKeys(operation, label, ["kind", "pageId", "expectedMetadataRevision"]);
    return {
      kind: operation.kind,
      pageId: readId(operation, "pageId", label),
      expectedMetadataRevision: readPositiveRevision(operation, "expectedMetadataRevision", label),
    };
  }
  if (operation.kind === "delete_page") {
    assertExactKeys(
      operation,
      label,
      ["kind", "pageId", "expectedMetadataRevision", "expectedParentRevision"],
      ["parentDocumentHead"],
    );
    const parentDocumentHead = readOptionalDocumentHead(operation, "parentDocumentHead", label);
    return {
      kind: "delete_page",
      pageId: readId(operation, "pageId", label),
      expectedMetadataRevision: readPositiveRevision(operation, "expectedMetadataRevision", label),
      expectedParentRevision: readPositiveRevision(operation, "expectedParentRevision", label),
      ...(parentDocumentHead === undefined ? {} : { parentDocumentHead }),
    };
  }
  if (operation.kind === "restore_page") {
    assertExactKeys(
      operation,
      label,
      [
        "kind",
        "pageId",
        "deleteOperationId",
        "expectedMetadataRevision",
        "expectedParentRevision",
        "membership",
      ],
      ["beforeBlockId", "parentDocumentHead"],
    );
    let membership: RestorePageOperationV2["membership"];
    if (operation.membership === null) {
      membership = null;
    } else {
      const candidate = readRecord(operation.membership, `${label}.membership`);
      assertExactKeys(candidate, `${label}.membership`, [
        "membershipId",
        "databaseId",
        "dataSourceId",
        "status",
        "position",
      ]);
      if (!isWorkflowStatus(candidate.status)) {
        throw new PageLifecycleV2ContractError(`${label}.membership.status is invalid`);
      }
      let dataSourceId: DataSourceId;
      try {
        dataSourceId = parseDataSourceId(candidate.dataSourceId);
      } catch (error) {
        throw new PageLifecycleV2ContractError(
          `${label}.membership.dataSourceId is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      let position: Exclude<RestorePageOperationV2["membership"], null>["position"];
      if (candidate.position === undefined) {
        throw new PageLifecycleV2ContractError(
          `${label}.membership.position must be null or an object`,
        );
      }
      if (candidate.position === null) {
        position = null;
      } else {
        const positionCandidate = readRecord(candidate.position, `${label}.membership.position`);
        assertExactKeys(
          positionCandidate,
          `${label}.membership.position`,
          ["viewId"],
          ["beforeViewPageId"],
        );
        const beforeViewPageId = readOptionalId(
          positionCandidate,
          "beforeViewPageId",
          `${label}.membership.position`,
        );
        position = {
          viewId: readId(positionCandidate, "viewId", `${label}.membership.position`),
          ...(beforeViewPageId === undefined ? {} : { beforeViewPageId }),
        };
      }
      membership = {
        membershipId: readId(candidate, "membershipId", `${label}.membership`),
        databaseId: readId(candidate, "databaseId", `${label}.membership`),
        dataSourceId,
        status: candidate.status,
        position,
      };
    }
    const beforeBlockId = readOptionalId(operation, "beforeBlockId", label);
    const parentDocumentHead = readOptionalDocumentHead(operation, "parentDocumentHead", label);
    return {
      kind: "restore_page",
      pageId: readId(operation, "pageId", label),
      deleteOperationId: readId(operation, "deleteOperationId", label),
      expectedMetadataRevision: readPositiveRevision(operation, "expectedMetadataRevision", label),
      expectedParentRevision: readPositiveRevision(operation, "expectedParentRevision", label),
      membership,
      ...(parentDocumentHead === undefined ? {} : { parentDocumentHead }),
      ...(beforeBlockId === undefined ? {} : { beforeBlockId }),
    };
  }
  if (operation.kind === "move_page_in_library") {
    assertExactKeys(
      operation,
      label,
      ["kind", "pageId", "expectedParentRevision"],
      ["beforeBlockId"],
    );
    const beforeBlockId = readOptionalId(operation, "beforeBlockId", label);
    return {
      kind: "move_page_in_library",
      pageId: readId(operation, "pageId", label),
      expectedParentRevision: readPositiveRevision(operation, "expectedParentRevision", label),
      ...(beforeBlockId === undefined ? {} : { beforeBlockId }),
    };
  }
  throw new PageLifecycleV2ContractError("pageLifecycleV2.operation.kind is not supported");
};

export const parsePageLifecycleMutationRequestV2 = (
  value: unknown,
): PageLifecycleMutationRequestV2 => {
  const request = readRecord(value, "pageLifecycleV2");
  assertExactKeys(
    request,
    "pageLifecycleV2",
    ["operationId", "projectId", "storeEpoch", "actor", "operation"],
    ["clientSessionId"],
  );

  const operation = parseOperationV2(request.operation);
  const clientSessionId = readOptionalId(request, "clientSessionId", "pageLifecycleV2");
  const parsed: PageLifecycleMutationRequestV2 = {
    operationId: readId(request, "operationId", "pageLifecycleV2"),
    projectId: readNullableId(request, "projectId", "pageLifecycleV2"),
    storeEpoch: readId(request, "storeEpoch", "pageLifecycleV2"),
    ...(clientSessionId === undefined ? {} : { clientSessionId }),
    actor: readActor(request.actor),
    operation,
  };
  if (parsed.operation.kind === "create_page" && parsed.projectId === null) {
    throw new PageLifecycleV2ContractError("Page creation requires a default Project destination");
  }
  const canonical = canonicalizeParsedRequest(parsed);
  if (canonical.length <= MAX_CANONICAL_REQUEST_LENGTH) return parsed;
  throw new PageLifecycleV2ContractError(
    "pageLifecycleV2 exceeds the canonical request size limit",
  );
};

const canonicalizeParsedRequest = (request: PageLifecycleMutationRequestV2): string =>
  stableStringifyBlockPropertyJson({
    operationId: request.operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    operation: request.operation,
  });

export const canonicalizePageLifecycleMutationRequestV2 = (value: unknown): string =>
  canonicalizeParsedRequest(parsePageLifecycleMutationRequestV2(value));

const RECEIPT_KEYS_V2 = [
  "operationId",
  "projectId",
  "storeEpoch",
  "operationKind",
  "pageId",
  "duplicate",
  "metadataRevision",
  "parentRevision",
  "lifecycle",
  "documentId",
  "documentGeneration",
  "documentHeadSeq",
  "databaseId",
  "dataSourceId",
  "membershipId",
  "viewId",
  "libraryRankKey",
  "viewRankKey",
  "createdBlockIds",
  "createdTagOptionIds",
  "commitSeq",
  "committedAt",
] as const;

const PAGE_LIFECYCLE_OPERATION_KINDS_V2 = new Set<PageLifecycleOperationV2["kind"]>([
  "create_page",
  "archive_page",
  "unarchive_page",
  "delete_page",
  "restore_page",
  "move_page_in_library",
]);

const readBoolean = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): boolean => {
  if (typeof value[key] === "boolean") return value[key];
  throw new PageLifecycleV2ContractError(`${label}.${key} must be a boolean`);
};

const readNullableId = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | null => {
  if (value[key] === null) return null;
  return readId(value, key, label);
};

const readNullableRank = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | null => {
  if (value[key] === null) return null;
  const rankKey = readId(value, key, label);
  if (isFractionalRankKey(rankKey)) return rankKey;
  throw new PageLifecycleV2ContractError(
    `${label}.${key} must be a canonical fractional rank or null`,
  );
};

const readNullableDataSourceId = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): DataSourceId | null => {
  if (value[key] === null) return null;
  try {
    return parseDataSourceId(value[key]);
  } catch (error) {
    throw new PageLifecycleV2ContractError(
      `${label}.${key} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const parsePageLifecycleMutationReceiptV2 = (
  value: unknown,
): PageLifecycleMutationReceiptV2 => {
  const receipt = readRecord(value, "pageLifecycleReceiptV2");
  const label = "pageLifecycleReceiptV2";
  assertExactKeys(receipt, label, RECEIPT_KEYS_V2);
  if (
    !PAGE_LIFECYCLE_OPERATION_KINDS_V2.has(
      receipt.operationKind as PageLifecycleOperationV2["kind"],
    )
  ) {
    throw new PageLifecycleV2ContractError(`${label}.operationKind is invalid`);
  }
  if (
    receipt.lifecycle !== "active" &&
    receipt.lifecycle !== "archived" &&
    receipt.lifecycle !== "deleted"
  ) {
    throw new PageLifecycleV2ContractError(`${label}.lifecycle is invalid`);
  }
  if (
    !Array.isArray(receipt.createdBlockIds) ||
    !receipt.createdBlockIds.every(
      (blockId) =>
        typeof blockId === "string" &&
        blockId.length > 0 &&
        blockId.length <= MAX_ID_LENGTH &&
        blockId === blockId.trim(),
    ) ||
    new Set(receipt.createdBlockIds).size !== receipt.createdBlockIds.length
  ) {
    throw new PageLifecycleV2ContractError(`${label}.createdBlockIds is invalid`);
  }
  const committedAt = readString(receipt, "committedAt", label, 128);
  const committedDate = new Date(committedAt);
  if (Number.isNaN(committedDate.getTime()) || committedDate.toISOString() !== committedAt) {
    throw new PageLifecycleV2ContractError(`${label}.committedAt must be canonical ISO time`);
  }
  return {
    operationId: readId(receipt, "operationId", label),
    projectId: readNullableId(receipt, "projectId", label),
    storeEpoch: readId(receipt, "storeEpoch", label),
    operationKind: receipt.operationKind as PageLifecycleOperationV2["kind"],
    pageId: readId(receipt, "pageId", label),
    duplicate: readBoolean(receipt, "duplicate", label),
    metadataRevision: readPositiveRevision(receipt, "metadataRevision", label),
    parentRevision: readPositiveRevision(receipt, "parentRevision", label),
    lifecycle: receipt.lifecycle,
    documentId: readId(receipt, "documentId", label),
    documentGeneration: readPositiveRevision(receipt, "documentGeneration", label),
    documentHeadSeq: readPositiveRevision(receipt, "documentHeadSeq", label),
    databaseId: readNullableId(receipt, "databaseId", label),
    dataSourceId: readNullableDataSourceId(receipt, "dataSourceId", label),
    membershipId: readNullableId(receipt, "membershipId", label),
    viewId: readNullableId(receipt, "viewId", label),
    libraryRankKey: readNullableRank(receipt, "libraryRankKey", label),
    viewRankKey: readNullableRank(receipt, "viewRankKey", label),
    createdBlockIds: [...receipt.createdBlockIds],
    createdTagOptionIds: parseTagOptionIds(receipt.createdTagOptionIds),
    commitSeq: readPositiveRevision(receipt, "commitSeq", label),
    committedAt,
  };
};

const PAGE_LIFECYCLE_V2_ERROR_CODES = new Set<PageLifecycleMutationErrorCodeV2>([
  "invalid_page_lifecycle_request",
  "store_epoch_mismatch",
  "operation_id_collision",
  "operation_receipt_corrupt",
  "project_not_found",
  "page_identity_collision",
  "page_not_found",
  "page_type_mismatch",
  "page_lifecycle_conflict",
  "metadata_revision_conflict",
  "parent_revision_conflict",
  "page_parent_invalid",
  "position_anchor_not_found",
  "position_anchor_group_mismatch",
  "data_source_not_found",
  "tags_property_not_found",
  "tags_property_revision_conflict",
  "tag_option_identity_conflict",
  "tag_name_conflict",
  "database_schema_invalid",
  "database_property_value_invalid",
  "membership_not_found",
  "view_not_found",
  "delete_evidence_invalid",
  "document_state_corrupt",
  "unknown",
]);

export const parsePageLifecycleMutationCommandErrorV2 = (
  value: unknown,
): PageLifecycleMutationCommandErrorV2 => {
  const error = readRecord(value, "pageLifecycleErrorV2");
  assertExactKeys(
    error,
    "pageLifecycleErrorV2",
    ["code", "message", "retryable"],
    ["operationId", "pageId", "expectedRevision", "actualRevision"],
  );
  if (
    typeof error.code !== "string" ||
    !PAGE_LIFECYCLE_V2_ERROR_CODES.has(error.code as PageLifecycleMutationErrorCodeV2)
  ) {
    throw new PageLifecycleV2ContractError("pageLifecycleErrorV2.code is invalid");
  }
  if (
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > 10_000
  ) {
    throw new PageLifecycleV2ContractError(
      "pageLifecycleErrorV2.message must be a bounded non-empty string",
    );
  }
  if (typeof error.retryable !== "boolean") {
    throw new PageLifecycleV2ContractError("pageLifecycleErrorV2.retryable must be a boolean");
  }
  const operationId =
    error.operationId === undefined
      ? undefined
      : readId(error, "operationId", "pageLifecycleErrorV2");
  const pageId =
    error.pageId === undefined ? undefined : readId(error, "pageId", "pageLifecycleErrorV2");
  const expectedRevision =
    error.expectedRevision === undefined
      ? undefined
      : readNonNegativeRevision(error, "expectedRevision", "pageLifecycleErrorV2");
  const actualRevision =
    error.actualRevision === undefined
      ? undefined
      : readNonNegativeRevision(error, "actualRevision", "pageLifecycleErrorV2");
  if ((expectedRevision === undefined) !== (actualRevision === undefined)) {
    throw new PageLifecycleV2ContractError(
      "pageLifecycleErrorV2 must carry both expectedRevision and actualRevision",
    );
  }
  return {
    code: error.code as PageLifecycleMutationErrorCodeV2,
    message: error.message,
    retryable: error.retryable,
    ...(operationId === undefined ? {} : { operationId }),
    ...(pageId === undefined ? {} : { pageId }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
};

export const parsePageLifecycleMutationCommandResultV2 = (
  value: unknown,
): PageLifecycleMutationCommandResultV2 => {
  const result = readRecord(value, "pageLifecycleResultV2");
  if (result.ok === true) {
    assertExactKeys(result, "pageLifecycleResultV2", ["ok", "value", "localCommit"]);
    return {
      ok: true,
      value: parsePageLifecycleMutationReceiptV2(result.value),
      localCommit: parseLocalCommitApply(result.localCommit),
    };
  }
  if (result.ok === false) {
    assertExactKeys(result, "pageLifecycleResultV2", ["ok", "error"]);
    return {
      ok: false,
      error: parsePageLifecycleMutationCommandErrorV2(result.error),
    };
  }
  throw new PageLifecycleV2ContractError("pageLifecycleResultV2.ok must be a boolean");
};
