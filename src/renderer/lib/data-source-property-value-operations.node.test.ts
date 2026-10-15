import { describe, expect, test } from "vite-plus/test";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type {
  DataSourcePageValueV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourcePropertyValueOperations,
  buildDataSourceRelationPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "./data-source-property-value-operations";

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
        current: value(definition, "build", 4),
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
