import {
  databaseGroupValueFromKey,
  stableStringifyDatabaseJson,
  type DatabaseJsonValue,
} from "../../shared/database-kernel";
import type {
  DatabaseApplyOperationV2,
  DatabasePropertyValueMutationV2,
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  buildDatabaseViewColumns,
  type DatabaseViewRenderModel,
} from "./database-view-render-model";
import { buildDatabaseViewPropertyValueOperations } from "./database-view-row-mutations";
import { contentAccessContextKey } from "../../shared/content-access-context";
import type { DatabaseViewOperationProjection } from "./database-view-operation-projection";

const activeProperty = (
  model: DatabaseViewRenderModel,
  propertyId: string | undefined,
): DataSourcePropertyRecordV2 | null => {
  if (!propertyId) return null;
  return (
    model.query.properties.find(
      (property) => property.lifecycle === "active" && property.propertyId === propertyId,
    ) ?? null
  );
};

const compactValueEdits = (
  operations: readonly DatabaseApplyOperationV2[],
): readonly DatabaseApplyOperationV2[] => {
  const edits: DatabasePropertyValueMutationV2[] = [];
  const other: DatabaseApplyOperationV2[] = [];
  for (const operation of operations) {
    if (operation.kind === "edit_property_values") {
      edits.push(...operation.edits);
      continue;
    }
    other.push(operation);
  }
  return edits.length === 0 ? other : [{ kind: "edit_property_values", edits }, ...other];
};

export interface DatabaseViewDropPropertyValue {
  readonly propertyId: string;
  readonly value: DatabaseJsonValue;
}

export interface DatabaseViewBoardDropProjection {
  readonly pageIds: readonly string[];
  /**
   * Keeps moved Pages visible while independently paged group windows repair.
   * Fresh authority wins as soon as it contains the row again.
   */
  readonly fallbackRows: readonly DataSourcePageRowV2[];
  readonly target: {
    readonly groupKey: string | null;
    readonly subgroupKey: string | null;
    readonly beforePageId?: string;
  };
  readonly propertyValues: readonly DatabaseViewDropPropertyValue[];
}

