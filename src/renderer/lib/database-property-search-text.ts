import {
  stableStringifyDatabaseJson,
  type DatabaseJsonValue,
  type DatabasePropertyOption,
} from "../../shared/database-kernel";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import { readRelationValuePreview } from "./data-source-relation-value";

interface DatabasePropertyValueSearchContext {
  readonly optionBacked?: boolean;
  readonly options?: readonly DatabasePropertyOption[];
}

/** Human-searchable text without exposing option identities as display text. */
export const databasePropertyValueSearchText = (
  value: DatabaseJsonValue,
  context: DatabasePropertyValueSearchContext = {},
): string => {
  const relation = readRelationValuePreview(value);
  if (relation)
    return relation.targets
      .flatMap((target) => (target.kind === "visible" ? [target.title] : []))
      .join(" ");
  if (!context.optionBacked) return stableStringifyDatabaseJson(value);

  const selectedIds = new Set(
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
  );
  if (selectedIds.size === 0) return "";
  const labelsById = new Map(
    (context.options ?? []).map((option) => [option.id, option.name] as const),
  );
  return [
    ...new Set([...selectedIds].map((optionId) => labelsById.get(optionId) ?? "Unknown option")),
  ].join(" ");
};

/** Board and List search the same authorized labels, including relation titles. */
export function databaseRowPropertySearchText(
  row: DataSourcePageRowV2,
  properties: readonly DataSourcePropertyRecordV2[],
  optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>,
): string {
  const propertyById = new Map(
    properties.map((property) => [String(property.propertyId), property] as const),
  );
  return Object.values(row.values)
    .map((entry) => {
      const property = propertyById.get(entry.propertyId);
      return databasePropertyValueSearchText(entry.value, {
        optionBacked: property?.valueType === "select" || property?.valueType === "multi_select",
        options: optionRegistries[entry.propertyId],
      });
    })
    .join(" ");
}
