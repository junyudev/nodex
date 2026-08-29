import { describe, expect, test } from "vite-plus/test";

import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import {
  databaseListGroupLabel,
  databaseListPropertyHasValue,
} from "./database-list-property-presentation";

const property = (
  valueType: DataSourcePropertyRecordV2["valueType"],
): DataSourcePropertyRecordV2 => ({
  propertyId: "custom:test" as DataSourcePropertyRecordV2["propertyId"],
  dataSourceId: "data-source:test" as DataSourcePropertyRecordV2["dataSourceId"],
  name: "Test",
  ...testPropertySemantics(valueType),
  valueType,
  config: {},
  optionCount: 0,
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
});

describe("Database List property presence", () => {
  test("presents canonical workflow status labels without rewriting custom options", () => {
    expect(databaseListGroupLabel("status", "triage", "triage")).toBe("Triage");
    expect(databaseListGroupLabel("status", "build", "build")).toBe("Build");
    expect(databaseListGroupLabel("custom:phase", "build", "Engineering")).toBe("Engineering");
  });

  test("omits visual placeholders while preserving meaningful falsy values", () => {
    expect(databaseListPropertyHasValue(property("text"), "")).toBe(false);
    expect(databaseListPropertyHasValue(property("multi_select"), [])).toBe(false);
    expect(databaseListPropertyHasValue(property("checkbox"), false)).toBe(false);
    expect(databaseListPropertyHasValue(property("number"), 0)).toBe(true);
    expect(databaseListPropertyHasValue(property("checkbox"), true)).toBe(true);
  });

  test("uses relation totals instead of object truthiness", () => {
    const emptyRelation = {
      kind: "relation",
      value: {
        value_revision: 1,
        total_count: 0,
        targets: [],
        restricted_count: 0,
        has_more: false,
      },
    } as const;
    expect(databaseListPropertyHasValue(property("relation"), emptyRelation)).toBe(false);
  });
});
