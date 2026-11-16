import { getIntl, type IntlShape } from "@/lib/i18n";
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
  intl: IntlShape,
): DatabaseViewRuleSummary | null => {
  if (!property || !value || !defaultValue) return null;
  const unchanged =
    value.includeEmpty === defaultValue.includeEmpty &&
    value.selectedOptionIds.length === defaultValue.selectedOptionIds.length &&
    value.selectedOptionIds.every((optionId) => defaultValue.selectedOptionIds.includes(optionId));
  if (unchanged) return null;
  const optionNames = value.selectedOptionIds.map(
    (optionId) =>
      property.options.find((option) => option.id === optionId)?.name ??
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.unknownOption",
        defaultMessage: "Unknown option",
      }),
  );
  if (value.includeEmpty)
    optionNames.push(
      intl.formatMessage({ id: "lib.databaseViewRuleSummary.empty", defaultMessage: "Empty" }),
    );
  return {
    key: property.propertyId,
    label: property.name,
    value:
      optionNames.length > 0
        ? optionNames.join(", ")
        : intl.formatMessage({ id: "lib.databaseViewRuleSummary.none", defaultMessage: "None" }),
  };
};

const summarizeTaskFilter = (
  filter: DatabaseViewFilterNode,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
  intl: IntlShape,
): readonly DatabaseViewRuleSummary[] | null => {
  const capabilities = resolveDatabaseTaskFilterCapabilities(
    properties,
    {
      tags: optionRegistries.tags ?? [],
    },
    intl,
  );
  const state = decodeDatabaseTaskFilter(filter, capabilities);
  if (!state) return null;
  if (state.groups.length > 1) {
    return [
      {
        key: "task-filter-groups",
        label: intl.formatMessage({
          id: "lib.databaseViewRuleSummary.filter",
          defaultMessage: "Filter",
        }),
        value: intl.formatMessage(
          { id: "lib.databaseViewRuleSummary.groups", defaultMessage: "{count} groups" },
          { count: state.groups.length },
        ),
      },
    ];
  }
  const group = state.groups[0];
  if (!group) return [];
  const defaults = createDefaultDatabaseTaskFilterGroup(capabilities);
  const summaries = [
    taskChoiceSummary(capabilities.status, group.status, defaults.status, intl),
    taskChoiceSummary(capabilities.priority, group.priority, defaults.priority, intl),
  ].filter((summary): summary is DatabaseViewRuleSummary => summary !== null);
  if (capabilities.tags && group.tags && group.tags.selectedOptionIds.length > 0) {
    const names = group.tags.selectedOptionIds.map(
      (optionId) =>
        capabilities.tags?.options.find((option) => option.id === optionId)?.name ??
        intl.formatMessage({
          id: "lib.databaseViewRuleSummary.unknownOption",
          defaultMessage: "Unknown option",
        }),
    );
    summaries.push({
      key: capabilities.tags.propertyId,
      label: capabilities.tags.name,
      value: intl.formatMessage(
        {
          id: "lib.databaseViewRuleSummary.tagMode",
          defaultMessage: "{mode, select, any {Any} all {All} other {None}}: {names}",
        },
        { mode: group.tags.mode, names: names.join(", ") },
      ),
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
  intl: IntlShape,
): string => {
  if (value === undefined || value === null || value === "")
    return intl.formatMessage({ id: "lib.databaseViewRuleSummary.none", defaultMessage: "None" });
  if (typeof value === "boolean")
    return value
      ? intl.formatMessage({ id: "lib.databaseViewRuleSummary.checked", defaultMessage: "Checked" })
      : intl.formatMessage({
          id: "lib.databaseViewRuleSummary.unchecked",
          defaultMessage: "Unchecked",
        });
  if (typeof value === "number")
    return intl.formatNumber(value, { useGrouping: false, maximumFractionDigits: 20 });
  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item, property, optionRegistries, intl)).join(", ");
  }
  if (typeof value === "object")
    return intl.formatMessage({
      id: "lib.databaseViewRuleSummary.configured",
      defaultMessage: "Configured",
    });
  const options = property
    ? (optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property))
    : [];
  const option = property ? options.find((candidate) => candidate.id === value) : null;
  if (option) return option.name;
  if (property?.valueType === "select" || property?.valueType === "multi_select") {
    return intl.formatMessage({
      id: "lib.databaseViewRuleSummary.unknownOption",
      defaultMessage: "Unknown option",
    });
  }
  return value;
};

