import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  CreateInputSchema,
  EditDatabaseInputSchema,
  EditDocumentInputSchema,
  GetBlockInputSchema,
  NODEX_AGENT_TOOL_CONTRACTS,
  NODEX_APP_V2_TOOLS,
  NODEX_APP_V2_TOOLSET_REVISION,
  QueryDatabaseInputSchema,
  QueryDatabaseOutputSchema,
  SearchInputSchema,
  TransferBlocksInputSchema,
  NODEX_AGENT_V3_CATALOG_BUDGETS,
} from ".";

const ETAG = `nxe1.${"a".repeat(43)}`;

describe("Nodex Agent tool contracts", () => {
  test("keeps the v2 catalog, schemas, loading policy, and handlers in one parity set", () => {
    expect(NODEX_APP_V2_TOOLSET_REVISION).toBe(2);
    expect(Object.keys(NODEX_AGENT_TOOL_CONTRACTS)).toEqual(NODEX_APP_V2_TOOLS);

    for (const [name, contract] of Object.entries(NODEX_AGENT_TOOL_CONTRACTS)) {
      const schema = z.toJSONSchema(contract.inputSchema) as Record<string, unknown>;
      expect(contract.description.length, name).toBeGreaterThan(40);
      const alternatives = Array.isArray(schema.oneOf)
        ? (schema.oneOf as Array<Record<string, unknown>>)
        : Array.isArray(schema.anyOf)
          ? (schema.anyOf as Array<Record<string, unknown>>)
          : [schema];
      expect(alternatives.length, name).toBeGreaterThan(0);
      for (const alternative of alternatives) {
        expect(alternative.type, name).toBe("object");
        expect(alternative.additionalProperties, name).toBe(false);
      }
      expect(typeof contract.classifyEffect, name).toBe("function");
    }

    expect(NODEX_AGENT_TOOL_CONTRACTS.get_context.deferLoading).toBe(false);
    expect(NODEX_AGENT_TOOL_CONTRACTS.get_block.deferLoading).toBe(false);
    expect(NODEX_AGENT_TOOL_CONTRACTS.search.deferLoading).toBe(false);
    expect(NODEX_AGENT_TOOL_CONTRACTS.query_database.deferLoading).toBe(true);
    expect(NODEX_AGENT_TOOL_CONTRACTS.create.deferLoading).toBe(true);
  });

  test("does not accept model-authored catalog, Project, actor, or idempotency scope", () => {
    const forbiddenRootFields = {
      version: 2,
      toolsetRevision: 2,
      schemaVersion: 2,
      projectId: "project-forged",
      storeEpoch: "epoch-forged",
      actor: "agent-forged",
      clientSession: "session-forged",
      mutationId: "mutation-forged",
      idempotencyKey: "key-forged",
      writeFence: "fence-forged",
    };

    for (const field of Object.keys(forbiddenRootFields)) {
      const parsed = SearchInputSchema.safeParse({
        query: "roadmap",
        [field]: forbiddenRootFields[field as keyof typeof forbiddenRootFields],
      });
      expect(parsed.success, field).toBe(false);
    }
  });

  test("removes storage revision topology from every public input schema", () => {
    const publicSchemas = Object.values(NODEX_AGENT_TOOL_CONTRACTS)
      .map((contract) => JSON.stringify(z.toJSONSchema(contract.inputSchema)))
      .join("\n");

    for (const forbidden of [
      "DocumentRevision",
      "LocationRevision",
      "DatabaseSchemaRevision",
      "DatabaseValueRevision",
      "ViewRevision",
      "ViewPlacementRevision",
      "ifRevision",
      "ifSchemaRevision",
      "ifLocationRevision",
    ]) {
      expect(publicSchemas, forbidden).not.toContain(forbidden);
    }
    expect(publicSchemas).toContain("ifMatch");
    expect(publicSchemas).toContain("prepareFor");
  });

  test("accepts one-call creation of a complete multi-Block NFM Card without revisions", () => {
    const parsed = CreateInputSchema.safeParse({
      resource: {
        kind: "page",
        title: { kind: "plain", text: "Migration plan" },
        body: {
          format: "nfm",
          content: [
            "## Goal",
            "",
            "Move in three phases.",
            "",
            "- [ ] Inventory",
            "\t- Check ownership",
            "- [ ] Migrate",
            "- [ ] Verify",
            "",
            '<callout icon="💡">Keep the rollback path open.</callout>',
          ].join("\n"),
        },
      },
      destination: { kind: "library", at: { kind: "end" } },
      return: { blockIds: true },
    });

    expect(parsed.success).toBe(true);
  });

  test("accepts revision-free NFM insertion and exact patching", () => {
    const insertion = EditDocumentInputSchema.parse({
      documentId: "document-1",
      body: {
        kind: "nfm.insert",
        at: { kind: "end" },
        content: "## Risks\n\n- First risk\n- Second risk\n- Third risk",
      },
    });
    const patch = EditDocumentInputSchema.parse({
      documentId: "document-1",
      body: {
        kind: "nfm.patch",
        patches: [{ oldNfm: "old", newNfm: "new", expectedMatches: 1 }],
      },
    });

    expect(NODEX_AGENT_TOOL_CONTRACTS.edit_document.classifyEffect(insertion)).toBe("write");
    expect(NODEX_AGENT_TOOL_CONTRACTS.edit_document.classifyEffect(patch)).toBe("write");
  });

  test("separates empty Document inputs from empty insertion Fragments", () => {
    expect(
      CreateInputSchema.safeParse({
        resource: {
          kind: "page",
          title: { kind: "plain", text: "Empty" },
          body: { format: "nfm", content: "" },
        },
        destination: { kind: "library" },
      }).success,
    ).toBe(true);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.replace", content: "", ifMatch: ETAG },
      }).success,
    ).toBe(true);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: {
          kind: "nfm.patch",
          patches: [{ oldNfm: "Only Block", newNfm: "" }],
        },
      }).success,
    ).toBe(true);
    for (const content of ["", "\n \t\n"]) {
      const result = EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.insert", at: { kind: "end" }, content },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("<empty-block/>");
      }
    }
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: {
          kind: "nfm.insert",
          at: { kind: "end" },
          content: "<empty-block/>",
        },
      }).success,
    ).toBe(true);
  });

  test("requires narrow ETags only for overwrite operations", () => {
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.replace", content: "Replacement" },
      }).success,
    ).toBe(false);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.replace", content: "Replacement", ifMatch: ETAG },
      }).success,
    ).toBe(true);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        title: { value: { kind: "plain", text: "New" } },
      }).success,
    ).toBe(false);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        title: { value: { kind: "plain", text: "New" }, ifMatch: ETAG },
      }).success,
    ).toBe(true);
    expect(
      EditDatabaseInputSchema.safeParse({
        databaseBlockId: "database-1",
        edits: [
          {
            kind: "value.set",
            blockId: "block-1",
            propertyId: "property-1",
            value: "done",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      EditDatabaseInputSchema.safeParse({
        databaseBlockId: "database-1",
        edits: [
          {
            kind: "value.add_remove",
            blockId: "block-1",
            propertyId: "property-1",
            add: ["done"],
            remove: [],
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("uses one logical source for a transfer move and no freshness proof for copy", () => {
    expect(
      TransferBlocksInputSchema.safeParse({
        mode: "move",
        blockIds: ["block-1", "block-2"],
        destination: { kind: "library" },
      }).success,
    ).toBe(false);
    expect(
      TransferBlocksInputSchema.safeParse({
        mode: "move",
        blockIds: ["block-1", "block-2"],
        from: { kind: "data_source", dataSourceId: "data-source-1" },
        destination: { kind: "library" },
      }).success,
    ).toBe(true);
    expect(
      TransferBlocksInputSchema.safeParse({
        mode: "copy",
        blockIds: ["block-1"],
        destination: {
          kind: "document",
          documentId: "document-2",
          at: { kind: "end" },
        },
      }).success,
    ).toBe(true);
  });

  test("accepts composed operation-scoped preparation", () => {
    expect(
      GetBlockInputSchema.safeParse({
        blockId: "block-1",
        include: {
          properties: { propertyIds: ["status"] },
          document: { format: "nfm" },
        },
        prepareFor: [
          { kind: "title.set" },
          { kind: "document.replace" },
          { kind: "value.set", propertyIds: ["status"] },
        ],
      }).success,
    ).toBe(true);
    expect(
      QueryDatabaseInputSchema.safeParse({
        source: { kind: "view", viewId: "view-1" },
        select: { propertyIds: ["status"] },
        prepareFor: [{ kind: "value.set", propertyIds: ["status"] }, { kind: "view.place" }],
      }).success,
    ).toBe(true);
  });

  test("keeps a representative default Database query below four KiB with no ETags", () => {
    const output = QueryDatabaseOutputSchema.parse({
      data: {
        database: {
          databaseBlockId: "database-1",
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
        view: { viewId: "view-1", name: "Board", layout: "board" },
        rows: Array.from({ length: 13 }, (_, index) => ({
          blockId: `block-${index + 1}`,
          title: `Task ${index + 1}`,
          values: { status: { value: index % 2 === 0 ? "Todo" : "Done" } },
          placement: { viewId: "view-1", groupKey: index % 2 === 0 ? "Todo" : "Done" },
        })),
      },
      page: { hasMore: false },
    });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain("etag");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(
      NODEX_AGENT_V3_CATALOG_BUDGETS.defaultQueryResultBytes,
    );
  });

  test("rejects ambiguous anchors, empty edits, unknown keys, and unsafe patch shapes", () => {
    expect(
      CreateInputSchema.safeParse({
        resource: { kind: "page", title: { kind: "plain", text: "Card" } },
        destination: {
          kind: "document",
          documentId: "document-1",
          at: { kind: "before", blockId: "block-1", parentBlockId: "block-2" },
        },
      }).success,
    ).toBe(false);
    expect(EditDocumentInputSchema.safeParse({ documentId: "document-1" }).success).toBe(false);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.patch", patches: [{ oldNfm: "", newNfm: "replacement" }] },
      }).success,
    ).toBe(false);
    expect(
      EditDocumentInputSchema.safeParse({
        documentId: "document-1",
        body: { kind: "nfm.replace", content: "Replacement", ifMatch: ETAG, extra: true },
      }).success,
    ).toBe(false);
  });

  test("classifies replacement and explicit deletion as destructive", () => {
    const replacement = EditDocumentInputSchema.parse({
      documentId: "document-1",
      body: { kind: "nfm.replace", content: "New body", ifMatch: ETAG },
    });
    const deletion = EditDocumentInputSchema.parse({
      documentId: "document-1",
      body: {
        kind: "blocks",
        edits: [{ kind: "delete", blockId: "block-1", ifMatch: ETAG }],
      },
    });

    expect(NODEX_AGENT_TOOL_CONTRACTS.edit_document.classifyEffect(replacement)).toBe(
      "destructive",
    );
    expect(NODEX_AGENT_TOOL_CONTRACTS.edit_document.classifyEffect(deletion)).toBe("destructive");
  });
});
