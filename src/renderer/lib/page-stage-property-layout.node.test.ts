import { describe, expect, test } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import type { PageStageDataSourceProperty } from "./page-stage-properties";
import {
  advancePageStagePropertyDisclosure,
  isPageStagePropertyHiddenByLayout,
  isPageStagePropertyValueEmpty,
  pageStagePropertyRows,
} from "./page-stage-property-layout";
import { testPropertySemantics } from "../../shared/testing/database-property-record";

const item = (
  valueType: DatabasePropertyValueType,
  value: PageStageDataSourceProperty["value"],
  pageVisibility: PageStageDataSourceProperty["pageVisibility"] = "hide_when_empty",
): PageStageDataSourceProperty => ({
  property: {
    propertyId: parseDataSourcePropertyId("p_AAAAAAAA"),
    dataSourceId: parseDataSourceId("source-1"),
    name: "Test",
    ...testPropertySemantics(valueType),
    valueType,
    config: {},
    rankKey: "a",
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  value,
  valueRevision: 0,
  error: null,
  pageVisibility,
});

describe("Page layout typed emptiness", () => {
  test("treats null, empty text, and empty multi-select as empty", () => {
    expect(isPageStagePropertyValueEmpty(item("date", null))).toBe(true);
    expect(isPageStagePropertyValueEmpty(item("text", ""))).toBe(true);
    expect(isPageStagePropertyValueEmpty(item("multi_select", []))).toBe(true);
  });

  test("keeps false and zero visible", () => {
    expect(isPageStagePropertyValueEmpty(item("checkbox", false))).toBe(false);
    expect(isPageStagePropertyValueEmpty(item("number", 0))).toBe(false);
  });

  test("separates always-hide from hide-when-empty", () => {
    expect(isPageStagePropertyHiddenByLayout(item("text", "value", "always_hide"))).toBe(true);
    expect(isPageStagePropertyHiddenByLayout(item("text", "value", "hide_when_empty"))).toBe(false);
    expect(isPageStagePropertyHiddenByLayout(item("text", "", "always_show"))).toBe(false);
  });
});

describe("Page property rows", () => {
  const withId = (
    propertyId: string,
    source: PageStageDataSourceProperty,
  ): PageStageDataSourceProperty => ({
    ...source,
    property: { ...source.property, propertyId: parseDataSourcePropertyId(propertyId) },
  });

  test("keeps layout order and reports which rows the layout shows", () => {
    const rows = pageStagePropertyRows(
      [
        withId("status", item("text", "build", "hide_when_empty")),
        withId("priority", item("text", null, "hide_when_empty")),
        withId("p_noteNote", item("text", "", "always_show")),
        withId("p_secret00", item("text", "value", "always_hide")),
      ],
      null,
    );
    expect(rows.map((row) => [row.key, row.shownByLayout])).toEqual([
      ["status", true],
      ["priority", false],
      ["p_noteNote", true],
      ["p_secret00", false],
    ]);
  });
});

describe("Page property disclosure", () => {
  const rows = (shown: Readonly<Record<string, boolean>>) =>
    Object.entries(shown).map(([key, shownByLayout]) => ({ key, shownByLayout }));

  test("starts from what the layout shows for each Page", () => {
    const first = advancePageStagePropertyDisclosure(null, {
      pageId: "page-1",
      rows: rows({ status: true, priority: false }),
      expanded: false,
    });
    expect([...first.shownKeys]).toEqual(["status"]);

    const next = advancePageStagePropertyDisclosure(first, {
      pageId: "page-2",
      rows: rows({ status: false, priority: true }),
      expanded: false,
    });
    expect([...next.shownKeys]).toEqual(["priority"]);
  });

  test("keeps a shown row after its value is cleared", () => {
    const shown = advancePageStagePropertyDisclosure(null, {
      pageId: "page-1",
      rows: rows({ priority: true }),
      expanded: false,
    });
    const cleared = advancePageStagePropertyDisclosure(shown, {
      pageId: "page-1",
      rows: rows({ priority: false }),
      expanded: false,
    });
    expect(cleared).toBe(shown);
    expect(cleared.shownKeys.has("priority")).toBe(true);
  });

  test("holds rows in place while open and promotes filled rows on close", () => {
    const initial = advancePageStagePropertyDisclosure(null, {
      pageId: "page-1",
      rows: rows({ status: true, tags: false }),
      expanded: false,
    });
    const filledWhileOpen = advancePageStagePropertyDisclosure(initial, {
      pageId: "page-1",
      rows: rows({ status: true, tags: true }),
      expanded: true,
    });
    expect(filledWhileOpen).toBe(initial);

    const closed = advancePageStagePropertyDisclosure(filledWhileOpen, {
      pageId: "page-1",
      rows: rows({ status: true, tags: true }),
      expanded: false,
    });
    expect([...closed.shownKeys]).toEqual(["status", "tags"]);
  });
});
