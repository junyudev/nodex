import { describe, expect, test } from "vite-plus/test";
import type {
  DatabaseJsonValue,
  DatabasePropertyValueType,
} from "../../../../shared/database-kernel";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import {
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import {
  databaseBoardValueIsVisible,
  formatDatabaseBoardMetadataTimestamp,
  projectDatabaseBoardCardFooter,
  projectDatabaseBoardGroup,
} from "./database-board-model";

const timestamp = "2026-08-17T00:00:00.000Z";
const dataSourceId = parseDataSourceId("source-board");

const property = (
  propertyId: string,
  valueType: DatabasePropertyValueType,
  name = propertyId,
): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId,
  name,
  ...testPropertySemantics(valueType, 1),
  valueType,
  config: valueType === "select" || valueType === "multi_select" ? { options: [] } : {},
  rankKey: propertyId,
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const authority = (values: Readonly<Record<string, DatabaseJsonValue>>): DataSourcePageRowV2 => ({
  pageKey: "TASK-1",
  membership: {
    membershipId: "membership-1",
    dataSourceId,
    revision: 1,
    createdAt: timestamp,
  },
  page: {
    pageId: "page-1",
    libraryId: "library-1",
    parent: { kind: "data_source", dataSourceId },
    lifecycle: "active",
    parentRevision: 1,
    metadataRevision: 1,
    documentId: "document-1",
    documentGeneration: 1,
    documentHeadSeq: 1,
    title: "Page",
    richTitle: [],
    preview: "",
    plainText: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  values: Object.fromEntries(
    Object.entries(values).map(([propertyId, value]) => [
      propertyId,
      {
        propertyId: parseDataSourcePropertyId(propertyId),
        valueType:
          typeof value === "boolean"
            ? "checkbox"
            : typeof value === "number"
              ? "number"
              : Array.isArray(value)
                ? "multi_select"
                : "text",
        value,
        revision: 1,
      },
    ]),
  ),
  taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
  position: { rankKey: "a", revision: 1 },
  effectiveGroupKey: null,
  effectiveSubgroupKey: null,
});

describe("database Board presentation model", () => {
  test("projects workflow, option, scalar, checkbox, and unassigned markers", () => {
    const status = projectDatabaseBoardGroup({
      property: property("status", "select", "Status"),
      groupKey: "doing",
      label: "Doing",
      pathKey: "status/doing",
      options: [],
    });
    expect(status.marker).toEqual({ kind: "status", statusId: "doing" });
    expect(status.surfaceColor).toBe("var(--column-doing-header-bg)");
    expect(status.activeSurfaceColor).toBe("var(--column-doing-drop-bg)");

    expect(
      projectDatabaseBoardGroup({
        property: property("priority", "select", "Priority"),
        groupKey: "p1-high",
        label: "P1 - High",
        pathKey: "priority/p1-high",
        options: [{ id: "p1-high", name: "P1 - High", color: "red" }],
      }).marker,
    ).toEqual({ kind: "priority", priorityId: "p1-high" });

    const option = projectDatabaseBoardGroup({
      property: property("p_TEAM0001", "select", "Team"),
      groupKey: "o_platform",
      label: "Platform",
      pathKey: "team/o_platform",
      options: [{ id: "o_platform", name: "Platform", color: "blue" }],
    });
    expect(option.marker).toEqual({
      kind: "option",
      optionId: "o_platform",
      color: "#56ABFD",
    });
    expect(option.surfaceColor).toBe("color-mix(in srgb, #56ABFD 4%, var(--background))");
    expect(option.activeSurfaceColor).toBe("color-mix(in srgb, #56ABFD 8%, var(--background))");

    expect(
      projectDatabaseBoardGroup({
        property: property("p_CHECK001", "checkbox", "Approved"),
        groupKey: "true",
        label: "Checked",
        pathKey: "approved/true",
        options: [],
      }).marker,
    ).toEqual({
      kind: "property",
      propertyId: "p_CHECK001",
      valueType: "checkbox",
    });

    expect(
      projectDatabaseBoardGroup({
        property: property("p_DATE0001", "date", "Due"),
        groupKey: null,
        label: "No Due",
        pathKey: "due/unassigned",
        options: [],
      }).marker,
    ).toEqual({
      kind: "unassigned",
      propertyId: "p_DATE0001",
      valueType: "date",
    });
  });

  test("resolves multi-select grouping colors only through the option registry", () => {
    expect(
      projectDatabaseBoardGroup({
        property: property("p_TEAM0001", "multi_select", "Team"),
        groupKey: '["o_platform"]',
        label: "Platform",
        pathKey: "team/platform",
        options: [{ id: "o_platform", name: "Platform", color: "blue" }],
      }).marker,
    ).toEqual({
      kind: "option",
      optionId: "o_platform",
      color: "#56ABFD",
    });
  });

  test("does not infer unknown option labels or colors outside the registry", () => {
    const projected = projectDatabaseBoardGroup({
      property: property("p_TEAM0001", "multi_select", "Team"),
      groupKey: '["missing"]',
      label: "Unknown option",
      pathKey: "team/missing",
      options: [],
    });
    expect(projected.label).toBe("Unknown option");
    expect(projected.marker).toEqual({
      kind: "property",
      propertyId: "p_TEAM0001",
      valueType: "multi_select",
    });
  });

  test("projects properties and intrinsic metadata in configured order", () => {
    const status = property("status", "select", "Status");
    const priority = property("priority", "select", "Priority");
    const tags = property("tags", "multi_select", "Tags");
    const estimate = property("estimate", "number", "Estimate");
    const notes = property("p_NOTES001", "text", "Notes");
    const slots = projectDatabaseBoardCardFooter({
      authority: authority({
        status: "doing",
        priority: "p1-high",
        tags: [],
        estimate: null,
        p_NOTES001: "Keep me",
      }),
      displayedFields: [
        { kind: "property", propertyId: priority.propertyId },
        { kind: "intrinsic", field: "created_at" },
        { kind: "property", propertyId: tags.propertyId },
        { kind: "property", propertyId: status.propertyId },
        { kind: "property", propertyId: estimate.propertyId },
        { kind: "property", propertyId: notes.propertyId },
        { kind: "intrinsic", field: "updated_at" },
        { kind: "intrinsic", field: "page_key" },
      ],
      properties: [priority, tags, status, estimate, notes],
      groupPropertyId: "priority",
      subgroupPropertyId: "status",
    });
    expect(slots).toEqual([
      { kind: "metadata", field: "created_at", value: timestamp },
      {
        kind: "property",
        property: notes,
        value: "Keep me",
        revision: 1,
      },
      { kind: "metadata", field: "updated_at", value: timestamp },
    ]);
  });

  test("formats recent and older Board timestamps like quiet activity metadata", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    expect(
      formatDatabaseBoardMetadataTimestamp("created_at", "2026-08-12T10:00:00.000Z", now, "en-US"),
    ).toBe("Created Aug 12");
    expect(
      formatDatabaseBoardMetadataTimestamp("updated_at", "2026-02-10T10:00:00.000Z", now, "en-US"),
    ).toBe("Updated Feb 2026");
  });

  test("treats false and zero as meaningful compact values", () => {
    expect(databaseBoardValueIsVisible(false)).toBe(true);
    expect(databaseBoardValueIsVisible(0)).toBe(true);
    expect(databaseBoardValueIsVisible(" ")).toBe(false);
    expect(databaseBoardValueIsVisible([])).toBe(false);
  });
});
