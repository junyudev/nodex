import { BlockNoteEditor, type PartialBlock, SideMenuExtension } from "@blocknote/core";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { nfmSchema } from "./nfm-schema";
import { createNfmEditorPlaceholders } from "./nfm-editor-placeholders";
import "../../../globals.css";
import { act, fireEvent, render } from "@testing-library/react";
import type * as Y from "yjs";
import * as YForTypedOwnerTransactionGuard from "yjs";
import {
  createDetachedPageDocumentFromBlockTree,
  type BlockTreeNode,
  createPageDocumentGenesis,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import { createNfmEditorModeOptions } from "./nfm-editor-source";
import { SelectedBlockDecorationsExtension } from "./selected-block-decorations";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  resolveTypedOwnerDocumentChanges,
  type TypedOwnerDocumentChangeDecision,
} from "../../../lib/typed-owner-blocks";
import {
  prepareNfmEditorForMutation,
  runNfmEditorFocusPreservingMutation,
} from "./nfm-editor-relocation";
import { splitBlockTr } from "../../../../../third_party/blocknote/packages/core/src/api/blockManipulation/commands/splitBlock/splitBlock.js";
import { NfmDocument } from "../nfm-renderer";
import { readMarkdown } from "../../../../shared/nodex-markdown";

describe("block children contract", () => {
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
});

describe("block node view identity", () => {
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
  ): BlockTreeNode => ({
    id,
    type,
    props,
    content: [{ type: "text", text, styles: {} }],
    children,
  });

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
    const toggle = (id: string) =>
      content(id).querySelector<HTMLButtonElement>(".bn-toggle-button")!;
    const placeholder = (id: string) =>
      content(id).querySelector<HTMLButtonElement>(".bn-toggle-add-block-button");
    const expanded = (id: string) =>
      content(id).querySelector(".bn-toggle-wrapper")?.getAttribute("data-show-children") ===
      "true";
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
        if (replacement?.type !== "checkListItem")
          throw new Error("Expected a replacement checkbox");
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
      expect(editor.getBlock("text")?.content).toEqual([
        { type: "text", text: "333!", styles: {} },
      ]);
    });
  });
});

