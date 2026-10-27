import { BlockNoteEditor } from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { nfmSchema } from "./nfm-schema";
import { createNfmEditorPlaceholders } from "./nfm-editor-placeholders";
import "../../../globals.css";

installRendererThemeFixture();

const mountedEditors: BlockNoteEditor<any, any, any>[] = [];

afterEach(() => {
  for (const editor of mountedEditors.splice(0)) editor._tiptapEditor.destroy();
  document.body.replaceChildren();
});

const mountEditor = (
  initialContent: PartialBlock<any, any, any>[],
  placeholders?: Record<string, string | undefined>,
) => {
  const editor = BlockNoteEditor.create({ schema: nfmSchema, initialContent, placeholders });
  const host = document.createElement("div");
  host.className = "nfm-editor";
  document.body.append(host);
  editor.mount(host);
  mountedEditors.push(editor);
  return { editor, host };
};

describe("Block children contract in Chromium", () => {
  test("prevents nesting beneath atomic Blocks and allows semantic containers", () => {
    const { editor } = mountEditor([
      { id: "atomic", type: "codeBlock", content: "const value = 1" },
      { id: "candidate", type: "paragraph", content: "Candidate" },
    ]);

    editor.setTextCursorPosition("candidate", "start");
    expect(editor.canNestBlock()).toBe(false);
    expect(editor.nestBlock()).toBeUndefined();
    expect(editor.getParentBlock("candidate")).toBeUndefined();

    editor.updateBlock("atomic", { type: "paragraph", content: "Container" });
    expect(editor.canNestBlock()).toBe(true);
    expect(editor.nestBlock()).toBeUndefined();
    expect(editor.getParentBlock("candidate")?.id).toBe("atomic");
  });

  test("normal headings are leaves while toggle headings accept children", () => {
    const { editor } = mountEditor([
      { id: "heading", type: "heading", props: { level: 2 }, content: "Heading" },
      { id: "candidate", type: "paragraph", content: "Candidate" },
    ]);

    editor.setTextCursorPosition("candidate", "start");
    expect(editor.canNestBlock()).toBe(false);
    editor.updateBlock("heading", { props: { isToggleable: true } });
    expect(editor.canNestBlock()).toBe(true);
  });

  test.each(["light", "dark"] as const)(
    "guards replacement and encloses children in %s",
    (theme) => {
      applyRendererThemeForTest(theme);
      const { editor, host } = mountEditor([
        {
          id: "callout",
          type: "callout",
          content: "Callout",
          children: [{ id: "inside", type: "paragraph", content: "Inside" }],
        },
        {
          id: "quote",
          type: "quote",
          content: "Quote",
          children: [{ id: "quoted", type: "paragraph", content: "Quoted child" }],
        },
        { id: "atomic", type: "divider" },
      ]);

      const callout = host.querySelector<HTMLElement>('.bn-block[data-id="callout"]');
      const calloutChild = host.querySelector<HTMLElement>('.bn-block[data-id="inside"]');
      expect(callout?.dataset.contentType).toBe("callout");
      expect(callout?.dataset.childrenLayout).toBe("enclosed");
      expect(callout?.dataset.acceptsChildren).toBe("true");
      expect(callout?.contains(calloutChild ?? null)).toBe(true);
      expect(getComputedStyle(callout!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

      const quote = host.querySelector<HTMLElement>('.bn-block[data-id="quote"]');
      const quotedChild = host.querySelector<HTMLElement>('.bn-block[data-id="quoted"]');
      expect(quote?.dataset.childrenLayout).toBe("enclosed");
      expect(quote?.contains(quotedChild ?? null)).toBe(true);
      expect(getComputedStyle(quote!, "::before").width).toBe("3px");

      editor.replaceBlocks(
        ["atomic"],
        [
          {
            id: "atomic",
            type: "divider",
            children: [{ id: "forbidden", type: "paragraph", content: "Forbidden" }],
          },
        ],
      );
      expect(editor.getBlock("forbidden")).toBeUndefined();
      expect(editor.getBlock("atomic")?.children).toHaveLength(0);
    },
  );

  test("matches the quote rhythm while keeping its rule coupled to text color", () => {
    const { host } = mountEditor([
      {
        id: "quote",
        type: "quote",
        props: { textColor: "red" },
        content: "quote-line1\nquote-line2",
      },
    ]);

    const quote = host.querySelector<HTMLElement>('.bn-block[data-id="quote"]')!;
    const quoteContent = quote.querySelector<HTMLElement>(
      ':scope > .bn-block-content[data-content-type="quote"]',
    )!;
    const blockquote = quoteContent.querySelector<HTMLElement>("blockquote")!;
    const quoteStyle = getComputedStyle(quote);
    const quoteRuleStyle = getComputedStyle(quote, "::before");
    const quoteContentStyle = getComputedStyle(quoteContent);
    const blockquoteStyle = getComputedStyle(blockquote);

    expect(quoteStyle.paddingBlockStart).toBe("8px");
    expect(quoteStyle.paddingBlockEnd).toBe("8px");
    expect(quoteStyle.paddingInlineStart).toBe("33px");
    expect(quoteStyle.paddingInlineEnd).toBe("30px");
    expect(quoteRuleStyle.insetBlockStart).toBe("8px");
    expect(quoteRuleStyle.insetBlockEnd).toBe("8px");
    expect(quoteRuleStyle.insetInlineStart).toBe("8px");
    expect(quoteRuleStyle.width).toBe("3px");
    expect(quoteRuleStyle.backgroundColor).toBe(quoteStyle.color);
    expect(quoteContentStyle.paddingBlockStart).toBe("0px");
    expect(quoteContentStyle.paddingInlineStart).toBe("0px");
    expect(blockquoteStyle.color).toBe(quoteStyle.color);
    expect(blockquoteStyle.fontSize).toBe("14px");
    expect(blockquoteStyle.lineHeight).toBe("22.75px");
    expect(quote.getBoundingClientRect().height).toBe(61.5);
    expect(blockquote.getBoundingClientRect().height).toBe(45.5);
  });

  test("keeps an empty focused quote on one line with a local placeholder", () => {
    const { editor, host } = mountEditor(
      [{ id: "quote", type: "quote", content: "" }],
      createNfmEditorPlaceholders("Add description…"),
    );
    editor.setTextCursorPosition("quote", "start");

    const quote = host.querySelector<HTMLElement>('.bn-block[data-id="quote"]')!;
    const quoteContent = quote.querySelector<HTMLElement>(
      ':scope > .bn-block-content[data-content-type="quote"]',
    )!;
    const blockquote = quoteContent.querySelector<HTMLElement>("blockquote")!;
    const placeholderStyle = getComputedStyle(quoteContent, "::after");

    expect(quoteContent.dataset.isEmptyAndFocused).toBe("true");
    expect(placeholderStyle.content).toBe('"Empty quote"');
    expect(placeholderStyle.position).toBe("absolute");
    expect(placeholderStyle.insetInlineStart).toBe("0px");
    expect(placeholderStyle.insetInlineEnd).toBe("0px");
    expect(placeholderStyle.fontStyle).toBe("normal");
    expect(placeholderStyle.whiteSpace).toBe("nowrap");
    expect(quoteContent.scrollWidth).toBe(quoteContent.clientWidth);
    expect(quote.getBoundingClientRect().height).toBe(38.75);
    expect(blockquote.getBoundingClientRect().height).toBe(22.75);
  });
});
