import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, test } from "vite-plus/test";
import "../../../globals.css";
import { writeTaskShorthandPagePromotionEnabled } from "../../../lib/page-promotion-preference";
import {
  APP_SHELL_MODAL_LAYER_INDEX,
  APP_SHELL_TOOLTIP_LAYER_INDEX,
} from "../../../lib/app-shell-layers";
import { nfmTaskShorthandPreviewExtension } from "./nfm-task-shorthand-preview-extension";

const mountedEditors: BlockNoteEditor[] = [];

type EditorOptions = NonNullable<Parameters<typeof BlockNoteEditor.create>[0]>;

const mountEditor = (initialContent: EditorOptions["initialContent"]) => {
  const editor = BlockNoteEditor.create({
    initialContent,
    extensions: [nfmTaskShorthandPreviewExtension()],
  });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  mountedEditors.push(editor);
  return { editor, host };
};

afterEach(() => {
  for (const editor of mountedEditors.splice(0)) {
    editor._tiptapEditor.destroy();
  }
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-codex-window-type");
  localStorage.clear();
});

describe("task shorthand authoring feedback in Chromium", () => {
  test("is quiet, inspectable, non-persistent, and updates with typing and preference", () => {
    document.documentElement.dataset.codexWindowType = "electron";
    writeTaskShorthandPagePromotionEnabled(true);
    const { editor, host } = mountEditor([
      {
        id: "shorthand",
        type: "paragraph",
        content: "1XL(ui, unclear) Fix import",
      },
    ]);
    const before = editor.document;
    const block = host.querySelector<HTMLElement>('.bn-block[data-id="shorthand"]');
    const prefix = host.querySelector<HTMLElement>("[data-task-shorthand-preview]");
    expect(block).not.toBeNull();
    expect(prefix?.textContent).toBe("1XL(ui, unclear) ");
    expect(host.textContent).not.toContain("P1 · XL · 2 tags");
    expect(editor.document).toEqual(before);

    const heightWithDecoration = block!.getBoundingClientRect().height;
    prefix!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const tooltip = document.querySelector<HTMLElement>("[data-task-shorthand-tooltip]");
    expect(tooltip?.classList.contains("hidden")).toBe(false);
    expect(tooltip?.textContent).toBe("P1 · XL · ui · unclear");
    expect(getComputedStyle(tooltip!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Number(getComputedStyle(tooltip!).zIndex)).toBe(APP_SHELL_TOOLTIP_LAYER_INDEX);
    expect(Number(getComputedStyle(tooltip!).zIndex)).toBeLessThan(APP_SHELL_MODAL_LAYER_INDEX);

    const view = editor.prosemirrorView;
    if (!view) throw new Error("Expected a mounted editor view");
    const decoration = view.dom.querySelector<HTMLElement>("[data-task-shorthand-preview]");
    const position = view.posAtDOM(decoration!, 0);
    view.dispatch(
      editor.prosemirrorState.tr.setSelection(
        TextSelection.create(editor.prosemirrorState.doc, position + 1),
      ),
    );
    expect(tooltip?.classList.contains("hidden")).toBe(false);

    writeTaskShorthandPagePromotionEnabled(false);
    expect(host.querySelector("[data-task-shorthand-preview]")).toBeNull();
    expect(block!.getBoundingClientRect().height).toBe(heightWithDecoration);
    expect(editor.document).toEqual(before);

    writeTaskShorthandPagePromotionEnabled(true);
    editor.updateBlock("shorthand", { content: "Plain title" });
    expect(host.querySelector("[data-task-shorthand-preview]")).toBeNull();
    editor.updateBlock("shorthand", { content: "2S Tighten tests" });
    expect(host.querySelector("[data-task-shorthand-preview]")?.textContent).toBe("2S ");
  });

  test("does not preview a prefix that crosses a rich-link authority boundary", () => {
    writeTaskShorthandPagePromotionEnabled(true);
    const { host } = mountEditor([
      {
        id: "rich-boundary",
        type: "paragraph",
        content: [
          { type: "text", text: "1", styles: {} },
          {
            type: "link",
            href: "https://nodex.dev",
            content: [{ type: "text", text: "XL", styles: {} }],
          },
          { type: "text", text: " Fix import", styles: {} },
        ],
      },
    ]);
    expect(host.textContent).toContain("1XL Fix import");
    expect(host.querySelector("[data-task-shorthand-preview]")).toBeNull();
  });

  test("previews a prefix completed before a rich-link title", () => {
    writeTaskShorthandPagePromotionEnabled(true);
    const { host } = mountEditor([
      {
        id: "rich-title",
        type: "paragraph",
        content: [
          { type: "text", text: "1XL ", styles: {} },
          {
            type: "link",
            href: "https://nodex.dev",
            content: [{ type: "text", text: "Fix import", styles: {} }],
          },
        ],
      },
    ]);
    expect(host.textContent).toContain("1XL Fix import");
    expect(host.querySelector("[data-task-shorthand-preview]")?.textContent).toBe("1XL ");
  });
});
