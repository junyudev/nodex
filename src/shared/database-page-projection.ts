import type {
  DatabaseContainerDescriptorV2,
  DatabaseViewRecordV2,
  DataSourcePageRowV2,
  DataSourceDescriptorV2,
  DataSourceQueryResultV2,
  DatabaseViewQueryResultV2,
  PageIntrinsicPropertyValueV2,
} from "./database-module-v2";
import type {
  BoardSummary,
  DatabasePage,
  DatabasePageSummary,
  Estimate,
  PageRunInTarget,
  Priority,
  RecurrenceConfig,
  ReminderConfig,
} from "./types";
import type { components } from "@nodex/core-protocol";
import {
  evaluateDatabaseViewRows,
  type DatabaseViewJsonValue,
  type DatabaseViewReadModel,
  type ReadDatabaseViewReferenceInput,
} from "./database-views";
import type { AuthorizedReadStamp } from "./authorized-read-stamp";
import { stableStringifyDatabaseJson } from "./database-kernel";
import { toDatabasePageSummary } from "./page-summary";
import { WORKFLOW_STATUS_COLUMNS, isWorkflowStatus } from "./workflow-status";
import { isPriority } from "./priority";
import { assertValidPageInput } from "./page-input-validation";
import { projectCoreDatabaseQueryRow } from "./core-database-row-projection";
import { parseDataSourceOptionId } from "./database-identities";

type CoreDatabaseRowDetail = components["schemas"]["DatabaseRowDetail"];
type CoreDatabaseRowSummary = components["schemas"]["DatabaseRowSummary"];
type CoreDatabaseViewWindow = components["schemas"]["DatabaseViewWindow"];
type CoreDataSourceQueryWindow = components["schemas"]["DatabaseDataSourceQueryWindow"];

const INTRINSIC_PROPERTY_KEYS = [
  "run.target",
  "run.localPath",
  "run.baseBranch",
  "run.worktreePath",
  "run.environmentPath",
  "schedule.isAllDay",
  "schedule.timezone",
  "recurrence.config",
  "reminders.config",
] as const;

const ESTIMATES = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);
const RUN_TARGETS = new Set<PageRunInTarget>(["localProject", "newWorktree", "cloud"]);
const UNPOSITIONED_PAGE_ORDER = Number.MAX_SAFE_INTEGER;

type DatabasePropertyId =
  | "status"
  | "priority"
  | "estimate"
  | "tags"
  | "due_date"
  | "scheduled_start"
  | "scheduled_end"
  | "assignee";
type IntrinsicPropertyKey = (typeof INTRINSIC_PROPERTY_KEYS)[number];

