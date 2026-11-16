import {
  AssigneeIcon,
  CalendarIcon,
  CheckboxSquareIcon,
  EstimateIcon,
  MultiSelectIcon,
  PageIcon,
  PartOfIcon,
  PriorityIcon,
  StatusIcon,
  TagsIcon,
  WaitsForIcon,
} from "@/components/shared/icons";
import { Hash, TextCursorInput } from "@/components/shared/icons/generic-icons";
import { defineMessages } from "@/lib/i18n";
import type { DatabasePropertyValueType } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import { matchBuiltInDataSourceProperty } from "../../../shared/data-source-built-ins";

export const DATA_SOURCE_PROPERTY_TYPE_MESSAGES = defineMessages({
  assignment: {
    id: "components.dataSourcePropertyPresentation.assignment",
    defaultMessage: "Person or Agent",
  },
  text: { id: "components.dataSourcePropertyPresentation.text", defaultMessage: "Text" },
  number: { id: "components.dataSourcePropertyPresentation.number", defaultMessage: "Number" },
  checkbox: {
    id: "components.dataSourcePropertyPresentation.checkbox",
    defaultMessage: "Checkbox",
  },
  select: {
    id: "components.dataSourcePropertyPresentation.select",
    defaultMessage: "Select",
    description: "Database property type with one selectable option",
  },
  multi_select: {
    id: "components.dataSourcePropertyPresentation.multiSelect",
    defaultMessage: "Multi-select",
  },
  date: { id: "components.dataSourcePropertyPresentation.date", defaultMessage: "Date" },
  datetime: {
    id: "components.dataSourcePropertyPresentation.dateTime",
    defaultMessage: "Date & time",
  },
  relation: {
    id: "components.dataSourcePropertyPresentation.relation",
    defaultMessage: "Relation",
    description: "Database property type linking Pages",
  },
} satisfies Record<
  DatabasePropertyValueType,
  { id: string; defaultMessage: string; description?: string }
>);

export const dataSourcePropertyTypeIcon = (valueType: DatabasePropertyValueType) => {
  switch (valueType) {
    case "assignment":
      return AssigneeIcon;
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
      // The two work Relations say what they mean, so a Page never lists three bare Page icons.
      switch (matchBuiltInDataSourceProperty(property)) {
        case "task_parent":
          return PartOfIcon;
        case "blocked_by":
          return WaitsForIcon;
        default:
          return dataSourcePropertyTypeIcon(role.valueType);
      }
  }
};
