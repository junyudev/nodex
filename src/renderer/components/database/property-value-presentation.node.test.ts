import { describe, expect, test } from "vite-plus/test";
import {
  EstimateIcon,
  MultiSelectIcon,
  PriorityIcon,
  StatusIcon,
  TagsIcon,
} from "@/components/shared/icons";
import { parseDataSourcePropertyId } from "../../../shared/database-identities";
import { dataSourcePropertyIcon } from "./data-source-property-presentation";
import {
  DATABASE_DUE_DATE_FUTURE_ICON_COLOR,
  DATABASE_DUE_DATE_MUTED_ICON_COLOR,
  DATABASE_DUE_DATE_NOW_ICON_COLOR,
  databaseDueDateIconColor,
  databaseDueDateIconState,
} from "./due-date-value-icon";
import {
  databasePropertyListInlineLabelLimit,
  databasePropertyOptionDotColor,
} from "./property-value-chip";
import {
  orderSemanticPropertyOptions,
  presentSemanticPropertyOptions,
} from "./semantic-property-editors";

describe("Data Source Property icons", () => {
  test("uses semantic icons for built-in identities", () => {
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("status"),
        valueType: "select",
      }),
    ).toBe(StatusIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("priority"),
        valueType: "select",
      }),
    ).toBe(PriorityIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("estimate"),
        valueType: "select",
      }),
    ).toBe(EstimateIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("tags"),
        valueType: "multi_select",
      }),
    ).toBe(TagsIcon);
  });

  test("uses distinct Select and Multi-select icons for user-defined Properties", () => {
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("p_0123abcd"),
        valueType: "select",
      }),
    ).toBe(TagsIcon);
    expect(
      dataSourcePropertyIcon({
        propertyId: parseDataSourcePropertyId("p_abcdefgh"),
        valueType: "multi_select",
      }),
    ).toBe(MultiSelectIcon);
  });
});

describe("Due date value icon", () => {
  test("distinguishes due-now and future calendar visuals by local date", () => {
    const today = new Date(2026, 7, 12, 12);
    expect(databaseDueDateIconColor("2026-08-11", today)).toBe(DATABASE_DUE_DATE_NOW_ICON_COLOR);
    expect(databaseDueDateIconColor("2026-08-12", today)).toBe(DATABASE_DUE_DATE_NOW_ICON_COLOR);
    expect(databaseDueDateIconColor("2026-08-13", today)).toBe(DATABASE_DUE_DATE_FUTURE_ICON_COLOR);
    expect(databaseDueDateIconColor("not-a-date", today)).toBe(DATABASE_DUE_DATE_MUTED_ICON_COLOR);
  });

  test("adds an overdue mark only before the current local date", () => {
    const today = new Date(2026, 7, 12, 12);
    expect(databaseDueDateIconState("2026-08-11", today)).toBe("overdue");
    expect(databaseDueDateIconState("2026-08-12", today)).toBe("calendar");
    expect(databaseDueDateIconState("2026-08-13", today)).toBe("calendar");
    expect(databaseDueDateIconState("not-a-date", today)).toBe("calendar");
  });
});

describe("Database Property chip presentation", () => {
  test("uses the List label limits at the reference viewport boundaries", () => {
    expect(databasePropertyListInlineLabelLimit(640)).toBe(2);
    expect(databasePropertyListInlineLabelLimit(641)).toBe(3);
    expect(databasePropertyListInlineLabelLimit(1_024)).toBe(3);
    expect(databasePropertyListInlineLabelLimit(1_025)).toBe(4);
    expect(databasePropertyListInlineLabelLimit(1_399)).toBe(4);
    expect(databasePropertyListInlineLabelLimit(1_400)).toBe(6);
  });

  test("preserves explicit CSS colors and maps named option colors", () => {
    expect(databasePropertyOptionDotColor("#BB87FC", "feature")).toBe("#BB87FC");
    expect(databasePropertyOptionDotColor("lch(66% 80 48)", "date")).toBe("lch(66% 80 48)");
    expect(databasePropertyOptionDotColor("purple", "feature")).toBe("#BB87FC");
    expect(databasePropertyOptionDotColor(undefined, "feature")).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("semantic Property option authority", () => {
  test("orders fixed semantic identities independently of renamed labels", () => {
    expect(
      orderSemanticPropertyOptions("status", [
        { id: "review", name: "QA" },
        { id: "triage", name: "Inbox" },
        { id: "done", name: "Done" },
        { id: "plan", name: "Ready" },
        { id: "doing", name: "Doing" },
      ]).map((option) => option.name),
    ).toEqual(["Inbox", "Ready", "Doing", "QA", "Done"]);
  });

  test("never restores a fixed option that ready registry authority deleted", () => {
    expect(
      presentSemanticPropertyOptions("status", [{ id: "doing", name: "Doing" }], "doing", "ready"),
    ).toEqual([{ id: "doing", name: "Doing" }]);
  });

  test("uses a non-authoritative fallback only to present the selected value while loading", () => {
    expect(presentSemanticPropertyOptions("status", [], "review", "loading")).toEqual([
      { id: "review", name: "In Review" },
    ]);
  });

  test("fails closed on retired or unknown Priority registry options", () => {
    expect(
      presentSemanticPropertyOptions(
        "priority",
        [
          { id: "p4-later", name: "P4 - Later" },
          { id: "custom", name: "Custom" },
          { id: "p3-low", name: "Low" },
        ],
        "p4-later",
        "loading",
      ),
    ).toEqual([{ id: "p3-low", name: "Low" }]);
  });
});
