import { describe, expect, test } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import type { PageStageDataSourceProperty } from "./page-stage-properties";
import {
  advancePageStagePropertyDisclosure,
  revealPageStageProperty,
  type PageStagePropertyDisclosureEntry,
  type PageStagePropertyDisclosureState,
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
        withId("status", item("text", "doing", "hide_when_empty")),
        withId("priority", item("text", null, "hide_when_empty")),
        withId("p_noteNote", item("text", "", "always_show")),
        withId("p_secret00", item("text", "value", "always_hide")),
      ],
      null,
    );
    expect(rows.map((row) => [row.key, row.shownByLayout, row.empty])).toEqual([
      ["status", true, false],
      ["priority", false, true],
      ["p_noteNote", true, true],
      ["p_secret00", false, false],
    ]);
  });
});

describe("Page property disclosure", () => {
  const entries = (
    shown: Readonly<Record<string, boolean | "tucked-value">>,
  ): readonly PageStagePropertyDisclosureEntry[] =>
    Object.entries(shown).map(([key, state]) => ({
      key,
      shownByLayout: state === true,
      empty: state !== "tucked-value" && state !== true,
    }));
  const advance = (
    current: PageStagePropertyDisclosureState | null,
    shown: Parameters<typeof entries>[0],
    expanded = false,
    pageId = "page-1",
  ) => advancePageStagePropertyDisclosure(current, { pageId, entries: entries(shown), expanded });

  test("starts from what the layout shows for each Page", () => {
    const first = advance(null, { status: true, priority: false });
    expect([...first.shownKeys]).toEqual(["status"]);

    const next = advance(first, { status: false, priority: true }, false, "page-2");
    expect([...next.shownKeys]).toEqual(["priority"]);
  });

  test("keeps a shown row after its value is cleared", () => {
    const shown = advance(null, { priority: true });
    const cleared = advance(shown, { priority: false });
    expect(cleared).toBe(shown);
    expect(cleared.shownKeys.has("priority")).toBe(true);
  });

  test("opens tucked-away values as rows and leaves empty entries to be chosen", () => {
    const closed = advance(null, { status: true, secret: "tucked-value", tags: false });
    expect([...closed.tuckedRowKeys]).toEqual([]);

    const open = advance(closed, { status: true, secret: "tucked-value", tags: false }, true);
    expect([...open.shownKeys]).toEqual(["status"]);
    expect([...open.tuckedRowKeys]).toEqual(["secret"]);
  });

  test("a chosen entry joins the list and stays after the disclosure closes", () => {
    const open = advance(null, { status: true, tags: false }, true);
    const chosen = revealPageStageProperty(open, "tags");
    expect([...chosen.shownKeys]).toEqual(["status", "tags"]);
    expect(revealPageStageProperty(chosen, "tags")).toBe(chosen);

    const closed = advance(chosen, { status: true, tags: false });
    expect(closed.shownKeys.has("tags")).toBe(true);
  });

  test("holds a tucked row in place while open, whatever happens to its value", () => {
    const open = advance(null, { status: true, files: "tucked-value" }, true);

    const cleared = advance(open, { status: true, files: false }, true);
    expect(cleared).toBe(open);

    const shownByLayout = advance(open, { status: true, files: true }, true);
    expect(shownByLayout).toBe(open);

    const closed = advance(shownByLayout, { status: true, files: true });
    expect([...closed.shownKeys]).toEqual(["status", "files"]);
    expect([...closed.tuckedRowKeys]).toEqual([]);
  });

  test("promotes an entry filled from elsewhere even while open", () => {
    const open = advance(null, { status: true, tags: false }, true);
    const filled = advance(open, { status: true, tags: true }, true);
    expect([...filled.shownKeys]).toEqual(["status", "tags"]);
  });
});
