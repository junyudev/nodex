import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { nfmSchema } from "@/components/board/editor/nfm-schema";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  applyTypographyPreferences,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  type TypographyPreferences,
} from "@/lib/typography-preferences";
import { CollaborativePageTitle } from "./collaborative-page-title";
import "@/globals.css";

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
        expect(getComputedStyle(element).getPropertyValue("-webkit-font-smoothing")).toBe(expected);
      }
      expect(prose.isConnected).toBe(true);
    }
  } finally {
    view.unmount();
    editor._tiptapEditor.destroy();
  }
});
