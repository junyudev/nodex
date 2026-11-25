import { describe, expect, test } from "vite-plus/test";
import {
  dataSourceCalendarDateKey,
  datetimeDraftFromIso,
  formatLocalDateAsIso,
  isCanonicalDataSourceDateTime,
  localDateTimeToIso,
  parseIsoDateToLocalDate,
} from "./data-source-property-date";
import {
  DATA_SOURCE_PROPERTY_OPTION_PALETTE,
  canCreateDataSourcePropertyOption,
  defaultDataSourcePropertyOptionColor,
  filterDataSourcePropertyOptions,
  presentSelectedDataSourcePropertyOptions,
  propertyOptionColorClassName,
} from "./data-source-property-options";
import { resolveDataSourcePropertyPresentationRole } from "./data-source-property-presentation-role";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type {
  DataSourcePageValueV2,
  DataSourcePropertyRecordV2,
  DataSourcePageRowV2,
} from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourcePropertyValueOperations,
  buildDataSourceRelationPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "./data-source-property-value-operations";
import {
  buildDataSourceRelationCandidateRead,
  searchRelationTitles,
} from "./data-source-relation-runtime";
import { readRelationValuePreview } from "./data-source-relation-value";
import { collectRequiredPropertyOptionIds } from "./database-option-registry-requirements";
import { formatDatabaseDate, formatDatabaseNumber } from "./database-property-display-format";

describe("Data Source Property dates", () => {
  test("round-trips calendar dates through local components without UTC drift", () => {
    const parsed = parseIsoDateToLocalDate("2026-08-04");
    expect(parsed).not.toBeNull();
    expect(formatLocalDateAsIso(parsed!)).toBe("2026-08-04");
  });

  test("rejects normalized-looking but impossible dates", () => {
    expect(parseIsoDateToLocalDate("2026-02-29")).toBeNull();
    expect(parseIsoDateToLocalDate("2026-2-04")).toBeNull();
  });

  test("preserves four-digit years below 100", () => {
    expect(formatLocalDateAsIso(parseIsoDateToLocalDate("0099-08-04")!)).toBe("0099-08-04");
  });

  test("round-trips a local datetime through canonical ISO", () => {
    const iso = localDateTimeToIso("2026-08-04", "13:45");
    expect(iso).not.toBeNull();
    expect(datetimeDraftFromIso(iso!)).toEqual({ date: "2026-08-04", time: "13:45" });
  });

  test("rejects invalid time and DST-normalized local values", () => {
    expect(localDateTimeToIso("2026-08-04", "24:00")).toBeNull();
    expect(localDateTimeToIso("invalid", "09:00")).toBeNull();
    expect(datetimeDraftFromIso("2026-08-04")).toBeNull();
  });

  test("accepts every canonical UTC precision supported by Core", () => {
    for (const value of [
      "2026-08-04T13:45:00Z",
      "2026-08-04T13:45:00.1Z",
      "2026-08-04T13:45:00.123456789Z",
    ]) {
      expect(isCanonicalDataSourceDateTime(value)).toBe(true);
      expect(datetimeDraftFromIso(value)).not.toBeNull();
    }
    for (const value of [
      "2026-08-04",
      "2026-08-04T13:45:00+00:00",
      "2026-02-29T13:45:00Z",
      "2026-08-04T24:00:00Z",
      "2026-08-04T13:45:00.1234567890Z",
    ]) {
      expect(isCanonicalDataSourceDateTime(value)).toBe(false);
      expect(datetimeDraftFromIso(value)).toBeNull();
    }
  });

  test("groups datetimes by the same local date shown in the editor", () => {
    const value = localDateTimeToIso("2026-08-04", "00:30");
    expect(value).not.toBeNull();
    expect(dataSourceCalendarDateKey(value, "datetime")).toBe("2026-08-04");
    expect(dataSourceCalendarDateKey("2026-08-04", "date")).toBe("2026-08-04");
    expect(dataSourceCalendarDateKey("2026-02-29", "date")).toBeNull();
  });
});

