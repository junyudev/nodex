import type { DatabaseJsonValue, DatabasePropertyValueType } from "../../shared/database-kernel";
import type {
  DatabasePagePropertyVisibilityV2,
  DataSourcePageValueV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  matchBuiltInDataSourceProperty,
  type BuiltInDataSourcePropertyRole,
} from "../../shared/data-source-built-ins";
import type { LibraryPageDetail, PageDetail } from "../../shared/page-detail";
import { isWorkflowStatus, type WorkflowStatus } from "../../shared/workflow-status";
import type { Estimate, Priority } from "../../shared/types";
import { isPriority } from "../../shared/priority";
import {
  isCanonicalDataSourceDateTime,
  parseIsoDateToLocalDate,
} from "./data-source-property-date";
import { readRelationValuePreview } from "./data-source-relation-value";

const ESTIMATES = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);

export const PAGE_STAGE_PRIMARY_PROPERTY_IDS = [
  "priority",
  "status",
  "estimate",
  "due_date",
] as const;

export interface PageStageDataSourceProperty {
  readonly property: DataSourcePropertyRecordV2;
  readonly value: DatabaseJsonValue;
  readonly valueRevision: number;
  readonly error: string | null;
  readonly pageVisibility: DatabasePagePropertyVisibilityV2;
}

export interface PageStageSemanticProperty<Value> {
  readonly item: PageStageDataSourceProperty;
  readonly value: Value | null;
}

export interface PageStageSemanticProperties {
  readonly status: PageStageSemanticProperty<WorkflowStatus> | null;
  readonly priority: PageStageSemanticProperty<Priority> | null;
  readonly estimate: PageStageSemanticProperty<Estimate> | null;
  readonly tags: PageStageSemanticProperty<readonly string[]> | null;
  readonly dueDate: PageStageSemanticProperty<Date> | null;
  readonly scheduledStart: PageStageSemanticProperty<Date> | null;
  readonly scheduledEnd: PageStageSemanticProperty<Date> | null;
  readonly assignee: PageStageSemanticProperty<string> | null;
}

export interface PageStageSemanticValues {
  readonly status?: WorkflowStatus;
  readonly priority?: Priority;
  readonly estimate?: Estimate;
  readonly tags?: readonly string[];
  readonly dueDate?: Date;
  readonly scheduledStart?: Date;
  readonly scheduledEnd?: Date;
  readonly assignee?: string;
}

export type PageStagePropertyEdit =
  | {
      readonly kind: "replace";
      readonly value: DatabaseJsonValue;
      readonly expectedValueRevision: number;
    }
  | {
      readonly kind: "create_option_and_select";
      readonly optionId: string;
      readonly name: string;
      readonly color?: string;
      readonly expectedPropertyRevision: number;
      readonly expectedValueRevision: number;
    }
  | {
      readonly kind: "patch_relation";
      readonly addPageIds: readonly string[];
      readonly removeEdgeIds: readonly string[];
    }
  | {
      readonly kind: "replace_one_relation";
      readonly targetPageId: string | null;
      readonly expectedValueRevision: number;
    }
  | {
      readonly kind: "patch_multi_select";
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    };

const emptyValue = (valueType: DatabasePropertyValueType): DatabaseJsonValue =>
  valueType === "multi_select" ? [] : null;

const invalidValueReason = (
  property: DataSourcePropertyRecordV2,
  value: DatabaseJsonValue,
): string | null => {
  if (value === null) return null;
  switch (property.valueType) {
    case "text":
    case "select":
      return typeof value === "string" ? null : "Expected a text value";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "Expected a finite number";
    case "checkbox":
      return typeof value === "boolean" ? null : "Expected a checkbox value";
    case "multi_select":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? null
        : "Expected a list of option IDs";
    case "date": {
      return typeof value === "string" && parseIsoDateToLocalDate(value)
        ? null
        : "Expected an ISO date";
    }
    case "datetime": {
      return typeof value === "string" && isCanonicalDataSourceDateTime(value)
        ? null
        : "Expected an ISO date and time";
    }
    case "relation":
      return readRelationValuePreview(value) ? null : "Expected a Relation preview";
  }
};

export const buildPageStageDataSourceProperties = (
  detail: PageDetail | LibraryPageDetail,
): readonly PageStageDataSourceProperty[] => {
  if (detail.dataSourceContext.kind !== "member") return [];
  const context = detail.dataSourceContext;
  const layoutByProperty = new Map(
    context.pageLayout.entries.map((entry) => [entry.propertyId, entry] as const),
  );
  return context.properties
    .filter((property) => property.lifecycle === "active")
    .map((property) => {
      const current = context.values[property.propertyId];
      const value = current?.value ?? emptyValue(property.valueType);
      return {
        property,
        value,
        valueRevision: current?.revision ?? 0,
        error: invalidValueReason(property, value),
        pageVisibility: layoutByProperty.get(property.propertyId)?.visibility ?? "always_show",
      };
    })
    .sort((left, right) => {
      const leftRank =
        layoutByProperty.get(left.property.propertyId)?.rankKey ?? left.property.rankKey;
      const rightRank =
        layoutByProperty.get(right.property.propertyId)?.rankKey ?? right.property.rankKey;
      return leftRank.localeCompare(rightRank);
    });
};

