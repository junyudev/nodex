import {
  AssigneeIcon,
  CalendarIcon,
  CheckboxSquareIcon,
  EstimateIcon,
  MultiSelectIcon,
  PageIcon,
  PriorityIcon,
  StatusIcon,
  TagsIcon,
} from "@/components/shared/icons";
import { Hash, TextCursorInput } from "@/components/shared/icons/generic-icons";
import type { DatabasePropertyValueType } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";

export const DATA_SOURCE_PROPERTY_TYPE_LABELS = {
  text: "Text",
  number: "Number",
  checkbox: "Checkbox",
  select: "Select",
  multi_select: "Multi-select",
  date: "Date",
  datetime: "Date & time",
  relation: "Relation",
} as const satisfies Record<DatabasePropertyValueType, string>;

export const dataSourcePropertyTypeIcon = (valueType: DatabasePropertyValueType) => {
  switch (valueType) {
    case "number":
      return Hash;
    case "checkbox":
      return CheckboxSquareIcon;
    case "select":
      return TagsIcon;
    case "multi_select":
      return MultiSelectIcon;
    case "date":
    case "datetime":
      return CalendarIcon;
    case "text":
      return TextCursorInput;
    case "relation":
      return PageIcon;
  }
};

export const dataSourcePropertyIcon = (
  property: Pick<DataSourcePropertyRecordV2, "propertyId" | "valueType">,
) => {
  const role = resolveDataSourcePropertyPresentationRole(property);
  switch (role.kind) {
    case "status":
      return StatusIcon;
    case "priority":
      return PriorityIcon;
    case "estimate":
      return EstimateIcon;
    case "tags":
      return TagsIcon;
    case "due_date":
    case "schedule_boundary":
      return CalendarIcon;
    case "assignee":
      return AssigneeIcon;
    case "typed":
      return dataSourcePropertyTypeIcon(role.valueType);
  }
};
