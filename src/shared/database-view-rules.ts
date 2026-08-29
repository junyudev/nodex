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

export const databaseViewFilterOperatorLabel = (operator: DatabaseViewFilterOperator): string =>
  ({
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    text_is: "is",
    text_is_not: "is not",
    text_contains: "contains",
    text_does_not_contain: "does not contain",
    text_starts_with: "starts with",
    text_ends_with: "ends with",
    number_equals: "equals",
    number_does_not_equal: "does not equal",
    number_greater_than: "is greater than",
    number_less_than: "is less than",
    number_greater_than_or_equal_to: "is at least",
    number_less_than_or_equal_to: "is at most",
    checkbox_is: "is",
    checkbox_is_not: "is not",
    select_is: "is",
    select_is_not: "is not",
    multi_select_contains: "contains",
    multi_select_does_not_contain: "does not contain",
    multi_select_contains_all: "contains all",
    date_is: "is",
    date_is_not: "is not",
    date_before: "is before",
    date_after: "is after",
    date_on_or_before: "is on or before",
    date_on_or_after: "is on or after",
    date_within: "is within",
    date_relative_to: "is relative to",
    relation_contains: "contains",
    relation_does_not_contain: "does not contain",
    is_empty: "is empty",
    is_not_empty: "is not empty",
  })[operator];

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
