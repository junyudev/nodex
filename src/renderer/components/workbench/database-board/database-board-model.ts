import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabasePropertyValueType,
  DatabaseViewField,
} from "../../../../shared/database-kernel";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import { databasePropertyOptionDotColor } from "@/components/database/property-value-chip";
import { columnStyles } from "@/lib/status-presentation";

export type DatabaseBoardMarker =
  | { readonly kind: "status"; readonly statusId: string }
  | { readonly kind: "priority"; readonly priorityId: string }
  | { readonly kind: "option"; readonly optionId: string; readonly color: string }
  | {
      readonly kind: "property";
      readonly propertyId: DataSourcePropertyRecordV2["propertyId"] | null;
      readonly valueType: DatabasePropertyValueType;
    }
  | {
      readonly kind: "unassigned";
      readonly propertyId: DataSourcePropertyRecordV2["propertyId"];
      readonly valueType: DatabasePropertyValueType;
    };

export interface DatabaseBoardGroupPresentation {
  readonly pathKey: string;
  readonly groupKey: string | null;
  readonly label: string;
  readonly marker: DatabaseBoardMarker;
  readonly accentColor: string;
  readonly surfaceColor: string;
  readonly activeSurfaceColor: string;
}

export type DatabaseBoardCardFooterSlot =
  | {
      readonly kind: "property";
      readonly property: DataSourcePropertyRecordV2;
      readonly value: DatabaseJsonValue;
      readonly revision: number;
    }
  | {
      readonly kind: "metadata";
      readonly field: "created_at" | "updated_at";
      readonly value: string;
    };

const quietAccent = "var(--foreground-tertiary)";

const quietSurfaceColor = (accentColor: string): string =>
  `color-mix(in srgb, ${accentColor} 4%, var(--background))`;

const quietActiveSurfaceColor = (accentColor: string): string =>
  `color-mix(in srgb, ${accentColor} 8%, var(--background))`;

const statusSurfaceColors = (
  statusId: string,
): {
  readonly surfaceColor: string;
  readonly activeSurfaceColor: string;
} => {
  const variableStem = statusId === "archived" ? "archive" : statusId;
  return {
    surfaceColor: `var(--column-${variableStem}-header-bg)`,
    activeSurfaceColor: `var(--column-${variableStem}-drop-bg)`,
  };
};

const presentationColors = (
  accentColor: string,
): Pick<DatabaseBoardGroupPresentation, "accentColor" | "surfaceColor" | "activeSurfaceColor"> => ({
  accentColor,
  surfaceColor: quietSurfaceColor(accentColor),
  activeSurfaceColor: quietActiveSurfaceColor(accentColor),
});

const semanticAccent = (propertyId: string, groupKey: string): string | null => {
  if (propertyId === "status") {
    return columnStyles[groupKey]?.accentColor ?? null;
  }
  if (propertyId !== "priority") return null;
  if (groupKey === "p0-critical") return "var(--priority-critical-text)";
  if (groupKey === "p1-high") return "var(--priority-high-text)";
  if (groupKey === "p2-medium") return "var(--priority-medium-text)";
  if (groupKey === "p3-low") return "var(--priority-low-text)";
  return null;
};