export class DatabasePageProjectionError extends Error {
  constructor(
    readonly pageId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Database Page ${pageId} ${message}`, options);
    this.name = "DatabasePageProjectionError";
  }
}

const fail = (pageId: string, message: string, options?: ErrorOptions): never => {
  throw new DatabasePageProjectionError(pageId, message, options);
};

const requireDatabaseValue = (
  row: DataSourcePageRowV2,
  propertyId: DatabasePropertyId,
): unknown => {
  const property = row.values[propertyId];
  if (property) return property.value;
  return fail(row.page.pageId, `is missing Database Property ${propertyId}`);
};

const indexIntrinsicProperties = (
  row: DataSourcePageRowV2,
): ReadonlyMap<string, PageIntrinsicPropertyValueV2> => {
  if (!row.intrinsicProperties) {
    return fail(row.page.pageId, "is missing intrinsic Property evidence");
  }
  const indexed = new Map<string, PageIntrinsicPropertyValueV2>();
  for (const property of row.intrinsicProperties) {
    if (indexed.has(property.key)) {
      return fail(row.page.pageId, `repeats intrinsic Property ${property.key}`);
    }
    indexed.set(property.key, property);
  }
  return indexed;
};

const requireIntrinsicValue = (
  row: DataSourcePageRowV2,
  properties: ReadonlyMap<string, PageIntrinsicPropertyValueV2>,
  key: IntrinsicPropertyKey,
): unknown => {
  const property = properties.get(key);
  if (property) return property.value;
  return fail(row.page.pageId, `is missing intrinsic Property ${key}`);
};

const nullableString = (
  row: DataSourcePageRowV2,
  label: string,
  value: unknown,
): string | undefined => {
  if (value === null) return undefined;
  if (typeof value === "string") return value;
  return fail(row.page.pageId, `${label} must be a string or null`);
};

const optionalDate = (
  row: DataSourcePageRowV2,
  label: string,
  value: unknown,
): Date | undefined => {
  const text = nullableString(row, label, value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) return date;
  return fail(row.page.pageId, `${label} is not a valid date`);
};

const requireStringArray = (
  row: DataSourcePageRowV2,
  label: string,
  value: unknown,
): readonly string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return fail(row.page.pageId, `${label} must be an array of strings`);
};

const readTagOptionIds = (row: DataSourcePageRowV2): string[] =>
  [...requireStringArray(row, "Database Property tags", requireDatabaseValue(row, "tags"))]
    .map((optionId) => {
      try {
        return parseDataSourceOptionId({ propertyId: "tags", value: optionId });
      } catch (cause) {
        return fail(row.page.pageId, "has an invalid tag option identity", { cause });
      }
    })
    .sort((left, right) => left.localeCompare(right));

const readPriority = (row: DataSourcePageRowV2, value: unknown): Priority | undefined => {
  const candidate = nullableString(row, "Database Property priority", value);
  if (candidate === undefined) return undefined;
  if (isPriority(candidate)) return candidate;
  return fail(row.page.pageId, "has an invalid priority");
};

const readEstimate = (row: DataSourcePageRowV2, value: unknown): Estimate | undefined => {
  const candidate = nullableString(row, "Database Property estimate", value);
  if (candidate === undefined) return undefined;
  if (ESTIMATES.has(candidate as Estimate)) return candidate as Estimate;
  return fail(row.page.pageId, "has an invalid estimate");
};

const readRunTarget = (row: DataSourcePageRowV2, value: unknown): PageRunInTarget => {
  const candidate = nullableString(row, "intrinsic Property run.target", value);
  if (candidate && RUN_TARGETS.has(candidate as PageRunInTarget)) {
    return candidate as PageRunInTarget;
  }
  return fail(row.page.pageId, "has an invalid run target");
};

const readRecurrence = (row: DataSourcePageRowV2, value: unknown): RecurrenceConfig | undefined => {
  if (value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as RecurrenceConfig;
  }
  return fail(row.page.pageId, "intrinsic Property recurrence.config must be an object or null");
};

const readReminders = (row: DataSourcePageRowV2, value: unknown): ReminderConfig[] => {
  if (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "object" && item !== null && typeof item.offsetMinutes === "number",
    )
  ) {
    return value as ReminderConfig[];
  }
  return fail(row.page.pageId, "intrinsic Property reminders.config must be an array of reminders");
};

const requireCoreDatabaseValue = (
  row: CoreDatabaseRowSummary,
  propertyId: DatabasePropertyId,
): unknown => {
  if (Object.prototype.hasOwnProperty.call(row.database_values, propertyId)) {
    return row.database_values[propertyId];
  }
  return fail(row.page_id, `is missing Database Property ${propertyId}`);
};

const coreDatabaseValueOr = (
  row: CoreDatabaseRowSummary,
  propertyId: Exclude<DatabasePropertyId, "status">,
  fallback: null | readonly never[],
): unknown => {
  if (Object.prototype.hasOwnProperty.call(row.database_values, propertyId)) {
    return row.database_values[propertyId];
  }
  return fallback;
};

const requireCoreIntrinsicValue = (
  row: CoreDatabaseRowSummary,
  key: IntrinsicPropertyKey,
): unknown => {
  if (Object.prototype.hasOwnProperty.call(row.intrinsic_properties, key)) {
    return row.intrinsic_properties[key];
  }
  return fail(row.page_id, `is missing intrinsic Property ${key}`);
};

const coreNullableString = (
  row: CoreDatabaseRowSummary,
  label: string,
  value: unknown,
): string | undefined => {
  if (value === null) return undefined;
  if (typeof value === "string") return value;
  return fail(row.page_id, `${label} must be a string or null`);
};

const coreOptionalDate = (
  row: CoreDatabaseRowSummary,
  label: string,
  value: unknown,
): Date | undefined => {
  const text = coreNullableString(row, label, value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) return date;
  return fail(row.page_id, `${label} is not a valid date`);
};

const coreStringArray = (row: CoreDatabaseRowSummary, label: string, value: unknown): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value].sort((left, right) => left.localeCompare(right));
  }
  return fail(row.page_id, `${label} must be an array of strings`);
};

const coreTagOptionIds = (row: CoreDatabaseRowSummary, value: unknown): string[] =>
  coreStringArray(row, "Database Property tags", value).map((optionId) => {
    try {
      return parseDataSourceOptionId({ propertyId: "tags", value: optionId });
    } catch (cause) {
      return fail(row.page_id, "has an invalid tag option identity", { cause });
    }
  });

const corePriority = (row: CoreDatabaseRowSummary, value: unknown): Priority | undefined => {
  const candidate = coreNullableString(row, "Database Property priority", value);
  if (candidate === undefined) return undefined;
  if (isPriority(candidate)) return candidate;
  return fail(row.page_id, "has an invalid priority");
};

const coreEstimate = (row: CoreDatabaseRowSummary, value: unknown): Estimate | undefined => {
  const candidate = coreNullableString(row, "Database Property estimate", value);
  if (candidate === undefined) return undefined;
  if (ESTIMATES.has(candidate as Estimate)) return candidate as Estimate;
  return fail(row.page_id, "has an invalid estimate");
};

const coreRunTarget = (row: CoreDatabaseRowSummary, value: unknown): PageRunInTarget => {
  const candidate = coreNullableString(row, "intrinsic Property run.target", value);
  if (candidate && RUN_TARGETS.has(candidate as PageRunInTarget)) {
    return candidate as PageRunInTarget;
  }
  return fail(row.page_id, "has an invalid run target");
};

const coreRecurrence = (
  row: CoreDatabaseRowSummary,
  value: unknown,
): RecurrenceConfig | undefined => {
  if (value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as RecurrenceConfig;
  }
  return fail(row.page_id, "intrinsic Property recurrence.config must be an object or null");
};

const coreReminders = (row: CoreDatabaseRowSummary, value: unknown): ReminderConfig[] => {
  if (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "object" && item !== null && typeof item.offsetMinutes === "number",
    )
  ) {
    return value as ReminderConfig[];
  }
  return fail(row.page_id, "intrinsic Property reminders.config must be an array of reminders");
};

export const projectCoreDatabaseRowSummary = (
  row: CoreDatabaseRowSummary,
  order = row.position_order ?? UNPOSITIONED_PAGE_ORDER,
): DatabasePageSummary => {
  const statusValue = requireCoreDatabaseValue(row, "status");
  if (!isWorkflowStatus(statusValue)) {
    return fail(row.page_id, "has an invalid workflow status");
  }
  if (!Array.isArray(row.rich_title)) {
    return fail(row.page_id, "has an invalid rich title");
  }
  const isAllDay = requireCoreIntrinsicValue(row, "schedule.isAllDay");
  if (typeof isAllDay !== "boolean") {
    return fail(row.page_id, "intrinsic Property schedule.isAllDay must be a boolean");
  }
  const page: DatabasePageSummary = {
    id: row.page_id,
    pageKey: row.page_key ?? null,
    status: statusValue,
    archived: row.lifecycle === "archived",
    title: row.title,
    richTitle: row.rich_title,
    descriptionPreview: row.description_preview,
    descriptionLength: row.description_length,
    hasDescription: row.has_description,
    priority: corePriority(row, coreDatabaseValueOr(row, "priority", null)),
    estimate: coreEstimate(row, coreDatabaseValueOr(row, "estimate", null)),
    tags: coreTagOptionIds(row, coreDatabaseValueOr(row, "tags", [])),
    dueDate: coreOptionalDate(
      row,
      "Database Property due_date",
      coreDatabaseValueOr(row, "due_date", null),
    ),
    scheduledStart: coreOptionalDate(
      row,
      "Database Property scheduled_start",
      coreDatabaseValueOr(row, "scheduled_start", null),
    ),
    scheduledEnd: coreOptionalDate(
      row,
      "Database Property scheduled_end",
      coreDatabaseValueOr(row, "scheduled_end", null),
    ),
    isAllDay,
    recurrence: coreRecurrence(row, requireCoreIntrinsicValue(row, "recurrence.config")),
    reminders: coreReminders(row, requireCoreIntrinsicValue(row, "reminders.config")),
    scheduleTimezone: coreNullableString(
      row,
      "intrinsic Property schedule.timezone",
      requireCoreIntrinsicValue(row, "schedule.timezone"),
    ),
    assignee: coreNullableString(
      row,
      "Database Property assignee",
      coreDatabaseValueOr(row, "assignee", null),
    ),
    runInTarget: coreRunTarget(row, requireCoreIntrinsicValue(row, "run.target")),
    runInLocalPath: coreNullableString(
      row,
      "intrinsic Property run.localPath",
      requireCoreIntrinsicValue(row, "run.localPath"),
    ),
    runInBaseBranch: coreNullableString(
      row,
      "intrinsic Property run.baseBranch",
      requireCoreIntrinsicValue(row, "run.baseBranch"),
    ),
    runInWorktreePath: coreNullableString(
      row,
      "intrinsic Property run.worktreePath",
      requireCoreIntrinsicValue(row, "run.worktreePath"),
    ),
    runInEnvironmentPath: coreNullableString(
      row,
      "intrinsic Property run.environmentPath",
      requireCoreIntrinsicValue(row, "run.environmentPath"),
    ),
    revision: row.metadata_revision,
    created: new Date(row.created_at),
    order,
  };
  try {
    assertValidPageInput(
      {
        priority: page.priority,
        estimate: page.estimate,
        tags: page.tags,
        dueDate: page.dueDate,
        scheduledStart: page.scheduledStart,
        scheduledEnd: page.scheduledEnd,
        isAllDay: page.isAllDay,
        recurrence: page.recurrence,
        reminders: page.reminders,
        scheduleTimezone: page.scheduleTimezone,
        assignee: page.assignee,
        runInTarget: page.runInTarget,
        runInLocalPath: page.runInLocalPath,
        runInBaseBranch: page.runInBaseBranch,
        runInWorktreePath: page.runInWorktreePath,
        runInEnvironmentPath: page.runInEnvironmentPath,
      },
      "update",
    );
  } catch (error) {
    return fail(row.page_id, "has invalid relational metadata", {
      cause: error,
    });
  }
  return page;
};

export const projectCoreDatabaseRowSummaries = (
  rows: readonly CoreDatabaseRowSummary[],
): readonly DatabasePageSummary[] => {
  const nextOrderByStatus = new Map<string, number>();
  return rows.map((row) => {
    const status = row.database_values.status;
    const order =
      typeof status === "string" ? (nextOrderByStatus.get(status) ?? 0) : UNPOSITIONED_PAGE_ORDER;
    if (typeof status === "string") {
      nextOrderByStatus.set(status, order + 1);
    }
    return projectCoreDatabaseRowSummary(row, order);
  });
};

/**
 * Adapts an already-bounded Core View window for renderer code that still uses
 * the query-shaped view model. It never performs or permits a full-row query.
 */
export const projectCoreDatabaseViewQuery = (
  window: CoreDatabaseViewWindow,
  libraryId: string,
  databaseDescriptor: DatabaseContainerDescriptorV2,
  sourceDescriptor: DataSourceDescriptorV2,
  view: DatabaseViewRecordV2,
): DatabaseViewQueryResultV2 => {
  return {
    database: databaseDescriptor.database,
    dataSource: sourceDescriptor.dataSource,
    view,
    properties: sourceDescriptor.properties,
    rows: window.rows.items.map((row) =>
      projectCoreDatabaseQueryRow(row, {
        libraryId,
        dataSourceId: sourceDescriptor.dataSource.dataSourceId,
        properties: sourceDescriptor.properties,
      }),
    ),
  };
};

/** Adapts a bounded transient Data Source query without inventing a View. */
export const projectCoreDataSourceQuery = (
  window: CoreDataSourceQueryWindow,
  libraryId: string,
  databaseDescriptor: DatabaseContainerDescriptorV2,
  sourceDescriptor: DataSourceDescriptorV2,
): DataSourceQueryResultV2 => ({
  database: databaseDescriptor.database,
  dataSource: sourceDescriptor.dataSource,
  properties: sourceDescriptor.properties,
  rows: window.rows.items.map((row) =>
    projectCoreDatabaseQueryRow(row, {
      libraryId,
      dataSourceId: sourceDescriptor.dataSource.dataSourceId,
      properties: sourceDescriptor.properties,
    }),
  ),
});

export const projectCoreDatabaseViewBoard = (
  rows: readonly CoreDatabaseRowSummary[],
): BoardSummary => {
  const cards = projectCoreDatabaseRowSummaries(rows);
  return {
    columns: WORKFLOW_STATUS_COLUMNS.map((column) => ({
      ...column,
      cards: cards.filter((card) => card.status === column.id),
    })),
  };
};

export const projectCoreDatabaseRowDetail = (detail: CoreDatabaseRowDetail): DatabasePage => ({
  ...projectCoreDatabaseRowSummary(detail.summary),
  description: detail.body_nfm,
});

export const projectDatabasePage = (
  row: DataSourcePageRowV2,
  order = row.position?.order ?? UNPOSITIONED_PAGE_ORDER,
): DatabasePage => {
  if (row.bodyNfm === undefined) {
    return fail(row.page.pageId, "is missing its exact-head NFM projection");
  }
  const statusValue = requireDatabaseValue(row, "status");
  if (!isWorkflowStatus(statusValue)) {
    return fail(row.page.pageId, "has an invalid workflow status");
  }
  const intrinsic = indexIntrinsicProperties(row);
  for (const key of INTRINSIC_PROPERTY_KEYS) {
    requireIntrinsicValue(row, intrinsic, key);
  }
  const isAllDay = requireIntrinsicValue(row, intrinsic, "schedule.isAllDay");
  if (typeof isAllDay !== "boolean") {
    return fail(row.page.pageId, "intrinsic Property schedule.isAllDay must be a boolean");
  }

  const page: DatabasePage = {
    id: row.page.pageId,
    pageKey: row.pageKey,
    status: statusValue,
    archived: row.page.lifecycle === "archived",
    title: row.page.title,
    richTitle: row.page.richTitle,
    description: row.bodyNfm,
    priority: readPriority(row, requireDatabaseValue(row, "priority")),
    estimate: readEstimate(row, requireDatabaseValue(row, "estimate")),
    tags: readTagOptionIds(row),
    dueDate: optionalDate(row, "Database Property due_date", requireDatabaseValue(row, "due_date")),
    scheduledStart: optionalDate(
      row,
      "Database Property scheduled_start",
      requireDatabaseValue(row, "scheduled_start"),
    ),
    scheduledEnd: optionalDate(
      row,
      "Database Property scheduled_end",
      requireDatabaseValue(row, "scheduled_end"),
    ),
    isAllDay,
    recurrence: readRecurrence(row, requireIntrinsicValue(row, intrinsic, "recurrence.config")),
    reminders: readReminders(row, requireIntrinsicValue(row, intrinsic, "reminders.config")),
    scheduleTimezone: nullableString(
      row,
      "intrinsic Property schedule.timezone",
      requireIntrinsicValue(row, intrinsic, "schedule.timezone"),
    ),
    assignee: nullableString(
      row,
      "Database Property assignee",
      requireDatabaseValue(row, "assignee"),
    ),
    runInTarget: readRunTarget(row, requireIntrinsicValue(row, intrinsic, "run.target")),
    runInLocalPath: nullableString(
      row,
      "intrinsic Property run.localPath",
      requireIntrinsicValue(row, intrinsic, "run.localPath"),
    ),
    runInBaseBranch: nullableString(
      row,
      "intrinsic Property run.baseBranch",
      requireIntrinsicValue(row, intrinsic, "run.baseBranch"),
    ),
    runInWorktreePath: nullableString(
      row,
      "intrinsic Property run.worktreePath",
      requireIntrinsicValue(row, intrinsic, "run.worktreePath"),
    ),
    runInEnvironmentPath: nullableString(
      row,
      "intrinsic Property run.environmentPath",
      requireIntrinsicValue(row, intrinsic, "run.environmentPath"),
    ),
    revision: row.page.metadataRevision,
    created: new Date(row.page.createdAt),
    order,
  };
  try {
    assertValidPageInput(
      {
        priority: page.priority,
        estimate: page.estimate,
        tags: page.tags,
        dueDate: page.dueDate,
        scheduledStart: page.scheduledStart,
        scheduledEnd: page.scheduledEnd,
        isAllDay: page.isAllDay,
        recurrence: page.recurrence,
        reminders: page.reminders,
        scheduleTimezone: page.scheduleTimezone,
        assignee: page.assignee,
        runInTarget: page.runInTarget,
        runInLocalPath: page.runInLocalPath,
        runInBaseBranch: page.runInBaseBranch,
        runInWorktreePath: page.runInWorktreePath,
        runInEnvironmentPath: page.runInEnvironmentPath,
      },
      "update",
    );
  } catch (error) {
    return fail(row.page.pageId, "has invalid relational metadata", {
      cause: error,
    });
  }
  return page;
};

export const projectDatabaseQueryPages = (
  query: DatabaseViewQueryResultV2,
): readonly DatabasePage[] => {
  const nextOrderByStatus = new Map<string, number>();
  return query.rows.map((row) => {
    const status = requireDatabaseValue(row, "status");
    const order =
      typeof status === "string" ? (nextOrderByStatus.get(status) ?? 0) : UNPOSITIONED_PAGE_ORDER;
    if (typeof status === "string") {
      nextOrderByStatus.set(status, order + 1);
    }
    return projectDatabasePage(row, order);
  });
};

export const projectDatabasePageSummaries = (
  query: DatabaseViewQueryResultV2,
): readonly DatabasePageSummary[] => projectDatabaseQueryPages(query).map(toDatabasePageSummary);

export const projectDatabaseViewReference = (
  query: DatabaseViewQueryResultV2,
  input: ReadDatabaseViewReferenceInput,
  authority: {
    readonly libraryId: string;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly authorization: AuthorizedReadStamp;
  },
): DatabaseViewReadModel => {
  const summaries = projectDatabasePageSummaries(query);
  const model: DatabaseViewReadModel = {
    ...authority,
    dataSourceId: query.dataSource.dataSourceId,
    view: {
      id: query.view.viewId,
      databaseBlockId: query.view.databaseId,
      projectId: input.accessContext.kind === "project" ? input.accessContext.projectId : null,
      name: query.view.name,
      layout: query.view.layout,
      config: JSON.parse(stableStringifyDatabaseJson(query.view.config)) as Readonly<
        Record<string, DatabaseViewJsonValue>
      >,
      isPrimary: query.database.defaultViewId === query.view.viewId,
      createdAt: query.view.createdAt,
      updatedAt: query.view.updatedAt,
    },
    rows: query.rows.map((row, index) => {
      const page = summaries[index];
      if (!page) {
        return fail(row.page.pageId, `is unavailable in Database View ${query.view.viewId}`);
      }
      return {
        page,
        groupKey: row.effectiveGroupKey,
        subgroupKey: row.effectiveSubgroupKey,
        rankKey: row.position?.rankKey ?? "ffffffffffffffffffffffffffffffff",
      };
    }),
  };
  const rows = evaluateDatabaseViewRows(model, {
    ...(input.hostBlockId ? { hostBlockId: input.hostBlockId } : {}),
  });
  if (rows === model.rows) return model;
  return { ...model, rows };
};
