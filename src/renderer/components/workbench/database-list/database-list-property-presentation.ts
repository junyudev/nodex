import { getIntl, type IntlShape } from "@/lib/i18n";
import { readRelationValuePreview } from "@/lib/data-source-relation-value";
import type { DatabaseJsonValue } from "../../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import {
  DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES,
  isWorkflowStatus,
} from "../../../../shared/workflow-status";

export const DATABASE_LIST_MUTED_ICON_COLOR = "var(--database-list-icon-muted)";

export const databaseListGroupLabel = (
  propertyId: string | undefined,
  key: string | null,
  configuredOptionName?: string,
  intl: IntlShape = getIntl(),
): string => {
  if (key === null)
    return intl.formatMessage({
      id: "database.databaseListPropertyPresentation.noValue",
      defaultMessage: "No value",
    });
  if (propertyId === "status") {
    return (
      configuredOptionName ??
      (isWorkflowStatus(key)
        ? intl.formatMessage(DEFAULT_WORKFLOW_STATUS_LABEL_MESSAGES[key])
        : key)
    );
  }
  if (configuredOptionName) return configuredOptionName;
  if (key === "true")
    return intl.formatMessage({
      id: "database.databaseListPropertyPresentation.yes",
      defaultMessage: "Yes",
    });
  if (key === "false")
    return intl.formatMessage({
      id: "database.databaseListPropertyPresentation.no",
      defaultMessage: "No",
    });
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
