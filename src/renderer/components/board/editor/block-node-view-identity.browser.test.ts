import { BlockNoteEditor, SideMenuExtension } from "@blocknote/core";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type * as Y from "yjs";

import {
  createDetachedPageDocumentFromBlockTree,
  type BlockTreeNode,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { nfmSchema } from "./nfm-schema";
import { SelectedBlockDecorationsExtension } from "./selected-block-decorations";
import "../../../globals.css";

const cleanups: (() => void)[] = [];
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

const block = (
  id: string,
  type: string,
  text: string,
  children: readonly BlockTreeNode[] = [],
  props: BlockTreeNode["props"] = {},
): BlockTreeNode => ({ id, type, props, content: [{ type: "text", text, styles: {} }], children });

const mountEditor = (blockTree: readonly BlockTreeNode[]) => {
  const { document: doc } = createDetachedPageDocumentFromBlockTree({
    documentId: "document:node-view-identity",
    blockTree,
  });
  const editor = BlockNoteEditor.create(
    createNfmEditorModeOptions(
      {
        kind: "collaborative-document",
        documentId: doc.guid,
        storeEpoch: "epoch:node-view-identity",
        generation: 1,
        clientSessionId: "surface:node-view-identity",
        fragment: doc.getXmlFragment("body"),
        user: { name: "Editor", color: "#2563eb" },
      },
      { schema: nfmSchema, extensions: [SelectedBlockDecorationsExtension()] },
    ),
  );
  const host = document.createElement("div");
  host.className = "nfm-editor";
  document.body.append(host);
  editor.mount(host);
  cleanups.push(() => {
    editor._tiptapEditor.destroy();
    doc.destroy();
    for (const id of ["full", "nested", "empty"]) localStorage.removeItem(`toggle-${id}`);
  });
  const content = (id: string) => {
    const element = host.querySelector<HTMLElement>(
      `.bn-block[data-id="${id}"] > .bn-block-content`,
    );
    if (!element) throw new Error(`Missing Block content: ${id}`);
    return element;
  };
  const toggle = (id: string) => content(id).querySelector<HTMLButtonElement>(".bn-toggle-button")!;
  const placeholder = (id: string) =>
    content(id).querySelector<HTMLButtonElement>(".bn-toggle-add-block-button");
  const expanded = (id: string) =>
    content(id).querySelector(".bn-toggle-wrapper")?.getAttribute("data-show-children") === "true";
  return { editor, doc, host, content, toggle, placeholder, expanded };
};

describe("Block NodeView identity in Chromium", () => {
  test.each(["toggleListItem", "heading"] as const)(
    "keeps %s disclosure and empty-child actions with their Block through side-menu drop and history",
    async (type) => {
      const props: BlockTreeNode["props"] =
        type === "heading" ? { isToggleable: true, level: 2 } : {};
      const { editor, host, content, toggle, placeholder, expanded } = mountEditor([
        block(
          "full",
          type,
          "111",
          [block("nested", "toggleListItem", "222", [block("text", "paragraph", "333")])],
          props,
        ),
        block("empty", type, "aaa", [], props),
      ]);
      await act(async () => {
        for (const id of ["full", "nested", "empty"]) {
          if (!expanded(id)) toggle(id).click();
        }
        await settle();
      });
      expect(placeholder("empty")).not.toBeNull();

      await act(async () => {
        editor.setTextCursorPosition("empty", "end");
        editor.focus();
        const dataTransfer = new DataTransfer();
        const sideMenu = editor.getExtension(SideMenuExtension)!;
        // Exercise the production side-menu Slice/selection and PM drop handlers.
        // This is a browser handler regression, not an OS-native drag gesture.
        try {
          sideMenu.blockDragStart({ dataTransfer, clientY: 0 }, editor.getBlock("empty")!);
          host.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
          const rect = content("full").getBoundingClientRect();
          content("full").dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: rect.x + 40,
              clientY: rect.top + 1,
            }),
          );
        } finally {
          sideMenu.blockDragEnd();
        }
        await settle();
      });
      const expectMoved = () => {
        expect(editor.document.slice(0, 2).map(({ id }) => id)).toEqual(["empty", "full"]);
        expect(placeholder("empty")).not.toBeNull();
        expect(placeholder("full")).toBeNull();
        expect(expanded("nested")).toBe(true);
      };
      expectMoved();
      await act(async () => {
        expect(editor.undo()).toBe(true);
        await settle();
      });
      expect(editor.document.slice(0, 2).map(({ id }) => id)).toEqual(["full", "empty"]);
      expect(placeholder("empty")).not.toBeNull();
      expect(placeholder("full")).toBeNull();
      await act(async () => {
        expect(editor.redo()).toBe(true);
        await settle();
      });
      expectMoved();

      await act(async () => {
        toggle("full").click();
        await settle();
      });
      expect(expanded("full")).toBe(false);
      expect(expanded("empty")).toBe(true);
      await act(async () => {
        placeholder("empty")!.click();
        await settle();
      });
      expect(editor.getBlock("empty")?.children).toHaveLength(1);
      expect(placeholder("empty")).toBeNull();
      expect(editor.getBlock("full")?.children.map(({ id }) => id)).toEqual(["nested"]);
      expect(editor.getBlock("nested")?.children.map(({ id }) => id)).toEqual(["text"]);
    },
  );

  test.each([false, true])(
    "binds identical replacement checkbox content to its new identity (nested: %s)",
    async (nested) => {
      const checkbox = block("old", "checkListItem", "Same");
      const { editor, content } = mountEditor(
        nested ? [block("parent", "paragraph", "Parent", [checkbox])] : [checkbox],
      );
      await act(async () => {
        editor.replaceBlocks(["old"], [{ id: "new", type: "checkListItem", content: "Same" }]);
        await settle();
      });
      await act(async () => {
        content("new").querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        await settle();
      });
      const replacement = editor.getBlock("new");
      if (replacement?.type !== "checkListItem") throw new Error("Expected a replacement checkbox");
      expect(replacement.props.checked).toBe(true);
      expect(editor.getBlock("old")).toBeUndefined();
      expect(editor.getParentBlock("new")?.id).toBe(nested ? "parent" : undefined);
    },
  );

  test("keeps toggle identity through synchronized placement while preserving live views during typing", async () => {
    const { editor, doc, content, toggle, placeholder, expanded } = mountEditor([
      block("full", "toggleListItem", "111", [block("text", "paragraph", "333")]),
      block("empty", "toggleListItem", "aaa"),
    ]);
    await act(async () => {
      for (const id of ["full", "empty"]) if (!expanded(id)) toggle(id).click();
      editor.setTextCursorPosition("text", "end");
      await settle();
    });
    const fullContent = content("full");
    const fullToggle = toggle("full");
    await act(async () => {
      editor.transact((transaction) => transaction.insertText("!"));
      await settle();
    });
    expect(content("full")).toBe(fullContent);
    expect(toggle("full")).toBe(fullToggle);
    expect(expanded("full")).toBe(true);

    await act(async () => {
      editor
        .getExtension(SelectedBlockDecorationsExtension)!
        .showSelectionAsBlocks(true, "test", ["empty"]);
      const group = doc.getXmlFragment("body").get(0) as Y.XmlElement;
      const moved = cloneXmlSubtree(group.get(1));
      doc.transact(
        () => {
          group.delete(1, 1);
          group.insert(0, [moved]);
        },
        { kind: "canonical-placement-delivery" },
      );
      await settle();
    });
    expect(editor.document.slice(0, 2).map(({ id }) => id)).toEqual(["empty", "full"]);
    expect(placeholder("empty")).not.toBeNull();
    expect(placeholder("full")).toBeNull();
    await act(async () => {
      placeholder("empty")!.click();
      await settle();
    });
    expect(editor.getBlock("empty")?.children).toHaveLength(1);
    expect(editor.getBlock("text")?.content).toEqual([{ type: "text", text: "333!", styles: {} }]);
  });
});
