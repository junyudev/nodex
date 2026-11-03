import type { SVGProps } from "react";
import {
  BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS,
  matchBuiltInDataSourceProperty,
} from "../../../shared/data-source-built-ins";
import {
  parseDataSourcePropertyId,
  type BuiltInDataSourcePropertyId,
} from "../../../shared/database-identities";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import type { DatabasePropertyValueType } from "../../../shared/database-kernel";
import {
  dataSourcePropertyIcon,
  dataSourcePropertyTypeIcon,
} from "./data-source-property-presentation";

const TYPE_ICONS = {
  text: dataSourcePropertyTypeIcon("text"),
  number: dataSourcePropertyTypeIcon("number"),
  checkbox: dataSourcePropertyTypeIcon("checkbox"),
  select: dataSourcePropertyTypeIcon("select"),
  multi_select: dataSourcePropertyTypeIcon("multi_select"),
  date: dataSourcePropertyTypeIcon("date"),
  datetime: dataSourcePropertyTypeIcon("datetime"),
  relation: dataSourcePropertyTypeIcon("relation"),
};

// Resolve the existing icon policy once; render only selects among static component identities.
const BUILT_IN_ICONS = Object.fromEntries(
  Object.entries(BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS).map(([propertyId, definition]) => [
    propertyId,
    dataSourcePropertyIcon({
      propertyId: parseDataSourcePropertyId(propertyId),
      valueType: definition.valueType,
    }),
  ]),
) as Record<BuiltInDataSourcePropertyId, ReturnType<typeof dataSourcePropertyIcon>>;

type IconProps = Omit<SVGProps<SVGSVGElement>, "ref">;

export function PropertyEditorIcon({
  property,
  ...props
}: IconProps & {
  readonly property: Pick<DataSourcePropertyRecordV2, "propertyId" | "valueType">;
}) {
  const builtIn = matchBuiltInDataSourceProperty(property);
  const Icon = builtIn ? BUILT_IN_ICONS[builtIn] : TYPE_ICONS[property.valueType];
  return <Icon {...props} />;
}

export function PropertyTypeIcon({
  valueType,
  ...props
}: IconProps & {
  readonly valueType: DatabasePropertyValueType;
}) {
  const Icon = TYPE_ICONS[valueType];
  return <Icon {...props} />;
}
