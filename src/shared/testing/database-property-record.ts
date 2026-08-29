import type {
  DatabasePropertyCapabilitiesV2,
  DatabasePropertySchemaV2,
  DataSourcePropertyRecordV2,
} from "../database-module-v2";
import type { DatabasePropertyValueType } from "../database-kernel";
import { databaseViewFilterOperatorsForValueType } from "../database-kernel";
import { parseDataSourceId } from "../database-identities";

export const testPropertyManagement = (): Pick<
  DataSourcePropertyRecordV2,
  "systemRole" | "nonEmptyValueCount" | "referencedViewIds" | "managementPolicy"
> => ({
  systemRole: null,
  nonEmptyValueCount: 0,
  referencedViewIds: [],
  managementPolicy: {
    canRename: true,
    canReorder: true,
    canChangeType: true,
    canDuplicate: true,
    canDelete: true,
    canRestore: false,
    canPermanentlyDelete: false,
    canManageOptions: true,
    allowedTypes: [
      "text",
      "number",
      "checkbox",
      "select",
      "multi_select",
      "date",
      "datetime",
      "relation",
    ],
    blockedReasons: [],
  },
});

export const testPropertySemantics = (
  valueType: DatabasePropertyValueType,
  optionCount = 0,
): Pick<
  DataSourcePropertyRecordV2,
  | "schema"
  | "capabilities"
  | "optionCount"
  | "systemRole"
  | "nonEmptyValueCount"
  | "referencedViewIds"
  | "managementPolicy"
> => {
  const schema: DatabasePropertySchemaV2 = (() => {
    if (valueType === "relation") {
      return {
        kind: "relation",
        targetDataSourceId: parseDataSourceId("source-1"),
        cardinality: "many",
      };
    }
    if (valueType === "number") return { kind: "number", format: { kind: "plain" } };
    if (valueType === "date") return { kind: "date", dateFormat: "full" };
    if (valueType === "datetime") {
      return { kind: "datetime", dateFormat: "full", timeFormat: "twelve_hour" };
    }
    return { kind: valueType };
  })();
  const capabilities: DatabasePropertyCapabilitiesV2 = {
    filterOperators: databaseViewFilterOperatorsForValueType(valueType),
    sortable: valueType !== "relation",
    groupable: valueType !== "relation",
  };
  return {
    schema,
    capabilities,
    optionCount,
    ...testPropertyManagement(),
    managementPolicy: {
      ...testPropertyManagement().managementPolicy,
      canManageOptions: valueType === "select" || valueType === "multi_select",
    },
  };
};
