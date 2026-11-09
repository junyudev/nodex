import type { DatabasePropertyValueType } from "./database-kernel";
import {
  isBuiltInDataSourcePropertyId,
  type BuiltInDataSourcePropertyId,
} from "./database-identities";

export const BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS = {
  status: { valueType: "select" },
  priority: { valueType: "select" },
  estimate: { valueType: "select" },
  tags: { valueType: "multi_select" },
  due_date: { valueType: "date" },
  scheduled_start: { valueType: "datetime" },
  scheduled_end: { valueType: "datetime" },
  assignee: { valueType: "text" },
  task_parent: { valueType: "relation" },
  blocked_by: { valueType: "relation" },
} as const satisfies Readonly<
  Record<BuiltInDataSourcePropertyId, { readonly valueType: DatabasePropertyValueType }>
>;

export type BuiltInDataSourcePropertyRole = keyof typeof BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS;

export const matchBuiltInDataSourceProperty = (input: {
  readonly propertyId: unknown;
  readonly valueType: DatabasePropertyValueType;
}): BuiltInDataSourcePropertyRole | null => {
  if (!isBuiltInDataSourcePropertyId(input.propertyId)) return null;
  const definition = BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS[input.propertyId];
  return definition.valueType === input.valueType ? input.propertyId : null;
};
