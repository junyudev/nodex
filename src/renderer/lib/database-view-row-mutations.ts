import {
  MAX_DATABASE_MODULE_V2_BULK_ENTRIES,
  type DatabaseApplyOperationV2,
  type DatabaseApplyReceiptV2,
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabaseModuleErrorV2,
  type DataSourcePageRowV2,
  type DataSourcePropertyRecordV2,
  type LibraryDatabaseApplyReceiptV2,
  type LibraryDatabaseApplyResultV2,
  type LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { DatabaseJsonValue } from "../../shared/database-kernel";
import { databaseViewPrimaryManualOrderDirection } from "../../shared/database-view-presentation";
import { applyDatabaseModule, applyLibraryDatabaseModule } from "./api";
import { buildDataSourcePropertyValueOperations } from "./data-source-property-value-operations";
import type { DatabaseViewRenderModel } from "./database-view-render-model";

export class DatabaseViewMutationError extends Error {
  constructor(readonly commandError: DatabaseModuleErrorV2) {
    super(commandError.message);
    this.name = "DatabaseViewMutationError";
  }
}

const localError = (message: string): DatabaseViewMutationError =>
  new DatabaseViewMutationError({
    code: "invalid_request",
    message,
    retryable: false,
  });

const findRow = (model: DatabaseViewRenderModel, pageId: string): DataSourcePageRowV2 => {
  const row = model.query.rows.find((candidate) => candidate.page.pageId === pageId);
  if (row) return row;
  throw localError(`Page is no longer present in View ${model.databaseViewId}`);
};

const findProperty = (
  model: DatabaseViewRenderModel,
  propertyId: string,
): DataSourcePropertyRecordV2 => {
  const property = model.query.properties.find(
    (candidate) => candidate.propertyId === propertyId && candidate.lifecycle === "active",
  );
  if (property) return property;
  throw localError(`Property is no longer active in Data Source ${model.dataSourceId}`);
};

export const buildDatabaseViewPropertyValueOperations = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageId: string;
  readonly propertyId: string;
  readonly value: DatabaseJsonValue;
}): readonly DatabaseApplyOperationV2[] => {
  const row = findRow(input.model, input.pageId);
  const property = findProperty(input.model, input.propertyId);
  const current = row.values[property.propertyId];
  try {
    return buildDataSourcePropertyValueOperations({
      pageId: row.page.pageId,
      dataSourceId: input.model.dataSourceId,
      property,
      current,
      value: input.value,
    });
  } catch (error) {
    if (error instanceof TypeError) throw localError(error.message);
    throw error;
  }
};

const hasEmptyAndFilter = (model: DatabaseViewRenderModel): boolean =>
  model.query.view.config.rules.propertyFilters.length === 0 &&
  model.query.view.config.rules.advancedFilter === null;

export const databaseViewSupportsManualReorder = (model: DatabaseViewRenderModel): boolean =>
  databaseViewPrimaryManualOrderDirection(model.query.view.config.rules.sorts) !== null;

export const buildDatabaseViewMoveOperations = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageId: string;
  readonly direction: "up" | "down" | "top" | "bottom";
  readonly groupComplete?: boolean;
}): readonly DatabaseApplyOperationV2[] => {
  if (!databaseViewSupportsManualReorder(input.model)) return [];
  const row = findRow(input.model, input.pageId);
  const visibleGroup = input.model.query.rows.filter(
    (candidate) => candidate.effectiveGroupKey === row.effectiveGroupKey,
  );
  const currentIndex = visibleGroup.findIndex(
    (candidate) => candidate.page.pageId === input.pageId,
  );
  const targetIndex =
    input.direction === "up"
      ? currentIndex - 1
      : input.direction === "down"
        ? currentIndex + 1
        : input.direction === "top"
          ? 0
          : visibleGroup.length - 1;
  if (
    currentIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= visibleGroup.length ||
    targetIndex === currentIndex
  ) {
    return [];
  }

  const desired = [...visibleGroup];
  const [moving] = desired.splice(currentIndex, 1);
  if (!moving) return [];
  desired.splice(targetIndex, 0, moving);
  // Position commands take visual order. Core alone maps it to physical rank direction.

  if (hasEmptyAndFilter(input.model) && input.groupComplete === true) {
    if (visibleGroup.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES) {
      throw localError("This View group is too large for one atomic manual-order mutation");
    }
    return [
      {
        kind: "position_pages",
        viewId: input.model.databaseViewId,
        pages: desired.map((candidate) => ({
          pageId: candidate.page.pageId,
          expectedPositionRevision: candidate.position?.revision ?? 0,
        })),
      },
    ];
  }

  const desiredIndex = desired.findIndex((candidate) => candidate.page.pageId === input.pageId);
  const anchor = desired[desiredIndex + 1];
  if (anchor && !anchor.position) return [];
  return [
    {
      kind: "position_page",
      viewId: input.model.databaseViewId,
      pageId: row.page.pageId,
      expectedPositionRevision: row.position?.revision ?? 0,
      ...(anchor ? { beforePageId: anchor.page.pageId } : {}),
    },
  ];
};

