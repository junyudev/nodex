import { useCallback, useMemo, useState } from "react";

import type { DataSourcePropertyEditorBinding } from "@/components/database/data-source-property-editor-binding";
import { usePropertyOptionRegistries } from "@/components/database/use-property-option-registries";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourceRelationPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "@/lib/data-source-property-value-operations";
import {
  readDataSourceRelationTargetDescriptor,
  readDataSourceRelationTargets,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import { collectRequiredPropertyOptionIds } from "@/lib/database-option-registry-requirements";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import {
  buildDatabaseViewPropertyValueOperations,
  commitDatabaseViewOperations,
  type DatabaseViewMutationReceipt,
} from "@/lib/database-view-row-mutations";
import type { DatabaseJsonValue, DatabasePropertyOption } from "../../../shared/database-kernel";
import type {
  DatabaseApplyOperationV2,
  DataSourcePropertyRecordV2,
} from "../../../shared/database-module-v2";

const mutationKey = (pageId: string, propertyId: string): string => `${pageId}\u0000${propertyId}`;

export interface BoardPagePropertyBindingRuntime {
  readonly bindingsByPageId: ReadonlyMap<string, readonly DataSourcePropertyEditorBinding[]>;
  readonly optionsByPropertyId: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
}

export type BoardPagePropertyChangeAuthority =
  | { readonly kind: "grouping_move"; readonly groupValue: string }
  | { readonly kind: "property_value" };

/** Only the active single-select grouping Property owns Board placement. */
export const resolveBoardPagePropertyChangeAuthority = (input: {
  readonly property: DataSourcePropertyRecordV2;
  readonly groupingPropertyId: string | null;
  readonly value: DatabaseJsonValue;
}): BoardPagePropertyChangeAuthority => {
  if (
    input.property.propertyId === input.groupingPropertyId &&
    input.property.valueType === "select" &&
    typeof input.value === "string"
  ) {
    return { kind: "grouping_move", groupValue: input.value };
  }
  return { kind: "property_value" };
};

/**
 * Adapts Board rows to the shared Property editor contract.
 * Grouping selection remains an injected Board move; every other value uses
 * the same receipt-backed Database operations as List and Page Stage.
 */
export function useBoardPagePropertyBindings({
  model,
  projectId,
  columnIdByPageId,
  onMoveGroupingValue,
  onCommitted,
  onOpenRelationPage,
}: {
  readonly model: DatabaseViewRenderModel | null;
  readonly projectId: string;
  readonly columnIdByPageId: ReadonlyMap<string, string>;
  readonly onMoveGroupingValue: (
    pageId: string,
    fromColumnId: string,
    value: DatabaseJsonValue,
  ) => Promise<boolean>;
  readonly onCommitted: (receipt: DatabaseViewMutationReceipt | null) => Promise<void> | void;
  readonly onOpenRelationPage: (pageId: string, title: string) => void;
}): BoardPagePropertyBindingRuntime {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const properties = useMemo(() => model?.query.properties ?? [], [model?.query.properties]);
  const requiredOptionIds = useMemo(
    () =>
      model
        ? collectRequiredPropertyOptionIds({
            properties,
            rows: model.query.rows,
          })
        : {},
    [model, properties],
  );
  const optionRegistries = usePropertyOptionRegistries({
    routingContext: { kind: "project", projectId },
    properties,
    requiredOptionIds,
  });

  const commit = useCallback(
    async (
      pageId: string,
      propertyId: string,
      operations: readonly DatabaseApplyOperationV2[],
      propagateError = false,
    ): Promise<void> => {
      if (!model || operations.length === 0) return;
      const key = mutationKey(pageId, propertyId);
      setPendingKeys((current) => new Set(current).add(key));
      setErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      let receipt: DatabaseViewMutationReceipt | null = null;
      try {
        receipt = await commitDatabaseViewOperations({ model, operations });
      } catch (cause) {
        console.error("[board:property-context-menu]", cause);
        setErrors((current) =>
          new Map(current).set(key, "Couldn’t save this Property. Refresh and try again."),
        );
        if (propagateError) throw cause;
      } finally {
        try {
          await onCommitted(receipt);
        } catch (cause) {
          console.error("[board:property-context-menu:refresh]", cause);
        }
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [model, onCommitted],
  );

  const bindingsByPageId = useMemo(() => {
    if (!model) return new Map<string, readonly DataSourcePropertyEditorBinding[]>();
    const groupingPropertyId = model.query.view.config.presentation.group?.propertyId ?? null;
    const relationCandidates = model.query.rows.map((row) => ({
      pageId: row.page.pageId,
      title: row.page.title,
    }));
    return new Map(
      model.query.rows.map((row) => {
        const pageId = row.page.pageId;
        const bindings = properties
          .filter((property) => property.lifecycle === "active")
          .map<DataSourcePropertyEditorBinding>((property) => {
            const current = row.values[property.propertyId];
            const key = mutationKey(pageId, property.propertyId);
            const groupingSelectionOwnedByBoard =
              property.propertyId === groupingPropertyId && property.valueType === "select";
            const createOption: NonNullable<DataSourcePropertyEditorBinding["onCreateOption"]> = (
              option,
            ) =>
              commit(
                pageId,
                property.propertyId,
                buildDataSourceCreateOptionAndSelectOperations({
                  pageId,
                  dataSourceId: model.dataSourceId,
                  property,
                  current,
                  option: {
                    id: option.optionId,
                    name: option.name,
                    ...(option.color === undefined ? {} : { color: option.color }),
                  },
                }),
                true,
              );
            const change = (value: DatabaseJsonValue): void => {
              const fromColumnId = columnIdByPageId.get(pageId);
              const authority = resolveBoardPagePropertyChangeAuthority({
                property,
                groupingPropertyId,
                value,
              });
              if (authority.kind === "grouping_move" && fromColumnId) {
                setPendingKeys((pending) => new Set(pending).add(key));
                setErrors((all) => {
                  const next = new Map(all);
                  next.delete(key);
                  return next;
                });
                void onMoveGroupingValue(pageId, fromColumnId, authority.groupValue)
                  .then((moved) => {
                    if (moved) return;
                    setErrors((all) =>
                      new Map(all).set(key, "Couldn’t move this Page to that group."),
                    );
                  })
                  .catch((cause) => {
                    console.error("[board:property-context-menu:move]", cause);
                    setErrors((all) =>
                      new Map(all).set(key, "Couldn’t move this Page to that group."),
                    );
                  })
                  .finally(() => {
                    setPendingKeys((pending) => {
                      const next = new Set(pending);
                      next.delete(key);
                      return next;
                    });
                  });
                return;
              }
              void commit(
                pageId,
                property.propertyId,
                buildDatabaseViewPropertyValueOperations({
                  model,
                  pageId,
                  propertyId: property.propertyId,
                  value,
                }),
              );
            };
            const binding: DataSourcePropertyEditorBinding = {
              property,
              value: current?.value,
              revision: current?.revision ?? 0,
              disabled: property.lifecycle !== "active",
              pending: pendingKeys.has(key),
              error: errors.get(key) ?? null,
              options: optionRegistries.options[property.propertyId] ?? [],
              optionRegistryState: optionRegistries.states[property.propertyId] ?? "ready",
              optionRegistryHasMore: optionRegistries.hasMore[property.propertyId] ?? false,
              optionRegistryLoadingMore: optionRegistries.loadingMore[property.propertyId] ?? false,
              onRequestOptions: () => optionRegistries.requestOptions(property),
              onRequestMoreOptions: () => optionRegistries.requestMoreOptions(property),
              relationCandidates,
              relationSourcePageId: pageId,
              onChange: change,
              onPatchOptions: (delta) =>
                void commit(
                  pageId,
                  property.propertyId,
                  buildDataSourceMultiSelectPatchOperations({
                    pageId,
                    dataSourceId: model.dataSourceId,
                    property,
                    ...delta,
                  }),
                ),
              ...(groupingSelectionOwnedByBoard
                ? {}
                : {
                    onCreateOption: createOption,
                  }),
              onPatchRelation: (delta) =>
                void commit(
                  pageId,
                  property.propertyId,
                  buildDataSourceRelationPatchOperations({
                    pageId,
                    dataSourceId: model.dataSourceId,
                    property,
                    ...delta,
                  }),
                ),
              onReplaceOneRelation: (targetPageId) =>
                void commit(
                  pageId,
                  property.propertyId,
                  buildDataSourceRelationReplacementOperations({
                    pageId,
                    dataSourceId: model.dataSourceId,
                    property,
                    expectedValueRevision: current?.revision ?? 0,
                    targetPageId,
                  }),
                ),
              onLoadRelationTargets: (after) =>
                readDataSourceRelationTargets({
                  routingContext: model.routingContext,
                  pageId,
                  property,
                  after,
                }),
              onSearchRelationCandidates: (query, after) =>
                searchDataSourceRelationCandidates({
                  routingContext: model.routingContext,
                  property,
                  query,
                  after,
                }),
              onLoadRelationTargetDescriptor: () =>
                readDataSourceRelationTargetDescriptor({
                  routingContext: model.routingContext,
                  property,
                }),
              onOpenRelationPage,
              onRelationValueStale: () => {
                void Promise.resolve(onCommitted(null)).catch((cause: unknown) => {
                  console.error("[board:property-context-menu:refresh]", cause);
                });
              },
            };
            return binding;
          });
        return [pageId, bindings] as const;
      }),
    );
  }, [
    columnIdByPageId,
    commit,
    errors,
    model,
    onCommitted,
    onMoveGroupingValue,
    onOpenRelationPage,
    optionRegistries,
    pendingKeys,
    properties,
  ]);

  return {
    bindingsByPageId,
    optionsByPropertyId: optionRegistries.options,
  };
}
