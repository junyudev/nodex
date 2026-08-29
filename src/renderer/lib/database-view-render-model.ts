import {
  WORKFLOW_STATUS_COLUMNS,
  DEFAULT_WORKFLOW_STATUS,
  isWorkflowStatus,
} from "../../shared/workflow-status";
import type {
  DatabaseModuleReadSnapshotV2,
  DatabaseViewQueryResultV2,
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
  LibraryDatabaseModuleReadSnapshotV2,
} from "../../shared/database-module-v2";
import type { DatabaseViewWindowSnapshot } from "../../shared/database-views";
import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import type {
  DatabaseJsonValue,
  DatabasePropertyValueType,
  DatabaseViewConditionalColor,
  DatabaseViewConditionalColorRule,
  DatabaseViewLayout,
  DatabaseViewPresentationConfig,
  DatabaseViewRules,
  EffectiveDatabaseView,
} from "../../shared/database-kernel";
import {
  evaluateDatabaseViewConditionalColor,
  stableStringifyDatabaseJson,
} from "../../shared/database-kernel";
import type { DatabaseId, DatabaseViewId, DataSourceId } from "../../shared/database-identities";
import { readDatabasePropertyOptions } from "./database-view-authoring";
import type { Estimate, Priority } from "./types";
import { isPriority } from "../../shared/priority";

const ESTIMATES = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);

export interface DatabaseViewRenderModel {
  readonly accessContext: DatabaseViewAccessContext;
  readonly libraryId: string;
  readonly databaseViewId: DatabaseViewId;
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly databaseName: string;
  readonly dataSourceName: string;
  readonly viewName: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: AuthorizedReadStamp | null;
  readonly columns: readonly DatabaseViewRenderColumn[];
  readonly query: DatabaseViewQueryResultV2;
  readonly readOnlyReason: string | null;
}

export interface PublishedDatabaseViewDefinitionPatch {
  readonly layout?: DatabaseViewLayout;
  readonly rules?: DatabaseViewRules;
  readonly presentation?: DatabaseViewPresentationConfig;
}

export type DatabaseViewAccessContext =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "library" };

export interface DatabaseViewRenderRow {
  readonly pageId: string;
  readonly pageKey: string | null;
  /** Standard Parent Relation projection, distinct from structural Page ownership. */
  readonly parentPageId?: string;
  readonly siblingRank?: string;
  readonly taskParentValueRevision: number;
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly title: string;
  readonly preview: string;
  readonly plainText: string;
  readonly status?: import("../../shared/workflow-status").WorkflowStatus;
  readonly priority?: Priority;
  readonly estimate?: Estimate;
  readonly tags: readonly string[];
  readonly dueDate?: Date;
  readonly scheduledStart?: Date;
  readonly scheduledEnd?: Date;
  readonly assignee?: string;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly metadataRevision: number;
  readonly createdAt: Date;
  readonly conditionalColor?: DatabaseViewConditionalColor | null;
}

export const databaseViewConditionalColorBackground = (
  color: DatabaseViewConditionalColor,
): string => `var(--${color}-bg)`;

/**
 * Stable key of one independently paged group window: `key:<group>` for a
 * concrete group, `unassigned` for rows with an empty grouping value, and
 * `all` for ungrouped Views that page as a single flat window.
 */
export const UNGROUPED_SCOPE_KEY = "all";

export const groupScopeKeyForColumn = (groupKey: string | null): string =>
  groupKey === null ? "unassigned" : `key:${JSON.stringify(groupKey)}`;

export const groupScopeKeyForPath = (
  groupKey: string | null,
  subgroupKey: string | null,
): string =>
  subgroupKey === null
    ? groupScopeKeyForColumn(groupKey)
    : `${groupScopeKeyForColumn(groupKey)}/sub:${JSON.stringify(subgroupKey)}`;