export const canMoveDatabaseViewPage = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageId: string;
  readonly direction: "up" | "down" | "top" | "bottom";
  readonly groupComplete?: boolean;
}): boolean => {
  try {
    return buildDatabaseViewMoveOperations(input).length > 0;
  } catch {
    return false;
  }
};

export const buildDatabaseViewMovePageRunOperations = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageIds: readonly string[];
  readonly direction: "up" | "down" | "top" | "bottom";
  readonly groupComplete?: boolean;
}): readonly DatabaseApplyOperationV2[] => {
  const uniquePageIds = [...new Set(input.pageIds)];
  if (uniquePageIds.length === 0) return [];
  if (uniquePageIds.length === 1) {
    return buildDatabaseViewMoveOperations({
      model: input.model,
      pageId: uniquePageIds[0]!,
      direction: input.direction,
      ...(input.groupComplete === undefined ? {} : { groupComplete: input.groupComplete }),
    });
  }
  if (
    !databaseViewSupportsManualReorder(input.model) ||
    !hasEmptyAndFilter(input.model) ||
    input.groupComplete !== true
  )
    return [];

  const selectedPageIds = new Set(uniquePageIds);
  const selectedRows = input.model.query.rows.filter((candidate) =>
    selectedPageIds.has(candidate.page.pageId),
  );
  if (selectedRows.length !== selectedPageIds.size) return [];
  const groupKey = selectedRows[0]?.effectiveGroupKey ?? null;
  if (selectedRows.some((row) => row.effectiveGroupKey !== groupKey)) return [];

  const visibleGroup = input.model.query.rows.filter(
    (candidate) => candidate.effectiveGroupKey === groupKey,
  );
  if (visibleGroup.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES) {
    throw localError("This View group is too large for one atomic manual-order mutation");
  }
  const desired = [...visibleGroup];
  if (input.direction === "top" || input.direction === "bottom") {
    const selected = desired.filter((row) => selectedPageIds.has(row.page.pageId));
    const unselected = desired.filter((row) => !selectedPageIds.has(row.page.pageId));
    desired.splice(
      0,
      desired.length,
      ...(input.direction === "top" ? [...selected, ...unselected] : [...unselected, ...selected]),
    );
  } else if (input.direction === "up") {
    for (let index = 1; index < desired.length; index += 1) {
      const current = desired[index];
      const previous = desired[index - 1];
      if (
        current &&
        previous &&
        selectedPageIds.has(current.page.pageId) &&
        !selectedPageIds.has(previous.page.pageId)
      ) {
        desired[index - 1] = current;
        desired[index] = previous;
      }
    }
  } else {
    for (let index = desired.length - 2; index >= 0; index -= 1) {
      const current = desired[index];
      const next = desired[index + 1];
      if (
        current &&
        next &&
        selectedPageIds.has(current.page.pageId) &&
        !selectedPageIds.has(next.page.pageId)
      ) {
        desired[index] = next;
        desired[index + 1] = current;
      }
    }
  }

  if (desired.every((row, index) => row === visibleGroup[index])) return [];
  return [
    {
      kind: "position_pages",
      viewId: input.model.databaseViewId,
      pages: desired.map((candidate) => ({
        pageId: candidate.page.pageId,
        expectedPositionRevision: candidate.position?.revision ?? 0,
      })),
    },
  ];
};

export interface DatabaseViewMutationDependencies {
  readonly applyProject: (
    projectId: string,
    request: DatabaseApplyV2,
  ) => Promise<DatabaseApplyResultV2>;
  readonly applyLibrary: (request: LibraryDatabaseApplyV2) => Promise<LibraryDatabaseApplyResultV2>;
}

const defaultDependencies: DatabaseViewMutationDependencies = {
  applyProject: applyDatabaseModule,
  applyLibrary: applyLibraryDatabaseModule,
};

export type DatabaseViewMutationReceipt = DatabaseApplyReceiptV2 | LibraryDatabaseApplyReceiptV2;
export type DatabaseViewMutationScope = Pick<
  DatabaseViewRenderModel,
  "accessContext" | "storeEpoch"
>;

export const commitDatabaseViewOperations = async (input: {
  readonly model: DatabaseViewMutationScope;
  readonly operations: readonly DatabaseApplyOperationV2[];
  readonly operationId?: string;
  readonly dependencies?: DatabaseViewMutationDependencies;
}): Promise<DatabaseViewMutationReceipt | null> => {
  if (input.operations.length === 0) return null;
  const commonRequest = {
    operationId: input.operationId ?? createUuidV7(),
    storeEpoch: input.model.storeEpoch,
    operations: input.operations,
  } as const;
  const dependencies = input.dependencies ?? defaultDependencies;
  const apply = () =>
    input.model.accessContext.kind === "library"
      ? dependencies.applyLibrary(commonRequest)
      : dependencies.applyProject(input.model.accessContext.projectId, {
          ...commonRequest,
          projectId: input.model.accessContext.projectId,
          actor: { kind: "renderer_database_view" as const },
        });
  const result = await apply();
  if (result.ok) return result.value;
  throw new DatabaseViewMutationError(result.error);
};
