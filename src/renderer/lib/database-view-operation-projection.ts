import { stableStringifyDatabaseJson, type DatabaseJsonValue } from "../../shared/database-kernel";
import type {
  DatabaseApplyOperationV2,
  DatabaseApplyReceiptV2,
  DatabasePropertyValueInputV2,
  DataSourcePageRowV2,
} from "../../shared/database-module-v2";
import { databaseViewPrimaryManualOrderDirection } from "../../shared/database-view-presentation";
import { contentAccessContextKey } from "../../shared/content-access-context";
import {
  buildDatabaseViewColumns,
  type DatabaseViewRenderModel,
} from "./database-view-render-model";

interface ValueIntent {
  readonly pageId: string;
  readonly dataSourceId: string;
  readonly propertyId: string;
  readonly value: DatabaseJsonValue;
}

interface PositionIntent {
  readonly viewId: string;
  readonly pageIds: readonly string[];
  readonly beforePageId: string | null;
  readonly direction?: "asc" | "desc";
}

export interface DatabaseViewOperationProjection {
  readonly apply: (canonical: DatabaseViewRenderModel) => DatabaseViewRenderModel;
  readonly conflictKeys: readonly string[];
  readonly predictable: boolean;
  readonly acknowledge?: (receipt: Pick<DatabaseApplyReceiptV2, "committedRevisions">) => void;
}

const inputValue = (input: DatabasePropertyValueInputV2): DatabaseJsonValue => {
  if (input.kind === "empty") return null;
  if (input.kind === "select") return input.optionId;
  if (input.kind === "multi_select") return [...new Set(input.optionIds)].sort();
  return input.value;
};

const sameGroup = (left: DataSourcePageRowV2, right: DataSourcePageRowV2): boolean =>
  left.effectiveGroupKey === right.effectiveGroupKey &&
  left.effectiveSubgroupKey === right.effectiveSubgroupKey;

const canProjectValue = (model: DatabaseViewRenderModel, intent: ValueIntent): boolean => {
  if (intent.dataSourceId !== model.dataSourceId) return false;
  if (!model.query.rows.some((row) => row.page.pageId === intent.pageId)) return false;
  const property = model.query.properties.find(
    (candidate) => candidate.propertyId === intent.propertyId,
  );
  if (!property || property.lifecycle !== "active" || property.valueType === "relation")
    return false;
  const { rules, presentation } = model.query.view.config;
  // Membership, grouping and sort changes need Core's complete projection, not
  // a partial client-side query evaluator over one bounded window.
  if (rules.propertyFilters.length > 0 || rules.advancedFilter !== null) return false;
  if (presentation.completion.range !== "all" || presentation.completion.orderByRecency)
    return false;
  if (
    presentation.group?.propertyId === intent.propertyId ||
    presentation.subgroup?.propertyId === intent.propertyId
  )
    return false;
  return !rules.sorts.some(
    (sort) => sort.field.kind === "property" && sort.field.propertyId === intent.propertyId,
  );
};

const canProjectPosition = (model: DatabaseViewRenderModel, intent: PositionIntent): boolean => {
  if (intent.viewId !== model.databaseViewId || intent.pageIds.length === 0) return false;
  const direction = databaseViewPrimaryManualOrderDirection(model.query.view.config.rules.sorts);
  if (!direction || (intent.direction && intent.direction !== direction)) return false;
  // A query result has no tail-completeness coordinate. An absent anchor can
  // mean more rows are outside this window, so it cannot prove an append.
  if (!intent.beforePageId || intent.pageIds.includes(intent.beforePageId)) return false;
  const anchor = model.query.rows.find((row) => row.page.pageId === intent.beforePageId);
  if (!anchor) return false;
  return intent.pageIds.every((pageId) => {
    const row = model.query.rows.find((candidate) => candidate.page.pageId === pageId);
    return row !== undefined && sameGroup(row, anchor);
  });
};

const projectValues = (
  model: DatabaseViewRenderModel,
  intents: readonly ValueIntent[],
): readonly DataSourcePageRowV2[] =>
  model.query.rows.map((row) => {
    const edits = intents.filter((intent) => intent.pageId === row.page.pageId);
    if (edits.length === 0) return row;
    const values = { ...row.values };
    for (const intent of edits) {
      const property = model.query.properties.find(
        (candidate) => candidate.propertyId === intent.propertyId,
      )!;
      const current = values[intent.propertyId];
      if (
        stableStringifyDatabaseJson(current?.value ?? null) ===
        stableStringifyDatabaseJson(intent.value)
      )
        continue;
      values[intent.propertyId] = {
        propertyId: property.propertyId,
        valueType: property.valueType,
        revision: current?.revision ?? 0,
        value: intent.value,
      };
    }
    const changed = Object.keys(values).some((key) => values[key] !== row.values[key]);
    return changed ? { ...row, values } : row;
  });

const projectPosition = (
  rows: readonly DataSourcePageRowV2[],
  intent: PositionIntent,
): readonly DataSourcePageRowV2[] => {
  const moving = intent.pageIds.map((pageId) => rows.find((row) => row.page.pageId === pageId)!);
  const selected = new Set(intent.pageIds);
  const remaining = rows.filter((row) => !selected.has(row.page.pageId));
  const anchorIndex = remaining.findIndex((row) => row.page.pageId === intent.beforePageId);
  return [...remaining.slice(0, anchorIndex), ...moving, ...remaining.slice(anchorIndex)];
};

/**
 * Freezes only semantics provable from this bounded View. Forward edits and
 * authoritative reverse recipes share the same transform. Identity is exact
 * materialization evidence only for a predictable plan in its original scope.
 */
