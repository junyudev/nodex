import { describe, expect, it } from "vite-plus/test";

import type { DataSourcePagePropertyMenuDescriptor } from "@/components/database/data-source-page-property-menu-source";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { buildPagePropertyContextMenuModel } from "./page-property-context-menu-model";

const binding = (
  propertyId: string,
  name: string,
  valueType: DatabasePropertyValueType,
  lifecycle: DataSourcePropertyRecordV2["lifecycle"] = "active",
): DataSourcePagePropertyMenuDescriptor => ({
  property: {
    propertyId,
    dataSourceId: "source-1",
    name,
    valueType,
    ...testPropertySemantics(valueType),
    config: {},
    rankKey: name,
    lifecycle,
    revision: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  } as DataSourcePropertyRecordV2,
  disabled: false,
  pending: false,
});

describe("buildPagePropertyContextMenuModel", () => {
  it("puts the grouping Property first and ranks exact built-in roles", () => {
    const custom = binding("p_custom", "Customer", "text");
    const priority = binding("priority", "Urgency", "select");
    const status = binding("status", "Workflow", "select");
    const tags = binding("tags", "Labels", "multi_select");

    const model = buildPagePropertyContextMenuModel([custom, priority, status, tags], {
      groupingPropertyId: "tags",
    });

    expect(model.visible.map((entry) => entry.property.propertyId)).toEqual([
      "tags",
      "status",
      "priority",
    ]);
    expect(model.overflow).toEqual([custom]);
  });

  it("discovers custom Properties directly by normalized display name", () => {
    const customer = binding("p_customer", "客户 Success", "relation");
    const notes = binding("p_notes", "Notes", "text");

    const model = buildPagePropertyContextMenuModel([customer, notes], {
      query: "  SUCCESS ",
    });

    expect(model.searching).toBe(true);
    expect(model.visible).toEqual([customer]);
    expect(model.overflow).toEqual([]);
  });

  it("excludes deleted Properties and respects the root limit", () => {
    const model = buildPagePropertyContextMenuModel(
      [
        binding("status", "Status", "select"),
        binding("priority", "Priority", "select"),
        binding("assignee", "Assignee", "assignment"),
        binding("due_date", "Due date", "date"),
        binding("tags", "Tags", "multi_select"),
        binding("estimate", "Estimate", "select"),
        binding("p_deleted", "Deleted", "text", "deleted"),
      ],
      { featuredLimit: 3 },
    );

    expect(model.visible.map((entry) => entry.property.propertyId)).toEqual([
      "status",
      "priority",
      "due_date",
    ]);
    expect(model.overflow.map((entry) => entry.property.propertyId)).toEqual(["tags", "estimate"]);
  });
});
