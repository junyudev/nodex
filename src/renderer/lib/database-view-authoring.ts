import {
  stableStringifyDatabaseJson,
  type DatabaseJsonValue,
  type DatabasePropertyOption,
  type DatabaseViewFilterClause,
  type DatabaseViewFilterNode,
  type DatabaseViewFilterOperator,
  type DatabaseViewSort,
  type DatabaseViewConfigV6,
} from "../../shared/database-kernel";
import type {
  DatabaseViewRecordV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";

type DatabaseAuthoringProperty = DataSourcePropertyRecordV2;
type DatabaseAuthoringView = DatabaseViewRecordV2;

const authoringPropertyId = (property: DatabaseAuthoringProperty): string => property.propertyId;
const authoringViewId = (view: DatabaseAuthoringView): string => view.viewId;

export const emptyDatabaseViewConfig = (): DatabaseViewConfigV6 => ({
  schemaKey: "nodex.database-view",
  schemaVersion: 6,
  rules: {
    propertyFilters: [],
    advancedFilter: null,
    sorts: [
      {
        field: { kind: "manual" },
        direction: "asc",
        nulls: "last",
      },
    ],
  },
  presentation: {
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: {
      fields: [],
      propertyOrder: [],
      showEmptyGroups: false,
      showDescription: true,
    },
    conditionalColors: [],
  },
});

export const readDatabasePropertyOptions = (
  property: DatabaseAuthoringProperty,
): readonly DatabasePropertyOption[] => {
  if (property.valueType !== "select" && property.valueType !== "multi_select") {
    return [];
  }
  const options = property.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const id = option.id;
    const name = option.name;
    const color = option.color;
    if (typeof id !== "string" || typeof name !== "string") return [];
    if (color !== undefined && typeof color !== "string") return [];
    return [{ id, name, ...(color === undefined ? {} : { color }) }];
  });
};

export const databaseViewConfigsEqual = (
  left: DatabaseViewConfigV6,
  right: DatabaseViewConfigV6,
): boolean => stableStringifyDatabaseJson(left) === stableStringifyDatabaseJson(right);

/**
 * Resolve the logical anchor for moving one durable View exactly one place.
 * `null` is the explicit append intent; `undefined` means the requested move
 * is already at an edge and should not emit a mutation.
 */
export const databaseViewMoveBeforeId = (
  views: readonly DatabaseAuthoringView[],
  viewId: string,
  direction: "up" | "down",
): string | null | undefined => {
  const ordered = views.filter((view) => view.lifecycle === "active").map(authoringViewId);
  const currentIndex = ordered.indexOf(viewId);
  if (currentIndex < 0) return undefined;
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= ordered.length) return undefined;

  const remaining = ordered.filter((candidate) => candidate !== viewId);
  return remaining[targetIndex] ?? null;
};

/**
 * Resolve one arbitrary tab-list reorder to the server-owned logical anchor.
 * The requested order must contain every active View exactly once; invalid or
 * unchanged requests do not emit a mutation.
 */
export const databaseViewReorderBeforeId = (
  views: readonly DatabaseAuthoringView[],
  viewId: string,
  requestedOrder: readonly string[],
): string | null | undefined => {
  const currentOrder = views.filter((view) => view.lifecycle === "active").map(authoringViewId);
  if (currentOrder.length !== requestedOrder.length) return undefined;
  if (new Set(requestedOrder).size !== requestedOrder.length) return undefined;
  if (currentOrder.some((candidate) => !requestedOrder.includes(candidate))) return undefined;

  const currentIndex = currentOrder.indexOf(viewId);
  const requestedIndex = requestedOrder.indexOf(viewId);
  if (currentIndex < 0 || requestedIndex < 0 || currentIndex === requestedIndex) return undefined;
  return requestedOrder[requestedIndex + 1] ?? null;
};

export type DatabaseViewFilterPath = readonly number[];

