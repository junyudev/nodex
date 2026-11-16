import { defineMessages } from "./i18n/messages";
import type {
  DatabaseJsonValue,
  DatabaseViewFilterClause,
  DatabaseViewFilterGroup,
  DatabaseViewFilterNode,
  DatabaseViewFilterOperator,
  DatabaseViewRules,
  DatabaseViewRulesOverride,
} from "./database-kernel";

export type DatabaseViewRuleScope = "filters" | "sorts" | "all";

export const clearDatabaseViewRulesOverrideScope = (
  override: DatabaseViewRulesOverride,
  scope: DatabaseViewRuleScope,
): DatabaseViewRulesOverride | null => {
  const filters = scope === "filters" || scope === "all";
  const sorts = scope === "sorts" || scope === "all";
  const remaining: DatabaseViewRulesOverride = {
    ...(!filters && override.propertyFilters !== undefined
      ? { propertyFilters: override.propertyFilters }
      : {}),
    ...(!filters && override.advancedFilter !== undefined
      ? { advancedFilter: override.advancedFilter }
      : {}),
    ...(!sorts && override.sorts !== undefined ? { sorts: override.sorts } : {}),
  };
  return Object.keys(remaining).length === 0 ? null : remaining;
};

const filterOperatorMessages = defineMessages({
  date_is: { id: "shared.databaseViewRules.operator.dateIs", defaultMessage: "is" },
  date_is_not: { id: "shared.databaseViewRules.operator.dateIsNot", defaultMessage: "is not" },
  relation_contains: {
    id: "shared.databaseViewRules.operator.relationContains",
    defaultMessage: "contains",
  },
  relation_does_not_contain: {
    id: "shared.databaseViewRules.operator.relationDoesNotContain",
    defaultMessage: "does not contain",
  },
  text_starts_with: {
    id: "shared.databaseViewRules.operator.textStartsWith",
    defaultMessage: "starts with",
  },
  text_ends_with: {
    id: "shared.databaseViewRules.operator.textEndsWith",
    defaultMessage: "ends with",
  },
  number_equals: { id: "shared.databaseViewRules.operator.numberEquals", defaultMessage: "equals" },
  number_does_not_equal: {
    id: "shared.databaseViewRules.operator.numberDoesNotEqual",
    defaultMessage: "does not equal",
  },
  number_greater_than: {
    id: "shared.databaseViewRules.operator.numberGreaterThan",
    defaultMessage: "is greater than",
  },
  number_less_than: {
    id: "shared.databaseViewRules.operator.numberLessThan",
    defaultMessage: "is less than",
  },
  number_greater_than_or_equal_to: {
    id: "shared.databaseViewRules.operator.numberGreaterThanOrEqualTo",
    defaultMessage: "is at least",
  },
  number_less_than_or_equal_to: {
    id: "shared.databaseViewRules.operator.numberLessThanOrEqualTo",
    defaultMessage: "is at most",
  },
  multi_select_contains_all: {
    id: "shared.databaseViewRules.operator.multiSelectContainsAll",
    defaultMessage: "contains all",
  },
  date_before: { id: "shared.databaseViewRules.operator.dateBefore", defaultMessage: "is before" },
  date_after: { id: "shared.databaseViewRules.operator.dateAfter", defaultMessage: "is after" },
  date_on_or_before: {
    id: "shared.databaseViewRules.operator.dateOnOrBefore",
    defaultMessage: "is on or before",
  },
  date_on_or_after: {
    id: "shared.databaseViewRules.operator.dateOnOrAfter",
    defaultMessage: "is on or after",
  },
  date_within: { id: "shared.databaseViewRules.operator.dateWithin", defaultMessage: "is within" },
  date_relative_to: {
    id: "shared.databaseViewRules.operator.dateRelativeTo",
    defaultMessage: "is relative to",
  },
  is_empty: { id: "shared.databaseViewRules.operator.isEmpty", defaultMessage: "is empty" },
  is_not_empty: {
    id: "shared.databaseViewRules.operator.isNotEmpty",
    defaultMessage: "is not empty",
  },
});

