import { describe, expect, test } from "vite-plus/test";
import { NODEX_AGENT_V5_TOOL_CONTRACTS } from "./v5-contracts";
import {
  NODEX_APP_TOOLSET_REVISION,
  NODEX_APP_V5_TOOLS,
  NODEX_APP_V5_TOOLSET_REVISION,
} from "./identity";

describe("nodex_app@5 contracts", () => {
  test("publishes the complete compact-identity catalog", () => {
    expect(NODEX_APP_V5_TOOLSET_REVISION).toBe(5);
    expect(Object.keys(NODEX_AGENT_V5_TOOL_CONTRACTS)).toEqual(NODEX_APP_V5_TOOLS);
    expect(NODEX_APP_TOOLSET_REVISION).toBe(6);
  });

  test("accepts compact and reserved Property identities at write boundaries", () => {
    const schema = NODEX_AGENT_V5_TOOL_CONTRACTS.create_pages.inputSchema;
    expect(
      schema.safeParse({
        destination: { kind: "data_source", dataSourceId: "source-1" },
        pages: [
          {
            title: "Ship compact identities",
            values: [
              { propertyId: "status", value: "done" },
              { propertyId: "p_AAAAAAAA", value: "value" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        destination: { kind: "data_source", dataSourceId: "source-1" },
        pages: [
          {
            title: "Reject legacy identity",
            values: [
              {
                propertyId: "database:project:primary:property:status",
                value: "done",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("validates nested query coordinates and returned option identities", () => {
    const queryInput = NODEX_AGENT_V5_TOOL_CONTRACTS.query_data_source.inputSchema;
    expect(
      queryInput.safeParse({
        dataSourceId: "source-1",
        filter: {
          kind: "group",
          operator: "and",
          children: [
            {
              kind: "clause",
              propertyId: "p_AAAAAAAA",
              operator: "equals",
              value: "x",
            },
          ],
        },
        sort: [
          {
            field: { kind: "property", propertyId: "priority" },
            direction: "asc",
            nulls: "last",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      queryInput.safeParse({
        dataSourceId: "source-1",
        filter: {
          kind: "clause",
          propertyId: "database:legacy:property:priority",
          operator: "equals",
          value: "p1-high",
        },
      }).success,
    ).toBe(false);
    expect(
      queryInput.safeParse({
        dataSourceId: "source-1",
        sort: Array.from({ length: 5 }, () => ({
          field: { kind: "title" },
          direction: "asc",
          nulls: "last",
        })),
      }).success,
    ).toBe(false);
    expect(
      queryInput.safeParse({
        dataSourceId: "source-1",
        select: {
          propertyIds: Array.from(
            { length: 201 },
            (_, index) => `p_${index.toString().padStart(8, "0")}`,
          ),
        },
      }).success,
    ).toBe(false);

    const queryOutput = NODEX_AGENT_V5_TOOL_CONTRACTS.query_data_source.outputSchema;
    const output = {
      data: {
        database: { databaseId: "database-1", name: "Tasks" },
        dataSource: {
          dataSourceId: "source-1",
          name: "Tasks",
          properties: [
            {
              propertyId: "tags",
              name: "Tags",
              valueType: "multi_select",
              config: {
                options: [{ id: "o_AAAAAAAA", name: "Release" }],
              },
            },
          ],
        },
        rows: [
          {
            pageId: "page-1",
            title: "Ship",
            values: { tags: ["o_AAAAAAAA"] },
          },
        ],
      },
    };
    expect(queryOutput.safeParse(output).success).toBe(true);
    expect(
      queryOutput.safeParse({
        ...output,
        data: {
          ...output.data,
          rows: [
            {
              ...output.data.rows[0],
              values: { tags: ["release"] },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
