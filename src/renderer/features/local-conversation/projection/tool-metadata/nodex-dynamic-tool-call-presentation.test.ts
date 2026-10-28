import { describe, expect, test } from "vite-plus/test";
import type { CodexDynamicToolCallView } from "../../../../lib/types";
import { resolveNodexDynamicToolCallPresentation } from "./nodex-dynamic-tool-call-presentation";

function call(
  tool: string,
  argumentsValue: CodexDynamicToolCallView["arguments"],
  output?: unknown,
): CodexDynamicToolCallView {
  return {
    callId: `call-${tool}`,
    namespace: "nodex_app",
    tool,
    arguments: argumentsValue,
    status: "completed",
    contentItems:
      output === undefined ? null : [{ type: "inputText", text: JSON.stringify(output) }],
    success: true,
    durationMs: 12,
    completed: true,
  };
}

describe("resolveNodexDynamicToolCallPresentation", () => {
  test("makes search and create targets visible in compact transcript labels", () => {
    const search = resolveNodexDynamicToolCallPresentation(
      call(
        "search",
        { query: "migrtion", target: "pages" },
        {
          data: {
            target: "pages",
            results: [
              { kind: "page", pageKey: "LAB-13" },
              { kind: "page", pageKey: "LAB-22" },
            ],
          },
        },
      ),
    );
    const create = resolveNodexDynamicToolCallPresentation(
      call(
        "create",
        {
          resource: {
            kind: "page",
            title: { kind: "plain", text: "Migration plan" },
            body: { format: "markdown", content: "# Plan\nDetails" },
          },
          destination: { kind: "library" },
        },
        {
          data: { resource: { bodyBlockCount: 2 } },
        },
      ),
    );

    expect(search?.label).toBe("Searched pages for “migrtion” · 2 results · LAB-13, LAB-22");
    expect(create?.label).toBe("Created “Migration plan” · 2 body blocks");
  });

  test("projects exact NFM patches into bounded addition and removal lines", () => {
    const presentation = resolveNodexDynamicToolCallPresentation(
      call("edit_document", {
        documentId: "document-1",
        body: {
          kind: "markdown.patch",
          patches: [
            { oldMarkdown: "## Draft\n- [ ] Ship", newMarkdown: "## Ready\n- [x] Ship" },
            { oldMarkdown: "Owner: TBD", newMarkdown: "Owner: Ada" },
          ],
        },
      }),
    );

    expect(presentation?.label).toBe("Edited document · 2 NFM patches");
    expect(presentation?.markdownChange?.additions).toBe(3);
    expect(presentation?.markdownChange?.deletions).toBe(3);
    expect(presentation?.markdownChange?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "removed:## Draft",
      "removed:- [ ] Ship",
      "added:## Ready",
      "added:- [x] Ship",
      "separator:Patch 2",
      "removed:Owner: TBD",
      "added:Owner: Ada",
    ]);
  });

  test("bounds large NFM previews while retaining exact line statistics", () => {
    const content = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}`).join("\n");
    const presentation = resolveNodexDynamicToolCallPresentation(
      call("edit_document", {
        documentId: "document-1",
        body: { kind: "markdown.insert", at: { kind: "end" }, content },
      }),
    );

    expect(presentation?.markdownChange?.additions).toBe(120);
    expect(presentation?.markdownChange?.lines).toHaveLength(80);
    expect(presentation?.markdownChange?.omittedLineCount).toBe(40);
  });

  test("keeps both sides of a large exact patch in the bounded preview", () => {
    const oldMarkdown = Array.from({ length: 100 }, (_, index) => `Old ${index + 1}`).join("\n");
    const newMarkdown = Array.from({ length: 100 }, (_, index) => `New ${index + 1}`).join("\n");
    const presentation = resolveNodexDynamicToolCallPresentation(
      call("edit_document", {
        documentId: "document-1",
        body: { kind: "markdown.patch", patches: [{ oldMarkdown, newMarkdown }] },
      }),
    );

    expect(presentation?.markdownChange?.lines).toHaveLength(64);
    expect(presentation?.markdownChange?.lines.some((line) => line.text === "Old 1")).toBe(true);
    expect(presentation?.markdownChange?.lines.some((line) => line.text === "New 1")).toBe(true);
    expect(presentation?.markdownChange?.omittedLineCount).toBe(136);
  });

  test("summarizes transfer and database edits by semantic effect", () => {
    const transfer = resolveNodexDynamicToolCallPresentation(
      call("transfer_blocks", {
        mode: "move",
        blockIds: ["a", "b"],
        from: { kind: "library", libraryId: "library-1" },
        destination: { kind: "data_source", dataSourceId: "data-source-1" },
      }),
    );
    const database = resolveNodexDynamicToolCallPresentation(
      call("edit_database", {
        databaseBlockId: "database-1",
        edits: [
          { kind: "value.set" },
          { kind: "view.place", items: [{ blockId: "a" }, { blockId: "b" }] },
        ],
      }),
    );

    expect(transfer?.label).toBe("Moved 2 blocks to data source “data-source-1”");
    expect(database?.label).toBe("Updated database · 1 value change, 2 placements");
  });

  test("makes v3 fetch and query targets visible before and after results arrive", () => {
    const fetch = resolveNodexDynamicToolCallPresentation(
      call(
        "fetch",
        {
          id: "card-launch",
        },
        {
          data: {
            resource: {
              id: "card-launch",
              pageKey: "LAB-13",
              type: "page",
              title: { markdown: "**Launch** plan" },
              lifecycle: "active",
              location: { kind: "library", libraryId: "library-1" },
            },
          },
        },
      ),
    );
    const view = resolveNodexDynamicToolCallPresentation(
      call(
        "query_database_view",
        {
          viewId: "view-roadmap",
        },
        {
          data: {
            database: { name: "Tasks" },
            view: { name: "Roadmap" },
            rows: [{}, {}],
          },
        },
      ),
    );
    const advanced = resolveNodexDynamicToolCallPresentation(
      call(
        "query_data_source",
        {
          dataSourceId: "source-tasks",
          filter: { kind: "condition" },
        },
        {
          data: { dataSource: { name: "Tasks" }, rows: [{}] },
        },
      ),
    );

    expect(fetch?.label).toBe("Fetched LAB-13 · “Launch plan” as markdown");
    expect(view?.label).toBe("Queried view “Roadmap” · 2 rows");
    expect(advanced?.label).toBe("Queried data source “Tasks” · 1 row");
  });

  test("summarizes v4 Page creation, movement, and fresh duplicate identity", () => {
    const create = resolveNodexDynamicToolCallPresentation(
      call(
        "create_pages",
        {
          destination: { kind: "data_source", dataSourceId: "source-1" },
          pages: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }],
        },
        {
          data: {
            pages: [
              { pageKey: "LAB-13", bodyBlocksCreated: 2 },
              { pageKey: "LAB-14", bodyBlocksCreated: 0 },
              { pageKey: "LAB-15", bodyBlocksCreated: 1 },
            ],
            created: 3,
          },
        },
      ),
    );
    const move = resolveNodexDynamicToolCallPresentation(
      call(
        "move_pages",
        {
          pageIds: ["page-a", "page-b"],
          destination: { kind: "page", pageId: "parent-1" },
        },
        { data: { pages: [{ pageKey: "LAB-13" }, { pageKey: null }] } },
      ),
    );
    const duplicate = resolveNodexDynamicToolCallPresentation(
      call(
        "duplicate_page",
        {
          pageId: "page-source-1",
          destination: { kind: "library" },
        },
        {
          data: {
            sourcePageId: "page-source-1",
            pageId: "page-copy-1",
            pageKey: "LAB-16",
          },
        },
      ),
    );

    expect(create?.label).toBe(
      "Created 3 pages: “Alpha”, “Beta” +1 in data source “source-1” · 3 body blocks · LAB-13, LAB-14 +1",
    );
    expect(move?.label).toBe("Moved 2 pages to page “parent-1” · LAB-13");
    expect(duplicate?.label).toBe("Duplicated page “page-source-1” → LAB-16 to Library");
  });

  test("renders v3 Nested Markdown patches as a bounded diff and separates stable Block edits", () => {
    const update = resolveNodexDynamicToolCallPresentation(
      call("update_page", {
        pageId: "page-1",
        body: {
          kind: "patch",
          patches: [
            { oldMarkdown: "Draft", newMarkdown: "Ready" },
            { oldMarkdown: "- [ ] Ship", newMarkdown: "- [x] Ship" },
          ],
        },
      }),
    );
    const advanced = resolveNodexDynamicToolCallPresentation(
      call("advanced_update_page", {
        pageId: "page-1",
        edits: [
          { kind: "update", blockId: "block-1" },
          { kind: "delete", blockId: "block-2" },
        ],
      }),
    );

    expect(update?.label).toBe("Updated page “page-1” · 2 Nested Markdown patches");
    expect(update?.markdownChange?.additions).toBe(2);
    expect(update?.markdownChange?.deletions).toBe(2);
    expect(update?.markdownChange?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "removed:Draft",
      "added:Ready",
      "separator:Patch 2",
      "removed:- [ ] Ship",
      "added:- [x] Ship",
    ]);
    expect(advanced?.label).toBe("Updated page “page-1” · 2 stable block changes, 1 delete");
    expect(advanced?.markdownChange).toBeNull();
  });
});
