import { describe, expect, test } from "vite-plus/test";
import { NODEX_AGENT_V3_CATALOG_BUDGETS } from "./budgets";
import {
  FetchV3OutputSchema,
  QueryDatabaseV3OutputSchema,
  FetchV3InputSchema,
  GetContextV3InputSchema,
  GetContextV3OutputSchema,
  QueryDatabaseViewV3InputSchema,
  QueryDataSourceV3InputSchema,
  SearchV3InputSchema,
} from "./v3-read-schemas";
import {
  AdvancedUpdatePageV3OutputSchema,
  CreatePagesV3OutputSchema,
  DuplicatePageV3OutputSchema,
  MovePagesV3OutputSchema,
  UpdatePageV3OutputSchema,
  AdvancedUpdatePageV3InputSchema,
  CreatePagesV3InputSchema,
  DuplicatePageV3InputSchema,
  MovePagesV3InputSchema,
  UpdatePageV3InputSchema,
} from "./v3-write-schemas";
import { z } from "zod";
import {
  NODEX_MARKDOWN_AGENT_GUIDE,
  NODEX_MARKDOWN_COMPACT_HINT,
} from "../nodex-markdown/agent-guide";
import { NODEX_AGENT_V3_TOOL_CONTRACTS } from "./v3-contracts";
import {
  NODEX_APP_V3_TOOLS,
  NODEX_APP_V3_TOOLSET_REVISION,
  NODEX_APP_TOOLSET_REVISION,
  NODEX_APP_V5_TOOLS,
  NODEX_APP_V5_TOOLSET_REVISION,
  NODEX_APP_V6_TOOLS,
  NODEX_APP_V6_TOOLSET_REVISION,
} from "./identity";
import { NODEX_AGENT_V5_TOOL_CONTRACTS } from "./v5-contracts";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "./v6-contracts";

describe("result budgets", () => {
  const ETAG = `nxe2.${"a".repeat(43)}`;

  function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  function etagCount(value: unknown): number {
    return JSON.stringify(value).match(/nxe2\.[A-Za-z0-9_-]{43}/gu)?.length ?? 0;
  }

  describe("Nodex Agent result budgets", () => {
    test("keeps v3 Database queries validator-free and below four KiB", () => {
      const output = QueryDatabaseV3OutputSchema.parse({
        data: {
          database: {
            databaseId: "database-1",
            name: "Tasks",
          },
          dataSource: {
            dataSourceId: "source-1",
            name: "Tasks",
            properties: [
              {
                propertyId: "status",
                name: "Status",
                valueType: "select",
                config: {},
              },
            ],
          },
          view: {
            viewId: "view-1",
            dataSourceId: "source-1",
            name: "Board",
            layout: "board",
          },
          rows: Array.from({ length: 13 }, (_, index) => ({
            pageId: `page-${index + 1}`,
            title: `Task ${index + 1}`,
            values: { status: index % 2 === 0 ? "Todo" : "Done" },
            placement: { viewId: "view-1", groupKey: index % 2 === 0 ? "Todo" : "Done" },
          })),
        },
        page: { hasMore: false },
      });

      expect(etagCount(output)).toBe(0);
      expect(serializedBytes(output)).toBeLessThan(
        NODEX_AGENT_V3_CATALOG_BUDGETS.defaultQueryResultBytes,
      );
    });

    test("keeps every v3 default mutation result sparse", () => {
      const effects = { created: 0, updated: 1, moved: 0, deleted: 0 };
      const outputs = [
        UpdatePageV3OutputSchema.parse({ data: { pageId: "page-1", effects } }),
        AdvancedUpdatePageV3OutputSchema.parse({ data: { pageId: "page-1", effects } }),
        MovePagesV3OutputSchema.parse({
          data: {
            pages: [
              {
                pageId: "page-1",
                location: { kind: "library", libraryId: "library-1" },
              },
            ],
            moved: 1,
          },
        }),
        DuplicatePageV3OutputSchema.parse({
          data: {
            sourcePageId: "page-1",
            pageId: "page-2",
            location: { kind: "library", libraryId: "library-1" },
            bodyBlocksCreated: 10,
          },
        }),
      ];

      for (const output of outputs) {
        expect(etagCount(output)).toBe(0);
        expect(JSON.stringify(output)).not.toContain("markdown");
        expect(serializedBytes(output)).toBeLessThan(
          NODEX_AGENT_V3_CATALOG_BUDGETS.defaultMutationResultBytes,
        );
      }
    });

    test("scales the default create_pages result only with returned Page summaries", () => {
      for (const pageCount of [1, 16]) {
        const output = CreatePagesV3OutputSchema.parse({
          data: {
            pages: Array.from({ length: pageCount }, (_, index) => ({
              pageId: `page-${index + 1}`,
              location: { kind: "library", libraryId: "library-1" },
              bodyBlocksCreated: 10,
            })),
            created: pageCount,
          },
        });
        const cap =
          NODEX_AGENT_V3_CATALOG_BUDGETS.defaultCreatePagesBaseBytes +
          NODEX_AGENT_V3_CATALOG_BUDGETS.defaultCreatePagesPerPageBytes * pageCount;

        expect(etagCount(output)).toBe(0);
        expect(JSON.stringify(output)).not.toContain("markdown");
        expect(serializedBytes(output)).toBeLessThan(cap);
      }
    });

    test("returns one adjacent v3 ETag only for an explicitly prepared title, body, or Block", () => {
      const resource = {
        id: "page-1",
        type: "page",
        lifecycle: "active",
        location: { kind: "library", libraryId: "library-1" },
      } as const;
      const prepared = [
        FetchV3OutputSchema.parse({
          data: {
            resource: { ...resource, title: { markdown: "Page", etag: ETAG } },
          },
        }),
        FetchV3OutputSchema.parse({
          data: {
            resource,
            content: { format: "markdown", markdown: "Body", contentHash: "hash", etag: ETAG },
          },
        }),
        FetchV3OutputSchema.parse({
          data: {
            resource,
            content: {
              format: "blocks",
              blocks: [
                {
                  id: "block-1",
                  parentId: null,
                  index: 0,
                  depth: 0,
                  type: "paragraph",
                  props: {},
                  content: [{ type: "text", text: "Body", styles: {} }],
                  etag: ETAG,
                },
              ],
            },
          },
        }),
      ];

      for (const output of prepared) expect(etagCount(output)).toBe(1);
    });
  });
});

