import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/shadcn";
import { act } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { writeMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";
import {
  richHtmlPageMarkdown,
  richHtmlPlainText,
  richHtmlSpacerFixtures,
} from "../../../../shared/markdown/__fixtures__/rich-html-paste";
import { createNfmPasteHandler } from "./nfm-editor-extensions";
import { nfmSchema } from "./nfm-schema";
import { renderWithAppMaitai } from "../../../test/app-maitai";

const settleEditor = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

async function pasteHtml(
  html: string,
  plain: string,
  options: {
    readonly code?: boolean;
    readonly internal?: boolean;
    readonly structural?: boolean;
    readonly initialText?: string;
  } = {},
) {
  const structural: MarkdownBlock[][] = [];
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    initialContent: [
      { type: options.code ? "codeBlock" : "paragraph", content: options.initialText ?? "" },
    ],
    pasteHandler: createNfmPasteHandler(
      options.structural
        ? {
            shouldHandleStructuralBlockPaste: () => true,
            onStructuralBlockPaste: (blocks) => {
              structural.push([...blocks]);
              return true;
            },
          }
        : {},
    ),
  });
  const rendered = renderWithAppMaitai(
    <BlockNoteView
      editor={editor}
      formattingToolbar={false}
      linkToolbar={false}
      slashMenu={false}
      sideMenu={false}
      tableHandles={false}
    />,
  );
  try {
    await act(async () => {
      await settleEditor();
      editor.setTextCursorPosition(editor.document[0]!, "start");
      editor.focus();
      await settleEditor();
    });
    const view = editor.prosemirrorView;
    if (!view) throw new Error("Expected a mounted editor view");
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", plain);
    if (options.internal) {
      data.setData(
        "blocknote/html",
        editor.blocksToClipboardHTML([
          { type: "paragraph", content: "First" },
          { type: "paragraph", content: "" },
          { type: "paragraph", content: "Last" },
        ]),
      );
    }
    await act(async () => {
      view.dom.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
      await settleEditor();
    });
    return { blocks: editor.document, structural };
  } finally {
    rendered.unmount();
    editor._tiptapEditor.destroy();
  }
}

describe("rich HTML paste spacing in Chromium", () => {
  test.each(richHtmlSpacerFixtures)("removes spacers from $source", async ({ html }) => {
    const { blocks } = await pasteHtml(html, richHtmlPlainText);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(blocks.map((block) => block.content)).toEqual(
      ["第一行", "第二行", "第三行"].map((text) => [{ type: "text", text, styles: {} }]),
    );
    expect(writeMarkdown(blocks)).toBe(richHtmlPageMarkdown);
  });

  test("keeps interior breaks in one paragraph", async () => {
    const { blocks } = await pasteHtml(
      "<span>第一行<br>第二行<br><br>第三行</span>",
      richHtmlPlainText,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toEqual([
      { type: "text", text: "第一行\n第二行\n\n第三行", styles: {} },
    ]);
    expect(writeMarkdown(blocks)).toBe("第一行\n第二行\n<br>第三行");
  });

  test("preserves content spacing next to removed edge breaks", async () => {
    const { blocks } = await pasteHtml(
      "<p><br>&nbsp;&nbsp;Indented&nbsp;&nbsp;<br></p>",
      "\n  Indented  \n",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toEqual([
      { type: "text", text: "\u00a0\u00a0Indented\u00a0\u00a0", styles: {} },
    ]);
  });

  test("keeps marks, links, lists, images and code while trimming paragraph edges", async () => {
    const { blocks } = await pasteHtml(
      '<p><b><br>Bold</b> <a href="https://example.com"><i>link<br></i></a></p><p><br></p><ul><li>Item</li></ul><p><img src="https://example.com/image.png" alt="Image"></p><pre><code>\ncode\n\n</code></pre>',
      "Bold link\nItem\ncode",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "bulletListItem",
      "image",
      "codeBlock",
    ]);
    expect(blocks[0]?.content).toEqual([
      { type: "text", text: "Bold", styles: { bold: true } },
      { type: "text", text: " ", styles: {} },
      {
        type: "link",
        href: "https://example.com",
        content: [{ type: "text", text: "link", styles: { italic: true } }],
      },
    ]);
    expect(blocks[1]?.content).toEqual([{ type: "text", text: "Item", styles: {} }]);
    expect(blocks[2]?.props).toMatchObject({ url: "https://example.com/image.png" });
    expect(blocks[3]?.content).toEqual([{ type: "text", text: "\ncode\n\n", styles: {} }]);
  });

  test("uses the same spacing rule for external structural replacements", async () => {
    const { structural } = await pasteHtml(richHtmlSpacerFixtures[0].html, richHtmlPlainText, {
      structural: true,
    });
    expect(structural).toHaveLength(1);
    expect(writeMarkdown(structural[0]!)).toBe(richHtmlPageMarkdown);
  });

  test("ignores an all-spacer paste without changing existing content", async () => {
    const { blocks } = await pasteHtml("<p><br></p><div>&nbsp;</div><p></p>", "\n\n", {
      initialText: "Keep",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toEqual([{ type: "text", text: "Keep", styles: {} }]);
  });

  test("preserves literal text when pasting into a Code Block", async () => {
    const { blocks } = await pasteHtml(richHtmlSpacerFixtures[0].html, richHtmlPlainText, {
      code: true,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toEqual([{ type: "text", text: richHtmlPlainText, styles: {} }]);
  });

  test("preserves empty paragraphs in internal clipboard fragments", async () => {
    const { blocks } = await pasteHtml("<p>First</p><p><br></p><p>Last</p>", "First\n\nLast", {
      internal: true,
    });
    expect(blocks.map((block) => block.content)).toEqual([
      [{ type: "text", text: "First", styles: {} }],
      [],
      [{ type: "text", text: "Last", styles: {} }],
    ]);
  });
});
