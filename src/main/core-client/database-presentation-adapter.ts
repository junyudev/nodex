import {
  parseDatabaseViewPresentationOverride,
  parseDatabaseViewRulesOverride,
  type DatabaseViewField,
  type DatabaseViewPreferencesOverride,
  type DatabaseViewPresentationOverride,
  type DatabaseViewRulesOverride,
} from "../../shared/database-kernel";
import type { DatabaseRead } from "./types";

export type CoreDatabaseViewPreferencesOverride = Extract<
  Extract<DatabaseRead, { readonly kind: "view_window" }>["target"],
  { readonly kind: "presented_view" }
>["preferences_override"];

export type CoreDatabaseViewPresentationOverride =
  CoreDatabaseViewPreferencesOverride["presentation_override"];
export type CoreDatabaseViewRulesOverride = CoreDatabaseViewPreferencesOverride["rules_override"];
type CoreDatabaseViewFilter = Extract<
  NonNullable<CoreDatabaseViewRulesOverride["advanced_filter"]>,
  { readonly kind: "filter" }
>["filter"];

const VALUELESS_FILTER_OPERATORS = new Set(["is_empty", "is_not_empty"]);

/**
 * Early v9 Core events could collapse an explicit null draft operand into an
 * omitted field. Normalize that historical shape only at the Core adapter;
 * renderer contracts and all newly authored mutations remain strict.
 */
const normalizeCoreFilterDraftValue = (filter: CoreDatabaseViewFilter): CoreDatabaseViewFilter => {
  if (filter.kind === "group") {
    return { ...filter, children: filter.children.map(normalizeCoreFilterDraftValue) };
  }
  if (VALUELESS_FILTER_OPERATORS.has(filter.operator)) {
    if (!("value" in filter)) return filter;
    const { value: _value, ...withoutValue } = filter;
    return withoutValue;
  }
  return "value" in filter ? filter : { ...filter, value: null };
};

const toCoreViewField = (
  field: DatabaseViewField,
): Extract<
  NonNullable<NonNullable<CoreDatabaseViewPresentationOverride["display"]>["fields"]>,
  readonly unknown[]
>[number] =>
  field.kind === "property"
    ? { kind: "property", property_id: field.propertyId }
    : { kind: "intrinsic", field: field.field };

const toCoreSort = (rule: NonNullable<DatabaseViewRulesOverride["sorts"]>[number]) => ({
  field:
    rule.field.kind === "property"
      ? { kind: "property" as const, property_id: rule.field.propertyId }
      : { kind: rule.field.kind },
  direction: rule.direction,
  nulls: rule.nulls,
});

const fromCoreSort = (rule: NonNullable<CoreDatabaseViewRulesOverride["sorts"]>[number]) => ({
  field:
    rule.field.kind === "property"
      ? { kind: "property" as const, propertyId: rule.field.property_id }
      : { kind: rule.field.kind },
  direction: rule.direction,
  nulls: rule.nulls,
});

export const toCoreDatabaseViewRulesOverride = (
  override: DatabaseViewRulesOverride,
): CoreDatabaseViewRulesOverride => ({
  ...(override.propertyFilters === undefined ? {} : { property_filters: override.propertyFilters }),
  ...(override.advancedFilter === undefined
    ? {}
    : {
        advanced_filter:
          override.advancedFilter === null
            ? { kind: "none" as const }
            : { kind: "filter" as const, filter: override.advancedFilter },
      }),
  ...(override.sorts === undefined ? {} : { sorts: override.sorts.map(toCoreSort) }),
});

export const fromCoreDatabaseViewRulesOverride = (
  override: CoreDatabaseViewRulesOverride,
): DatabaseViewRulesOverride =>
  parseDatabaseViewRulesOverride({
    ...(override.property_filters == null
      ? {}
      : {
          propertyFilters: override.property_filters.map((filter) => ({
            ...filter,
            clause: normalizeCoreFilterDraftValue(filter.clause),
          })),
        }),
    ...(override.advanced_filter == null
      ? {}
      : {
          advancedFilter:
            override.advanced_filter.kind === "none"
              ? null
              : normalizeCoreFilterDraftValue(override.advanced_filter.filter),
        }),
    ...(override.sorts == null ? {} : { sorts: override.sorts.map(fromCoreSort) }),
  });