export interface DatabaseViewRenderColumn {
  readonly id: string;
  readonly groupKey: string | null;
  readonly name: string;
  /** Pagination scope of this column's group window in the board store. */
  readonly scopeKey: string;
  readonly rows: readonly DatabaseViewRenderRow[];
}

const propertyById = (
  properties: readonly DataSourcePropertyRecordV2[],
  propertyId: string,
): DataSourcePropertyRecordV2 | null =>
  properties.find(
    (property) => property.lifecycle === "active" && property.propertyId === propertyId,
  ) ?? null;

const readValue = (
  row: DataSourcePageRowV2,
  property: DataSourcePropertyRecordV2 | null,
  valueType?: DatabasePropertyValueType,
): DatabaseJsonValue | undefined => {
  if (!property) return undefined;
  const value = row.values[property.propertyId];
  if (!value || (valueType && value.valueType !== valueType)) return undefined;
  return value.value;
};

const readNullableString = (
  row: DataSourcePageRowV2,
  property: DataSourcePropertyRecordV2 | null,
): string | undefined => {
  const value = readValue(row, property);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readDate = (
  row: DataSourcePageRowV2,
  property: DataSourcePropertyRecordV2 | null,
): Date | undefined => {
  const value = readNullableString(row, property);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const readStringList = (
  row: DataSourcePageRowV2,
  property: DataSourcePropertyRecordV2 | null,
): string[] => {
  const value = readValue(row, property, "multi_select");
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

export const projectDataSourcePageRowToDatabaseViewRenderRow = (
  row: DataSourcePageRowV2,
  properties: readonly DataSourcePropertyRecordV2[],
  conditionalColors: readonly DatabaseViewConditionalColorRule[] = [],
): DatabaseViewRenderRow => {
  const statusValue = readNullableString(row, propertyById(properties, "status"));
  const priorityValue = readNullableString(row, propertyById(properties, "priority"));
  const estimateValue = readNullableString(row, propertyById(properties, "estimate"));
  const dueDate = readDate(row, propertyById(properties, "due_date"));
  const scheduledStart = readDate(row, propertyById(properties, "scheduled_start"));
  const scheduledEnd = readDate(row, propertyById(properties, "scheduled_end"));
  const assignee = readNullableString(row, propertyById(properties, "assignee"));

  return {
    pageId: row.page.pageId,
    pageKey: row.pageKey,
    ...(row.taskParent.parentPageId
      ? {
          parentPageId: row.taskParent.parentPageId,
          ...(row.taskParent.siblingRank ? { siblingRank: row.taskParent.siblingRank } : {}),
        }
      : {}),
    taskParentValueRevision: row.taskParent.valueRevision,
    groupKey: row.effectiveGroupKey,
    subgroupKey: row.effectiveSubgroupKey,
    title: row.page.title || "Untitled",
    preview: row.page.preview,
    plainText: row.page.plainText,
    ...(isWorkflowStatus(statusValue) ? { status: statusValue } : {}),
    ...(isPriority(priorityValue) ? { priority: priorityValue } : {}),
    ...(estimateValue && ESTIMATES.has(estimateValue as Estimate)
      ? { estimate: estimateValue as Estimate }
      : {}),
    tags: readStringList(row, propertyById(properties, "tags")),
    ...(dueDate ? { dueDate } : {}),
    ...(scheduledStart ? { scheduledStart } : {}),
    ...(scheduledEnd ? { scheduledEnd } : {}),
    ...(assignee ? { assignee } : {}),
    documentGeneration: row.page.documentGeneration,
    documentHeadSeq: row.page.documentHeadSeq,
    metadataRevision: row.page.metadataRevision,
    createdAt: new Date(row.page.createdAt),
    conditionalColor: evaluateDatabaseViewConditionalColor(
      conditionalColors,
      (propertyId) => row.values[propertyId]?.value,
    ),
  };
};

const hasStatusGroupContract = (
  query: DatabaseViewQueryResultV2,
  statusProperty: DataSourcePropertyRecordV2 | null,
  groupPropertyId: string | null,
): boolean => {
  if (!statusProperty) return false;
  if (groupPropertyId !== statusProperty.propertyId) {
    return false;
  }
  return query.rows.every((row) => {
    const value = readNullableString(row, statusProperty);
    return isWorkflowStatus(value) && row.effectiveGroupKey === value;
  });
};

export const buildDatabaseViewColumns = (
  query: DatabaseViewQueryResultV2,
  groupPropertyId: string | null,
  showEmptyGroups = true,
): readonly DatabaseViewRenderColumn[] => {
  const statusGrouped = hasStatusGroupContract(
    query,
    propertyById(query.properties, "status"),
    groupPropertyId,
  );
  const rows = query.rows.map((row) => ({
    row,
    renderRow: projectDataSourcePageRowToDatabaseViewRenderRow(
      row,
      query.properties,
      query.view.config.presentation.conditionalColors,
    ),
  }));
  if (!statusGrouped) {
    if (!groupPropertyId) {
      return [
        {
          id: DEFAULT_WORKFLOW_STATUS,
          groupKey: null,
          name: query.view.name,
          scopeKey: UNGROUPED_SCOPE_KEY,
          rows: rows.map(({ renderRow }) => renderRow),
        },
      ];
    }
    const groupProperty = query.properties.find(
      (property) => property.propertyId === groupPropertyId && property.lifecycle === "active",
    );
    if (!groupProperty) {
      return [
        {
          id: DEFAULT_WORKFLOW_STATUS,
          groupKey: null,
          name: query.view.name,
          scopeKey: UNGROUPED_SCOPE_KEY,
          rows: rows.map(({ renderRow }) => renderRow),
        },
      ];
    }
    const options = readDatabasePropertyOptions(groupProperty);
    const optionNames = new Map(options.map((option) => [option.id, option.name]));
    const configuredGroupKeys = [
      ...(showEmptyGroups ? options.map((option) => option.id) : []),
      ...rows.map(({ row }) => row.effectiveGroupKey),
    ].filter((key, index, all): key is string | null => all.indexOf(key) === index);
    const groupKeys = configuredGroupKeys.length > 0 ? configuredGroupKeys : [null];
    const groupName = (key: string | null): string => {
      if (key === null) return `No ${groupProperty.name}`;
      const optionName = optionNames.get(key);
      if (optionName) return optionName;
      if (groupProperty.valueType === "multi_select") {
        try {
          const optionIds = JSON.parse(key) as unknown;
          if (Array.isArray(optionIds) && optionIds.every((id) => typeof id === "string")) {
            return optionIds.map((id) => optionNames.get(id) ?? id).join(" · ");
          }
        } catch {
          // Unknown canonical group keys remain visible.
        }
      }
      if (key === "true") return "Checked";
      if (key === "false") return "Unchecked";
      return key;
    };
    return groupKeys.map((groupKey) => ({
      id: groupKey ?? `empty:${groupProperty.propertyId}`,
      groupKey,
      name: groupName(groupKey),
      scopeKey: groupScopeKeyForColumn(groupKey),
      rows: rows.flatMap(({ row, renderRow }) =>
        row.effectiveGroupKey === groupKey ? [renderRow] : [],
      ),
    }));
  }

  const workflowColumns = showEmptyGroups
    ? WORKFLOW_STATUS_COLUMNS
    : WORKFLOW_STATUS_COLUMNS.filter((column) =>
        rows.some(({ row }) => row.effectiveGroupKey === column.id),
      );
  return workflowColumns.map((column) => ({
    ...column,
    groupKey: column.id,
    scopeKey: groupScopeKeyForColumn(column.id),
    rows: rows.flatMap(({ row, renderRow }) =>
      row.effectiveGroupKey === column.id ? [renderRow] : [],
    ),
  }));
};

/**
 * Binds a model to the exact presentation coordinate rendered by a surface.
 * Personal presentation edits can render before their replacement Core
 * window reaches the shared store, so gesture compilation must not infer its
 * grouping and sorting semantics from the older durable snapshot.
 */
export const withEffectiveDatabaseView = (
  model: DatabaseViewRenderModel,
  effective: EffectiveDatabaseView,
): DatabaseViewRenderModel => {
  const query = {
    ...model.query,
    view: {
      ...model.query.view,
      layout: effective.layout,
      config: {
        ...model.query.view.config,
        presentation: effective.presentation,
      },
    },
  };
  return {
    ...model,
    columns: buildDatabaseViewColumns(query, effective.presentation.group?.propertyId ?? null),
    query,
  };
};

/**
 * Hands already-rendered effective settings to durable View metadata without
 * rebuilding its projection. The current rows and columns already represent
 * this coordinate; a receipt-fenced optimistic journal retains this patch only
 * until a canonical read materializes the same definition.
 */
export const withPublishedDatabaseViewDefinition = (
  model: DatabaseViewRenderModel,
  patch: PublishedDatabaseViewDefinitionPatch,
): DatabaseViewRenderModel => {
  const layout = patch.layout ?? model.query.view.layout;
  const config = {
    ...model.query.view.config,
    ...(patch.rules === undefined ? {} : { rules: patch.rules }),
    ...(patch.presentation === undefined ? {} : { presentation: patch.presentation }),
  };
  if (
    layout === model.query.view.layout &&
    stableStringifyDatabaseJson(config) === stableStringifyDatabaseJson(model.query.view.config)
  ) {
    return model;
  }
  return {
    ...model,
    query: {
      ...model.query,
      view: {
        ...model.query.view,
        layout,
        config,
      },
    },
  };
};

const queryFromSnapshot = (
  snapshot: DatabaseModuleReadSnapshotV2 | LibraryDatabaseModuleReadSnapshotV2,
): DatabaseViewQueryResultV2 => {
  if (snapshot.value.kind === "query") return snapshot.value.value;
  throw new Error("Database View read did not return a query");
};

export const buildDatabaseViewRenderModel = (
  snapshot: DatabaseModuleReadSnapshotV2 | LibraryDatabaseModuleReadSnapshotV2,
): DatabaseViewRenderModel => {
  const query = queryFromSnapshot(snapshot);
  if (
    query.database.libraryId !== snapshot.libraryId ||
    query.dataSource.libraryId !== snapshot.libraryId ||
    query.view.databaseId !== query.database.databaseId ||
    query.view.dataSourceId !== query.dataSource.dataSourceId
  ) {
    throw new Error("Database View query has mismatched Library resource identity");
  }
  const groupPropertyId = query.view.config.presentation.group?.propertyId ?? null;

  return {
    accessContext:
      "accessContext" in snapshot
        ? { kind: "library" }
        : { kind: "project", projectId: snapshot.projectId },
    libraryId: snapshot.libraryId,
    databaseViewId: query.view.viewId,
    databaseId: query.database.databaseId,
    dataSourceId: query.dataSource.dataSourceId,
    databaseName: query.database.name,
    dataSourceName: query.dataSource.name,
    viewName: query.view.name,
    storeEpoch: snapshot.storeEpoch,
    commitSeq: snapshot.commitSeq,
    authorization: snapshot.authorization,
    columns: buildDatabaseViewColumns(query, groupPropertyId),
    query,
    readOnlyReason: null,
  };
};

export const buildDatabaseViewWindowRenderModel = (
  window: DatabaseViewWindowSnapshot<string | null>,
): DatabaseViewRenderModel =>
  buildDatabaseViewRenderModel({
    ...(window.projectId === null
      ? { accessContext: { kind: "library" as const } }
      : { projectId: window.projectId }),
    libraryId: window.libraryId,
    storeEpoch: window.storeEpoch,
    commitSeq: window.commitSeq,
    authorization: window.authorization,
    value: { kind: "query", value: window.query },
  });
