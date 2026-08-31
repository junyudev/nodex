import { BlockNoteEditor, getNodeById, MultipleNodeSelection } from "@blocknote/core";
import { canInsertInlineMath } from "@blocknote/math-block";
import { BlockNoteViewRaw } from "@blocknote/react";
import { TextSelection } from "@tiptap/pm/state";
import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { contrastRatio, getPaintedBackground, parseComputedColor } from "@/test/color-contrast";
import { pressProseMirrorShortcut } from "@/test/prosemirror-shortcut";
import { inlineTintedChipVariants } from "@/components/ui/inline-tinted-chip";
import { nfmSchema } from "./nfm-schema";
import { createNfmEditorExtensions } from "./nfm-editor-extensions";
import "katex/dist/katex.min.css";
import "../../../globals.css";

const mountedEditors: BlockNoteEditor<any, any, any>[] = [];
const mountedViews: RenderResult[] = [];

afterEach(() => {
  for (const view of mountedViews.splice(0)) view.unmount();
  for (const editor of mountedEditors.splice(0)) editor._tiptapEditor.destroy();
  document.body.replaceChildren();
});

async function mountMath(source: string, theme: "light" | "dark" = "light") {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    extensions: createNfmEditorExtensions(),
    initialContent: [
      { id: "math-1", type: "mathBlock", content: source },
      { id: "after-math", type: "paragraph", content: "following text" },
    ],
  });
  mountedEditors.push(editor);
  const view = render(
    <div className={`${theme === "dark" ? "dark " : ""}nfm-editor bg-[var(--background)]`}>
      <BlockNoteViewRaw
        editor={editor}
        theme={theme}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
    </div>,
  );
  mountedViews.push(view);
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return { editor, host: view.container };
}

async function mountInlineMath(source: string, theme: "light" | "dark" = "light") {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    extensions: createNfmEditorExtensions(),
    initialContent: [
      {
        type: "paragraph",
        content: ["Inline energy is ", { type: "math", content: source }, "."],
      },
    ],
  });
  mountedEditors.push(editor);
  const view = render(
    <div className={`${theme === "dark" ? "dark " : ""}nfm-editor bg-[var(--background)]`}>
      <BlockNoteViewRaw
        editor={editor}
        theme={theme}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
    </div>,
  );
  mountedViews.push(view);
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return { editor, host: view.container };
}

async function mountParagraph(content = "") {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    extensions: createNfmEditorExtensions(),
    initialContent: [{ id: "paragraph-1", type: "paragraph", content }],
  });
  mountedEditors.push(editor);
  const view = render(
    <div className="nfm-editor bg-[var(--background)]">
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
    </div>,
  );
  mountedViews.push(view);
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  editor.setTextCursorPosition("paragraph-1", "end");
  editor.focus();
  return { editor, host: view.container };
}

function simulateTextInput(editor: BlockNoteEditor<any, any, any>, text: string) {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  const { from, to } = view.state.selection;
  const defaultTransaction = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (handler) =>
    handler(view, from, to, text, defaultTransaction),
  );
  if (!handled) view.dispatch(defaultTransaction());
}

function typeString(editor: BlockNoteEditor<any, any, any>, text: string) {
  for (const character of text) simulateTextInput(editor, character);
}

interface ClipboardTestBlock {
  readonly id: string;
  readonly content?: unknown;
  readonly children?: readonly ClipboardTestBlock[];
}

function flattenClipboardTestBlocks(
  blocks: readonly ClipboardTestBlock[],
): readonly ClipboardTestBlock[] {
  return blocks.flatMap((block) => [block, ...flattenClipboardTestBlocks(block.children ?? [])]);
}