export const compileDatabaseViewOperationProjection = (
  model: DatabaseViewRenderModel,
  operations: readonly DatabaseApplyOperationV2[],
): DatabaseViewOperationProjection => {
  const values: ValueIntent[] = [];
  const positions: PositionIntent[] = [];
  let supported = operations.length > 0;
  for (const operation of operations) {
    if (operation.kind === "edit_property_values") {
      for (const edit of operation.edits) {
        if (edit.edit.kind !== "replace") {
          supported = false;
          continue;
        }
        values.push({ ...edit, value: inputValue(edit.edit.value) });
      }
      continue;
    }
    if (operation.kind === "position_page" || operation.kind === "position_pages") {
      positions.push({
        viewId: operation.viewId,
        pageIds:
          operation.kind === "position_page"
            ? [operation.pageId]
            : operation.pages.map((page) => page.pageId),
        beforePageId: operation.beforePageId ?? null,
      });
      continue;
    }
    if (operation.kind === "reverse_data_edit") {
      values.push(
        ...operation.recipe.propertyStates.map((state) => ({
          ...state.address,
          value: inputValue(state.beforeValue),
        })),
      );
      positions.push(
        ...operation.recipe.positionStates.flatMap((state) =>
          state.beforeRuns.map((run) => ({
            ...run,
            viewId: state.viewId,
            direction: state.direction,
          })),
        ),
      );
      continue;
    }
    supported = false;
  }
  const conflictKeys = [
    ...new Set([
      ...values.map(
        (intent) => `value:${intent.dataSourceId}:${intent.pageId}:${intent.propertyId}`,
      ),
      ...positions.flatMap((intent) => [
        `view-order:${intent.viewId}`,
        ...intent.pageIds.map((pageId) => `page:${pageId}`),
      ]),
    ]),
  ];
  const valid = (candidate: DatabaseViewRenderModel): boolean =>
    values.every((intent) => {
      const original = model.query.rows.find((row) => row.page.pageId === intent.pageId);
      const current = candidate.query.rows.find((row) => row.page.pageId === intent.pageId);
      const propertyType = (view: DatabaseViewRenderModel) =>
        view.query.properties.find((property) => property.propertyId === intent.propertyId)
          ?.valueType;
      return (
        canProjectValue(candidate, intent) &&
        original?.membership.membershipId === current?.membership.membershipId &&
        propertyType(model) === propertyType(candidate)
      );
    }) && positions.every((intent) => canProjectPosition(candidate, intent));
  const predictable = supported && valid(model);
  if (!predictable) return { apply: (canonical) => canonical, conflictKeys, predictable: false };
  // A batch may replace one value repeatedly. Its final post-image, rather
  // than intermediate allocations, is the observable materialization proof.
  const finalValues = [
    ...new Map(
      values.map((intent) => [
        JSON.stringify([intent.dataSourceId, intent.pageId, intent.propertyId]),
        intent,
      ]),
    ).values(),
  ];
  const configKey = stableStringifyDatabaseJson(model.query.view.config);
  let committedRevisions: Readonly<Record<string, number>> = {};
  const superseded = (key: string, revision: number | undefined): boolean => {
    const committed = committedRevisions[key];
    return committed !== undefined && revision !== undefined && revision > committed;
  };
  return {
    conflictKeys,
    predictable: true,
    acknowledge: (receipt) => {
      committedRevisions = receipt.committedRevisions;
    },
    apply: (canonical) => {
      if (
        canonical.storeEpoch !== model.storeEpoch ||
        canonical.libraryId !== model.libraryId ||
        contentAccessContextKey(canonical.accessContext) !==
          contentAccessContextKey(model.accessContext) ||
        canonical.databaseId !== model.databaseId ||
        canonical.databaseViewId !== model.databaseViewId ||
        canonical.dataSourceId !== model.dataSourceId ||
        stableStringifyDatabaseJson(canonical.query.view.config) !== configKey ||
        !valid(canonical)
      ) {
        // A missing row/anchor is not success. Keep a non-identity result so
        // the owner cannot retire this intent on incomplete canonical data.
        return { ...canonical };
      }
      // A later write to this exact resource supersedes our post-image, even
      // if an intermediate read never observed it. Unrelated cursor movement
      // and other addresses in the same batch are not settlement evidence.
      const outstandingValues = finalValues.filter((intent) => {
        const row = canonical.query.rows.find(
          (candidate) => candidate.page.pageId === intent.pageId,
        )!;
        return !superseded(
          `value:${intent.dataSourceId}:${row.membership.membershipId}:${intent.propertyId}`,
          row.values[intent.propertyId]?.revision,
        );
      });
      const outstandingPositions = positions.map((intent) => ({
        ...intent,
        pageIds: intent.pageIds.filter((pageId) => {
          const committed = committedRevisions[`position:${intent.viewId}:${pageId}`];
          const revision = canonical.query.rows.find((row) => row.page.pageId === pageId)?.position
            ?.revision;
          // Rank values are assigned by Core. Its exact receipt revision is
          // stronger evidence than relative adjacency, which another row's
          // later move can legitimately change without rewriting this rank.
          return committed === undefined || revision === undefined || revision < committed;
        }),
      }));
      const rows = outstandingPositions.reduce(
        projectPosition,
        projectValues(canonical, outstandingValues),
      );
      if (rows.every((row, index) => row === canonical.query.rows[index])) return canonical;
      const query = { ...canonical.query, rows };
      return {
        ...canonical,
        query,
        columns: buildDatabaseViewColumns(
          query,
          query.view.config.presentation.group?.propertyId ?? null,
        ),
      };
    },
  };
};