export const toCoreDatabaseViewPresentationOverride = (
  override: DatabaseViewPresentationOverride,
): CoreDatabaseViewPresentationOverride => ({
  ...(override.group === undefined
    ? {}
    : {
        group:
          override.group === null
            ? { kind: "none" as const }
            : { kind: "property" as const, property_id: override.group.propertyId },
      }),
  ...(override.subgroup === undefined
    ? {}
    : {
        subgroup:
          override.subgroup === null
            ? { kind: "none" as const }
            : { kind: "property" as const, property_id: override.subgroup.propertyId },
      }),
  ...(override.groupDirection === undefined ? {} : { group_direction: override.groupDirection }),
  ...(override.completion === undefined
    ? {}
    : {
        completion: {
          ...(override.completion.range === undefined ? {} : { range: override.completion.range }),
          ...(override.completion.orderByRecency === undefined
            ? {}
            : { order_by_recency: override.completion.orderByRecency }),
        },
      }),
  ...(override.hierarchy === undefined
    ? {}
    : {
        hierarchy: {
          ...(override.hierarchy.showSubPages === undefined
            ? {}
            : { show_sub_pages: override.hierarchy.showSubPages }),
          ...(override.hierarchy.nestedSubPages === undefined
            ? {}
            : { nested_sub_pages: override.hierarchy.nestedSubPages }),
        },
      }),
  ...(override.display === undefined
    ? {}
    : {
        display: {
          ...(override.display.fields === undefined
            ? {}
            : { fields: override.display.fields.map(toCoreViewField) }),
          ...(override.display.propertyOrder === undefined
            ? {}
            : { property_order: [...override.display.propertyOrder] }),
          ...(override.display.showEmptyGroups === undefined
            ? {}
            : { show_empty_groups: override.display.showEmptyGroups }),
          ...(override.display.showDescription === undefined
            ? {}
            : { show_description: override.display.showDescription }),
        },
      }),
});

const fromCoreViewField = (
  field: NonNullable<
    NonNullable<NonNullable<CoreDatabaseViewPresentationOverride["display"]>["fields"]>
  >[number],
): DatabaseViewField =>
  field.kind === "property"
    ? { kind: "property", propertyId: field.property_id }
    : { kind: "intrinsic", field: field.field };

export const fromCoreDatabaseViewPresentationOverride = (
  override: CoreDatabaseViewPresentationOverride,
): DatabaseViewPresentationOverride =>
  parseDatabaseViewPresentationOverride({
    ...(override.group == null
      ? {}
      : {
          group: override.group.kind === "none" ? null : { propertyId: override.group.property_id },
        }),
    ...(override.subgroup == null
      ? {}
      : {
          subgroup:
            override.subgroup.kind === "none"
              ? null
              : { propertyId: override.subgroup.property_id },
        }),
    ...(override.group_direction == null ? {} : { groupDirection: override.group_direction }),
    ...(override.completion == null
      ? {}
      : {
          completion: {
            ...(override.completion.range == null ? {} : { range: override.completion.range }),
            ...(override.completion.order_by_recency == null
              ? {}
              : { orderByRecency: override.completion.order_by_recency }),
          },
        }),
    ...(override.hierarchy == null
      ? {}
      : {
          hierarchy: {
            ...(override.hierarchy.show_sub_pages == null
              ? {}
              : { showSubPages: override.hierarchy.show_sub_pages }),
            ...(override.hierarchy.nested_sub_pages == null
              ? {}
              : { nestedSubPages: override.hierarchy.nested_sub_pages }),
          },
        }),
    ...(override.display == null
      ? {}
      : {
          display: {
            ...(override.display.fields == null
              ? {}
              : { fields: override.display.fields.map(fromCoreViewField) }),
            ...(override.display.property_order == null
              ? {}
              : { propertyOrder: override.display.property_order }),
            ...(override.display.show_empty_groups == null
              ? {}
              : { showEmptyGroups: override.display.show_empty_groups }),
            ...(override.display.show_description == null
              ? {}
              : { showDescription: override.display.show_description }),
          },
        }),
  });

export const toCoreDatabaseViewPreferencesOverride = (
  override: DatabaseViewPreferencesOverride,
): CoreDatabaseViewPreferencesOverride => ({
  rules_override: toCoreDatabaseViewRulesOverride(override.rulesOverride),
  presentation_override: toCoreDatabaseViewPresentationOverride(override.presentationOverride),
});

export const fromCoreDatabaseViewPreferencesOverride = (
  override: CoreDatabaseViewPreferencesOverride,
): DatabaseViewPreferencesOverride => ({
  rulesOverride: fromCoreDatabaseViewRulesOverride(override.rules_override),
  presentationOverride: fromCoreDatabaseViewPresentationOverride(override.presentation_override),
});
