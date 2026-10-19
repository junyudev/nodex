import { describe, expect, test } from "vite-plus/test";
import { parseDataSourcePropertyId } from "../../shared/database-identities";
import type { PageDetail } from "../../shared/page-detail";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { buildPageDetailFixtureResult } from "@/test/page-detail-fixture";
import { buildPageStageFixturePage } from "@/test/page-stage-fixture";
import { projectPageDetailToStageModel } from "./page-stage-page";
import {
  hasPageStageScheduleCapability,
  readPageDetailWorkflowStatus,
} from "./page-stage-properties";
import { pageStagePropertyRows } from "./page-stage-property-layout";

const detail = (): PageDetail => {
  const result = buildPageDetailFixtureResult("project-1", buildPageStageFixturePage());
  if (!result.ok) throw new Error("Expected Page Detail fixture");
  return result.value;
};

const withoutProperty = (source: PageDetail, propertyId: string): PageDetail => {
  if (source.dataSourceContext.kind !== "member") return source;
  const { [propertyId]: _removed, ...values } = source.dataSourceContext.values;
  void _removed;
  return {
    ...source,
    dataSourceContext: {
      ...source.dataSourceContext,
      properties: source.dataSourceContext.properties.filter(
        (property) => property.propertyId !== propertyId,
      ),
      values,
    },
  };
};

describe("Page Stage properties", () => {
  test("reads workflow Status for compact Page presentation", () => {
    expect(readPageDetailWorkflowStatus(detail())).toBe("build");
    expect(
      readPageDetailWorkflowStatus({
        ...detail(),
        dataSourceContext: { kind: "standalone" },
      }),
    ).toBeNull();
    expect(readPageDetailWorkflowStatus(null)).toBeNull();
  });

  test.each(["assignee", "due_date", "priority", "tags"])(
    "keeps the remaining Property rows when %s is removed",
    (removedPropertyId) => {
      const source = detail();
      const originalPropertyCount =
        source.dataSourceContext.kind === "member" ? source.dataSourceContext.properties.length : 0;
      const model = projectPageDetailToStageModel(withoutProperty(source, removedPropertyId));
      expect(model.databaseContext.kind).toBe("member");
      if (model.databaseContext.kind !== "member") return;
      expect(model.databaseContext.properties).toHaveLength(originalPropertyCount - 1);
      expect(
        model.databaseContext.properties.some(
          (item) => item.property.propertyId === removedPropertyId,
        ),
      ).toBe(false);
      expect(model.databaseContext.semanticProperties.status?.value).toBe("build");
    },
  );

  test("projects custom typed properties in schema order", () => {
    const source = detail();
    if (source.dataSourceContext.kind !== "member") return;
    const customId = parseDataSourcePropertyId("p_0123abcd");
    const model = projectPageDetailToStageModel({
      ...source,
      dataSourceContext: {
        ...source.dataSourceContext,
        properties: [
          ...source.dataSourceContext.properties,
          {
            propertyId: customId,
            dataSourceId: source.dataSourceContext.dataSource.dataSourceId,
            name: "Risk score",
            ...testPropertySemantics("number"),
            valueType: "number",
            config: {},
            rankKey: "zz",
            lifecycle: "active",
            revision: 1,
            createdAt: source.page.createdAt,
            updatedAt: source.page.updatedAt,
          },
        ],
        values: {
          ...source.dataSourceContext.values,
          [customId]: {
            propertyId: customId,
            valueType: "number",
            value: 8,
            revision: 2,
          },
        },
      },
    });
    if (model.databaseContext.kind !== "member") return;
    expect(model.databaseContext.properties.at(-1)).toMatchObject({
      property: { propertyId: customId, name: "Risk score" },
      value: 8,
      valueRevision: 2,
      error: null,
    });
  });

  test("presents a valid schedule pair as one Schedule row", () => {
    const model = projectPageDetailToStageModel(detail());
    if (model.databaseContext.kind !== "member") throw new Error("Expected a Database Page");
    const rowKeys = pageStagePropertyRows(
      model.databaseContext.properties,
      model.databaseContext.semanticProperties,
    ).map((row) => row.key);
    expect(rowKeys.filter((key) => key === "schedule")).toHaveLength(1);
    expect(rowKeys).not.toContain("scheduled_start");
    expect(rowKeys).not.toContain("scheduled_end");
  });

  test("degrades a partial schedule pair to ordinary independent rows", () => {
    const model = projectPageDetailToStageModel(withoutProperty(detail(), "scheduled_end"));
    if (model.databaseContext.kind !== "member") return;
    expect(hasPageStageScheduleCapability(model.databaseContext.semanticProperties)).toBe(false);
    const rowKeys = pageStagePropertyRows(
      model.databaseContext.properties,
      model.databaseContext.semanticProperties,
    ).map((row) => row.key);
    expect(rowKeys).toContain("scheduled_start");
    expect(rowKeys).not.toContain("schedule");
  });

  test("degrades a corrupt schedule pair so the local error remains visible", () => {
    const source = detail();
    if (source.dataSourceContext.kind !== "member") return;
    const model = projectPageDetailToStageModel({
      ...source,
      dataSourceContext: {
        ...source.dataSourceContext,
        values: {
          ...source.dataSourceContext.values,
          scheduled_start: {
            propertyId: parseDataSourcePropertyId("scheduled_start"),
            valueType: "datetime",
            value: "not-a-datetime",
            revision: 9,
          },
        },
      },
    });
    if (model.databaseContext.kind !== "member") return;
    expect(hasPageStageScheduleCapability(model.databaseContext.semanticProperties)).toBe(false);
    expect(
      pageStagePropertyRows(
        model.databaseContext.properties,
        model.databaseContext.semanticProperties,
      ).map((row) => row.key),
    ).toEqual(expect.arrayContaining(["scheduled_start", "scheduled_end"]));
  });

  test("isolates a corrupt value to its Property item", () => {
    const source = detail();
    if (source.dataSourceContext.kind !== "member") return;
    const model = projectPageDetailToStageModel({
      ...source,
      dataSourceContext: {
        ...source.dataSourceContext,
        values: {
          ...source.dataSourceContext.values,
          due_date: {
            propertyId: parseDataSourcePropertyId("due_date"),
            valueType: "date",
            value: "2026-02-30",
            revision: 4,
          },
        },
      },
    });
    if (model.databaseContext.kind !== "member") return;
    expect(
      model.databaseContext.properties.find((item) => item.property.propertyId === "due_date")
        ?.error,
    ).toBe("Expected an ISO date");
    expect(model.databaseContext.semanticProperties.dueDate?.value).toBeNull();
    expect(model.databaseContext.semanticProperties.status?.value).toBe("build");
  });

  test("does not grant built-in semantics to a wrong-type reserved Property", () => {
    const source = detail();
    if (source.dataSourceContext.kind !== "member") return;
    const model = projectPageDetailToStageModel({
      ...source,
      dataSourceContext: {
        ...source.dataSourceContext,
        properties: source.dataSourceContext.properties.map((property) =>
          property.propertyId === "due_date"
            ? {
                ...property,
                ...testPropertySemantics("text"),
                valueType: "text" as const,
              }
            : property,
        ),
        values: {
          ...source.dataSourceContext.values,
          due_date: {
            propertyId: parseDataSourcePropertyId("due_date"),
            valueType: "text",
            value: "2026-02-30",
            revision: 4,
          },
        },
      },
    });
    if (model.databaseContext.kind !== "member") return;
    expect(model.databaseContext.semanticProperties.dueDate).toBeNull();
  });
});
