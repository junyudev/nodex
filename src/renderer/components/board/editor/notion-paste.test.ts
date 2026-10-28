import { describe, expect, test, vi } from "vite-plus/test";
import { markdownPlainText, writeMarkdown } from "../../../../shared/nodex-markdown";
import {
  NOTION_BLOCKS_MIME,
  extractNotionBlocksFromClipboardData,
  extractNotionBlocksFromPayload,
  insertMarkdownBlocksFromPaste,
} from "./notion-paste";

const payload = (roots: unknown[]) => ({ selection: { roots } });

describe("Notion clipboard conversion", () => {
  test("keeps hierarchy, title styles and links directly in BlockNote JSON", () => {
    const blocks = extractNotionBlocksFromClipboardData({
      types: [NOTION_BLOCKS_MIME],
      getData: () =>
        JSON.stringify(
          payload([
            {
              id: "toggle",
              type: "toggle",
              title: [["Details", [["b"]]]],
              children: [
                {
                  id: "child",
                  type: "text",
                  title: [["first\nsecond", [["a", "https://example.com"], ["_"]]]],
                  children: [],
                },
              ],
            },
          ]),
        ),
    });
    expect(blocks?.[0]?.type).toBe("toggleListItem");
    expect(blocks?.[0]?.children?.[0]?.content).toEqual([
      {
        type: "link",
        href: "https://example.com",
        content: [{ type: "text", text: "first\nsecond", styles: { underline: true } }],
      },
    ]);
    expect(markdownPlainText(blocks ?? [])).toBe("Details first second");
  });
  test("keeps table headers, column order and widths", () => {
    const blocks = extractNotionBlocksFromPayload(
      payload([
        {
          id: "table",
          type: "table",
          format: {
            table_block_column_order: ["b", "a"],
            table_block_row_header: true,
            table_block_column_header: true,
            table_block_column_format: { b: { width: 180, color: "blue_background" } },
          },
          children: [
            { id: "row", type: "table_row", properties: { a: [["A"]], b: [["B"]] }, children: [] },
            {
              id: "row-2",
              type: "table_row",
              properties: { a: [["2"]], b: [["1"]] },
              children: [],
            },
          ],
        },
      ]),
    );
    expect(blocks?.[0]?.content).toEqual({
      type: "tableContent",
      headerRows: 1,
      headerCols: 1,
      columnWidths: [180, undefined],
      rows: [
        {
          cells: [
            {
              type: "tableCell",
              props: { backgroundColor: "blue" },
              content: [{ type: "text", text: "B", styles: {} }],
            },
            { type: "tableCell", content: [{ type: "text", text: "A", styles: {} }] },
          ],
        },
        {
          cells: [
            {
              type: "tableCell",
              props: { backgroundColor: "blue" },
              content: [{ type: "text", text: "1", styles: {} }],
            },
            { type: "tableCell", content: [{ type: "text", text: "2", styles: {} }] },
          ],
        },
      ],
    });
    expect(writeMarkdown(blocks ?? [])).toContain(':::table{header="both" widths="180,auto"}');
  });
  test("rejects invalid clipboard data and lets structural authority intercept insertion", () => {
    expect(
      extractNotionBlocksFromClipboardData({ types: [NOTION_BLOCKS_MIME], getData: () => "{" }),
    ).toBeNull();
    const replaceBlocks = vi.fn();
    const editor = {
      getSelection: () => ({ blocks: [{ id: "selected", type: "paragraph" }] }),
      getTextCursorPosition: () => ({ block: { id: "cursor", type: "paragraph" } }),
      replaceBlocks,
      insertBlocks: vi.fn(),
    };
    expect(
      insertMarkdownBlocksFromPaste(editor, [{ type: "paragraph", content: [] }], {
        onBeforeReplaceBlocks: () => true,
      }),
    ).toBe(true);
    expect(replaceBlocks).not.toHaveBeenCalled();
    expect(insertMarkdownBlocksFromPaste(editor, [{ type: "paragraph", content: [] }])).toBe(true);
    expect(replaceBlocks).toHaveBeenCalledWith(["selected"], [{ type: "paragraph", content: [] }]);
  });
});