describe("data source property options", () => {
  const options = [
    { id: "one", name: "Needs Review", color: "orange" },
    { id: "two", name: "Ready", color: "green" },
  ] as const;

  describe("Data Source Property option presentation", () => {
    test("filters normalized option names without changing registry order", () => {
      expect(filterDataSourcePropertyOptions(options, " REVIEW ")).toEqual([options[0]]);
    });

    test("offers creation only for a non-empty unique name", () => {
      expect(canCreateDataSourcePropertyOption(options, "Review")).toBe(true);
      expect(canCreateDataSourcePropertyOption(options, " needs review ")).toBe(false);
      expect(canCreateDataSourcePropertyOption(options, " ")).toBe(false);
    });

    test("keeps missing selected identities visible as local warnings", () => {
      expect(presentSelectedDataSourcePropertyOptions(options, ["two", "gone"])).toEqual([
        { ...options[1], missing: false },
        { id: "gone", name: "Unknown option", missing: true },
      ]);
    });

    test("maps only known colors and falls back to neutral tokens", () => {
      expect(propertyOptionColorClassName("green")).toContain("--green-bg");
      expect(propertyOptionColorClassName("arbitrary-tailwind")).toBe(
        propertyOptionColorClassName(),
      );
    });

    test("chooses a stable allowlisted color for atomic option creation", () => {
      const color = defaultDataSourcePropertyOptionColor("o_AAAAAAAA");
      expect(defaultDataSourcePropertyOptionColor("o_AAAAAAAA")).toBe(color);
      expect(DATA_SOURCE_PROPERTY_OPTION_PALETTE).toContain(color);
    });
  });
});

describe("Data Source Property presentation role", () => {
  test("preserves semantic roles across display-name changes by using identity", () => {
    expect(
      resolveDataSourcePropertyPresentationRole({
        propertyId: "status",
        valueType: "select",
      }),
    ).toEqual({ kind: "status" });
  });

  test("keeps a custom select named Status on the typed fallback", () => {
    expect(
      resolveDataSourcePropertyPresentationRole({
        propertyId: "p_0123abcd",
        valueType: "select",
      }),
    ).toEqual({ kind: "typed", valueType: "select" });
  });

  test("keeps a type-corrupt reserved identity on the honest typed fallback", () => {
    expect(
      resolveDataSourcePropertyPresentationRole({
        propertyId: "due_date",
        valueType: "datetime",
      }),
    ).toEqual({ kind: "typed", valueType: "datetime" });
  });

  test("groups both schedule endpoints under one presentation role", () => {
    expect(
      resolveDataSourcePropertyPresentationRole({
        propertyId: "scheduled_end",
        valueType: "datetime",
      }),
    ).toEqual({ kind: "schedule_boundary" });
  });
});

