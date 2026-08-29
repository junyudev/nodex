import {
  MAX_DATABASE_MODULE_V2_BULK_ENTRIES,
  type DatabaseApplyOperationV2,
  type DatabaseModuleReadSnapshotV2,
  type DatabaseViewQueryResultV2,
  type DataSourcePageRowV2,
  type DataSourcePropertyRecordV2,
  type DatabasePropertyValueMutationV2,
} from "./database-module-v2";
import type { DatabaseJsonValue } from "./database-kernel";
import { parseDataSourceOptionId, type DataSourceId } from "./database-identities";
import type { MovePageInput, MovePagesInput } from "./types";
import { databaseViewFractionalOrderDirection } from "./database-view-presentation";

export type DatabasePageDragErrorCode =
  | "invalid_page_set"
  | "view_not_available"
  | "page_not_found"
  | "source_status_conflict"
  | "status_property_not_found"
  | "status_value_invalid"
  | "property_not_found"
  | "property_value_invalid"
  | "position_index_invalid"
  | "manual_direction_unsupported"
  | "bulk_limit_exceeded"
  | "empty_drag_intent";

export class DatabasePageDragError extends Error {
  constructor(
    readonly code: DatabasePageDragErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatabasePageDragError";
  }
}

export interface CompiledDatabasePageDrag {
  readonly databaseId: string;
  readonly dataSourceId: DataSourceId;
  readonly viewId: string;
  readonly operations: readonly DatabaseApplyOperationV2[];
}

const fail = (code: DatabasePageDragErrorCode, message: string): never => {
  throw new DatabasePageDragError(code, message);
};

const queryFromSnapshot = (snapshot: DatabaseModuleReadSnapshotV2): DatabaseViewQueryResultV2 => {
  if (snapshot.value.kind === "query") return snapshot.value.value;
  return fail("view_not_available", "Database drag requires one current View query");
};

const activePropertyById = (
  query: DatabaseViewQueryResultV2,
  propertyId: string,
): DataSourcePropertyRecordV2 | null =>
  query.properties.find(
    (property) => property.lifecycle === "active" && property.propertyId === propertyId,
  ) ?? null;