export const DATABASE_VIEW_FILTER_OPERATOR_MESSAGES = {
  equals: filterOperatorMessages.date_is,
  not_equals: filterOperatorMessages.date_is_not,
  contains: filterOperatorMessages.relation_contains,
  not_contains: filterOperatorMessages.relation_does_not_contain,
  text_is: filterOperatorMessages.date_is,
  text_is_not: filterOperatorMessages.date_is_not,
  text_contains: filterOperatorMessages.relation_contains,
  text_does_not_contain: filterOperatorMessages.relation_does_not_contain,
  text_starts_with: filterOperatorMessages.text_starts_with,
  text_ends_with: filterOperatorMessages.text_ends_with,
  number_equals: filterOperatorMessages.number_equals,
  number_does_not_equal: filterOperatorMessages.number_does_not_equal,
  number_greater_than: filterOperatorMessages.number_greater_than,
  number_less_than: filterOperatorMessages.number_less_than,
  number_greater_than_or_equal_to: filterOperatorMessages.number_greater_than_or_equal_to,
  number_less_than_or_equal_to: filterOperatorMessages.number_less_than_or_equal_to,
  checkbox_is: filterOperatorMessages.date_is,
  checkbox_is_not: filterOperatorMessages.date_is_not,
  select_is: filterOperatorMessages.date_is,
  select_is_not: filterOperatorMessages.date_is_not,
  multi_select_contains: filterOperatorMessages.relation_contains,
  multi_select_does_not_contain: filterOperatorMessages.relation_does_not_contain,
  multi_select_contains_all: filterOperatorMessages.multi_select_contains_all,
  date_is: filterOperatorMessages.date_is,
  date_is_not: filterOperatorMessages.date_is_not,
  date_before: filterOperatorMessages.date_before,
  date_after: filterOperatorMessages.date_after,
  date_on_or_before: filterOperatorMessages.date_on_or_before,
  date_on_or_after: filterOperatorMessages.date_on_or_after,
  date_within: filterOperatorMessages.date_within,
  date_relative_to: filterOperatorMessages.date_relative_to,
  relation_contains: filterOperatorMessages.relation_contains,
  relation_does_not_contain: filterOperatorMessages.relation_does_not_contain,
  is_empty: filterOperatorMessages.is_empty,
  is_not_empty: filterOperatorMessages.is_not_empty,
} satisfies Record<
  DatabaseViewFilterOperator,
  (typeof filterOperatorMessages)[keyof typeof filterOperatorMessages]
>;

export const databaseViewFilterOperatorLabel = (
  operator: DatabaseViewFilterOperator,
  formatMessage?: (
    message: (typeof DATABASE_VIEW_FILTER_OPERATOR_MESSAGES)[DatabaseViewFilterOperator],
  ) => string,
): string => {
  const message = DATABASE_VIEW_FILTER_OPERATOR_MESSAGES[operator];
  return formatMessage ? formatMessage(message) : message.defaultMessage;
};

export const databaseViewFilterClauseIsEmpty = (clause: DatabaseViewFilterClause): boolean => {
  if (clause.operator === "is_empty" || clause.operator === "is_not_empty") return false;
  if (clause.value === undefined || clause.value === null || clause.value === "") return true;
  if (Array.isArray(clause.value)) return clause.value.length === 0;
  if (clause.operator !== "date_within") return false;
  if (typeof clause.value !== "object") return true;
  const range = clause.value as Readonly<Record<string, DatabaseJsonValue>>;
  const start = range.start;
  const end = range.end;
  return typeof start !== "string" || start === "" || typeof end !== "string" || end === "";
};

const effectiveDatabaseViewFilterNode = (
  node: DatabaseViewFilterNode,
): DatabaseViewFilterNode | null => {
  if (node.kind === "clause") {
    return databaseViewFilterClauseIsEmpty(node) ? null : node;
  }
  const children = node.children.flatMap((child) => {
    const effective = effectiveDatabaseViewFilterNode(child);
    return effective ? [effective] : [];
  });
  return children.length === 0 ? null : { ...node, children };
};

/** The canonical query tree: non-empty quick filters AND the optional advanced group. */
export const effectiveDatabaseViewFilter = (rules: DatabaseViewRules): DatabaseViewFilterGroup => ({
  kind: "group",
  operator: "and",
  children: [
    ...rules.propertyFilters.flatMap((filter) =>
      databaseViewFilterClauseIsEmpty(filter.clause) ? [] : [filter.clause],
    ),
    ...(rules.advancedFilter
      ? [effectiveDatabaseViewFilterNode(rules.advancedFilter)].filter(
          (filter): filter is DatabaseViewFilterNode => filter !== null,
        )
      : []),
  ],
});

export const databaseViewFilterNodeRuleCount = (node: DatabaseViewFilterNode | null): number => {
  if (!node) return 0;
  if (node.kind === "clause") return 1;
  return node.children.reduce((count, child) => count + databaseViewFilterNodeRuleCount(child), 0);
};
