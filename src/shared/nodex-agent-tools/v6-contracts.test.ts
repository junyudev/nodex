import { describe, expect, test } from "vite-plus/test";
import { NODEX_AGENT_V5_TOOL_CONTRACTS } from "./v5-contracts";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "./v6-contracts";
import {
  NODEX_APP_TOOLSET_REVISION,
  NODEX_APP_V6_TOOLS,
  NODEX_APP_V6_TOOLSET_REVISION,
} from "./identity";

const location = { kind: "library", libraryId: "library-1" } as const;

describe("nodex_app@6 contracts", () => {
  test("publishes the Page-key catalog without changing mutation inputs", () => {
    expect(NODEX_APP_V6_TOOLSET_REVISION).toBe(6);
    expect(NODEX_APP_TOOLSET_REVISION).toBe(6);
    expect(Object.keys(NODEX_AGENT_V6_TOOL_CONTRACTS)).toEqual(NODEX_APP_V6_TOOLS);

    expect(
      NODEX_AGENT_V6_TOOL_CONTRACTS.move_pages.inputSchema.safeParse({
        pageKeys: ["LAB-13"],
        destination: { kind: "library" },
      }).success,
    ).toBe(false);
    expect(
      NODEX_AGENT_V6_TOOL_CONTRACTS.duplicate_page.inputSchema.safeParse({
        pageKey: "LAB-13",
        destination: { kind: "library" },
      }).success,
    ).toBe(false);
  });

  test("keeps v5 output parsing frozen while v6 requires Page-key projections", () => {
    const legacySearchOutput = {
      data: {
        results: [
          {
            kind: "page",
            id: "page-1",
            title: "Release plan",
            location,
            matches: [{ source: "title", quality: "exact", excerpt: "Release plan" }],
          },
        ],
      },
    };
    const v6SearchOutput = {
      data: {
        results: [
          {
            ...legacySearchOutput.data.results[0],
            pageKey: "LAB-13",
            matches: [
              {
                source: "page_key",
                quality: "exact",
                pageKey: "OLD-7",
                isCurrent: false,
              },
            ],
          },
        ],
      },
    };

    expect(
      NODEX_AGENT_V5_TOOL_CONTRACTS.search.outputSchema.safeParse(legacySearchOutput).success,
    ).toBe(true);
    expect(
      NODEX_AGENT_V5_TOOL_CONTRACTS.search.outputSchema.safeParse(v6SearchOutput).success,
    ).toBe(false);
    expect(
      NODEX_AGENT_V6_TOOL_CONTRACTS.search.outputSchema.safeParse(legacySearchOutput).success,
    ).toBe(false);
    expect(
      NODEX_AGENT_V6_TOOL_CONTRACTS.search.outputSchema.safeParse(v6SearchOutput).success,
    ).toBe(true);
  });

  test("requires nullable Page keys on every affected read and receipt", () => {
    const outputs = [
      {
        contract: NODEX_AGENT_V6_TOOL_CONTRACTS.fetch,
        valid: {
          data: {
            resource: {
              id: "page-1",
              pageKey: "LAB-13",
              type: "page",
              lifecycle: "active",
              location,
            },
          },
        },
        missing: {
          data: {
            resource: {
              id: "page-1",
              type: "page",
              lifecycle: "active",
              location,
            },
          },
        },
      },
      {
        contract: NODEX_AGENT_V6_TOOL_CONTRACTS.query_data_source,
        valid: {
          data: {
            database: { databaseId: "database-1", name: "Tasks" },
            dataSource: { dataSourceId: "source-1", name: "Tasks", properties: [] },
            rows: [{ pageId: "page-1", pageKey: null, title: "Ship", values: {} }],
          },
        },
        missing: {
          data: {
            database: { databaseId: "database-1", name: "Tasks" },
            dataSource: { dataSourceId: "source-1", name: "Tasks", properties: [] },
            rows: [{ pageId: "page-1", title: "Ship", values: {} }],
          },
        },
      },
      {
        contract: NODEX_AGENT_V6_TOOL_CONTRACTS.create_pages,
        valid: {
          data: {
            pages: [
              {
                pageId: "page-1",
                pageKey: "LAB-13",
                location,
                bodyBlocksCreated: 0,
                status: { optionId: "triage", label: "New" },
              },
            ],
            created: 1,
          },
        },
        missing: {
          data: {
            pages: [{ pageId: "page-1", location, bodyBlocksCreated: 0 }],
            created: 1,
          },
        },
      },
      {
        contract: NODEX_AGENT_V6_TOOL_CONTRACTS.move_pages,
        valid: {
          data: {
            pages: [
              {
                pageId: "page-1",
                pageKey: null,
                location,
                status: { optionId: "plan", label: "Scheduled" },
              },
            ],
            moved: 1,
          },
        },
        missing: {
          data: {
            pages: [{ pageId: "page-1", location }],
            moved: 1,
          },
        },
      },
      {
        contract: NODEX_AGENT_V6_TOOL_CONTRACTS.duplicate_page,
        valid: {
          data: {
            sourcePageId: "page-1",
            pageId: "page-2",
            pageKey: "LAB-14",
            location,
            bodyBlocksCreated: 0,
            status: { optionId: "plan", label: "Scheduled" },
          },
        },
        missing: {
          data: {
            sourcePageId: "page-1",
            pageId: "page-2",
            location,
            bodyBlocksCreated: 0,
          },
        },
      },
    ];

    for (const { contract, valid, missing } of outputs) {
      expect(contract.outputSchema.safeParse(valid).success).toBe(true);
      expect(contract.outputSchema.safeParse(missing).success).toBe(false);
    }
  });
});
