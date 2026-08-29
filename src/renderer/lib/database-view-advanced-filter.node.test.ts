import { describe, expect, test } from "vite-plus/test";

import type { DatabaseViewFilterGroup } from "../../shared/database-kernel";
import {
  duplicateDatabaseViewAdvancedFilterNode,
  unwrapDatabaseViewAdvancedFilterGroup,
  wrapDatabaseViewAdvancedFilterNode,
} from "./database-view-advanced-filter";

const root = (): DatabaseViewFilterGroup => ({
  kind: "group",
  operator: "and",
  children: [
    { kind: "clause", propertyId: "name", operator: "text_contains", value: "alpha" },
    { kind: "clause", propertyId: "status", operator: "select_is", value: "build" },
  ],
});

describe("advanced Database View filter transforms", () => {
  test("duplicates a target beside its stable path", () => {
    const next = duplicateDatabaseViewAdvancedFilterNode(root(), [0]);
    expect(next.children).toHaveLength(3);
    expect(next.children[0]).toEqual(next.children[1]);
  });

  test("wraps with the opposite combinator and can unwrap without losing siblings", () => {
    const wrapped = wrapDatabaseViewAdvancedFilterNode(root(), [0]);
    expect(wrapped.children[0]).toMatchObject({ kind: "group", operator: "or" });

    const unwrapped = unwrapDatabaseViewAdvancedFilterGroup(wrapped, [0]);
    expect(unwrapped).toEqual(root());
  });

  test("invalid and root paths are safe no-ops", () => {
    const current = root();
    expect(wrapDatabaseViewAdvancedFilterNode(current, [])).toBe(current);
    expect(duplicateDatabaseViewAdvancedFilterNode(current, [9])).toBe(current);
    expect(unwrapDatabaseViewAdvancedFilterGroup(current, [1])).toBe(current);
  });
});
