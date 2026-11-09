import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import { matchBuiltInDataSourceProperty } from "../../shared/data-source-built-ins";

export type DataSourcePropertyPresentationRole =
  | { readonly kind: "status" }
  | { readonly kind: "priority" }
  | { readonly kind: "estimate" }
  | { readonly kind: "tags" }
  | { readonly kind: "due_date" }
  | { readonly kind: "schedule_boundary" }
  | { readonly kind: "assignee" }
  | { readonly kind: "typed"; readonly valueType: DatabasePropertyValueType };

export const resolveDataSourcePropertyPresentationRole = (input: {
  readonly propertyId: unknown;
  readonly valueType: DatabasePropertyValueType;
}): DataSourcePropertyPresentationRole => {
  const builtIn = matchBuiltInDataSourceProperty(input);
  switch (builtIn) {
    case "status":
    case "priority":
    case "estimate":
    case "tags":
    case "due_date":
    case "assignee":
      return { kind: builtIn };
    case "scheduled_start":
    case "scheduled_end":
      return { kind: "schedule_boundary" };
    case "task_parent":
    case "blocked_by":
    case null:
      return { kind: "typed", valueType: input.valueType };
  }
};