export const summarizeDatabaseViewFilter = (
  filter: DatabaseViewFilterNode,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {},
  intl: IntlShape = getIntl(),
): readonly DatabaseViewRuleSummary[] => {
  const taskSummaries = summarizeTaskFilter(filter, properties, optionRegistries, intl);
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
        label:
          property?.name ??
          intl.formatMessage({
            id: "lib.databaseViewRuleSummary.missingProperty",
            defaultMessage: "Missing property",
          }),
        value: intl.formatMessage(
          { id: "lib.databaseViewRuleSummary.rules", defaultMessage: "{count} rules" },
          { count: clauses.length },
        ),
      };
    }
    const clause = clauses[0]!;
    const operator = databaseViewFilterOperatorLabel(clause.operator, intl.formatMessage);
    const value =
      clause.operator === "is_empty" || clause.operator === "is_not_empty"
        ? operator
        : intl.formatMessage(
            {
              id: "lib.databaseViewRuleSummary.operatorValue",
              defaultMessage: "{operator} {value}",
            },
            { operator, value: formatValue(clause.value, property, optionRegistries, intl) },
          );
    return {
      key: propertyId,
      label:
        property?.name ??
        intl.formatMessage({
          id: "lib.databaseViewRuleSummary.missingProperty",
          defaultMessage: "Missing property",
        }),
      value,
    };
  });
};

export const databaseViewSortFieldLabel = (
  sort: DatabaseViewSort,
  properties: readonly DataSourcePropertyRecordV2[],
  intl: IntlShape = getIntl(),
): string => {
  if (sort.field.kind === "manual")
    return intl.formatMessage({
      id: "lib.databaseViewRuleSummary.manualOrder",
      defaultMessage: "Manual order",
    });
  if (sort.field.kind === "title")
    return intl.formatMessage({
      id: "lib.databaseViewRuleSummary.name",
      defaultMessage: "Name",
    });
  if (sort.field.kind === "created")
    return intl.formatMessage({
      id: "lib.databaseViewRuleSummary.createdTime",
      defaultMessage: "Created time",
    });
  const propertyId = sort.field.propertyId;
  return (
    properties.find((property) => property.propertyId === propertyId)?.name ??
    intl.formatMessage({
      id: "lib.databaseViewRuleSummary.missingProperty",
      defaultMessage: "Missing property",
    })
  );
};

export const databaseViewSortDirectionLabels = (
  sort: DatabaseViewSort,
  properties: readonly DataSourcePropertyRecordV2[],
  intl: IntlShape = getIntl(),
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
    return [
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.earliestFirst",
        defaultMessage: "Earliest first",
      }),
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.latestFirst",
        defaultMessage: "Latest first",
      }),
    ];
  }
  if (property?.valueType === "number")
    return [
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.ascendingNumber",
        defaultMessage: "Low to high",
      }),
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.descendingNumber",
        defaultMessage: "High to low",
      }),
    ];
  if (property?.valueType === "checkbox")
    return [
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.uncheckedFirst",
        defaultMessage: "Unchecked first",
      }),
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.checkedFirst",
        defaultMessage: "Checked first",
      }),
    ];
  if (sort.field.kind === "manual")
    return [
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.topToBottom",
        defaultMessage: "Top to bottom",
      }),
      intl.formatMessage({
        id: "lib.databaseViewRuleSummary.bottomToTop",
        defaultMessage: "Bottom to top",
      }),
    ];
  return [
    intl.formatMessage({ id: "lib.databaseViewRuleSummary.aToZ", defaultMessage: "A to Z" }),
    intl.formatMessage({ id: "lib.databaseViewRuleSummary.zToA", defaultMessage: "Z to A" }),
  ];
};

export const hasCustomDatabaseViewSort = (sorts: readonly DatabaseViewSort[]): boolean => {
  if (sorts.length === 0) return false;
  if (sorts.length > 1) return true;
  const sort = sorts[0];
  return sort?.field.kind !== "manual" || sort.direction !== "asc" || sort.nulls !== "last";
};
