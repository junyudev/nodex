import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/shadcn";
import { TextSelection } from "@tiptap/pm/state";
import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import { writeMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";
import { createNfmPasteHandler } from "./nfm-editor-extensions";
import { nfmSchema } from "./nfm-schema";

const settleEditor = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

/** Pastes a copy at `offset` in a Page holding one paragraph, and returns the Page's Blocks. */
async function pasteInto(text: string, offset: number, copy: Record<string, string>) {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    initialContent: [{ id: "target", type: "paragraph", content: text }],
    pasteHandler: createNfmPasteHandler(),
  });
  const view = render(
    <BlockNoteView editor={editor} formattingToolbar={false} sideMenu={false} slashMenu={false} />,
  );
  try {
    await act(settleEditor);
    const pm = editor.prosemirrorView!;
    await act(async () => {
      // The paragraph's text starts inside its blockGroup, blockContainer and paragraph.
      pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, 3 + offset)));
      const clipboardData = new DataTransfer();
      for (const [type, value] of Object.entries(copy)) clipboardData.setData(type, value);
      pm.dom.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
      await settleEditor();
    });
    return editor.document as unknown as MarkdownBlock[];
  } finally {
    view.unmount();
    editor._tiptapEditor.destroy();
  }
}

type Inline = { readonly type: string; readonly text?: string; readonly content?: Inline[] };
const inlineText = (items: readonly Inline[]): string =>
  items.map((item) => item.text ?? inlineText(item.content ?? [])).join("");
const texts = (blocks: readonly MarkdownBlock[]) =>
  blocks.map((block) => inlineText(block.content as Inline[]));

describe("pasting text into a Page", () => {
  test("plain text that is not Markdown becomes a Block per line, exactly as written", async () => {
    const blocks = await pasteInto("", 0, {
      "text/plain": "第一行\n第二行\n\n  缩进\t和  两个空格\nsee https://e.x",
    });
    expect(blocks.map((block) => block.type)).toEqual(Array(4).fill("paragraph"));
    expect(texts(blocks)).toEqual(["第一行", "第二行", "  缩进\t和  两个空格", "see https://e.x"]);
    // Its web address still links.
    expect((blocks[3]!.content as Inline[]).map((item) => item.type)).toEqual(["text", "link"]);
  });

  test("lines pasted inside a paragraph split it where the paste goes", async () => {
    expect(texts(await pasteInto("ABCD", 2, { "text/plain": "one\ntwo" }))).toEqual([
      "ABone",
      "twoCD",
    ]);
    expect(texts(await pasteInto("ABCD", 2, { "text/plain": "one" }))).toEqual(["ABoneCD"]);
  });

  test("plain text written in Markdown becomes its Blocks, one newline breaking a line", async () => {
    const blocks = await pasteInto("", 0, {
      "text/plain": "# 标题\n\n- 一\n- 二\n\n**粗体**正文\n换行",
    });
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "bulletListItem",
      "bulletListItem",
      "paragraph",
    ]);
    expect(writeMarkdown(blocks)).toBe("# 标题\n\n- 一\n- 二\n\n**粗体**正文\n换行");
    expect(writeMarkdown(await pasteInto("ABCD", 2, { "text/plain": "**粗体**" }))).toBe(
      "AB**粗体**CD",
    );
  });

  test("Markdown keeps the spaces it writes", async () => {
    expect(
      writeMarkdown(
        await pasteInto("", 0, { "text/markdown": "`a  b`\tand  two", "text/plain": "" }),
      ),
    ).toBe("`a  b`\tand  two");
  });

  test("rich text decides how its Markdown-looking plain text pastes", async () => {
    const blocks = await pasteInto("", 0, {
      "text/html": "<p>- not a list</p>",
      "text/plain": "- not a list\n- either",
    });
    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(texts(blocks)).toEqual(["- not a list"]);
  });
});