const optionIdsForGroupKey = (
  property: DataSourcePropertyRecordV2,
  groupKey: string,
): readonly string[] => {
  if (property.valueType !== "multi_select") return [groupKey];
  try {
    const parsed = JSON.parse(groupKey) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

/**
 * Projects one Core-owned grouping value into the visual role used by every
 * Board column and swimlane. Unknown values remain visible and receive a
 * deterministic, quiet accent rather than selecting another presenter.
 */
export const projectDatabaseBoardGroup = ({
  property,
  groupKey,
  label,
  pathKey,
  options,
}: {
  readonly property: DataSourcePropertyRecordV2 | null;
  readonly groupKey: string | null;
  readonly label: string;
  readonly pathKey: string;
  readonly options: readonly DatabasePropertyOption[];
}): DatabaseBoardGroupPresentation => {
  if (!property) {
    return {
      pathKey,
      groupKey,
      label,
      marker: { kind: "property", propertyId: null, valueType: "text" },
      ...presentationColors(quietAccent),
    };
  }
  if (groupKey === null) {
    return {
      pathKey,
      groupKey,
      label,
      marker: {
        kind: "unassigned",
        propertyId: property.propertyId,
        valueType: property.valueType,
      },
      ...presentationColors(quietAccent),
    };
  }
  if (property.propertyId === "status" && columnStyles[groupKey]) {
    const accentColor = columnStyles[groupKey]!.accentColor;
    return {
      pathKey,
      groupKey,
      label,
      marker: { kind: "status", statusId: groupKey },
      accentColor,
      ...statusSurfaceColors(groupKey),
    };
  }
  if (property.propertyId === "priority" && semanticAccent("priority", groupKey)) {
    const accentColor = semanticAccent("priority", groupKey)!;
    return {
      pathKey,
      groupKey,
      label,
      marker: { kind: "priority", priorityId: groupKey },
      ...presentationColors(accentColor),
    };
  }
  const optionIds = optionIdsForGroupKey(property, groupKey);
  const option = optionIds
    .map((optionId) => options.find((candidate) => candidate.id === optionId))
    .find((candidate) => candidate !== undefined);
  const optionBacked =
    property.valueType === "select" ||
    property.valueType === "multi_select" ||
    property.propertyId === "priority" ||
    property.propertyId === "estimate";
  if (optionBacked && option) {
    const accentColor =
      semanticAccent(property.propertyId, groupKey) ??
      databasePropertyOptionDotColor(option.color, option.id);
    return {
      pathKey,
      groupKey,
      label,
      marker: {
        kind: "option",
        optionId: option.id,
        color: databasePropertyOptionDotColor(option.color, option.id),
      },
      ...presentationColors(accentColor),
    };
  }
  const accentColor = semanticAccent(property.propertyId, groupKey) ?? quietAccent;
  return {
    pathKey,
    groupKey,
    label,
    marker: {
      kind: "property",
      propertyId: property.propertyId,
      valueType: property.valueType,
    },
    ...presentationColors(accentColor),
  };
};

export const databaseBoardValueIsVisible = (
  value: DatabaseJsonValue | undefined,
): value is DatabaseJsonValue => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/**
 * Projects the configured Board footer in field order. Structural properties,
 * empty values, and the Page key (which has its own title-line presenter) vanish.
 */
export const projectDatabaseBoardCardFooter = ({
  authority,
  displayedFields,
  properties,
  groupPropertyId,
  subgroupPropertyId,
}: {
  readonly authority: DataSourcePageRowV2;
  readonly displayedFields: readonly DatabaseViewField[];
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly groupPropertyId: string | null;
  readonly subgroupPropertyId: string | null;
}): readonly DatabaseBoardCardFooterSlot[] => {
  const propertyById = new Map<string, DataSourcePropertyRecordV2>(
    properties
      .filter((property) => property.lifecycle === "active")
      .map((property) => [property.propertyId, property] as const),
  );
  return displayedFields.flatMap((field): readonly DatabaseBoardCardFooterSlot[] => {
    if (field.kind === "intrinsic") {
      if (field.field === "page_key") return [];
      return [
        {
          kind: "metadata",
          field: field.field,
          value: field.field === "created_at" ? authority.page.createdAt : authority.page.updatedAt,
        },
      ];
    }
    const property = propertyById.get(field.propertyId);
    if (!property) return [];
    if (property.propertyId === groupPropertyId || property.propertyId === subgroupPropertyId)
      return [];
    const current = authority.values[property.propertyId];
    if (!current || !databaseBoardValueIsVisible(current.value)) return [];
    return [
      {
        kind: "property",
        property,
        value: current.value,
        revision: current.revision,
      },
    ];
  });
};

export const formatDatabaseBoardMetadataTimestamp = (
  field: "created_at" | "updated_at",
  value: string,
  now = new Date(),
  locale?: string,
): string => {
  const prefix = field === "created_at" ? "Created" : "Updated";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return prefix;
  const recent =
    timestamp.getFullYear() === now.getFullYear() &&
    Math.abs(now.getTime() - timestamp.getTime()) <= 31 * 86_400_000;
  const formatted = new Intl.DateTimeFormat(
    locale,
    recent ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" },
  ).format(timestamp);
  return `${prefix} ${formatted}`;
};