describe("data source property value operations", () => {
  const dataSourceId = parseDataSourceId("source-1");
  const timestamp = "2026-08-04T00:00:00.000Z";
  const property = (
    propertyId: string,
    valueType: DataSourcePropertyRecordV2["valueType"],
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId,
    name: propertyId,
    ...testPropertySemantics(valueType),
    valueType,
    config: {},
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const value = (
    definition: DataSourcePropertyRecordV2,
    current: DataSourcePageValueV2["value"],
    revision = 1,
  ): DataSourcePageValueV2 => ({
    propertyId: definition.propertyId,
    valueType: definition.valueType,
    value: current,
    revision,
  });

  describe("Data Source Property value operations", () => {
    test("compiles a scalar replacement with value-level CAS", () => {
      const definition = property("p_0123abcd", "number");
      expect(
        buildDataSourcePropertyValueOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          current: value(definition, 3, 7),
          value: 5,
        }),
      ).toEqual([
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId: "page-1",
              dataSourceId,
              propertyId: definition.propertyId,
              edit: {
                kind: "replace",
                expectedValueRevision: 7,
                value: { kind: "number", value: 5 },
              },
            },
          ],
        },
      ]);
    });

    test("preserves set intent for multi-select values", () => {
      const definition = property("p_0123abcd", "multi_select");
      expect(
        buildDataSourcePropertyValueOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          current: value(definition, ["o_AAAAAAAA", "o_BBBBBBBB"]),
          value: ["o_BBBBBBBB", "o_CCCCCCCC"],
        }),
      ).toMatchObject([
        {
          kind: "edit_property_values",
          edits: [
            {
              edit: {
                kind: "patch_set",
                delta: {
                  kind: "multi_select",
                  addOptionIds: ["o_CCCCCCCC"],
                  removeOptionIds: ["o_AAAAAAAA"],
                },
              },
            },
          ],
        },
      ]);
    });

    test("compiles an explicit multi-select delta without removing unseen options", () => {
      const definition = property("p_0123abcd", "multi_select");
      expect(
        buildDataSourceMultiSelectPatchOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          addOptionIds: ["o_CCCCCCCC"],
          removeOptionIds: [],
        }),
      ).toMatchObject([
        {
          kind: "edit_property_values",
          edits: [
            {
              edit: {
                kind: "patch_set",
                delta: {
                  kind: "multi_select",
                  addOptionIds: ["o_CCCCCCCC"],
                  removeOptionIds: [],
                },
              },
            },
          ],
        },
      ]);
    });

    test("compiles Relation add/remove intent independently", () => {
      const definition = property("p_0123abcd", "relation");
      expect(
        buildDataSourceRelationPatchOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          addPageIds: ["page-2"],
          removeEdgeIds: ["a".repeat(64)],
        }),
      ).toMatchObject([
        {
          kind: "edit_property_values",
          edits: [
            {
              edit: {
                kind: "patch_set",
                delta: {
                  kind: "relation",
                  addPageIds: ["page-2"],
                  removeEdgeIds: ["a".repeat(64)],
                },
              },
            },
          ],
        },
      ]);
    });

    test("selects exactly one cardinality-one Relation target", () => {
      const base = property("p_0123abcd", "relation");
      const definition: DataSourcePropertyRecordV2 = {
        ...base,
        schema: { ...base.schema, cardinality: "one" },
      } as DataSourcePropertyRecordV2;
      expect(
        buildDataSourceRelationReplacementOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          expectedValueRevision: 4,
          targetPageId: "page-2",
        }),
      ).toMatchObject([
        {
          kind: "edit_property_values",
          edits: [
            {
              edit: {
                kind: "replace_one_relation",
                expectedValueRevision: 4,
                targetPageId: "page-2",
              },
            },
          ],
        },
      ]);
      expect(() =>
        buildDataSourceRelationPatchOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          addPageIds: ["page-3"],
          removeEdgeIds: [],
        }),
      ).toThrow(/incompatible/u);
      expect(() =>
        buildDataSourceRelationReplacementOperations({
          pageId: "page-1",
          dataSourceId,
          property: base,
          expectedValueRevision: 4,
          targetPageId: "page-2",
        }),
      ).toThrow(/incompatible/u);
    });

    test("clears every visible and unavailable Relation edge behind a revision fence", () => {
      const definition = property("p_0123abcd", "relation");
      expect(
        buildDataSourcePropertyValueOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          current: value(
            definition,
            {
              kind: "relation",
              value: {
                value_revision: 7,
                total_count: 4,
                targets: [],
                unavailable_count: 4,
                has_more: true,
              },
            },
            7,
          ),
          value: [],
        }),
      ).toEqual([
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId: "page-1",
              dataSourceId,
              propertyId: definition.propertyId,
              edit: { kind: "clear_many_relation", expectedValueRevision: 7 },
            },
          ],
        },
      ]);
    });

    test("creates an option and selects it in one ordered apply batch", () => {
      const definition = property("p_0123abcd", "multi_select");
      expect(
        buildDataSourceCreateOptionAndSelectOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          current: value(definition, [], 4),
          option: { id: "o_AAAAAAAA", name: "New option", color: "blue" },
        }),
      ).toMatchObject([
        {
          kind: "put_option",
          optionId: "o_AAAAAAAA",
          expectedPropertyRevision: 1,
        },
        {
          kind: "edit_property_values",
          edits: [
            {
              edit: {
                kind: "patch_set",
                delta: { addOptionIds: ["o_AAAAAAAA"], removeOptionIds: [] },
              },
            },
          ],
        },
      ]);
    });

    test("keeps fixed semantic registries out of inline option creation", () => {
      const definition = property("status", "select");
      expect(() =>
        buildDataSourceCreateOptionAndSelectOperations({
          pageId: "page-1",
          dataSourceId,
          property: definition,
          current: value(definition, "doing", 4),
          option: { id: "custom-status", name: "Custom" },
        }),
      ).toThrow(/incompatible/u);
    });

    test("canonicalizes decomposed Unicode before creating a Tags option", () => {
      const definition = property("tags", "multi_select");
      const operations = buildDataSourceCreateOptionAndSelectOperations({
        pageId: "page-1",
        dataSourceId,
        property: definition,
        current: value(definition, [], 4),
        option: { id: "o_AAAAAAAA", name: "Cafe\u0301" },
      });
      expect(operations[0]).toMatchObject({
        kind: "put_option",
        name: "Café",
      });
    });
  });
});

