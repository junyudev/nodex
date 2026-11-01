import { readRelationValuePreview } from "@/lib/data-source-relation-value";
import type { DatabaseJsonValue } from "../../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import { resolveWorkflowStatusName } from "../../../../shared/workflow-status";

export const DATABASE_LIST_MUTED_ICON_COLOR = "var(--database-list-icon-muted)";

export const databaseListGroupLabel = (
  propertyId: string | undefined,
  key: string | null,
  configuredOptionName?: string,
): string => {
  if (key === null) return "No value";
  if (propertyId === "status") {
    return resolveWorkflowStatusName(
      key,
      configuredOptionName === undefined ? [] : [{ id: key, name: configuredOptionName }],
    );
  }
  if (configuredOptionName) return configuredOptionName;
  if (key === "true") return "Yes";
  if (key === "false") return "No";
  return key;
};

export const databaseListPropertyHasValue = (
  property: DataSourcePropertyRecordV2,
  value: DatabaseJsonValue | undefined,
): boolean => {
  if (value === null || value === undefined) return false;
  if (property.valueType === "relation") {
    return (readRelationValuePreview(value)?.totalCount ?? 0) > 0;
  }
  if (property.valueType === "checkbox") return value === true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
};
