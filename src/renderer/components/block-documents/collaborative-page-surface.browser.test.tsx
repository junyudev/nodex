import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import * as Y from "yjs";
import {
  readPortableRichTextFromYText,
  replaceYTextWithPortableRichText,
} from "../../../shared/block-documents/portable-rich-text";
import {
  isRichTitleDomSelectionAtVerticalBoundary,
  readRichTitleDomSelection,
  restoreRichTitleDomSelection,
} from "@/lib/rich-title-editor-dom";
import { CollaborativePageTitle } from "./collaborative-page-title";
import { dispatchFocusedHistory } from "@/lib/focused-history";
import { ownsNfmEditorEvent } from "../board/editor/nfm-editor-event-owner";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { nfmSchema } from "@/components/board/editor/nfm-schema";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  applyTypographyPreferences,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  type TypographyPreferences,
} from "@/lib/typography-preferences";
import "@/globals.css";

describe("collaborative page title", () => {
  const createTitle = (value: string) => {
    const document = new Y.Doc({ guid: "browser-rich-title" });
    const title = document.getText("title");
    title.insert(0, value);
    return { document, title };
  };

  const selectAllShortcut = async (): Promise<void> => {
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}a{/${modifier}}`);
  };

  describe("CollaborativePageTitle in Chromium", () => {
    test("a focused title routes native Undo to the latest title interaction in its content realm", async () => {
      const first = createTitle("First");
      const second = createTitle("Second");
      const historyScope = {
        libraryId: "title-browser-library",
        storeEpoch: "title-browser-epoch",
        routingContext: { kind: "library" as const },
      };
      const view = render(
        <>
          <CollaborativePageTitle
            title={first.title}
            historyScope={historyScope}
            aria-label="First title"
          />
          <CollaborativePageTitle
            title={second.title}
            historyScope={historyScope}
            aria-label="Second title"
          />
        </>,
      );
      const a = view.getByRole("textbox", { name: "First title" }) as HTMLDivElement;
      const b = view.getByRole("textbox", { name: "Second title" }) as HTMLDivElement;
      try {
        await act(async () => {
          a.focus();
          restoreRichTitleDomSelection(a, first.title.length, first.title.length);
          await userEvent.keyboard(" A");
          b.focus();
          restoreRichTitleDomSelection(b, second.title.length, second.title.length);
          await userEvent.keyboard(" B");
          a.focus();
          dispatchFocusedHistory("undo");
          await Promise.resolve();
        });
        expect(first.title.toString()).toBe("First A");
        expect(second.title.toString()).toBe("Second");
        expect(document.activeElement).toBe(a);
        await act(async () => {
          dispatchFocusedHistory("redo");
          await Promise.resolve();
        });
        expect(second.title.toString()).toBe("Second B");
        expect(document.activeElement).toBe(a);
      } finally {
        view.unmount();
        first.document.destroy();
        second.document.destroy();
      }
    });

    test("native history commands belong to the focused title, including redo", async () => {
      const { document, title } = createTitle("Title");
      const view = render(
        <div className="nfm-editor">
          <div {...embeddedEditorSelectionContextAttributes}>
            <CollaborativePageTitle title={title} aria-label="History title" />
          </div>
        </div>,
      );
      const parent = view.container.firstElementChild as HTMLElement;
      const parentHistory = vi.fn();
      parent.addEventListener(
        "beforeinput",
        (event) => {
          if (!ownsNfmEditorEvent(parent, event.target)) return;
          parentHistory();
          event.preventDefault();
          event.stopPropagation();
        },
        true,
      );
      const editor = view.getByRole("textbox", { name: "History title" }) as HTMLDivElement;
      try {
        await act(async () => {
          editor.focus();
          restoreRichTitleDomSelection(editor, title.length, title.length);
          await userEvent.keyboard(" B");
        });
        expect(title.toString()).toBe("Title B");
        await act(async () => {
          dispatchFocusedHistory("undo");
          await Promise.resolve();
        });
        expect(title.toString()).toBe("Title");
        await act(async () => {
          dispatchFocusedHistory("redo");
          await Promise.resolve();
        });
        expect(title.toString()).toBe("Title B");
        expect(parentHistory).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        document.destroy();
      }
    });

    test("selects the complete title on the first select-all command", async () => {
      const { document, title } = createTitle("Nested Page");
      const view = render(<CollaborativePageTitle title={title} aria-label="Nested title" />);
      const editor = view.getByRole("textbox", { name: "Nested title" }) as HTMLDivElement;

      await act(async () => {
        editor.focus();
        restoreRichTitleDomSelection(editor, 3, 3);
        await selectAllShortcut();
      });

      expect(readRichTitleDomSelection(editor)).toMatchObject({
        start: 0,
        end: title.length,
      });
      document.destroy();
    });

    test("detects the first and last rendered title lines rather than logical offsets", async () => {
      const { document, title } = createTitle(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
      );
      const view = render(
        <div style={{ width: 120 }}>
          <CollaborativePageTitle title={title} />
        </div>,
      );
      const editor = view.getByRole("textbox", { name: "Page title" }) as HTMLDivElement;
      const caretTopByIndex: number[] = [];

      await act(async () => {
        editor.focus();
        for (let index = 0; index <= title.length; index += 1) {
          restoreRichTitleDomSelection(editor, index, index);
          const selection = editor.ownerDocument.getSelection();
          const rect = selection?.rangeCount
            ? selection.getRangeAt(0).getBoundingClientRect()
            : null;
          caretTopByIndex.push(rect?.top ?? 0);
        }
      });

      const lastLineTop = Math.max(...caretTopByIndex);
      const lastLineIndex = caretTopByIndex.findIndex((top) => top === lastLineTop);
      expect(new Set(caretTopByIndex).size).toBeGreaterThan(1);
      expect(lastLineIndex).toBeGreaterThan(0);
      expect(lastLineIndex).toBeLessThan(title.length);

      restoreRichTitleDomSelection(editor, lastLineIndex, lastLineIndex);
      expect(isRichTitleDomSelectionAtVerticalBoundary(editor, "down")).toBe(true);
      expect(isRichTitleDomSelectionAtVerticalBoundary(editor, "up")).toBe(false);

      restoreRichTitleDomSelection(editor, 0, 0);
      expect(isRichTitleDomSelectionAtVerticalBoundary(editor, "up")).toBe(true);
      document.destroy();
    });

    test("keeps the caret after sequential local text input", async () => {
      const existing = createTitle("123");
      const existingView = render(
        <CollaborativePageTitle title={existing.title} aria-label="Existing title" />,
      );
      const existingEditor = existingView.getByRole("textbox", {
        name: "Existing title",
      }) as HTMLDivElement;

      await act(async () => {
        existingEditor.focus();
        restoreRichTitleDomSelection(existingEditor, 3, 3);
        await userEvent.keyboard("4");
      });

      expect(existing.title.toString()).toBe("1234");
      expect(readRichTitleDomSelection(existingEditor)).toMatchObject({
        anchor: 4,
        focus: 4,
      });

      const empty = createTitle("");
      const emptyView = render(
        <CollaborativePageTitle title={empty.title} aria-label="Empty title" />,
      );
      const emptyEditor = emptyView.getByRole("textbox", {
        name: "Empty title",
      }) as HTMLDivElement;

      await act(async () => {
        emptyEditor.focus();
        restoreRichTitleDomSelection(emptyEditor, 0, 0);
        await userEvent.keyboard("abcdefg");
      });

      expect(empty.title.toString()).toBe("abcdefg");
      expect(readRichTitleDomSelection(emptyEditor)).toMatchObject({
        anchor: 7,
        focus: 7,
      });
      existing.document.destroy();
      empty.document.destroy();
    });

    test("reconciles a non-cancelable browser DOM draft in draft coordinates", async () => {
      const { document, title } = createTitle("123");
      const view = render(<CollaborativePageTitle title={title} />);
      const editor = view.getByRole("textbox", {
        name: "Page title",
      }) as HTMLDivElement;
      const segment = editor.querySelector<HTMLElement>("[data-rich-title-kind='text']");
      const textNode = segment?.firstChild;
      if (!segment || !(textNode instanceof Text)) {
        throw new TypeError("Expected a rendered rich-title text segment");
      }

      await act(async () => {
        editor.focus();
        restoreRichTitleDomSelection(editor, 3, 3);
        editor.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: false,
            data: "4",
            inputType: "insertReplacementText",
          }),
        );
        textNode.insertData(3, "4");
        editor.ownerDocument.getSelection()?.setBaseAndExtent(textNode, 4, textNode, 4);
        editor.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "4",
            inputType: "insertReplacementText",
          }),
        );
        await Promise.resolve();
      });

      expect(title.toString()).toBe("1234");
      expect(readRichTitleDomSelection(editor)).toMatchObject({
        anchor: 4,
        focus: 4,
      });
      document.destroy();
    });

    test("restores a native selection through a remote Y.Text insertion", async () => {
      const { document, title } = createTitle("Hello Chromium");
      const view = render(<CollaborativePageTitle title={title} />);
      const editor = view.getByRole("textbox", { name: "Page title" }) as HTMLDivElement;

      await act(async () => {
        editor.focus();
        restoreRichTitleDomSelection(editor, 6, 14);
        document.transact(() => title.insert(0, "Remote "), "browser-remote");
        await Promise.resolve();
      });

      expect(editor.textContent).toBe("Remote Hello Chromium");
      expect(readRichTitleDomSelection(editor)).toMatchObject({
        start: 13,
        end: 21,
      });
      document.destroy();
    });

    test("applies native keyboard formatting and deletes an atomic mention as one unit", async () => {
      const { document, title } = createTitle("");
      replaceYTextWithPortableRichText(title, [
        { type: "text", text: "Bold", styles: {} },
        { type: "threadMention", uuid: "thread-browser" },
      ]);
      const view = render(<CollaborativePageTitle title={title} />);
      const editor = view.getByRole("textbox", { name: "Page title" }) as HTMLDivElement;

      await act(async () => {
        editor.focus();
        restoreRichTitleDomSelection(editor, 0, 4);
        fireEvent.keyDown(editor, { key: "b", metaKey: true });
        await Promise.resolve();
      });
      expect(readPortableRichTextFromYText(title)[0]).toMatchObject({
        type: "text",
        text: "Bold",
        styles: { bold: true },
      });

      await act(async () => {
        restoreRichTitleDomSelection(editor, 5, 5);
        await userEvent.keyboard("{Backspace}");
        await Promise.resolve();
      });
      expect(title.toString()).toBe("Bold");
      document.destroy();
    });

    test("rebases a browser composition draft over a concurrent remote edit", async () => {
      const { document, title } = createTitle("local title");
      const view = render(<CollaborativePageTitle title={title} />);
      const editor = view.getByRole("textbox", { name: "Page title" }) as HTMLDivElement;

      await act(async () => {
        editor.focus();
        fireEvent.compositionStart(editor);
        editor.textContent = "local composed title";
        editor.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertCompositionText",
            data: "composed ",
            isComposing: true,
          }),
        );
        document.transact(() => title.insert(0, "remote "), "browser-remote");
        fireEvent.compositionEnd(editor);
        await Promise.resolve();
      });

      expect(title.toString()).toBe("remote local composed title");
      expect(editor.textContent).toBe("remote local composed title");
      document.destroy();
    });
  });
});

describe("page typography", () => {
  installRendererThemeFixture();
  afterEach(() => document.body.replaceChildren());

  test("keeps Page prose, title, and source on their independent typography preferences", async () => {
    const document = new Y.Doc();
    const title = document.getText("title");
    title.insert(0, "Page typography");
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "prose",
          type: "paragraph",
          content: [
            { type: "text", text: "Paragraph ", styles: {} },
            { type: "text", text: "emphasis ", styles: { bold: true } },
            { type: "text", text: "inline source", styles: { code: true } },
          ],
        },
        ...([1, 2, 3, 4] as const).map((level) => ({
          id: `heading-${level}`,
          type: "heading" as const,
          props: { level },
          content: `Heading ${level}`,
        })),
        {
          id: "table",
          type: "table",
          content: { type: "tableContent", rows: [{ cells: ["Table content"] }] },
        },
        { id: "source", type: "codeBlock", props: { language: "text" }, content: "source" },
      ],
    });
    let preferences: TypographyPreferences = {
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      fonts: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
        light: { ui: "Arial", content: "Georgia", code: '"Courier New"' },
      },
    };
    const applyPreferences = () =>
      applyTypographyPreferences(
        window.document.documentElement,
        window.document.body,
        preferences,
        "light",
      );
    applyPreferences();
    const view = renderWithAppMaitai(
      <>
        <CollaborativePageTitle title={title} />
        <div className="nfm-editor">
          <BlockNoteViewRaw
            editor={editor}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          />
        </div>
      </>,
    );
    const element = (selector: string) => {
      const result = view.container.querySelector<HTMLElement>(selector);
      if (!result) throw new Error(`Missing Page surface ${selector}`);
      return result;
    };
    const style = (selector: string) => getComputedStyle(element(selector));
    const body = '[data-id="prose"] .bn-block-content';
    const heading = (level: number) => `[data-id="heading-${level}"] .bn-block-content`;
    const source = '[data-id="source"] pre';
    try {
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      await waitFor(() => expect(style(source).fontSize).toBe("12px"));

      expect(getComputedStyle(view.getByRole("textbox", { name: "Page title" })).fontSize).toBe(
        "28px",
      );
      expect(style(body).fontSize).toBe("14px");
      expect(style(body).lineHeight).toBe("22.75px");
      expect(style(body).fontWeight).toBe("430");
      expect(style(`${body} strong`).fontWeight).toBe("600");
      expect(style(body).fontFamily.startsWith("Georgia")).toBe(true);
      expect(style(`${body} code`).fontFamily.startsWith('"Courier New"')).toBe(true);
      expect(Number.parseFloat(style(`${body} code`).fontSize)).toBeCloseTo(12.88);
      expect(style('[data-id="table"] .bn-block-content').fontSize).toBe("14px");
      for (const [level, size, lineHeight] of [
        [1, 21, 28],
        [2, 17.5, 24.5],
        [3, 15.75, 24.5],
        [4, 14, 21],
      ]) {
        expect(style(heading(level)).fontSize).toBe(`${size}px`);
        expect(style(heading(level)).lineHeight).toBe(`${lineHeight}px`);
      }

      preferences = { ...preferences, pageFontSize: 20 };
      applyPreferences();
      expect(style(body).fontSize).toBe("20px");
      expect(style(body).lineHeight).toBe("32.5px");
      expect(style(heading(1)).fontSize).toBe("30px");
      expect(style('[data-id="table"] .bn-block-content').fontSize).toBe("20px");
      expect(Number.parseFloat(style(`${body} code`).fontSize)).toBeCloseTo(18.4);
      expect(style(source).fontSize).toBe("12px");
      expect(getComputedStyle(view.getByRole("textbox", { name: "Page title" })).fontSize).toBe(
        "28px",
      );

      preferences = { ...preferences, uiFontSize: 16, codeFontSize: 18 };
      applyPreferences();
      expect(style(body).fontSize).toBe("20px");
      expect(getComputedStyle(view.getByRole("textbox", { name: "Page title" })).fontSize).toBe(
        "32px",
      );
      expect(style(source).fontSize).toBe("18px");
      expect(style(source).lineHeight).toBe("20px");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
      document.destroy();
    }
  });

  test("keeps mounted Page prose on the workspace font smoothing preference", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [{ id: "prose", type: "paragraph", content: "Page prose 中文" }],
    });
    const view = renderWithAppMaitai(
      <div className="nfm-editor">
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
    try {
      const prose = view.getByText("Page prose 中文");
      for (const useFontSmoothing of [true, false, true]) {
        await act(async () => {
          applyTypographyPreferences(
            document.documentElement,
            document.body,
            { ...DEFAULT_TYPOGRAPHY_PREFERENCES, useFontSmoothing },
            "light",
          );
          await Promise.resolve();
        });
        const expected = useFontSmoothing ? "antialiased" : "auto";
        for (const element of [document.documentElement, document.body, prose]) {
          expect(getComputedStyle(element).getPropertyValue("-webkit-font-smoothing")).toBe(
            expected,
          );
        }
        expect(prose.isConnected).toBe(true);
      }
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});