describe("typed owner transaction guard", () => {
  const settleEditor = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  };

  type BlockedDecision = Exclude<TypedOwnerDocumentChangeDecision, { readonly kind: "allow" }>;

  describe("typed owner transaction guard in Chromium", () => {
    test("allows Enter to split rich inline text without treating a later owner as crossed", async () => {
      const editor = BlockNoteEditor.create({
        schema: nfmSchema,
        headless: true,
        initialContent: [
          {
            id: "text",
            type: "paragraph",
            content: [
              "Review ",
              { type: "pageMention", props: { targetPageId: "mentioned-page" } },
              " tomorrow",
            ],
          },
          { id: "page-after", type: "page" },
        ],
      });
      const text = editor.getBlock("text");
      if (!text) throw new Error("Expected the fixture paragraph");
      const blocked: BlockedDecision[] = [];
      const releaseGuard = editor.onBeforeChange(({ getChanges }) => {
        const changes = getChanges();
        const decision = resolveTypedOwnerDocumentChanges(changes);
        if (decision.kind === "allow") return;
        blocked.push(decision);
        return false;
      });

      try {
        const split = editor.transact((transaction) => {
          let paragraphEnd: number | undefined;
          transaction.doc.descendants((node, position) => {
            if (paragraphEnd !== undefined || node.type.name !== "paragraph") return true;
            paragraphEnd = position + 1 + node.content.size;
            return false;
          });
          if (paragraphEnd === undefined) throw new Error("Expected paragraph content");
          transaction.setSelection(TextSelection.create(transaction.doc, paragraphEnd));
          return splitBlockTr(transaction, paragraphEnd);
        });
        await act(settleEditor);

        expect(blocked).toEqual([]);
        expect(split).toBe(true);
        expect(editor.document.map(({ type }) => type)).toEqual(["paragraph", "paragraph", "page"]);
      } finally {
        releaseGuard();
        editor._tiptapEditor.destroy();
      }
    });

    test("intercepts every local Page deletion shape while accepting lifecycle delivery", async () => {
      const genesis = createPageDocumentGenesis({
        documentId: "document:typed-owner-guard",
        title: "Typed owner guard",
        markdown: "Editable paragraph",
        allocateBlockId: () => "text",
      });
      const localDocument = genesis.document;
      const remoteDocument = new YForTypedOwnerTransactionGuard.Doc({ guid: localDocument.guid });
      YForTypedOwnerTransactionGuard.applyUpdate(
        remoteDocument,
        YForTypedOwnerTransactionGuard.encodeStateAsUpdate(localDocument),
      );
      const createEditor = (
        document: YForTypedOwnerTransactionGuard.Doc,
        clientSessionId: string,
      ) =>
        BlockNoteEditor.create({
          schema: nfmSchema,
          ...createNfmEditorModeOptions({
            kind: "collaborative-document",
            documentId: document.guid,
            storeEpoch: "epoch:typed-owner-guard",
            generation: 1,
            clientSessionId,
            fragment: document.getXmlFragment("body"),
            user: { name: clientSessionId, color: "#2563eb" },
          }),
        });
      const local = createEditor(localDocument, "surface:local");
      const remote = createEditor(remoteDocument, "surface:core-delivery");
      const localHost = document.createElement("div");
      const remoteHost = document.createElement("div");
      document.body.append(localHost, remoteHost);
      local.mount(localHost);
      remote.mount(remoteHost);
      const localView = local.prosemirrorView;
      if (!localView) throw new Error("Expected a mounted local editor view");
      const blocked: BlockedDecision[] = [];
      const releaseGuard = local.onBeforeChange(({ getChanges }) => {
        const decision = resolveTypedOwnerDocumentChanges(getChanges());
        if (decision.kind === "allow") return;
        blocked.push(decision);
        return false;
      });
      const relayRemoteUpdate = (update: Uint8Array) =>
        YForTypedOwnerTransactionGuard.applyUpdate(localDocument, update);
      remoteDocument.on("update", relayRemoteUpdate);

      try {
        await act(settleEditor);
        const remoteText = remote.getBlock("text");
        if (!remoteText) throw new Error("Expected the fixture paragraph");
        await act(async () => {
          remote.insertBlocks([{ id: "page-before", type: "page" }], remoteText, "before");
          await settleEditor();
        });
        expect(local.getBlock("page-before")?.type).toBe("page");

        await act(async () => {
          local.setTextCursorPosition("text", "start");
          fireEvent.keyDown(localView.dom, { key: "Tab", code: "Tab" });
          await settleEditor();
        });
        expect(local.getParentBlock("text")).toBeUndefined();
        expect(blocked).toHaveLength(0);

        await act(async () => {
          const blockedBeforeBackspace = blocked.length;
          local.setTextCursorPosition("text", "start");
          fireEvent.keyDown(localView.dom, { key: "Backspace", code: "Backspace" });
          await settleEditor();
          expect(blocked).toHaveLength(blockedBeforeBackspace);
        });
        expect(local.getBlock("page-before")?.type).toBe("page");

        await act(async () => {
          local.setTextCursorPosition("text", "start");
          local.moveBlocksUp();
          await settleEditor();
        });
        expect(local.document.map(({ id }) => id)).toEqual(["page-before", "text"]);
        expect(blocked.at(-1)).toEqual({
          kind: "forbidden",
          reason: "generic_typed_owner_mutation",
        });

        await act(async () => {
          local.setTextCursorPosition("page-before");
          local.focus();
          expect(local.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
          expect(localView.hasFocus()).toBe(true);
          fireEvent.keyDown(localView.dom, { key: "Backspace", code: "Backspace" });
          await settleEditor();
        });
        expect(local.getBlock("page-before")?.type).toBe("page");

        await act(async () => {
          local.removeBlocks(["page-before"]);
          await settleEditor();
        });
        expect(local.getBlock("page-before")?.type).toBe("page");

        await act(async () => {
          await runNfmEditorFocusPreservingMutation(local, localHost, async () => {
            await prepareNfmEditorForMutation(local, localHost);
            expect(localView.hasFocus()).toBe(false);
            remote.removeBlocks(["page-before"]);
            await settleEditor();
          });
        });
        expect(local.getBlock("page-before")).toBeUndefined();
        expect(local.prosemirrorState.selection).not.toBeInstanceOf(NodeSelection);
        expect(local.getTextCursorPosition().block.id).toBe("text");
        expect(localView.hasFocus()).toBe(true);

        const currentRemoteText = remote.getBlock("text");
        if (!currentRemoteText) throw new Error("Expected the surviving fixture paragraph");
        await act(async () => {
          remote.insertBlocks([{ id: "page-after", type: "page" }], currentRemoteText, "after");
          await settleEditor();
          local.setTextCursorPosition("text", "start");
          local.moveBlocksDown();
          await settleEditor();
        });
        expect(local.document.map(({ id }) => id)).toEqual(["text", "page-after"]);
        expect(blocked.at(-1)).toEqual({
          kind: "forbidden",
          reason: "generic_typed_owner_mutation",
        });

        await act(async () => {
          local.setTextCursorPosition("text", "end");
          fireEvent.keyDown(localView.dom, { key: "Delete", code: "Delete" });
          await settleEditor();
        });
        expect(local.getBlock("page-after")?.type).toBe("page");
        expect(blocked.every((decision) => decision.kind === "forbidden")).toBe(true);
      } finally {
        remoteDocument.off("update", relayRemoteUpdate);
        releaseGuard();
        local.unmount();
        remote.unmount();
        localHost.remove();
        remoteHost.remove();
        local._tiptapEditor.destroy();
        remote._tiptapEditor.destroy();
        localDocument.destroy();
        remoteDocument.destroy();
      }
    });
  });
});

describe("nfm renderer", () => {
  /** Nodex Markdown read and shown as a Page lays it out. */
  function NfmRenderer({ content }: { readonly content: string }) {
    return <NfmDocument blocks={readMarkdown(content)} />;
  }

  describe("NfmRenderer quote geometry in Chromium", () => {
    test("keeps the rule and content on the same inherited color and rhythm", () => {
      const view = render(
        <div style={{ color: "rgb(24, 93, 161)", fontSize: 16 }}>
          <NfmRenderer content={"> quote-line1<br>quote-line2"} />
        </div>,
      );
      const quote = view.container.querySelector<HTMLElement>("blockquote")!;
      const style = getComputedStyle(quote);

      expect(style.marginBlockStart).toBe("8px");
      expect(style.marginInlineStart).toBe("8px");
      expect(style.borderInlineStartWidth).toBe("3px");
      expect(style.borderInlineStartColor).toBe(style.color);
      expect(style.paddingInlineStart).toBe("22px");
      expect(style.paddingInlineEnd).toBe("22px");
      expect(style.fontSize).toBe("16px");
      expect(style.lineHeight).toBe("24px");
    });
  });
});
