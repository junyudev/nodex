import { describe, expect, test } from "vite-plus/test";
import { parseNfm } from "./parser";
import { serializeClipboardText } from "./clipboard-text-serializer";
import type { NfmAttachmentInlineContent, NfmBlock } from "./types";

const attachment: NfmAttachmentInlineContent = {
  type: "attachment",
  kind: "file",
  mode: "link",
  source: "/Users/example/setup.html",
  name: "setup.html",
};

describe("attachment clipboard text", () => {
  test("keeps linked files and folders in paragraphs, descendants and image captions", () => {
    const blocks: NfmBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Read ", styles: {} }, attachment],
        children: [
          {
            type: "bulletListItem",
            content: [
              { ...attachment, kind: "folder", source: "/Users/example/docs", name: "docs" },
            ],
            children: [],
          },
        ],
      },
      {
        type: "image",
        source: "https://example.com/image.png",
        caption: [attachment],
        children: [],
      },
    ];

    expect(serializeClipboardText(blocks)).toBe(
      'Read [setup.html](/Users/example/setup.html)\n\t- [docs](/Users/example/docs)\n<image source="https://example.com/image.png">[setup.html](/Users/example/setup.html)</image>',
    );
  });

  test("copies saved attachments from their current source rather than their origin", () => {
    const source = "nodex://files/0199134e-cbb0-7000-8000-000000000006";
    const blocks: NfmBlock[] = [
      {
        type: "paragraph",
        content: [{ ...attachment, mode: "materialized", source, origin: "/old/setup.html" }],
        children: [],
      },
    ];
    expect(serializeClipboardText(blocks)).toBe(`[setup.html](${source})`);
  });

  test("preserves exact attachment paths in tab-separated table cells", () => {
    const blocks: NfmBlock[] = [
      {
        type: "table",
        rows: [
          {
            cells: [
              { content: [attachment] },
              {
                content: [
                  {
                    ...attachment,
                    source: "/Users/example/my  files/setup (v2).html",
                  },
                ],
              },
              {
                content: [
                  { type: "text", text: "one ", styles: {} },
                  { type: "text", text: " two", styles: { bold: true } },
                ],
              },
            ],
          },
        ],
        columns: [{}, {}, {}],
        children: [],
      },
    ];
    expect(serializeClipboardText(blocks)).toBe(
      "[setup.html](/Users/example/setup.html)\t[setup.html](</Users/example/my  files/setup (v2).html>)\tone two",
    );
  });

  test("keeps usable references for unnamed attachments and readable text for missing targets", () => {
    const blocks: NfmBlock[] = [
      {
        type: "paragraph",
        content: [
          { ...attachment, name: "" },
          { ...attachment, source: "" },
        ],
        children: [],
      },
    ];
    expect(serializeClipboardText(blocks)).toBe(
      "[Untitled attachment](/Users/example/setup.html)[Attachment: setup.html]",
    );
  });

  test("does not reinterpret attachment-like text inside code", () => {
    const source =
      '<attachment kind="file" mode="link" source="/tmp/setup.html" name="setup.html" />';
    expect(serializeClipboardText(parseNfm(`\`\`\`html\n${source}\n\`\`\``))).toBe(
      `\`\`\`html\n${source}\n\`\`\``,
    );
  });
});