describe("data source relation runtime", () => {
  const property: DataSourcePropertyRecordV2 = {
    propertyId: parseDataSourcePropertyId("p_Relation"),
    dataSourceId: parseDataSourceId("source-current"),
    name: "Blocked by",
    ...testPropertySemantics("relation"),
    schema: {
      kind: "relation",
      targetDataSourceId: parseDataSourceId("source-target"),
      cardinality: "many",
    },
    valueType: "relation",
    config: {},
    optionCount: 0,
    rankKey: "a",
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };

  describe("Relation candidate runtime", () => {
    test.each(["", "   ", "\u3000"])(
      "encodes an empty editor query as an unfiltered first window: %j",
      (query) => {
        const read = buildDataSourceRelationCandidateRead({ property, query });
        expect(read).toMatchObject({
          target: { kind: "data_source", dataSourceId: "source-target" },
          mode: "relation_candidate_window",
          window: { after: null, first: 100 },
        });
        expect(read && "query" in read).toBe(false);
      },
    );

    test("trims a filtered continuation without changing its cursor", () => {
      expect(
        buildDataSourceRelationCandidateRead({
          property,
          query: "  Ｂlocked  ",
          after: "opaque-cursor",
        }),
      ).toMatchObject({
        query: "Ｂlocked",
        window: { after: "opaque-cursor", first: 100 },
      });
    });

    test("matches target titles with word boundaries, width folding, and typo fallback", () => {
      const candidates = [
        { title: "QueryMigartion" },
        { title: "QueryMigration" },
        { title: "数据库迁移方案" },
      ];
      expect(searchRelationTitles(candidates, "Ｍｉｇｒａｔｉｏｎ")).toEqual([candidates[1]]);
      expect(searchRelationTitles([candidates[1]], "migartion")).toEqual([candidates[1]]);
      expect(searchRelationTitles(candidates, "迁移")).toEqual([candidates[2]]);
    });
  });
});

describe("data source relation value", () => {
  const relationValue = {
    kind: "relation",
    value: {
      value_revision: 4,
      total_count: 2,
      targets: [
        {
          kind: "visible",
          edge_id: "a".repeat(64),
          page_id: "page-visible",
          title: "Visible task",
          lifecycle: "active",
          membership_state: "active_in_target_source",
        },
      ],
      unavailable_count: 1,
      has_more: true,
    },
  };

  describe("Relation value preview", () => {
    test("projects complete visible targets without inventing unavailable identities", () => {
      expect(readRelationValuePreview(relationValue)).toEqual({
        valueRevision: 4,
        totalCount: 2,
        targets: [
          {
            kind: "visible",
            edgeId: "a".repeat(64),
            pageId: "page-visible",
            title: "Visible task",
            lifecycle: "active",
            membershipState: "active_in_target_source",
          },
        ],
        unavailableCount: 1,
        hasMore: true,
      });
      expect(
        readRelationValuePreview({
          kind: "relation",
          value: { ...relationValue.value, targets: [{ kind: "unavailable", page_id: "leak" }] },
        }),
      ).toBeNull();
    });

    test("rejects the entire preview when any authority field or target is malformed", () => {
      expect(
        readRelationValuePreview({
          kind: "relation",
          value: { ...relationValue.value, targets: [{}] },
        }),
      ).toBeNull();
      expect(
        readRelationValuePreview({
          kind: "relation",
          value: { ...relationValue.value, value_revision: -1 },
        }),
      ).toBeNull();
      expect(
        readRelationValuePreview({
          kind: "relation",
          value: { ...relationValue.value, unavailable_count: 3 },
        }),
      ).toBeNull();
      expect(
        readRelationValuePreview({
          kind: "relation",
          value: { ...relationValue.value, has_more: false },
        }),
      ).toBeNull();
    });
  });
});

