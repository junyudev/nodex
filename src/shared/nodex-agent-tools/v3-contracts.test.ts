import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { NESTED_MARKDOWN_AGENT_GUIDE, NESTED_MARKDOWN_COMPACT_HINT } from "../nfm/agent-guide";
import { NODEX_AGENT_V3_TOOL_CONTRACTS } from "./v3-contracts";
import { NODEX_APP_V3_TOOLS, NODEX_APP_V3_TOOLSET_REVISION } from "./identity";
import {
  FetchV3InputSchema,
  GetContextV3InputSchema,
  GetContextV3OutputSchema,
  QueryDatabaseViewV3InputSchema,
  QueryDataSourceV3InputSchema,
  SearchV3InputSchema,
} from "./v3-read-schemas";
import {
  AdvancedUpdatePageV3InputSchema,
  CreatePagesV3InputSchema,
  DuplicatePageV3InputSchema,
  MovePagesV3InputSchema,
  UpdatePageV3InputSchema,
} from "./v3-write-schemas";

const ETAG = `nxe1.${"a".repeat(43)}`;

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

  test("uses only Agent-visible Nested Markdown vocabulary", () => {
    const publicContract = JSON.stringify(
      Object.values(NODEX_AGENT_V3_TOOL_CONTRACTS).map((contract) => ({
        description: contract.description,
        input: z.toJSONSchema(contract.inputSchema),
        output: z.toJSONSchema(contract.outputSchema),
      })),
    );

    expect(publicContract).not.toMatch(/NFM|nfm/u);
    expect(publicContract).not.toContain("documentId");
    expect(publicContract).not.toContain("cardId");
    expect(publicContract).not.toContain("cardIds");
    expect(publicContract).not.toContain("databaseBlockId");
    expect(publicContract).not.toContain('"const":"space"');
    expect(publicContract).toContain("markdown");
    expect(Buffer.byteLength(NESTED_MARKDOWN_COMPACT_HINT, "utf8")).toBeLessThanOrEqual(200);
  });

  test("keeps the full guide opt-in and aligned with the compact tab rule", () => {
    expect(GetContextV3InputSchema.safeParse({}).success).toBe(true);
    expect(
      GetContextV3InputSchema.safeParse({
        include: { markdownGuide: true },
      }).success,
    ).toBe(true);
    expect(GetContextV3InputSchema.safeParse({ include: { nfmGuide: true } }).success).toBe(false);
    expect(
      GetContextV3OutputSchema.safeParse({
        data: {
          project: null,
          access: { read: "allowed", write: "consent_required", domains: [] },
          markdownGuide: NESTED_MARKDOWN_AGENT_GUIDE,
        },
      }).success,
    ).toBe(true);
    expect(NESTED_MARKDOWN_AGENT_GUIDE.instructions).toContain(NESTED_MARKDOWN_COMPACT_HINT);
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
            markdown: "▶ Scope\n\tChild paragraph\n\t- [ ] Child task",
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
        expect(result.error.issues[0]?.message).toContain("<empty-block/>");
      }
    }
    expect(
      UpdatePageV3InputSchema.safeParse({
        pageId: "page-1",
        body: {
          kind: "insert",
          at: { kind: "end" },
          markdown: "<empty-block/>",
        },
      }).success,
    ).toBe(true);
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
