import type {
  DatabaseViewFilterNode,
  DatabaseViewFilterOperator,
  DatabasePropertyOption,
} from "../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { matchBuiltInDataSourceProperty } from "../../shared/data-source-built-ins";
import { WORKFLOW_STATUS_COLUMNS } from "../../shared/workflow-status";
import { PRIORITY_VALUES } from "../../shared/priority";
import { readDatabasePropertyOptions } from "./database-view-authoring";
import { getPriorityLabel } from "./priority-presentation";

export type DatabaseTaskFilterRole = "status" | "priority" | "tags";
export type DatabaseTaskTagMode = "any" | "all" | "none";

export interface DatabaseTaskFilterProperty {
  readonly role: DatabaseTaskFilterRole;
  readonly propertyId: string;
  readonly name: string;
  readonly options: readonly DatabasePropertyOption[];
}

export interface DatabaseTaskChoiceFilter {
  readonly selectedOptionIds: readonly string[];
  readonly includeEmpty: boolean;
}

export interface DatabaseTaskTagFilter {
  readonly selectedOptionIds: readonly string[];
  readonly mode: DatabaseTaskTagMode;
}

export interface DatabaseTaskFilterGroup {
  readonly status?: DatabaseTaskChoiceFilter;
  readonly priority?: DatabaseTaskChoiceFilter;
  readonly tags?: DatabaseTaskTagFilter;
}

export interface DatabaseTaskFilterState {
  readonly groups: readonly DatabaseTaskFilterGroup[];
}

export interface DatabaseTaskFilterCapabilities {
  readonly status: DatabaseTaskFilterProperty | null;
  readonly priority: DatabaseTaskFilterProperty | null;
  readonly tags: DatabaseTaskFilterProperty | null;
}

const taskFilterProperty = (
  property: DataSourcePropertyRecordV2,
  observedOptions: readonly DatabasePropertyOption[] = [],
): DatabaseTaskFilterProperty | null => {
  const role = matchBuiltInDataSourceProperty(property);
  if (role !== "status" && role !== "priority" && role !== "tags") return null;
  const authoredOptions = readDatabasePropertyOptions(property);
  const fallbackOptions =
    role === "status"
      ? WORKFLOW_STATUS_COLUMNS
      : role === "priority"
        ? PRIORITY_VALUES.map((id) => ({ id, name: getPriorityLabel(id) }))
        : observedOptions;
  return {
    role,
    propertyId: property.propertyId,
    name: property.name,
    options: authoredOptions.length > 0 ? authoredOptions : fallbackOptions,
  };
};

export const resolveDatabaseTaskFilterCapabilities = (
  properties: readonly DataSourcePropertyRecordV2[],
  observedOptions: Partial<
    Readonly<Record<DatabaseTaskFilterRole, readonly DatabasePropertyOption[]>>
  > = {},
): DatabaseTaskFilterCapabilities => {
  const matched = properties
    .filter((property) => property.lifecycle === "active")
    .map((property) => {
      const role = matchBuiltInDataSourceProperty(property);
      const taskRole = role === "status" || role === "priority" || role === "tags" ? role : null;
      return taskFilterProperty(property, taskRole ? (observedOptions[taskRole] ?? []) : []);
    })
    .filter((property): property is DatabaseTaskFilterProperty => property !== null);
  const find = (role: DatabaseTaskFilterRole) =>
    matched.find((property) => property.role === role) ?? null;
  return {
    status: find("status"),
    priority: find("priority"),
    tags: find("tags"),
  };
};