/** Freeze gesture evidence separately from its bounded pointer preview. */
export const compileDatabaseViewBoardDropProjection = (
  model: DatabaseViewRenderModel,
  projection: DatabaseViewBoardDropProjection,
  options: { readonly targetComplete?: boolean } = {},
): DatabaseViewOperationProjection => {
  const scope = (candidate: DatabaseViewRenderModel) =>
    JSON.stringify([
      candidate.libraryId,
      contentAccessContextKey(candidate.accessContext),
      candidate.storeEpoch,
      candidate.databaseId,
      candidate.dataSourceId,
      candidate.databaseViewId,
      candidate.query.view.config,
    ]);
  const admittedScope = scope(model);
  const memberships = new Map(
    model.query.rows.map((row) => [row.page.pageId, row.membership.membershipId]),
  );
  let committedRevisions: Readonly<Record<string, number>> = {};
  const supersededValue = (row: DataSourcePageRowV2, propertyId: string): boolean => {
    const committed =
      committedRevisions[
        `value:${model.dataSourceId}:${memberships.get(row.page.pageId)}:${propertyId}`
      ];
    const current = row.values[propertyId]?.revision;
    return committed !== undefined && current !== undefined && current > committed;
  };
  const coveredPosition = (row: DataSourcePageRowV2): boolean => {
    const committed = committedRevisions[`position:${model.databaseViewId}:${row.page.pageId}`];
    return committed !== undefined && row.position !== null && row.position.revision >= committed;
  };
  const hasEvidence = (candidate: DatabaseViewRenderModel): boolean => {
    if (scope(candidate) !== admittedScope) return false;
    const rows = new Map(candidate.query.rows.map((row) => [row.page.pageId, row]));
    if (
      !projection.pageIds.every(
        (id) => rows.get(id)?.membership.membershipId === memberships.get(id),
      )
    )
      return false;
    const outstandingSlot = projection.pageIds.some((id) => {
      const row = rows.get(id)!;
      return (
        !coveredPosition(row) &&
        !projection.propertyValues.some(({ propertyId }) => supersededValue(row, propertyId))
      );
    });
    if (projection.target.beforePageId && outstandingSlot) {
      const anchor = rows.get(projection.target.beforePageId);
      if (
        !anchor ||
        anchor.effectiveGroupKey !== projection.target.groupKey ||
        anchor.effectiveSubgroupKey !== projection.target.subgroupKey
      )
        return false;
    }
    return projection.propertyValues.every(({ propertyId }) =>
      candidate.query.properties.some(
        (property) =>
          property.propertyId === propertyId &&
          property.lifecycle === "active" &&
          property.valueType ===
            model.query.properties.find((original) => original.propertyId === propertyId)
              ?.valueType,
      ),
    );
  };
  const conflictKeys = projection.pageIds.map((pageId) => `page:${pageId}:position`);
  if ((!projection.target.beforePageId && options.targetComplete !== true) || !hasEvidence(model))
    return { apply: (canonical) => canonical, conflictKeys, predictable: false };
  return {
    conflictKeys,
    predictable: true,
    acknowledge: (receipt) => {
      committedRevisions = receipt.committedRevisions;
    },
    apply: (canonical) => {
      if (
        scope(canonical) !== admittedScope ||
        canonical.query.rows.some(
          (row) =>
            projection.pageIds.includes(row.page.pageId) &&
            row.membership.membershipId !== memberships.get(row.page.pageId),
        ) ||
        projection.propertyValues.some(({ propertyId }) => {
          const property = canonical.query.properties.find(
            (item) => item.propertyId === propertyId,
          );
          return (
            property?.lifecycle !== "active" ||
            property.valueType !==
              model.query.properties.find((item) => item.propertyId === propertyId)?.valueType
          );
        })
      )
        return { ...canonical };
      const supersededPages = new Set(
        canonical.query.rows.flatMap((row) =>
          projection.pageIds.includes(row.page.pageId) &&
          (coveredPosition(row) ||
            projection.propertyValues.some(({ propertyId }) => supersededValue(row, propertyId)))
            ? [row.page.pageId]
            : [],
        ),
      );
      const positioned = applyOptimisticDatabaseViewBoardDrop(canonical, {
        ...projection,
        pageIds: projection.pageIds.filter((id) => !supersededPages.has(id)),
      });
      // Exact rank receipt evidence or a later geometry write yields this
      // Page's old slot, not unrelated values or other Pages in the gesture.
      const rows = positioned.query.rows.map((row) => {
        if (!supersededPages.has(row.page.pageId)) return row;
        const values = { ...row.values };
        let changed = false;
        let effectiveGroupKey = row.effectiveGroupKey;
        let effectiveSubgroupKey = row.effectiveSubgroupKey;
        for (const { propertyId, value } of projection.propertyValues) {
          if (supersededValue(row, propertyId)) continue;
          const property = canonical.query.properties.find(
            (item) => item.propertyId === propertyId,
          );
          if (
            !property ||
            stableStringifyDatabaseJson(values[propertyId]?.value ?? null) ===
              stableStringifyDatabaseJson(value)
          )
            continue;
          values[propertyId] = {
            propertyId: property.propertyId,
            valueType: property.valueType,
            value,
            revision: values[propertyId]?.revision ?? 0,
          };
          if (propertyId === canonical.query.view.config.presentation.group?.propertyId)
            effectiveGroupKey = projection.target.groupKey;
          if (propertyId === canonical.query.view.config.presentation.subgroup?.propertyId)
            effectiveSubgroupKey = projection.target.subgroupKey;
          changed = true;
        }
        return changed ? { ...row, values, effectiveGroupKey, effectiveSubgroupKey } : row;
      });
      const query = { ...positioned.query, rows };
      const projected = rows.some((row, index) => row !== positioned.query.rows[index])
        ? {
            ...positioned,
            query,
            columns: buildDatabaseViewColumns(
              query,
              query.view.config.presentation.group?.propertyId ?? null,
            ),
          }
        : positioned;
      if (projected !== canonical || hasEvidence(canonical)) return projected;
      // Missing bounded evidence is not an identity/materialization proof.
      return { ...canonical };
    },
  };
};

/**
 * Replays one accepted Board drop over the latest readable authority. The
 * transform becomes an identity once canonical grouping, values, and order
 * materialize, which gives the UI a receipt-fenced handoff without a stale
 * frame between the drag ghost and Core's projection.
 */
