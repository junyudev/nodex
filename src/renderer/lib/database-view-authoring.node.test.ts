import { describe, expect, test } from "vite-plus/test";
import type { DatabaseViewFilterNode, DatabaseViewConfigV6 } from "../../shared/database-kernel";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import type {
  DatabaseViewRecordV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import {
  appendDatabaseViewFilterChild,
  createDatabaseViewFilterClause,
  databaseFilterClauseWithOperator,
  filterOperatorsForProperty,
  databaseViewConfigsEqual,
  databaseViewMoveBeforeId,
  databaseViewReorderBeforeId,
  emptyDatabaseViewConfig,
  moveDatabaseViewSort,
  removeDatabaseViewFilterNode,
  updateDatabaseViewFilterNode,
} from "./database-view-authoring";

const timestamp = "2026-07-12T00:00:00.000Z";

const property = (
  valueType: DataSourcePropertyRecordV2["valueType"],
): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId("p_AAAAAAAA"),
  dataSourceId: parseDataSourceId("source-1"),
  name: valueType,
  ...testPropertySemantics(
    valueType,
    valueType === "select" || valueType === "multi_select" ? 1 : 0,
  ),
  valueType,
  config:
    valueType === "select" || valueType === "multi_select"
      ? { options: [{ id: "o_AAAAAAAA", name: "One" }] }
      : {},
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const view = (id: string): DatabaseViewRecordV2 => ({
  viewId: parseDatabaseViewId(id),
  databaseId: parseDatabaseId("database-1"),
  dataSourceId: parseDataSourceId("source-1"),
  name: id,
  layout: "list",
  config: upgradeDatabaseViewConfigV2({
    schemaKey: "nodex.database-view",
    schemaVersion: 2,
    filter: { kind: "group", operator: "and", children: [] },
    sort: [],
    group: null,
    display: { propertyIds: [], showTitle: true },
  }),
  isDefault: id === "a",
  revision: 1,
  rankKey: id,
  lifecycle: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
});

describe("durable Database View authoring", () => {
  test("starts a new View with one empty display configuration", () => {
    const config = emptyDatabaseViewConfig();
    expect(config.presentation.display.fields).toEqual([]);
  });

  test("derives server-owned logical anchors for adjacent View moves", () => {
    const views = [view("a"), view("b"), view("c")];
    expect(databaseViewMoveBeforeId(views, "b", "up")).toBe("a");
    expect(databaseViewMoveBeforeId(views, "a", "down")).toBe("c");
    expect(databaseViewMoveBeforeId(views, "b", "down")).toBe(null);
    expect(databaseViewMoveBeforeId(views, "a", "up")).toBeUndefined();
    expect(databaseViewMoveBeforeId(views, "c", "down")).toBeUndefined();
  });

  test("compiles arbitrary tab-list reorder into one logical anchor", () => {
    const views = [view("a"), view("b"), view("c"), view("d")];

    expect(databaseViewReorderBeforeId(views, "d", ["a", "d", "b", "c"])).toBe("b");
    expect(databaseViewReorderBeforeId(views, "a", ["b", "c", "d", "a"])).toBeNull();
    expect(databaseViewReorderBeforeId(views, "b", ["a", "b", "c", "d"])).toBeUndefined();
    expect(databaseViewReorderBeforeId(views, "b", ["a", "b", "c"])).toBeUndefined();
  });

  test("updates nested filters immutably and preserves value arity", () => {
    const text = property("text");
    const number = property("number");
    const initial: DatabaseViewFilterNode = {
      kind: "group",
      operator: "and",
      children: [createDatabaseViewFilterClause(text)],
    };
    const nested = appendDatabaseViewFilterChild(initial, [], {
      kind: "group",
      operator: "or",
      children: [createDatabaseViewFilterClause(number)],
    });
    const withoutValue = databaseFilterClauseWithOperator(number, "is_empty");
    const updated = updateDatabaseViewFilterNode(nested, [1, 0], withoutValue);
    const removed = removeDatabaseViewFilterNode(updated, [0]);

    expect(initial.kind === "group" ? initial.children.length : -1).toBe(1);
    expect(JSON.stringify(updated).includes('"value"')).toBe(true);
    expect(JSON.stringify(withoutValue).includes('"value"')).toBe(false);
    expect(removed.kind === "group" ? removed.children.length : -1).toBe(1);
  });

  test("authors typed membership and relative-date values", () => {
    const multiSelect = property("multi_select");
    expect(filterOperatorsForProperty(multiSelect)).toContain("multi_select_does_not_contain");
    expect(databaseFilterClauseWithOperator(multiSelect, "multi_select_does_not_contain")).toEqual({
      kind: "clause",
      propertyId: multiSelect.propertyId,
      operator: "multi_select_does_not_contain",
      value: [],
    });
    expect(databaseFilterClauseWithOperator(property("date"), "date_relative_to")).toEqual({
      kind: "clause",
      propertyId: "p_AAAAAAAA",
      operator: "date_relative_to",
      value: { direction: "past", count: 1, unit: "week" },
    });
  });

  test("compares canonical configs and reorders sort precedence", () => {
    const base: DatabaseViewConfigV6 = upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view",
      schemaVersion: 2,
      filter: { kind: "group", operator: "and", children: [] },
      sort: [
        { field: { kind: "title" }, direction: "asc", nulls: "last" },
        { field: { kind: "manual" }, direction: "asc", nulls: "last" },
      ],
      group: null,
      display: { propertyIds: [], showTitle: true },
    });
    const moved = moveDatabaseViewSort(base.rules.sorts, 1, "up");
    expect(moved[0]?.field.kind).toBe("manual");
    expect(
      databaseViewConfigsEqual(base, {
        ...base,
        rules: {
          ...base.rules,
          sorts: [...base.rules.sorts],
        },
      }),
    ).toBe(true);
    expect(
      databaseViewConfigsEqual(base, {
        ...base,
        rules: { ...base.rules, sorts: moved },
      }),
    ).toBe(false);
  });
});