describe("v3 contracts", () => {
  const ETAG = `nxe2.${"a".repeat(43)}`;

  describe("nodex_app@4 contracts", () => {
    test("defines one strict contract for every intent tool", () => {
      expect(NODEX_APP_V3_TOOLSET_REVISION).toBe(4);
      expect(Object.keys(NODEX_AGENT_V3_TOOL_CONTRACTS)).toEqual(NODEX_APP_V3_TOOLS);

      for (const [name, contract] of Object.entries(NODEX_AGENT_V3_TOOL_CONTRACTS)) {
        const schema = z.toJSONSchema(contract.inputSchema) as Record<string, unknown>;
        expect(schema.type, name).toBe("object");
        expect(schema.additionalProperties, name).toBe(false);
        expect(contract.description.length, name).toBeGreaterThan(40);
      }
    });

    test("uses only Agent-visible Nodex Markdown vocabulary", () => {
      const publicContract = JSON.stringify(
        Object.values(NODEX_AGENT_V3_TOOL_CONTRACTS).map((contract) => ({
          description: contract.description,
          input: z.toJSONSchema(contract.inputSchema),
          output: z.toJSONSchema(contract.outputSchema),
        })),
      );

      expect(publicContract).not.toMatch(/NFM|nested_markdown/u);
      expect(publicContract).not.toContain("documentId");
      expect(publicContract).not.toContain("cardId");
      expect(publicContract).not.toContain("cardIds");
      expect(publicContract).not.toContain("databaseBlockId");
      expect(publicContract).not.toContain('"const":"space"');
      expect(publicContract).toContain("markdown");
      expect(Buffer.byteLength(NODEX_MARKDOWN_COMPACT_HINT, "utf8")).toBeLessThanOrEqual(200);
    });

    test("keeps the full guide opt-in and aligned with the compact tab rule", () => {
      expect(GetContextV3InputSchema.safeParse({}).success).toBe(true);
      expect(
        GetContextV3InputSchema.safeParse({
          include: { markdownGuide: true },
        }).success,
      ).toBe(true);
      expect(GetContextV3InputSchema.safeParse({ include: { unknownGuide: true } }).success).toBe(
        false,
      );
      expect(
        GetContextV3OutputSchema.safeParse({
          data: {
            libraryId: "library",
            project: null,

            markdownGuide: NODEX_MARKDOWN_AGENT_GUIDE,
          },
        }).success,
      ).toBe(true);
      expect(NODEX_MARKDOWN_AGENT_GUIDE.instructions).toContain(NODEX_MARKDOWN_COMPACT_HINT);
    });

    test("defaults fetch to content while guarding Block-only controls", () => {
      expect(FetchV3InputSchema.safeParse({ id: "card-1" }).success).toBe(true);
      expect(FetchV3InputSchema.safeParse({ id: "card-1", format: "summary" }).success).toBe(true);
      expect(FetchV3InputSchema.safeParse({ id: "card-1", maxDepth: 2 }).success).toBe(false);
      expect(
        FetchV3InputSchema.safeParse({
          id: "card-1",
          format: "blocks",
          maxDepth: 2,
          prepareFor: [{ kind: "block_update", blockIds: ["block-1"] }],
          page: { limit: 20 },
        }).success,
      ).toBe(true);
      expect(
        FetchV3InputSchema.safeParse({
          id: "card-1",
          prepareFor: [{ kind: "block_delete", blockIds: ["block-1"] }],
        }).success,
      ).toBe(false);
      expect(
        FetchV3InputSchema.safeParse({
          id: "card-1",
          format: "summary",
          prepareFor: [{ kind: "body" }],
        }).success,
      ).toBe(false);
    });

    test("flattens search while retaining target-specific validation", () => {
      expect(SearchV3InputSchema.safeParse({ query: "dynmic tools" }).success).toBe(true);
      expect(
        SearchV3InputSchema.safeParse({
          query: "decision",
          target: "blocks",
          scope: { kind: "page", pageId: "page-1" },
          blockTypes: ["heading"],
          includeArchived: false,
          page: { limit: 20 },
        }).success,
      ).toBe(true);
      expect(
        SearchV3InputSchema.safeParse({
          query: "decision",
          blockTypes: ["heading"],
        }).success,
      ).toBe(false);
      expect(
        SearchV3InputSchema.safeParse({
          query: "decision",
          filters: { includeArchived: true },
        }).success,
      ).toBe(false);
      expect(
        SearchV3InputSchema.safeParse({
          query: "decision",
          scope: { kind: "document", documentId: "document-1" },
        }).success,
      ).toBe(false);
    });

    test("separates saved View queries from ad-hoc Data Source queries", () => {
      expect(QueryDatabaseViewV3InputSchema.safeParse({ viewId: "view-1" }).success).toBe(true);
      expect(
        QueryDatabaseViewV3InputSchema.safeParse({
          databaseBlockId: "database-1",
        }).success,
      ).toBe(false);
      expect(
        QueryDataSourceV3InputSchema.safeParse({
          dataSourceId: "source-1",
          filter: {
            kind: "clause",
            propertyId: "status",
            operator: "equals",
            value: "Todo",
          },
        }).success,
      ).toBe(true);
      expect(QueryDataSourceV3InputSchema.safeParse({ viewId: "view-1" }).success).toBe(false);
    });

    test("creates one to sixteen complete Pages with direct title/body strings", () => {
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [
            {
              title: "**Launch** plan",
              markdown: ":::toggle[Scope]\n  Child paragraph\n\n  - [ ] Child task\n:::",
            },
          ],
        }).success,
      ).toBe(true);
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [{ title: "  Intentional leading spaces", markdown: "  Body spaces" }],
        }).success,
      ).toBe(true);
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [{ title: { kind: "plain", text: "Old wrapper" } }],
        }).success,
      ).toBe(false);
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [{ title: "Page", values: [{ propertyId: "status", value: "Todo" }] }],
        }).success,
      ).toBe(false);
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "data_source", dataSourceId: "source-1" },
          pages: Array.from({ length: 16 }, (_, index) => ({
            title: `Page ${index + 1}`,
            values: [{ propertyId: "status", value: "Todo" }],
          })),
          return: ["block_ids", "etags"],
        }).success,
      ).toBe(true);
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: Array.from({ length: 17 }, (_, index) => ({ title: `Page ${index}` })),
        }).success,
      ).toBe(false);
    });

    test("keeps default and stable-Block Page updates in separate tools", () => {
      const patch = UpdatePageV3InputSchema.parse({
        pageId: "page-1",
        title: { markdown: "Ready", ifMatch: ETAG },
        body: {
          kind: "patch",
          patches: [
            { oldMarkdown: "old one", newMarkdown: "new one" },
            { oldMarkdown: "old two", newMarkdown: "new two", expectedMatches: 1 },
          ],
        },
        return: ["etags"],
      });
      expect(NODEX_AGENT_V3_TOOL_CONTRACTS.update_page.classifyEffect(patch)).toBe("write");
      expect(
        UpdatePageV3InputSchema.parse({
          pageId: "page-1",
          body: {
            kind: "patch",
            ifMatch: ETAG,
            patches: [{ oldMarkdown: "old", newMarkdown: "new" }],
          },
        }).body,
      ).toMatchObject({ kind: "patch", ifMatch: ETAG });
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: {
            kind: "patch",
            ifMatch: "invalid-etag",
            patches: [{ oldMarkdown: "old", newMarkdown: "new" }],
          },
        }).success,
      ).toBe(false);
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: { kind: "replace", markdown: "Replacement" },
        }).success,
      ).toBe(false);
      const replacement = UpdatePageV3InputSchema.parse({
        pageId: "page-1",
        body: { kind: "replace", markdown: "Replacement", ifMatch: ETAG },
      });
      expect(NODEX_AGENT_V3_TOOL_CONTRACTS.update_page.classifyEffect(replacement)).toBe(
        "destructive",
      );
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          edits: [{ kind: "delete", blockId: "block-1", ifMatch: ETAG }],
        }).success,
      ).toBe(false);

      const advanced = AdvancedUpdatePageV3InputSchema.parse({
        pageId: "page-1",
        edits: [{ kind: "delete", blockId: "block-1", ifMatch: ETAG }],
      });
      expect(NODEX_AGENT_V3_TOOL_CONTRACTS.advanced_update_page.classifyEffect(advanced)).toBe(
        "destructive",
      );
      expect(
        AdvancedUpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          edits: [{ kind: "delete", blockId: "block-1", ifMatch: ETAG }],
          safety: { allowDeletingOwnedBlocks: true },
        }).success,
      ).toBe(false);
    });

    test("allows empty Page bodies but rejects empty insertion Fragments", () => {
      expect(
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [{ title: "Empty", markdown: "" }],
        }).success,
      ).toBe(true);
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: { kind: "replace", markdown: "", ifMatch: ETAG },
        }).success,
      ).toBe(true);
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: {
            kind: "patch",
            patches: [{ oldMarkdown: "Only Block", newMarkdown: "" }],
          },
        }).success,
      ).toBe(true);
      for (const markdown of ["", "\n \t\n"]) {
        const result = UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: { kind: "insert", at: { kind: "end" }, markdown },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toContain("<br>");
        }
      }
      expect(
        UpdatePageV3InputSchema.safeParse({
          pageId: "page-1",
          body: {
            kind: "insert",
            at: { kind: "end" },
            markdown: "<br>",
          },
        }).success,
      ).toBe(true);
    });

    test("writes one Markdown language and refuses the retired body field", () => {
      const create = (page: Record<string, unknown>) =>
        CreatePagesV3InputSchema.safeParse({
          destination: { kind: "library" },
          pages: [{ title: "Plan", ...page }],
        }).success;
      expect(create({ markdown: "- Plan\n  - nested" })).toBe(true);
      expect(create({})).toBe(true);
      expect(create({ gfm: "Plan" })).toBe(false);
      const update = (body: Record<string, unknown>) =>
        UpdatePageV3InputSchema.safeParse({ pageId: "page-1", body }).success;
      const insert = { kind: "insert", at: { kind: "end" } };
      expect(update({ ...insert, markdown: "> [!NOTE]\n> Shipped" })).toBe(true);
      expect(update({ ...insert, markdown: "<br>" })).toBe(true);
      expect(update({ ...insert, markdown: "" })).toBe(false);
      expect(update({ ...insert, gfm: "Plan" })).toBe(false);
      expect(update({ kind: "replace", markdown: "", ifMatch: ETAG })).toBe(true);
      expect(update({ kind: "replace", ifMatch: ETAG })).toBe(false);
    });

    test("uses Page-only move and duplicate intents without generic transfer fields", () => {
      expect(
        MovePagesV3InputSchema.safeParse({
          pageIds: ["page-1", "page-2"],
          destination: { kind: "page", pageId: "parent-page", at: { kind: "end" } },
        }).success,
      ).toBe(true);
      expect(
        MovePagesV3InputSchema.safeParse({
          pageIds: ["page-1", "page-1"],
          destination: { kind: "library" },
        }).success,
      ).toBe(false);
      expect(
        MovePagesV3InputSchema.safeParse({
          mode: "move",
          pageIds: ["page-1"],
          from: { kind: "library" },
          destination: { kind: "library" },
        }).success,
      ).toBe(false);
      expect(
        DuplicatePageV3InputSchema.safeParse({
          pageId: "page-1",
          destination: { kind: "library" },
          return: ["block_map"],
        }).success,
      ).toBe(true);
      expect(
        DuplicatePageV3InputSchema.safeParse({
          pageIds: ["page-1"],
          destination: { kind: "library" },
        }).success,
      ).toBe(false);
      expect(
        DuplicatePageV3InputSchema.safeParse({
          pageId: "page-1",
          destination: { kind: "library" },
          return: ["block_map", "block_map"],
        }).success,
      ).toBe(false);
    });
  });
});

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

describe("v6 contracts", () => {
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
});
