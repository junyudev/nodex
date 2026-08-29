import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabaseViewFilterClause,
  DatabaseViewFilterNode,
  DatabaseViewSort,
} from "../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { databaseViewFilterOperatorLabel } from "../../shared/database-view-rules";
import { readDatabasePropertyOptions } from "./database-view-authoring";
import {
  createDefaultDatabaseTaskFilterGroup,
  decodeDatabaseTaskFilter,
  resolveDatabaseTaskFilterCapabilities,
  type DatabaseTaskChoiceFilter,
  type DatabaseTaskFilterProperty,
} from "./database-view-task-filter";

export interface DatabaseViewRuleSummary {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const taskChoiceSummary = (
  property: DatabaseTaskFilterProperty | null,
  value: DatabaseTaskChoiceFilter | undefined,
  defaultValue: DatabaseTaskChoiceFilter | undefined,
): DatabaseViewRuleSummary | null => {
  if (!property || !value || !defaultValue) return null;
  const unchanged =
    value.includeEmpty === defaultValue.includeEmpty &&
    value.selectedOptionIds.length === defaultValue.selectedOptionIds.length &&
    value.selectedOptionIds.every((optionId) => defaultValue.selectedOptionIds.includes(optionId));
  if (unchanged) return null;
  const optionNames = value.selectedOptionIds.map(
    (optionId) =>
      property.options.find((option) => option.id === optionId)?.name ?? "Unknown option",
  );
  if (value.includeEmpty) optionNames.push("Empty");
  return {
    key: property.propertyId,
    label: property.name,
    value: optionNames.length > 0 ? optionNames.join(", ") : "None",
  };
};

const summarizeTaskFilter = (
  filter: DatabaseViewFilterNode,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): readonly DatabaseViewRuleSummary[] | null => {
  const capabilities = resolveDatabaseTaskFilterCapabilities(properties, {
    tags: optionRegistries.tags ?? [],
  });
  const state = decodeDatabaseTaskFilter(filter, capabilities);
  if (!state) return null;
  if (state.groups.length > 1) {
    return [
      {
        key: "task-filter-groups",
        label: "Filter",
        value: `${state.groups.length} groups`,
      },
    ];
  }
  const group = state.groups[0];
  if (!group) return [];
  const defaults = createDefaultDatabaseTaskFilterGroup(capabilities);
  const summaries = [
    taskChoiceSummary(capabilities.status, group.status, defaults.status),
    taskChoiceSummary(capabilities.priority, group.priority, defaults.priority),
  ].filter((summary): summary is DatabaseViewRuleSummary => summary !== null);
  if (capabilities.tags && group.tags && group.tags.selectedOptionIds.length > 0) {
    const mode = group.tags.mode === "any" ? "Any" : group.tags.mode === "all" ? "All" : "None";
    const names = group.tags.selectedOptionIds.map(
      (optionId) =>
        capabilities.tags?.options.find((option) => option.id === optionId)?.name ??
        "Unknown option",
    );
    summaries.push({
      key: capabilities.tags.propertyId,
      label: capabilities.tags.name,
      value: `${mode}: ${names.join(", ")}`,
    });
  }
  return summaries;
};

const collectClauses = (node: DatabaseViewFilterNode): readonly DatabaseViewFilterClause[] => {
  if (node.kind === "clause") return [node];
  return node.children.flatMap(collectClauses);
};

const formatValue = (
  value: DatabaseJsonValue | undefined,
  property: DataSourcePropertyRecordV2 | null,
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): string => {
  if (value === undefined || value === null || value === "") return "None";
  if (typeof value === "boolean") return value ? "Checked" : "Unchecked";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item, property, optionRegistries)).join(", ");
  }
  if (typeof value === "object") return "Configured";
  const options = property
    ? (optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property))
    : [];
  const option = property ? options.find((candidate) => candidate.id === value) : null;
  if (option) return option.name;
  if (property?.valueType === "select" || property?.valueType === "multi_select") {
    return "Unknown option";
  }
  return value;
};

export const summarizeDatabaseViewFilter = (
  filter: DatabaseViewFilterNode,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {},
): readonly DatabaseViewRuleSummary[] => {
  const taskSummaries = summarizeTaskFilter(filter, properties, optionRegistries);
  if (taskSummaries) return taskSummaries;
  const propertyById = new Map<string, DataSourcePropertyRecordV2>(
    properties.map((property) => [property.propertyId, property]),
  );
  const grouped = new Map<string, DatabaseViewFilterClause[]>();
  for (const clause of collectClauses(filter)) {
    const clauses = grouped.get(clause.propertyId) ?? [];
    clauses.push(clause);
    grouped.set(clause.propertyId, clauses);
  }

  return [...grouped.entries()].map(([propertyId, clauses]) => {
    const property = propertyById.get(propertyId) ?? null;
    if (clauses.length > 1) {
      return {
        key: propertyId,
        label: property?.name ?? "Missing property",
        value: `${clauses.length} rules`,
      };
    }
    const clause = clauses[0]!;
    const operator = databaseViewFilterOperatorLabel(clause.operator);
    const value =
      clause.operator === "is_empty" || clause.operator === "is_not_empty"
        ? operator
        : `${operator} ${formatValue(clause.value, property, optionRegistries)}`;
    return {
      key: propertyId,
      label: property?.name ?? "Missing property",
      value,
    };
  });
};

export const databaseViewSortFieldLabel = (
  sort: DatabaseViewSort,
  properties: readonly DataSourcePropertyRecordV2[],
): string => {
  if (sort.field.kind === "manual") return "Manual order";
  if (sort.field.kind === "title") return "Name";
  if (sort.field.kind === "created") return "Created time";
  const propertyId = sort.field.propertyId;
  return (
    properties.find((property) => property.propertyId === propertyId)?.name ?? "Missing property"
  );
};

export const databaseViewSortDirectionLabels = (
  sort: DatabaseViewSort,
  properties: readonly DataSourcePropertyRecordV2[],
): readonly [ascending: string, descending: string] => {
  const propertyId = sort.field.kind === "property" ? sort.field.propertyId : null;
  const property = propertyId
    ? (properties.find((candidate) => candidate.propertyId === propertyId) ?? null)
    : null;
  if (
    sort.field.kind === "created" ||
    property?.valueType === "date" ||
    property?.valueType === "datetime"
  ) {
    return ["Earliest first", "Latest first"];
  }
  if (property?.valueType === "number") return ["Low to high", "High to low"];
  if (property?.valueType === "checkbox") return ["Unchecked first", "Checked first"];
  if (sort.field.kind === "manual") return ["Top to bottom", "Bottom to top"];
  return ["A to Z", "Z to A"];
};

export const hasCustomDatabaseViewSort = (sorts: readonly DatabaseViewSort[]): boolean => {
  if (sorts.length === 0) return false;
  if (sorts.length > 1) return true;
  const sort = sorts[0];
  return sort?.field.kind !== "manual" || sort.direction !== "asc" || sort.nulls !== "last";
};