export const createDefaultDatabaseTaskFilterGroup = (
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseTaskFilterGroup => ({
  ...(capabilities.status
    ? {
        status: {
          selectedOptionIds: capabilities.status.options.map((option) => option.id),
          includeEmpty: true,
        },
      }
    : {}),
  ...(capabilities.priority
    ? {
        priority: {
          selectedOptionIds: capabilities.priority.options.map((option) => option.id),
          includeEmpty: true,
        },
      }
    : {}),
  ...(capabilities.tags ? { tags: { selectedOptionIds: [], mode: "any" } } : {}),
});

const roleForProperty = (
  propertyId: string,
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseTaskFilterRole | null => {
  if (capabilities.status?.propertyId === propertyId) return "status";
  if (capabilities.priority?.propertyId === propertyId) return "priority";
  if (capabilities.tags?.propertyId === propertyId) return "tags";
  return null;
};

const choiceFromNodes = (
  nodes: readonly DatabaseViewFilterNode[],
  propertyId: string,
): DatabaseTaskChoiceFilter | null => {
  const selectedOptionIds: string[] = [];
  let includeEmpty = false;
  for (const node of nodes) {
    if (node.kind !== "clause" || node.propertyId !== propertyId) return null;
    if (node.operator === "is_empty") {
      includeEmpty = true;
      continue;
    }
    if (
      (node.operator !== "select_is" && node.operator !== "equals") ||
      typeof node.value !== "string"
    ) {
      return null;
    }
    selectedOptionIds.push(node.value);
  }
  return { selectedOptionIds, includeEmpty };
};

const tagsFromNodes = (
  nodes: readonly DatabaseViewFilterNode[],
  propertyId: string,
  operator: "and" | "or",
): DatabaseTaskTagFilter | null => {
  const clauses = nodes.flatMap((node) => (node.kind === "clause" ? [node] : []));
  if (clauses.length !== nodes.length) return null;
  if (clauses.some((clause) => clause.propertyId !== propertyId)) return null;
  const filterOperators = new Set(clauses.map((clause) => clause.operator));
  if (filterOperators.size > 1) return null;
  const filterOperator = clauses[0]?.operator;
  if (
    filterOperator !== "contains" &&
    filterOperator !== "not_contains" &&
    filterOperator !== "multi_select_contains" &&
    filterOperator !== "multi_select_does_not_contain" &&
    filterOperator !== "multi_select_contains_all"
  ) {
    return null;
  }
  const selectedOptionIds = clauses.flatMap((clause) =>
    Array.isArray(clause.value)
      ? clause.value.filter((value): value is string => typeof value === "string")
      : typeof clause.value === "string"
        ? [clause.value]
        : [],
  );
  if (selectedOptionIds.length === 0) return null;
  return {
    selectedOptionIds: [...new Set(selectedOptionIds)],
    mode:
      filterOperator === "not_contains" || filterOperator === "multi_select_does_not_contain"
        ? "none"
        : filterOperator === "multi_select_contains_all" || operator === "and"
          ? "all"
          : "any",
  };
};

type DecodedCriterion =
  | { readonly role: "status" | "priority"; readonly value: DatabaseTaskChoiceFilter }
  | { readonly role: "tags"; readonly value: DatabaseTaskTagFilter };

const decodeCriterion = (
  node: DatabaseViewFilterNode,
  capabilities: DatabaseTaskFilterCapabilities,
): DecodedCriterion | null => {
  if (node.kind === "clause") {
    const role = roleForProperty(node.propertyId, capabilities);
    if (role === "status" || role === "priority") {
      const value = choiceFromNodes([node], node.propertyId);
      return value ? { role, value } : null;
    }
    if (role === "tags") {
      const value = tagsFromNodes([node], node.propertyId, "or");
      return value ? { role, value } : null;
    }
    return null;
  }

  const firstClause = node.children.find(
    (child): child is Extract<DatabaseViewFilterNode, { kind: "clause" }> =>
      child.kind === "clause",
  );
  if (!firstClause && node.children.length > 0) return null;
  if (!firstClause) return null;
  const role = roleForProperty(firstClause.propertyId, capabilities);
  if (role === "status" || role === "priority") {
    if (node.operator === "and") {
      const operators = node.children.flatMap((child) =>
        child.kind === "clause" && child.propertyId === firstClause.propertyId
          ? [child.operator]
          : [],
      );
      if (
        operators.length === 2 &&
        operators.includes("is_empty") &&
        operators.includes("is_not_empty")
      ) {
        return {
          role,
          value: { selectedOptionIds: [], includeEmpty: false },
        };
      }
      return null;
    }
    const value = choiceFromNodes(node.children, firstClause.propertyId);
    return value ? { role, value } : null;
  }
  if (role === "tags") {
    const value = tagsFromNodes(node.children, firstClause.propertyId, node.operator);
    return value ? { role, value } : null;
  }
  return null;
};

const decodeGroup = (
  node: DatabaseViewFilterNode,
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseTaskFilterGroup | null => {
  const defaultGroup = createDefaultDatabaseTaskFilterGroup(capabilities);
  const criteria = node.kind === "group" && node.operator === "and" ? node.children : [node];
  let status = defaultGroup.status;
  let priority = defaultGroup.priority;
  let tags = defaultGroup.tags;
  const decodedRoles = new Set<keyof DatabaseTaskFilterGroup>();
  for (const criterion of criteria) {
    const result = decodeCriterion(criterion, capabilities);
    if (!result || decodedRoles.has(result.role)) return null;
    decodedRoles.add(result.role);
    if (result.role === "tags") tags = result.value;
    if (result.role === "status") status = result.value;
    if (result.role === "priority") priority = result.value;
  }
  return { status, priority, tags };
};

export const decodeDatabaseTaskFilter = (
  filter: DatabaseViewFilterNode,
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseTaskFilterState | null => {
  const hasTaskProperties = capabilities.status || capabilities.priority || capabilities.tags;
  if (!hasTaskProperties) return null;
  if (filter.kind === "group" && filter.children.length === 0) {
    return { groups: [createDefaultDatabaseTaskFilterGroup(capabilities)] };
  }
  const groupNodes =
    filter.kind === "group" && filter.operator === "or" ? filter.children : [filter];
  const groups = groupNodes.map((node) => decodeGroup(node, capabilities));
  if (groups.some((group) => group === null)) return null;
  return { groups: groups as DatabaseTaskFilterGroup[] };
};

const choiceCriterion = (
  property: DatabaseTaskFilterProperty,
  value: DatabaseTaskChoiceFilter,
): DatabaseViewFilterNode | null => {
  const allSelected = property.options.every((option) =>
    value.selectedOptionIds.includes(option.id),
  );
  if (allSelected && value.includeEmpty) return null;
  const children: DatabaseViewFilterNode[] = value.selectedOptionIds.map((optionId) => ({
    kind: "clause",
    propertyId: property.propertyId,
    operator: "select_is",
    value: optionId,
  }));
  if (value.includeEmpty) {
    children.push({
      kind: "clause",
      propertyId: property.propertyId,
      operator: "is_empty",
    });
  }
  if (children.length === 0) {
    return {
      kind: "group",
      operator: "and",
      children: [
        {
          kind: "clause",
          propertyId: property.propertyId,
          operator: "is_empty",
        },
        {
          kind: "clause",
          propertyId: property.propertyId,
          operator: "is_not_empty",
        },
      ],
    };
  }
  if (children.length === 1) return children[0]!;
  return { kind: "group", operator: "or", children };
};

const tagOperator = (mode: DatabaseTaskTagMode): DatabaseViewFilterOperator =>
  mode === "none"
    ? "multi_select_does_not_contain"
    : mode === "all"
      ? "multi_select_contains_all"
      : "multi_select_contains";

const tagsCriterion = (
  property: DatabaseTaskFilterProperty,
  value: DatabaseTaskTagFilter,
): DatabaseViewFilterNode | null => {
  if (value.selectedOptionIds.length === 0) return null;
  return {
    kind: "clause",
    propertyId: property.propertyId,
    operator: tagOperator(value.mode),
    value: value.selectedOptionIds,
  };
};

const encodeGroup = (
  group: DatabaseTaskFilterGroup,
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseViewFilterNode => {
  const children = [
    capabilities.status && group.status ? choiceCriterion(capabilities.status, group.status) : null,
    capabilities.priority && group.priority
      ? choiceCriterion(capabilities.priority, group.priority)
      : null,
    capabilities.tags && group.tags ? tagsCriterion(capabilities.tags, group.tags) : null,
  ].filter((node): node is DatabaseViewFilterNode => node !== null);
  return { kind: "group", operator: "and", children };
};

export const encodeDatabaseTaskFilter = (
  state: DatabaseTaskFilterState,
  capabilities: DatabaseTaskFilterCapabilities,
): DatabaseViewFilterNode => {
  const groups = state.groups.map((group) => encodeGroup(group, capabilities));
  if (groups.length === 0) return { kind: "group", operator: "and", children: [] };
  if (groups.length === 1) return groups[0]!;
  return { kind: "group", operator: "or", children: groups };
};
