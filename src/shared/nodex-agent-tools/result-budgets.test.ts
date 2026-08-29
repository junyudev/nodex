import { describe, expect, test } from "vite-plus/test";
import { NODEX_AGENT_V3_CATALOG_BUDGETS } from "./budgets";
import { GetBlockOutputSchema } from "./read-schemas";
import { FetchV3OutputSchema, QueryDatabaseV3OutputSchema } from "./v3-read-schemas";
import {
  CreateOutputSchema,
  EditDatabaseOutputSchema,
  EditDocumentOutputSchema,
  TransferBlocksOutputSchema,
} from "./write-schemas";
import {
  AdvancedUpdatePageV3OutputSchema,
  CreatePagesV3OutputSchema,
  DuplicatePageV3OutputSchema,
  MovePagesV3OutputSchema,
  UpdatePageV3OutputSchema,
} from "./v3-write-schemas";

const ETAG = `nxe1.${"a".repeat(43)}`;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function etagCount(value: unknown): number {
  return JSON.stringify(value).match(/nxe1\.[A-Za-z0-9_-]{43}/gu)?.length ?? 0;
}

describe("Nodex Agent result budgets", () => {
  test("keeps default mutation results sparse", () => {
    const outputs = [
      CreateOutputSchema.parse({
        data: {
          resource: {
            kind: "page",
            blockId: "card-1",
            documentId: "document-1",
            location: { kind: "library", libraryId: "library-1" },
            bodyBlockCount: 12,
          },
        },
      }),
      EditDocumentOutputSchema.parse({
        data: {
          documentId: "document-1",
          effects: { created: 2, updated: 1, moved: 0, deleted: 0 },
        },
      }),
      TransferBlocksOutputSchema.parse({
        data: {
          mode: "move",
          results: [
            {
              sourceBlockId: "card-1",
              resultBlockId: "card-1",
              location: { kind: "library", libraryId: "library-1" },
              transformation: "preserved",
            },
          ],
        },
      }),
      EditDatabaseOutputSchema.parse({
        data: {
          databaseBlockId: "database-1",
          effects: { valuesSet: 1, setsChanged: 0, placementsChanged: 0 },
        },
      }),
    ];

    for (const output of outputs) {
      expect(etagCount(output)).toBe(0);
      expect(serializedBytes(output)).toBeLessThan(
        NODEX_AGENT_V3_CATALOG_BUDGETS.defaultMutationResultBytes,
      );
    }
  });

  test("adds exactly one adjacent ETag for each prepared title, body, or Block", () => {
    const prepared = [
      GetBlockOutputSchema.parse({
        data: {
          block: {
            blockId: "card-1",
            type: "page",
            title: { value: { kind: "plain", text: "Card" }, etag: ETAG },
            lifecycle: "active",
            location: { kind: "library", libraryId: "library-1" },
          },
        },
      }),
      GetBlockOutputSchema.parse({
        data: {
          block: {
            blockId: "card-1",
            type: "page",
            lifecycle: "active",
            location: { kind: "library", libraryId: "library-1" },
          },
          document: {
            documentId: "document-1",
            ownerBlockId: "card-1",
            body: { format: "nfm", content: "Body", contentHash: "hash", etag: ETAG },
          },
        },
      }),
      GetBlockOutputSchema.parse({
        data: {
          block: {
            blockId: "card-1",
            type: "page",
            lifecycle: "active",
            location: { kind: "library", libraryId: "library-1" },
          },
          document: {
            documentId: "document-1",
            ownerBlockId: "card-1",
            body: {
              format: "blocks",
              blocks: [
                {
                  blockId: "block-1",
                  parentBlockId: null,
                  siblingIndex: 0,
                  depth: 0,
                  type: "paragraph",
                  props: {},
                  content: [{ type: "text", text: "Body", styles: {} }],
                  etag: ETAG,
                },
              ],
            },
          },
        },
      }),
    ];

    for (const output of prepared) {
      expect(etagCount(output)).toBe(1);
    }
  });

  test("treats requested document content separately from bounded metadata", () => {
    const content = "x".repeat(10_000);
    const output = GetBlockOutputSchema.parse({
      data: {
        block: {
          blockId: "card-1",
          type: "page",
          lifecycle: "active",
          location: { kind: "library", libraryId: "library-1" },
        },
        document: {
          documentId: "document-1",
          ownerBlockId: "card-1",
          body: { format: "nfm", content, contentHash: "hash" },
        },
      },
    });

    expect(serializedBytes(output) - Buffer.byteLength(content, "utf8")).toBeLessThan(512);
  });

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
