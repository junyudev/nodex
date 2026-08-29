import { describe, expect, it } from "vitest";

import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import type {
  DatabaseViewRecordV2,
  DataSourceDescriptorV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import { testPropertyManagement } from "../../shared/testing/database-property-record";
import { emptyDatabaseViewConfig } from "./database-view-authoring";
import {
  changeDatabaseViewLayoutOperation,
  databaseViewConfigWithoutProperty,
  deleteDataSourcePropertyOperations,
  duplicateDatabaseViewOperation,
  moveDataSourcePropertyOperation,
  moveDatabaseViewOperation,
  reorderDatabaseViewOperation,
} from "./database-settings-operations";

const sourceId = parseDataSourceId("source");
const databaseId = parseDatabaseId("database");
const propertyId = parseDataSourcePropertyId("p_AAAAAAAA");

const property: DataSourcePropertyRecordV2 = {
  propertyId,
  dataSourceId: sourceId,
  name: "Priority",
  schema: { kind: "select" },
  capabilities: {
    filterOperators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
    sortable: true,
    groupable: true,
  },
  ...testPropertyManagement(),
  valueType: "select",
  config: {},
  optionCount: 0,
  rankKey: "a",
  lifecycle: "active",
  revision: 3,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const view = (id: string, rankKey: string): DatabaseViewRecordV2 => ({
  viewId: parseDatabaseViewId(id),
  databaseId,
  dataSourceId: sourceId,
  name: id,
  layout: "board",
  config: {
    ...emptyDatabaseViewConfig(),
    rules: {
      propertyFilters: [],
      advancedFilter: {
        kind: "group",
        operator: "and",
        children: [{ kind: "clause", propertyId, operator: "select_is", value: "high" }],
      },
      sorts: [{ field: { kind: "property", propertyId }, direction: "asc", nulls: "last" }],
    },
    presentation: {
      ...emptyDatabaseViewConfig().presentation,
      group: { propertyId },
      subgroup: { propertyId },
      display: {
        fields: [{ kind: "property", propertyId }],
        propertyOrder: [propertyId],
        showEmptyGroups: false,
      },
      conditionalColors: [
        {
          ruleId: "rule-1",
          propertyId,
          operator: "equals",
          value: "high",
          color: "red",
        },
      ],
    },
  },
  isDefault: id === "a",
  revision: 2,
  rankKey,
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const source: DataSourceDescriptorV2 = {
  dataSource: {
    dataSourceId: sourceId,
    libraryId: "library",
    homeDatabaseId: databaseId,
    name: "Tasks",
    schemaKey: "tasks",
    schemaRevision: 8,
    lifecycle: "active",
    rankKey: "a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  properties: [property],
};

describe("database settings operations", () => {
  it("uses explicit durable intents for View duplication and layout conversion", () => {
    const current = view("a", "a");
    const newViewId = parseDatabaseViewId("b");

    expect(duplicateDatabaseViewOperation({ view: current, viewId: newViewId })).toEqual({
      kind: "duplicate_view",
      databaseId,
      sourceViewId: current.viewId,
      expectedRevision: current.revision,
      newViewId,
    });
    expect(changeDatabaseViewLayoutOperation(current, "list")).toEqual({
      kind: "change_view_layout",
      databaseId,
      viewId: current.viewId,
      expectedRevision: current.revision,
      layout: "list",
    });
  });

  it("removes all supported references to a deleted Property", () => {
    const next = databaseViewConfigWithoutProperty(view("a", "a").config, propertyId);

    expect(next.rules.advancedFilter).toEqual({ kind: "group", operator: "and", children: [] });
    expect(next.rules.sorts).toEqual([]);
    expect(next.presentation.group).toBeNull();
    expect(next.presentation.subgroup).toBeNull();
    expect(next.presentation.display.fields).toEqual([]);
    expect(next.presentation.display.propertyOrder).toEqual([]);
    expect(next.presentation.conditionalColors).toEqual([]);
  });

  it("repairs every affected View before one soft delete", () => {
    const operations = deleteDataSourcePropertyOperations({
      source,
      views: [view("a", "a"), view("b", "b")],
      property,
    });

    expect(operations.map((operation) => operation.kind)).toEqual([
      "put_view",
      "put_view",
      "delete_property",
    ]);
  });

  it("reorders a real View identity without changing its layout", () => {
    const views = [view("a", "a"), view("b", "b"), view("c", "c")];
    const operation = moveDatabaseViewOperation(views, views[1]!, "down");

    expect(operation).toMatchObject({
      kind: "move_view",
      viewId: "b",
      placement: { kind: "end" },
    });
  });

  it("persists an arbitrary tab drop with one placement operation", () => {
    const views = [view("a", "a"), view("b", "b"), view("c", "c")];

    expect(reorderDatabaseViewOperation(views, "c", ["a", "c", "b"])).toMatchObject({
      kind: "move_view",
      viewId: "c",
      placement: { kind: "before", viewId: "b" },
    });
    expect(reorderDatabaseViewOperation(views, "a", ["b", "c", "a"])).toMatchObject({
      kind: "move_view",
      viewId: "a",
      placement: { kind: "end" },
    });
  });

  it("expresses move-to-end explicitly for Properties", () => {
    const second = { ...property, propertyId: parseDataSourcePropertyId("p_BBBBBBBB") };
    const operation = moveDataSourcePropertyOperation(
      { ...source, properties: [property, second] },
      property,
      "down",
    );

    expect(operation).toMatchObject({
      kind: "move_property",
      propertyId,
      placement: { kind: "end" },
    });
  });
});
