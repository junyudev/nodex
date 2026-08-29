import { describe, expect, test } from "vite-plus/test";

import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import {
  databaseViewSortDirectionLabels,
  hasCustomDatabaseViewSort,
  summarizeDatabaseViewFilter,
} from "./database-view-rule-summary";

const property = (propertyId: string, name: string): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId: parseDataSourceId("source:rules"),
  name,
  ...testPropertySemantics("select", 2),
  valueType: "select",
  config: { options: [{ id: "build", name: "Build" }] },
  rankKey: propertyId,
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
});

describe("database View rule summaries", () => {
  test("groups nested clauses by property and resolves option names", () => {
    expect(
      summarizeDatabaseViewFilter(
        {
          kind: "group",
          operator: "and",
          children: [
            { kind: "clause", propertyId: "p_status00", operator: "equals", value: "build" },
            {
              kind: "group",
              operator: "or",
              children: [
                { kind: "clause", propertyId: "p_priorit0", operator: "is_empty" },
                { kind: "clause", propertyId: "p_priorit0", operator: "equals", value: "build" },
              ],
            },
          ],
        },
        [property("p_status00", "Status"), property("p_priorit0", "Priority")],
      ),
    ).toEqual([
      { key: "p_status00", label: "Status", value: "is Build" },
      { key: "p_priorit0", label: "Priority", value: "2 rules" },
    ]);
  });

  test("summarizes familiar task chips by their visible option labels", () => {
    const status = property("status", "Status");
    const taskStatus: DataSourcePropertyRecordV2 = {
      ...status,
      config: {
        options: [
          { id: "triage", name: "Triage" },
          { id: "plan", name: "Plan" },
          { id: "build", name: "Build" },
          { id: "review", name: "Review" },
          { id: "ship", name: "Ship" },
        ],
      },
    };
    expect(
      summarizeDatabaseViewFilter(
        {
          kind: "group",
          operator: "and",
          children: [
            {
              kind: "group",
              operator: "or",
              children: [
                { kind: "clause", propertyId: "status", operator: "equals", value: "triage" },
                { kind: "clause", propertyId: "status", operator: "equals", value: "plan" },
              ],
            },
          ],
        },
        [taskStatus],
      ),
    ).toEqual([
      {
        key: "status",
        label: "Status",
        value: "Triage, Plan",
      },
    ]);
  });

  test("resolves tag identities only through the bounded option registry", () => {
    const tags: DataSourcePropertyRecordV2 = {
      ...property("tags", "Tags"),
      ...testPropertySemantics("multi_select", 1),
      valueType: "multi_select",
      config: {},
    };
    const filter = {
      kind: "clause" as const,
      propertyId: "tags",
      operator: "contains" as const,
      value: "o_AAAAAAAA",
    };

    expect(
      summarizeDatabaseViewFilter(filter, [tags], {
        tags: [{ id: "o_AAAAAAAA", name: "Product" }],
      }),
    ).toEqual([
      {
        key: "tags",
        label: "Tags",
        value: "Any: Product",
      },
    ]);
    expect(summarizeDatabaseViewFilter(filter, [tags])).toEqual([
      {
        key: "tags",
        label: "Tags",
        value: "Any: Unknown option",
      },
    ]);
  });

  test("treats only canonical manual ordering as the default", () => {
    expect(
      hasCustomDatabaseViewSort([
        {
          field: { kind: "manual" },
          direction: "asc",
          nulls: "last",
        },
      ]),
    ).toBe(false);
    expect(
      hasCustomDatabaseViewSort([
        {
          field: { kind: "title" },
          direction: "asc",
          nulls: "last",
        },
      ]),
    ).toBe(true);
  });

  test("uses direction language that matches the selected Property semantics", () => {
    const numeric = {
      ...property("p_number00", "Estimate"),
      ...testPropertySemantics("number"),
      valueType: "number" as const,
    };
    expect(
      databaseViewSortDirectionLabels(
        {
          field: { kind: "property", propertyId: numeric.propertyId },
          direction: "asc",
          nulls: "last",
        },
        [numeric],
      ),
    ).toEqual(["Low to high", "High to low"]);
    expect(
      databaseViewSortDirectionLabels(
        { field: { kind: "created" }, direction: "desc", nulls: "last" },
        [],
      ),
    ).toEqual(["Earliest first", "Latest first"]);
  });
});