describe("NFM Equation surface in Chromium", () => {
  test.each([
    ["a complete Block copied from a collapsed caret", "block"],
    ["a selected inline range", "range"],
  ] as const)("round-trips content after an Inline Equation from %s", async (_label, mode) => {
    const { editor } = await mountInlineMath("E = mc^2");
    const sourceBlockId = editor.document[0]!.id;
    editor.insertBlocks(
      [{ id: "paste-target", type: "paragraph", content: "Paste target" }],
      editor.document[0]!,
      "after",
    );
    const view = editor.prosemirrorView!;
    if (mode === "block") {
      editor.setTextCursorPosition(sourceBlockId, "end");
    } else {
      const position = getNodeById(editor.document[0]!.id, view.state.doc);
      const inlineContent = position?.node.firstChild;
      if (!position || !inlineContent) throw new Error("Inline Equation Block did not mount");
      const from = position.posBeforeNode + 2;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, from, from + inlineContent.content.size),
        ),
      );
    }
    editor.focus();

    const clipboardData = new DataTransfer();
    await act(async () => {
      view.dom.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      editor.setTextCursorPosition("paste-target", "end");
      view.dom.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      await Promise.resolve();
    });

    const clipboardHtml = clipboardData.getData("blocknote/html");
    expect(clipboardHtml).not.toContain("bn-source-block-popup");
    expect(clipboardHtml).toContain('data-inline-content-type="math"');
    if (mode === "block") {
      expect(clipboardHtml).toContain('data-pm-slice="0 0 -1 []"');
      expect(editor.getBlock("paste-target")?.content).toEqual([
        { type: "text", text: "Paste target", styles: {} },
      ]);
      const pastedBlocks = flattenClipboardTestBlocks(editor.document).filter(
        (block) => block.id !== sourceBlockId && block.id !== "paste-target",
      );
      expect(pastedBlocks).toHaveLength(1);
      expect(pastedBlocks[0]?.content).toEqual([
        { type: "text", text: "Inline energy is ", styles: {} },
        { type: "math", props: {}, content: "E = mc^2" },
        { type: "text", text: ".", styles: {} },
      ]);
      return;
    }

    expect(clipboardHtml).not.toContain("data-pm-slice");
    expect(editor.getBlock("paste-target")?.content).toEqual([
      { type: "text", text: "Paste targetInline energy is ", styles: {} },
      { type: "math", props: {}, content: "E = mc^2" },
      { type: "text", text: ".", styles: {} },
    ]);
  });

  test("converts a complete double-dollar expression inline without opening the popup", async () => {
    const { editor, host } = await mountParagraph();

    await act(async () => {
      typeString(editor, "$$x + y$$");
      await Promise.resolve();
    });

    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "x + y" },
    ]);
    expect(host.querySelector('.bn-preview-with-source-popup[data-open="true"]')).toBeNull();

    await act(async () => {
      typeString(editor, " after");
      await Promise.resolve();
    });
    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "x + y" },
      { type: "text", text: " after", styles: {} },
    ]);
  });

  test.each(["$$ ", String.raw`\[ `])(
    "keeps display delimiter %s as paragraph text",
    async (delimiter) => {
      const { editor } = await mountParagraph();

      await act(async () => {
        typeString(editor, delimiter);
        await Promise.resolve();
      });

      expect(editor.getBlock("paragraph-1")).toMatchObject({
        type: "paragraph",
        content: [{ type: "text", text: delimiter, styles: {} }],
      });
    },
  );

  test("preserves a valid opening boundary and keeps an adjacent expression literal", async () => {
    const separated = await mountParagraph("before ");
    await act(async () => {
      typeString(separated.editor, "$$x$$");
      await Promise.resolve();
    });
    expect(separated.editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "text", text: "before ", styles: {} },
      { type: "math", props: {}, content: "x" },
    ]);

    const adjacent = await mountParagraph("before");
    await act(async () => {
      typeString(adjacent.editor, "$$x$$");
      await Promise.resolve();
    });
    expect(adjacent.editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "text", text: "before$$x$$", styles: {} },
    ]);
  });

  test("restores typed delimiters with Undo and deletes the Equation with Backspace", async () => {
    const { editor } = await mountParagraph();

    await act(async () => {
      typeString(editor, "$$x$$");
      await Promise.resolve();
    });
    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "x" },
    ]);

    await act(async () => {
      expect(editor.undo()).toBe(true);
      await Promise.resolve();
    });
    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "text", text: "$$x$$", styles: {} },
    ]);

    await act(async () => {
      expect(editor.redo()).toBe(true);
      await Promise.resolve();
    });
    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "x" },
    ]);

    await act(async () => {
      expect(pressProseMirrorShortcut(editor, { key: "Backspace", code: "Backspace" })).toBe(true);
      await Promise.resolve();
    });
    expect(editor.getBlock("paragraph-1")?.content).toEqual([]);
  });

  test("inserts or converts an Inline Equation with Mod-Shift-E and selects its source", async () => {
    const { editor } = await mountParagraph("x^2");
    const view = editor.prosemirrorView!;
    const selectionStart = view.state.selection.from - 3;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, selectionStart, selectionStart + 3),
      ),
    );
    expect(canInsertInlineMath(editor)).toBe(true);

    await act(async () => {
      expect(
        pressProseMirrorShortcut(editor, {
          key: "E",
          code: "KeyE",
          modKey: true,
          shiftKey: true,
        }),
      ).toBe(true);
      await Promise.resolve();
    });

    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "x^2" },
    ]);
    expect(await screen.findByLabelText("Equation (LaTeX)")).toBeVisible();
    expect(document.getSelection()?.toString()).toBe("x^2");
  });

  test("opens a new empty Inline Equation from Mod-Shift-E", async () => {
    const { editor, host } = await mountParagraph();
    expect(canInsertInlineMath(editor)).toBe(true);

    await act(async () => {
      expect(
        pressProseMirrorShortcut(editor, {
          key: "E",
          code: "KeyE",
          modKey: true,
          shiftKey: true,
        }),
      ).toBe(true);
      await Promise.resolve();
    });

    expect(editor.getBlock("paragraph-1")?.content).toEqual([
      { type: "math", props: {}, content: "" },
      { type: "text", text: " ", styles: {} },
    ]);
    expect(host.querySelector('.bn-preview-with-source-popup[data-open="true"]')).toBeVisible();
  });

  test("opens a Block Equation with its complete source selected", async () => {
    const source = String.raw`\frac{a}{b}`;
    const { host } = await mountMath(source);
    const preview = await waitFor(() => {
      const element = host.querySelector<HTMLElement>(".bn-preview-container");
      if (!element?.querySelector("math")) throw new Error("MathML preview did not render");
      return element;
    });

    await act(async () => userEvent.click(preview));
    const sourceEditor = await screen.findByLabelText("Equation (LaTeX)");
    expect(sourceEditor.closest("pre")?.getAttribute("aria-hidden")).toBeNull();
    expect(document.getSelection()?.toString()).toBe(source);
  });

  test("keeps invalid TeX editable and prevents committing it from Done", async () => {
    const { host } = await mountMath(String.raw`\frac{broken`);
    const errorPreview = await waitFor(() => {
      const element = host.querySelector<HTMLElement>(".bn-preview-placeholder-error");
      if (!element) throw new Error("Equation error preview did not render");
      return element;
    });

    await act(async () => userEvent.click(errorPreview));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    expect(screen.getByLabelText("Equation (LaTeX)")).toHaveAttribute("aria-invalid", "true");
  });

  test("keeps the dark error surface and highlighted TeX source readable", async () => {
    const { host } = await mountMath(String.raw`\frac{broken`, "dark");
    const errorPreview = await waitFor(() => {
      const element = host.querySelector<HTMLElement>(".bn-preview-placeholder-error");
      if (!element) throw new Error("Equation error preview did not render");
      return element;
    });
    const previewBackground = getPaintedBackground(errorPreview);
    const previewForeground = parseComputedColor(getComputedStyle(errorPreview).color);
    const previewContainer = errorPreview.closest<HTMLElement>(".bn-preview-container")!;

    expect(contrastRatio(previewForeground, previewBackground)).toBeGreaterThanOrEqual(4.5);
    expect(errorPreview).toHaveTextContent("KaTeX parse error:");
    expect(
      Math.abs(
        errorPreview.getBoundingClientRect().width - previewContainer.getBoundingClientRect().width,
      ),
    ).toBeLessThanOrEqual(1);

    await act(async () => userEvent.click(errorPreview));
    const sourceEditor = await screen.findByLabelText("Equation (LaTeX)");
    const sourceBackground = getPaintedBackground(sourceEditor);
    const tokens = await waitFor(() => {
      const highlightedTokens = [...sourceEditor.querySelectorAll<HTMLElement>(".shiki")];
      if (highlightedTokens.length === 0) throw new Error("TeX highlighting did not render");
      return highlightedTokens;
    });

    for (const token of tokens) {
      const foreground = parseComputedColor(getComputedStyle(token).color);
      expect(
        contrastRatio(foreground, sourceBackground),
        `TeX token contrast for ${JSON.stringify(token.textContent)}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("aligns an empty Inline Equation chip to the surrounding text baseline", async () => {
    const { host } = await mountInlineMath("", "dark");
    const inline = await waitFor(() => {
      const element = host.querySelector<HTMLElement>(".bn-inline-content-section");
      if (!element) throw new Error("Inline Equation did not render");
      return element;
    });
    const paragraph = inline.closest("p")!;
    const leadingText = paragraph.firstChild!;
    const placeholder = inline.querySelector<HTMLElement>(".bn-preview-placeholder")!;
    const label = placeholder.querySelector<HTMLElement>(".bn-preview-placeholder-text")!;
    const labelText = label.firstChild!;
    const textRange = document.createRange();
    textRange.selectNodeContents(leadingText);
    const labelRange = document.createRange();
    labelRange.selectNodeContents(labelText);

    expect(
      Math.abs(
        labelRange.getBoundingClientRect().bottom - textRange.getBoundingClientRect().bottom,
      ),
    ).toBeLessThanOrEqual(0.75);
    expect(placeholder).toHaveTextContent("New equation");
    expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(paragraph).fontSize);
    expect(getComputedStyle(label).lineHeight).toBe(getComputedStyle(paragraph).lineHeight);

    const primitiveProbe = document.createElement("span");
    primitiveProbe.className = inlineTintedChipVariants({ tone: "neutral" });
    primitiveProbe.textContent = "Chip geometry probe";
    paragraph.append(primitiveProbe);

    const placeholderStyle = getComputedStyle(placeholder);
    const primitiveStyle = getComputedStyle(primitiveProbe);
    expect({
      borderRadius: placeholderStyle.borderRadius,
      color: placeholderStyle.color,
      backgroundColor: placeholderStyle.backgroundColor,
      paddingInlineStart: placeholderStyle.paddingInlineStart,
      paddingInlineEnd: placeholderStyle.paddingInlineEnd,
    }).toEqual({
      borderRadius: primitiveStyle.borderRadius,
      color: primitiveStyle.color,
      backgroundColor: primitiveStyle.backgroundColor,
      paddingInlineStart: primitiveStyle.paddingInlineStart,
      paddingInlineEnd: primitiveStyle.paddingInlineEnd,
    });
    primitiveProbe.remove();
  });

  test("keeps an invalid Inline Equation as a compact in-flow chip", async () => {
    const { host } = await mountInlineMath("abc^", "dark");
    const inline = await waitFor(() => {
      const element = host.querySelector<HTMLElement>(".bn-inline-content-section");
      if (!element) throw new Error("Inline Equation did not render");
      return element;
    });
    const errorPreview = inline.querySelector<HTMLElement>(".bn-preview-placeholder-error")!;
    const label = errorPreview.querySelector<HTMLElement>(".bn-preview-placeholder-text")!;
    const paragraph = inline.closest("p")!;

    expect(errorPreview).toHaveTextContent("Invalid equation");
    expect(errorPreview.getBoundingClientRect().width).toBeLessThan(
      paragraph.getBoundingClientRect().width,
    );
    expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(paragraph).fontSize);
    expect(
      contrastRatio(
        parseComputedColor(getComputedStyle(errorPreview).color),
        getPaintedBackground(errorPreview),
      ),
    ).toBeGreaterThanOrEqual(4.5);

    await act(async () => userEvent.click(errorPreview));
    const sourceEditor = await screen.findByLabelText("Equation (LaTeX)");
    const sourceStyle = getComputedStyle(sourceEditor);
    expect(parseComputedColor(sourceStyle.backgroundColor).alpha).toBe(0);
    expect(sourceStyle.padding).toBe("0px");
    expect(sourceStyle.borderRadius).toBe("0px");
    expect(document.getSelection()?.toString()).toBe("abc^");
  });

  test("deletes a Block Equation when the complete Block is selected", async () => {
    const { editor } = await mountMath("x = 1");
    const view = editor.prosemirrorView!;
    const position = getNodeById("math-1", view.state.doc);
    if (!position) throw new Error("Block Equation did not mount");

    await act(async () => {
      view.dispatch(
        view.state.tr.setSelection(
          MultipleNodeSelection.create(
            view.state.doc,
            position.posBeforeNode,
            position.posBeforeNode + position.node.nodeSize,
          ),
        ),
      );
      fireEvent.keyDown(view.dom, { key: "Backspace", code: "Backspace" });
      await Promise.resolve();
    });

    expect(editor.getBlock("math-1")).toBeUndefined();
    expect(editor.getBlock("after-math")?.type).toBe("paragraph");
  });

  test("keeps both sides of a Block Equation atomic on Backspace", async () => {
    const { editor } = await mountMath("x = 1");
    const before = editor.document;

    await act(async () => {
      editor.setTextCursorPosition("math-1", "start");
      editor.focus();
      fireEvent.keyDown(editor.prosemirrorView!.dom, { key: "Backspace", code: "Backspace" });
      await Promise.resolve();
    });
    expect(editor.document).toEqual(before);

    await act(async () => {
      editor.setTextCursorPosition("after-math", "start");
      editor.focus();
      fireEvent.keyDown(editor.prosemirrorView!.dom, { key: "Backspace", code: "Backspace" });
      await Promise.resolve();
    });
    expect(editor.document).toEqual(before);
  });
});