const findBuiltInProperty = (
  properties: readonly PageStageDataSourceProperty[],
  propertyId: BuiltInDataSourcePropertyRole,
): PageStageDataSourceProperty | null =>
  properties.find((item) => matchBuiltInDataSourceProperty(item.property) === propertyId) ?? null;

const scalarSemantic = <Value extends string>(
  item: PageStageDataSourceProperty | null,
  isValue: (value: string) => value is Value,
): PageStageSemanticProperty<Value> | null => {
  if (!item) return null;
  return {
    item,
    value: typeof item.value === "string" && isValue(item.value) ? item.value : null,
  };
};

const dateSemantic = (
  item: PageStageDataSourceProperty | null,
): PageStageSemanticProperty<Date> | null => {
  if (!item) return null;
  if (item.error) return { item, value: null };
  if (typeof item.value !== "string") return { item, value: null };
  const parsed =
    item.property.valueType === "date" ? parseIsoDateToLocalDate(item.value) : new Date(item.value);
  if (!parsed) return { item, value: null };
  return { item, value: Number.isNaN(parsed.getTime()) ? null : parsed };
};

export const readPageStageSemanticProperties = (
  properties: readonly PageStageDataSourceProperty[],
): PageStageSemanticProperties => {
  const status = scalarSemantic(findBuiltInProperty(properties, "status"), isWorkflowStatus);
  const priority = scalarSemantic(findBuiltInProperty(properties, "priority"), isPriority);
  const estimate = scalarSemantic(
    findBuiltInProperty(properties, "estimate"),
    (value): value is Estimate => ESTIMATES.has(value as Estimate),
  );
  const tagsItem = findBuiltInProperty(properties, "tags");
  const tags = tagsItem
    ? {
        item: tagsItem,
        value:
          !tagsItem.error && Array.isArray(tagsItem.value)
            ? tagsItem.value.filter((entry): entry is string => typeof entry === "string")
            : null,
      }
    : null;
  const assigneeItem = findBuiltInProperty(properties, "assignee");
  const assignee = assigneeItem
    ? {
        item: assigneeItem,
        value: typeof assigneeItem.value === "string" ? assigneeItem.value : null,
      }
    : null;
  return {
    status,
    priority,
    estimate,
    tags,
    dueDate: dateSemantic(findBuiltInProperty(properties, "due_date")),
    scheduledStart: dateSemantic(findBuiltInProperty(properties, "scheduled_start")),
    scheduledEnd: dateSemantic(findBuiltInProperty(properties, "scheduled_end")),
    assignee,
  };
};

export const readPageDetailWorkflowStatus = (
  detail: PageDetail | LibraryPageDetail | null,
): WorkflowStatus | null => {
  if (!detail) return null;
  return (
    readPageStageSemanticProperties(buildPageStageDataSourceProperties(detail)).status?.value ??
    null
  );
};

export const isPageStagePrimaryProperty = (property: PageStageDataSourceProperty): boolean =>
  PAGE_STAGE_PRIMARY_PROPERTY_IDS.some(
    (propertyId) => matchBuiltInDataSourceProperty(property.property) === propertyId,
  );

export const hasPageStageScheduleCapability = (semantic: PageStageSemanticProperties): boolean =>
  semantic.scheduledStart !== null &&
  semantic.scheduledEnd !== null &&
  semantic.scheduledStart.item.error === null &&
  semantic.scheduledEnd.item.error === null;

export const pageStageSemanticValues = (
  semantic: PageStageSemanticProperties,
): PageStageSemanticValues => ({
  ...(semantic.status?.value ? { status: semantic.status.value } : {}),
  ...(semantic.priority?.value ? { priority: semantic.priority.value } : {}),
  ...(semantic.estimate?.value ? { estimate: semantic.estimate.value } : {}),
  ...(semantic.tags?.value ? { tags: semantic.tags.value } : {}),
  ...(semantic.dueDate?.value ? { dueDate: semantic.dueDate.value } : {}),
  ...(semantic.scheduledStart?.value ? { scheduledStart: semantic.scheduledStart.value } : {}),
  ...(semantic.scheduledEnd?.value ? { scheduledEnd: semantic.scheduledEnd.value } : {}),
  ...(semantic.assignee?.value ? { assignee: semantic.assignee.value } : {}),
});

export const pageStageSectionProperties = (
  properties: readonly PageStageDataSourceProperty[],
  semantic: PageStageSemanticProperties,
): readonly PageStageDataSourceProperty[] => {
  const ownsSchedulePair = hasPageStageScheduleCapability(semantic);
  return properties.filter((property) => {
    if (isPageStagePrimaryProperty(property)) return false;
    if (!ownsSchedulePair) return true;
    return (
      property.property.propertyId !== "scheduled_start" &&
      property.property.propertyId !== "scheduled_end"
    );
  });
};

export const pageStageValueRecord = (
  item: PageStageDataSourceProperty,
): DataSourcePageValueV2 | undefined =>
  item.valueRevision === 0
    ? undefined
    : {
        propertyId: item.property.propertyId,
        valueType: item.property.valueType,
        value: item.value,
        revision: item.valueRevision,
      };