export const applyOptimisticDatabaseViewBoardDrop = (
  model: DatabaseViewRenderModel,
  projection: DatabaseViewBoardDropProjection,
): DatabaseViewRenderModel => {
  const pageIds = [...new Set(projection.pageIds)];
  if (pageIds.length === 0) return model;
  const selected = new Set(pageIds);
  const rowsById = new Map(model.query.rows.map((row) => [row.page.pageId, row] as const));
  const fallbackRowsById = new Map(
    projection.fallbackRows.map((row) => [row.page.pageId, row] as const),
  );
  const moving = pageIds.flatMap((pageId) => {
    const row = rowsById.get(pageId) ?? fallbackRowsById.get(pageId);
    return row ? [row] : [];
  });
  if (moving.length !== pageIds.length) return model;
  if (projection.target.beforePageId && selected.has(projection.target.beforePageId)) return model;

  const propertiesById = new Map<string, DataSourcePropertyRecordV2>(
    model.query.properties.map((property) => [property.propertyId, property] as const),
  );
  let valuesChanged = false;
  const projectedMoving = moving.map((row) => {
    const values = { ...row.values };
    let rowValuesChanged = false;
    for (const { propertyId, value } of projection.propertyValues) {
      const property = propertiesById.get(propertyId);
      if (!property) continue;
      const current = values[propertyId];
      if (
        current &&
        stableStringifyDatabaseJson(current.value) === stableStringifyDatabaseJson(value)
      )
        continue;
      valuesChanged = true;
      rowValuesChanged = true;
      values[propertyId] = {
        propertyId: property.propertyId,
        valueType: property.valueType,
        value,
        revision: current?.revision ?? 0,
      };
    }
    const groupChanged = row.effectiveGroupKey !== projection.target.groupKey;
    const subgroupChanged = row.effectiveSubgroupKey !== projection.target.subgroupKey;
    if (!rowValuesChanged && !groupChanged && !subgroupChanged) return row;
    return {
      ...row,
      values,
      effectiveGroupKey: projection.target.groupKey,
      effectiveSubgroupKey: projection.target.subgroupKey,
    };
  });
  const remaining = model.query.rows.filter((row) => !selected.has(row.page.pageId));
  const anchorIndex = projection.target.beforePageId
    ? remaining.findIndex((row) => row.page.pageId === projection.target.beforePageId)
    : -1;
  const targetTailIndex = remaining.findLastIndex(
    (row) =>
      row.effectiveGroupKey === projection.target.groupKey &&
      row.effectiveSubgroupKey === projection.target.subgroupKey,
  );
  const insertionIndex =
    anchorIndex >= 0 ? anchorIndex : targetTailIndex >= 0 ? targetTailIndex + 1 : remaining.length;
  const rows = [...remaining];
  rows.splice(insertionIndex, 0, ...projectedMoving);
  const orderChanged = rows.some((row, index) => row !== model.query.rows[index]);
  if (!valuesChanged && !orderChanged) return model;
  const query = {
    ...model.query,
    rows,
  };
  return {
    ...model,
    columns: buildDatabaseViewColumns(
      query,
      query.view.config.presentation.group?.propertyId ?? null,
    ),
    query,
  };
};

const resolveStructuralDropValues = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageIds: readonly string[];
  readonly target: {
    readonly groupKey: string | null;
    readonly subgroupKey: string | null;
  };
}): readonly DatabaseViewDropPropertyValue[] => {
  const presentation = input.model.query.view.config.presentation;
  const rowsById = new Map(input.model.query.rows.map((row) => [row.page.pageId, row] as const));
  return [
    {
      property: activeProperty(input.model, presentation.group?.propertyId),
      key: input.target.groupKey,
      readCurrentKey: (pageId: string) => rowsById.get(pageId)?.effectiveGroupKey,
    },
    {
      property: activeProperty(input.model, presentation.subgroup?.propertyId),
      key: input.target.subgroupKey,
      readCurrentKey: (pageId: string) => rowsById.get(pageId)?.effectiveSubgroupKey,
    },
  ].flatMap(({ property, key, readCurrentKey }) => {
    if (!property) return [];
    const changesValue =
      input.pageIds.length === 0 || input.pageIds.some((pageId) => readCurrentKey(pageId) !== key);
    if (!changesValue) return [];
    return [
      {
        propertyId: property.propertyId,
        value: databaseGroupValueFromKey(property.valueType, key),
      },
    ];
  });
};

export const databaseViewSupportsSortedSlotInference = (
  model: DatabaseViewRenderModel,
): boolean => {
  for (const sort of model.query.view.config.rules.sorts) {
    if (sort.field.kind === "manual") return true;
    if (sort.field.kind !== "property") return false;
    const property = activeProperty(model, sort.field.propertyId);
    if (!property || property.valueType === "relation") {
      return false;
    }
  }
  return true;
};

const rowPropertyValue = (
  row: DatabaseViewRenderModel["query"]["rows"][number] | undefined,
  propertyId: string,
): DatabaseJsonValue => row?.values[propertyId]?.value ?? null;

/**
 * Infers the writable prefix of the active sort tuple at one visible slot.
 * The target row order already reflects direction/null policy, so the same
 * neighbor rule works for ascending and descending Views. Once adjacent rows
 * diverge, later sort fields cannot make the requested slot more precise.
 */
