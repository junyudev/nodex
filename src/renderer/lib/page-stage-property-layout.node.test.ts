import { describe, expect, test } from "vite-plus/test";

import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import type { PageStageDataSourceProperty } from "./page-stage-properties";
import {
  isPageStagePropertyHiddenByLayout,
  isPageStagePropertyValueEmpty,
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