const transformFilterNode = (
  node: DatabaseViewFilterNode,
  path: DatabaseViewFilterPath,
  transform: (current: DatabaseViewFilterNode) => DatabaseViewFilterNode,
): DatabaseViewFilterNode => {
  const [index, ...rest] = path;
  if (index === undefined) return transform(node);
  if (node.kind !== "group" || !node.children[index]) return node;
  return {
    ...node,
    children: node.children.map((child, childIndex) =>
      childIndex === index ? transformFilterNode(child, rest, transform) : child,
    ),
  };
};

export const updateDatabaseViewFilterNode = (
  root: DatabaseViewFilterNode,
  path: DatabaseViewFilterPath,
  next: DatabaseViewFilterNode,
): DatabaseViewFilterNode => transformFilterNode(root, path, () => next);

export const appendDatabaseViewFilterChild = (
  root: DatabaseViewFilterNode,
  path: DatabaseViewFilterPath,
  child: DatabaseViewFilterNode,
): DatabaseViewFilterNode =>
  transformFilterNode(root, path, (node) => {
    if (node.kind !== "group") return node;
    return { ...node, children: [...node.children, child] };
  });

export const removeDatabaseViewFilterNode = (
  root: DatabaseViewFilterNode,
  path: DatabaseViewFilterPath,
): DatabaseViewFilterNode => {
  if (path.length === 0) {
    return { kind: "group", operator: "and", children: [] };
  }
  const parentPath = path.slice(0, -1);
  const targetIndex = path[path.length - 1];
  if (targetIndex === undefined) return root;
  return transformFilterNode(root, parentPath, (node) => {
    if (node.kind !== "group") return node;
    return {
      ...node,
      children: node.children.filter((_, index) => index !== targetIndex),
    };
  });
};

export const filterOperatorsForProperty = (
  property: DatabaseAuthoringProperty,
): readonly DatabaseViewFilterOperator[] => property.capabilities.filterOperators;

export const defaultDatabaseFilterValue = (
  property: DatabaseAuthoringProperty,
  operator: DatabaseViewFilterOperator,
): DatabaseJsonValue => {
  if (operator === "date_within") return { start: "", end: "" };
  if (operator === "date_relative_to") {
    return { direction: "past", count: 1, unit: "week" };
  }
  if (property.valueType === "checkbox") return false;
  if (property.valueType === "number") return null;
  if (property.valueType === "select") return null;
  if (property.valueType === "multi_select") return [];
  if (property.valueType === "relation") return [];
  return "";
};

export const createDatabaseViewFilterClause = (
  property: DatabaseAuthoringProperty,
): DatabaseViewFilterClause =>
  databaseFilterClauseWithOperator(property, filterOperatorsForProperty(property)[0] ?? "is_empty");

export const databaseFilterClauseWithOperator = (
  property: DatabaseAuthoringProperty,
  operator: DatabaseViewFilterOperator,
): DatabaseViewFilterClause => {
  if (operator === "is_empty" || operator === "is_not_empty") {
    return { kind: "clause", propertyId: authoringPropertyId(property), operator };
  }
  return {
    kind: "clause",
    propertyId: authoringPropertyId(property),
    operator,
    value: defaultDatabaseFilterValue(property, operator),
  };
};

export const databaseFilterClauseWithProperty = (
  clause: DatabaseViewFilterClause,
  property: DatabaseAuthoringProperty,
): DatabaseViewFilterClause => {
  const supported = filterOperatorsForProperty(property);
  const operator = supported.includes(clause.operator)
    ? clause.operator
    : (supported[0] ?? "is_empty");
  return databaseFilterClauseWithOperator(property, operator);
};

export const createDatabaseViewSort = (): DatabaseViewSort => ({
  field: { kind: "title" },
  direction: "asc",
  nulls: "last",
});

export const moveDatabaseViewSort = (
  sorts: readonly DatabaseViewSort[],
  index: number,
  direction: "up" | "down",
): readonly DatabaseViewSort[] => {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= sorts.length || target < 0 || target >= sorts.length) {
    return sorts;
  }
  const next = [...sorts];
  const current = next[index];
  const replacement = next[target];
  if (!current || !replacement) return sorts;
  next[index] = replacement;
  next[target] = current;
  return next;
};
