import { describe, expect, test } from "vite-plus/test";

import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { collectRequiredPropertyOptionIds } from "./database-option-registry-requirements";

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