const sameJsonValue = (left: DatabaseJsonValue | undefined, right: DatabaseJsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const readSelectValue = (
  value: DatabaseJsonValue | undefined,
  propertyKey: string,
): string | null => {
  if (value === null || typeof value === "string") return value;
  return fail(
    "property_value_invalid",
    `Database property ${propertyKey} is not a scalar select value`,
  );
};

const resolveTargetIndex = (newOrder: number | undefined, remainingCount: number): number => {
  if (newOrder === undefined) return remainingCount;
  if (!Number.isInteger(newOrder) || newOrder < 0) {
    return fail("position_index_invalid", "Database View position must be a non-negative integer");
  }
  return Math.min(newOrder, remainingCount);
};

const compileValue = (input: {
  readonly pageId: string;
  readonly dataSourceId: DataSourceId;
  readonly property: DataSourcePropertyRecordV2;
  readonly current: DataSourcePageRowV2["values"][string] | undefined;
  readonly value: DatabaseJsonValue;
}): DatabasePropertyValueMutationV2 | null => {
  if (sameJsonValue(input.current?.value, input.value)) return null;
  return {
    pageId: input.pageId,
    dataSourceId: input.dataSourceId,
    propertyId: input.property.propertyId,
    edit: {
      kind: "replace",
      expectedValueRevision: input.current?.revision ?? 0,
      value:
        input.value === null
          ? { kind: "empty" }
          : {
              kind: "select",
              optionId: parseDataSourceOptionId({
                propertyId: input.property.propertyId,
                value: input.value,
              }),
            },
    },
  };
};

const compilePageRunFromQuery = (input: {
  readonly move: MovePagesInput;
  readonly query: DatabaseViewQueryResultV2;
}): CompiledDatabasePageDrag => {
  const pageIds = input.move.pageIds;
  if (pageIds.length < 1 || new Set(pageIds).size !== pageIds.length) {
    return fail("invalid_page_set", "A Database drag requires unique Page IDs in visual order");
  }
  if (pageIds.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES) {
    return fail(
      "bulk_limit_exceeded",
      `A Database drag supports at most ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} Pages`,
    );
  }

  const query = input.query;
  if (
    query.database.lifecycle !== "active" ||
    query.dataSource.lifecycle !== "active" ||
    query.view.lifecycle !== "active" ||
    query.view.layout !== "board" ||
    query.view.databaseId !== query.database.databaseId ||
    query.view.dataSourceId !== query.dataSource.dataSourceId
  ) {
    return fail(
      "view_not_available",
      "The bound Project Database has no active single-Source Board View",
    );
  }

  const rowsById = new Map(query.rows.map((row) => [row.page.pageId, row] as const));
  const rows = pageIds.map((pageId) => {
    const row = rowsById.get(pageId);
    if (row) return row;
    return fail(
      "page_not_found",
      `Page ${pageId} is not in Data Source ${query.dataSource.dataSourceId}`,
    );
  });

  const statusProperty = activePropertyById(query, "status");
  if (
    !statusProperty ||
    query.view.config.presentation.group?.propertyId !== statusProperty.propertyId
  ) {
    return fail(
      "status_property_not_found",
      "The Board View is not grouped by its active status property",
    );
  }
  const currentStatuses = rows.map((row) => {
    const status = readSelectValue(row.values[statusProperty.propertyId]?.value, "status");
    if (status !== null) return status;
    return fail("status_value_invalid", `Page ${row.page.pageId} has no status value`);
  });
  if (input.move.fromStatus) {
    const staleIndex = currentStatuses.findIndex((status) => status !== input.move.fromStatus);
    if (staleIndex >= 0) {
      return fail(
        "source_status_conflict",
        `Page ${pageIds[staleIndex]} left ${input.move.fromStatus} before this drag committed`,
      );
    }
  }

  const patchProperties = (["priority", "estimate"] as const).flatMap((key) => {
    if (!input.move.fieldPatch || !Object.hasOwn(input.move.fieldPatch, key)) {
      return [];
    }
    const property = activePropertyById(query, key);
    if (property) return [{ key, property }] as const;
    return fail(
      "property_not_found",
      `Data Source ${query.dataSource.dataSourceId} has no active ${key} property`,
    );
  });

  const values: DatabasePropertyValueMutationV2[] = [];
  rows.forEach((row) => {
    const statusValue = compileValue({
      pageId: row.page.pageId,
      dataSourceId: query.dataSource.dataSourceId,
      property: statusProperty,
      current: row.values[statusProperty.propertyId],
      value: input.move.toStatus,
    });
    if (statusValue) values.push(statusValue);
    for (const { key, property } of patchProperties) {
      const value: DatabaseJsonValue = input.move.fieldPatch?.[key] ?? null;
      readSelectValue(value, key);
      const patchedValue = compileValue({
        pageId: row.page.pageId,
        dataSourceId: query.dataSource.dataSourceId,
        property,
        current: row.values[property.propertyId],
        value,
      });
      if (patchedValue) values.push(patchedValue);
    }
  });
  if (values.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES) {
    return fail(
      "bulk_limit_exceeded",
      `A Database drag supports at most ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} value writes`,
    );
  }

  const selected = new Set(pageIds);
  const currentTargetOrder = query.rows
    .filter((row) => row.effectiveGroupKey === input.move.toStatus)
    .map((row) => row.page.pageId);
  const remainingTargetOrder = currentTargetOrder.filter((pageId) => !selected.has(pageId));
  const targetIndex = resolveTargetIndex(input.move.newOrder, remainingTargetOrder.length);
  const nextTargetOrder = [...remainingTargetOrder];
  nextTargetOrder.splice(targetIndex, 0, ...pageIds);
  const crossesGroup = currentStatuses.some((status) => status !== input.move.toStatus);
  const positionChanged =
    crossesGroup || currentTargetOrder.join("\u0000") !== nextTargetOrder.join("\u0000");
  const manualDirection = databaseViewFractionalOrderDirection(query.view.config.rules.sorts);
  if (manualDirection === "desc" && positionChanged) {
    return fail(
      "manual_direction_unsupported",
      "Descending manual Views require a visual-direction-aware Page anchor",
    );
  }

  const expectedPositionRevision = (row: DataSourcePageRowV2): number =>
    row.position?.revision ?? 0;

  const operations: DatabaseApplyOperationV2[] = [];
  if (values.length > 0) {
    operations.push({ kind: "edit_property_values", edits: values });
  }
  if (manualDirection && positionChanged) {
    const beforePageId = remainingTargetOrder[targetIndex];
    if (rows.length === 1 && rows[0]) {
      operations.push({
        kind: "position_page",
        viewId: query.view.viewId,
        pageId: rows[0].page.pageId,
        expectedPositionRevision: expectedPositionRevision(rows[0]),
        ...(beforePageId === undefined ? {} : { beforePageId }),
      });
    } else {
      operations.push({
        kind: "position_pages",
        viewId: query.view.viewId,
        pages: rows.map((row) => ({
          pageId: row.page.pageId,
          expectedPositionRevision: expectedPositionRevision(row),
        })),
        ...(beforePageId === undefined ? {} : { beforePageId }),
      });
    }
  }
  if (operations.length === 0) {
    return fail(
      "empty_drag_intent",
      "The selected Database View does not permit this drag to change authority",
    );
  }
  return {
    databaseId: query.database.databaseId,
    dataSourceId: query.dataSource.dataSourceId,
    viewId: query.view.viewId,
    operations,
  };
};

export const compileDatabasePageDrag = (input: {
  readonly move: MovePageInput;
  readonly snapshot: DatabaseModuleReadSnapshotV2;
}): CompiledDatabasePageDrag =>
  compilePageRunFromQuery({
    move: {
      pageIds: [input.move.pageId],
      ...(input.move.fromStatus ? { fromStatus: input.move.fromStatus } : {}),
      toStatus: input.move.toStatus,
      ...(input.move.newOrder === undefined ? {} : { newOrder: input.move.newOrder }),
      ...(input.move.fieldPatch ? { fieldPatch: input.move.fieldPatch } : {}),
      ...(input.move.groupId ? { groupId: input.move.groupId } : {}),
    },
    query: queryFromSnapshot(input.snapshot),
  });

export const compileDatabasePagesDrag = (input: {
  readonly move: MovePagesInput;
  readonly snapshot: DatabaseModuleReadSnapshotV2;
}): CompiledDatabasePageDrag =>
  compilePageRunFromQuery({
    move: input.move,
    query: queryFromSnapshot(input.snapshot),
  });

export const compileDatabasePagesDragFromQuery = (input: {
  readonly move: MovePagesInput;
  readonly query: DatabaseViewQueryResultV2;
}): CompiledDatabasePageDrag => compilePageRunFromQuery(input);