describe("database option registry requirements", () => {
  const property = (
    propertyId: string,
    valueType: "select" | "multi_select",
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId: parseDataSourceId("source:options"),
    name: propertyId,
    ...testPropertySemantics(valueType, 4),
    valueType,
    config: {},
    optionCount: 4,
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });

  describe("Database option registry requirements", () => {
    test("collects canonical row and Filter identities without loading static built-ins", () => {
      const rows = [
        {
          values: {
            tags: {
              propertyId: "tags",
              valueType: "multi_select",
              value: ["o_AAAAAAAA", "o_BBBBBBBB"],
              revision: 1,
            },
            p_choice00: {
              propertyId: "p_choice00",
              valueType: "select",
              value: "o_CCCCCCCC",
              revision: 1,
            },
            status: {
              propertyId: "status",
              valueType: "select",
              value: "doing",
              revision: 1,
            },
          },
        },
      ] as unknown as readonly DataSourcePageRowV2[];

      expect(
        collectRequiredPropertyOptionIds({
          properties: [
            property("status", "select"),
            property("tags", "multi_select"),
            property("p_choice00", "select"),
          ],
          rows,
          filter: {
            kind: "group",
            operator: "and",
            children: [
              {
                kind: "clause",
                propertyId: "tags",
                operator: "contains",
                value: "o_DDDDDDDD",
              },
              {
                kind: "clause",
                propertyId: "p_choice00",
                operator: "equals",
                value: "o_CCCCCCCC",
              },
            ],
          },
        }),
      ).toEqual({
        tags: ["o_AAAAAAAA", "o_BBBBBBBB", "o_DDDDDDDD"],
        p_choice00: ["o_CCCCCCCC"],
      });
    });

    test("honors a visible-property restriction", () => {
      expect(
        collectRequiredPropertyOptionIds({
          properties: [property("tags", "multi_select"), property("p_choice00", "select")],
          rows: [
            {
              values: {
                tags: {
                  propertyId: "tags",
                  valueType: "multi_select",
                  value: ["o_AAAAAAAA"],
                  revision: 1,
                },
                p_choice00: {
                  propertyId: "p_choice00",
                  valueType: "select",
                  value: "o_CCCCCCCC",
                  revision: 1,
                },
              },
            },
          ] as unknown as readonly DataSourcePageRowV2[],
          propertyIds: new Set(["tags"]),
        }),
      ).toEqual({ tags: ["o_AAAAAAAA"] });
    });
  });
});

describe("Database Property display formats", () => {
  test("formats finite number modes without changing stored values", () => {
    expect(formatDatabaseNumber(0.25, { kind: "percent" }, "en-US")).toBe("25%");
    expect(formatDatabaseNumber(12.5, { kind: "currency", currencyCode: "usd" }, "en-US")).toBe(
      "$12.50",
    );
    expect(formatDatabaseNumber(1_200.5, { kind: "plain" }, "en-US")).toBe("1,200.5");
  });

  test("formats date order, relative dates, and explicit 24-hour time", () => {
    const date = new Date(2026, 7, 29, 17, 5);
    expect(formatDatabaseDate({ date, dateFormat: "year_month_day", locale: "en-US" })).toBe(
      "2026-08-29",
    );
    expect(
      formatDatabaseDate({
        date,
        dateFormat: "relative",
        now: new Date(2026, 7, 28),
      }),
    ).toBe("Tomorrow");
    expect(
      formatDatabaseDate({
        date,
        dateFormat: "year_month_day",
        timeFormat: "twenty_four_hour",
        locale: "en-US",
      }),
    ).toContain("17:05");
  });
});