export const resolveDatabaseViewSortedDropValues = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageIds?: readonly string[];
  readonly target: {
    readonly groupKey: string | null;
    readonly subgroupKey: string | null;
    readonly beforePageId?: string;
  };
}): readonly DatabaseViewDropPropertyValue[] => {
  const ignoredPageIds = new Set(input.pageIds ?? []);
  const rows = input.model.query.rows.filter(
    (row) =>
      !ignoredPageIds.has(row.page.pageId) &&
      row.effectiveGroupKey === input.target.groupKey &&
      row.effectiveSubgroupKey === input.target.subgroupKey,
  );
  const afterIndex = input.target.beforePageId
    ? rows.findIndex((row) => row.page.pageId === input.target.beforePageId)
    : rows.length;
  if (afterIndex < 0) return [];
  const before = rows[afterIndex - 1];
  const after = rows[afterIndex];
  if (!before && !after) return [];

  const presentation = input.model.query.view.config.presentation;
  const structuralPropertyIds = new Set(
    [presentation.group?.propertyId, presentation.subgroup?.propertyId].filter(
      (propertyId): propertyId is string => propertyId !== undefined,
    ),
  );
  const values: DatabaseViewDropPropertyValue[] = [];
  for (const sort of input.model.query.view.config.rules.sorts) {
    if (sort.field.kind === "manual") break;
    if (sort.field.kind !== "property") break;
    const propertyId = sort.field.propertyId;
    if (structuralPropertyIds.has(propertyId)) continue;
    const property = activeProperty(input.model, propertyId);
    if (!property || property.valueType === "relation") break;
    const beforeValue = rowPropertyValue(before, propertyId);
    const afterValue = rowPropertyValue(after, propertyId);
    const neighborsMatch =
      before !== undefined &&
      after !== undefined &&
      stableStringifyDatabaseJson(beforeValue) === stableStringifyDatabaseJson(afterValue);
    const value = after !== undefined ? afterValue : beforeValue;
    values.push({ propertyId, value });
    if (!neighborsMatch) break;
  }
  return values;
};

/**
 * Describes every Property value the current visual drop proposal will impose.
 * Existing Pages omit structural values they already have; an empty Page set
 * represents incoming Blocks, whose promoted Pages receive all target values.
 */
export const resolveDatabaseViewDropPropertyValues = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageIds: readonly string[];
  readonly target: {
    readonly groupKey: string | null;
    readonly subgroupKey: string | null;
    readonly beforePageId?: string;
  };
}): readonly DatabaseViewDropPropertyValue[] => [
  ...resolveStructuralDropValues(input),
  ...resolveDatabaseViewSortedDropValues(input).filter(
    ({ propertyId, value }) =>
      input.pageIds.length === 0 ||
      input.pageIds.some((pageId) => {
        const row = input.model.query.rows.find((candidate) => candidate.page.pageId === pageId);
        if (!row) return false;
        return (
          stableStringifyDatabaseJson(rowPropertyValue(row, propertyId)) !==
          stableStringifyDatabaseJson(value)
        );
      }),
  ),
];

/**
 * Compiles one Board drop into a single Database transaction: grouping values
 * move first, then writable sort values or the View-global manual rank preserve
 * the user's visual insertion intent.
 */
export const buildDatabaseViewBoardDropOperations = (input: {
  readonly model: DatabaseViewRenderModel;
  readonly pageIds: readonly string[];
  readonly target: {
    readonly groupKey: string | null;
    readonly subgroupKey: string | null;
    readonly beforePageId?: string;
  };
  /** Exact semantic Property changes accepted at mouse-up. */
  readonly propertyValues?: readonly DatabaseViewDropPropertyValue[];
}): readonly DatabaseApplyOperationV2[] => {
  if (input.model.readOnlyReason) return [];
  const pageIds = [...new Set(input.pageIds)];
  if (pageIds.length === 0) return [];
  const rowsById = new Map(input.model.query.rows.map((row) => [row.page.pageId, row] as const));
  if (pageIds.some((pageId) => !rowsById.has(pageId))) return [];
  if (
    input.target.beforePageId &&
    (pageIds.includes(input.target.beforePageId) || !rowsById.has(input.target.beforePageId))
  )
    return [];

  const propertyValues =
    input.propertyValues ??
    resolveDatabaseViewDropPropertyValues({
      model: input.model,
      pageIds,
      target: input.target,
    });
  const valueOperations = compactValueEdits(
    propertyValues.flatMap(({ propertyId, value }) =>
      pageIds.flatMap((pageId) =>
        buildDatabaseViewPropertyValueOperations({
          model: input.model,
          pageId,
          propertyId,
          value,
        }),
      ),
    ),
  );
  const positionOperation: DatabaseApplyOperationV2[] = databaseViewSupportsSortedSlotInference(
    input.model,
  )
    ? [
        {
          kind: "position_pages",
          viewId: input.model.databaseViewId,
          pages: pageIds.map((pageId) => ({
            pageId,
            expectedPositionRevision: rowsById.get(pageId)?.position?.revision ?? 0,
          })),
          ...(input.target.beforePageId ? { beforePageId: input.target.beforePageId } : {}),
        },
      ]
    : [];
  return [...valueOperations, ...positionOperation];
};
