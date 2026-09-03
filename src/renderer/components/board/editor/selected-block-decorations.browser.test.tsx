import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  type CustomBlockConfig,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import type { Node } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "@blocknote/shadcn/style.css";
import "../../../globals.css";
import { PageOutlinerFrame } from "@/components/block-documents/page-outliner-surface";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE } from "@/lib/editor-selection-presentation";
import {
  applySideMenuSelectionIntent,
  createSideMenuSelectionIntent,
  type SideMenuSelectionBlock,
  type SideMenuSelectionEditor,
} from "./nfm-side-menu-selection";
import { NfmStructuredClipboardExtension } from "./nfm-editor-extensions";
import { NfmSideMenuOpenProvider, useNfmSideMenuOpenController } from "./nfm-side-menu";
import { NfmTextActionMenu, NfmTextActionMenuSurface } from "./nfm-text-action-menu";
import {
  useNfmRetainedSelectionPresentation,
  type NfmRetainedSelectionPresentation,
} from "./nfm-retained-selection-presentation";
import {
  BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE,
  SelectedBlockDecorationsExtension,
  selectedBlockDecorationsExtension,
} from "./selected-block-decorations";
import { nfmSchema } from "./nfm-schema";

const testPageBlockConfig = {
  type: "testPage",
  propSchema: {},
  content: "none",
} as const satisfies CustomBlockConfig;

const testPageBlockSpec = createReactBlockSpec(testPageBlockConfig, {
  render: () => <section data-test-page-title>Atomic page title</section>,
});

const testSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    testPage: testPageBlockSpec(),
  },
});

const selectionImageProps = {
  url: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#aac0d4"/></svg>',
  )}`,
  previewWidth: 160,
  sourceWidth: 320,
  sourceHeight: 200,
  caption: "",
  showPreview: true,
};

const settleEditor = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

const requireMountedEditorView = (editor: {
  readonly prosemirrorView?: EditorView;
}): EditorView => {
  const view = editor.prosemirrorView;
  if (!view) throw new Error("Expected a mounted editor view");
  return view;
};

function PointerSideMenuOpenHarness() {
  const sideMenu = useNfmSideMenuOpenController();
  return (
    <button
      type="button"
      onClick={(event) => {
        sideMenu.openForCurrentSelection({ returnFocusElement: event.currentTarget });
      }}
    >
      Open pointer Block actions
    </button>
  );
}

function BlockActionSelectionHarness() {
  const [presentation, setPresentation] = useState<NfmRetainedSelectionPresentation>("none");
  useNfmRetainedSelectionPresentation(presentation, "block-action-browser-test", [
    "first",
    "second",
  ]);

  return (
    <NfmTextActionMenuSurface
      currentBlockTypeLabel="Normal Text"
      blockTypeItems={[
        {
          key: "paragraph",
          label: "Normal Text",
          type: "paragraph",
          isSelected: true,
        },
      ]}
      activeStyles={{}}
      textColor="default"
      backgroundColor="default"
      canUseTextColor
      canUseBackgroundColor
      canClearFormat
      linkControl={<button type="button">Link</button>}
      nodexRows={[
        { key: "send-to-thread", label: "Send to chat", enabled: true },
        { key: "move-to", label: "Move to", enabled: true },
      ]}
      sourceProjectId="project"
      sourcePageId="page"
      onSelectBlockType={() => undefined}
      onToggleStyle={() => undefined}
      onSetTextColor={() => undefined}
      onSetBackgroundColor={() => undefined}
      onClearFormat={() => undefined}
      onOpenBlockActions={() => undefined}
      onNodexRow={() => undefined}
      onMoveBlocksToDestination={() => undefined}
      onSendBlocksToThread={() => undefined}
      onSelectionPresentationChange={setPresentation}
      renderMoveToMenu={() => <div>Move destination picker</div>}
      renderSendToThreadMenu={() => <div>Chat picker</div>}
    />
  );
}

function inlinePosition(doc: Node, blockId: string, offset: number) {
  let position: number | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer" || node.attrs.id !== blockId) return true;
    position = pos + 2 + offset;
    return false;
  });
  if (position === undefined) throw new Error(`Missing fixture Block ${blockId}`);
  return position;
}

describe("selected Block presentation in Chromium", () => {
  test("ignores a stale React NodeView selection class after text selection moves away", async () => {
    const editor = BlockNoteEditor.create({
      schema: testSchema,
      initialContent: [
        { id: "before", type: "paragraph", content: "123456789" },
        { id: "page", type: "testPage" },
        { id: "after", type: "paragraph", content: "after" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const view = render(
      <BlockNoteView
        editor={editor}
        className="nfm-editor"
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        editor.focus();
        editor.setTextCursorPosition("page");
        await settleEditor();
      });

      const pageContainer = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="page"]',
      );
      const pageNodeView = pageContainer?.querySelector<HTMLElement>(".ProseMirror-selectednode");
      const pageContent = pageContainer?.querySelector<HTMLElement>(
        '.bn-block-content[data-content-type="testPage"]',
      );
      const pageTitle = pageContainer?.querySelector<HTMLElement>("[data-test-page-title]");
      const beforeInlineContent = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="before"] .bn-inline-content',
      );
      if (!pageContainer || !pageNodeView || !pageContent || !pageTitle || !beforeInlineContent) {
        throw new Error("Expected the selected atomic React Block");
      }

      expect(pageContainer.classList.contains("nodex-selected-block")).toBe(true);
      expect(pageContainer.dataset.nodexSelectionKind).toBe("structural");
      expect(getComputedStyle(pageContent, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(pageContent, "::after").opacity).toBe("1");
      expect(getComputedStyle(pageTitle).outlineStyle).toBe("none");

      await act(async () => {
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(
              doc,
              inlinePosition(doc, "before", 6),
              inlinePosition(doc, "before", 7),
            ),
          ),
        );
        await settleEditor();
      });

      expect(
        editor.prosemirrorState.doc.textBetween(
          editor.prosemirrorState.selection.from,
          editor.prosemirrorState.selection.to,
        ),
      ).toBe("7");
      expect(pageContainer.classList.contains("nodex-selected-block")).toBe(false);
      expect(getComputedStyle(beforeInlineContent, "::selection").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.28)",
      );

      view.container.classList.add("dark");
      expect(getComputedStyle(beforeInlineContent, "::selection").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.28)",
      );
      view.container.classList.remove("dark");

      const showSelection = editor.getExtension(ShowSelectionExtension);
      showSelection?.showSelection(true, "inline-selection-test");
      await act(settleEditor);
      expect(view.container.querySelectorAll("[data-show-selection]")).toHaveLength(1);
      expect(view.container.querySelector("[data-show-selection]")?.textContent).toBe("7");
      expect(
        getComputedStyle(view.container.querySelector<HTMLElement>("[data-show-selection]")!)
          .backgroundColor,
      ).toBe("rgba(35, 131, 226, 0.28)");
      expect(getComputedStyle(beforeInlineContent, "::selection").backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      showSelection?.showSelection(false, "inline-selection-test");
      await act(settleEditor);
      expect(getComputedStyle(beforeInlineContent, "::selection").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.28)",
      );

      pageNodeView.classList.add("ProseMirror-selectednode");
      expect(getComputedStyle(pageTitle).outlineStyle).toBe("none");
      expect(getComputedStyle(pageContent, "::after").content).toBe("none");

      await act(async () => {
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(
              doc,
              inlinePosition(doc, "before", 6),
              inlinePosition(doc, "after", 2),
            ),
          ),
        );
        await settleEditor();
      });

      expect(pageContainer.classList.contains("nodex-selected-block")).toBe(true);
      expect(pageContainer.dataset.nodexSelectionKind).toBe("atomic-range");
      expect(getComputedStyle(pageContent, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(pageContent, "::after").opacity).toBe("1");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("presents a retained text-menu command target as Blocks without duplicate text paint", async () => {
    const editor = BlockNoteEditor.create({
      schema: testSchema,
      initialContent: [
        { id: "first", type: "paragraph", content: "first block" },
        { id: "second", type: "paragraph", content: "second block" },
        { id: "outside", type: "paragraph", content: "outside" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const view = render(
      <>
        <button type="button">Outside retained selection</button>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </>,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        editor.focus();
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(
              doc,
              inlinePosition(doc, "first", 2),
              inlinePosition(doc, "second", 2),
            ),
          ),
        );
        await settleEditor();
      });

      const firstOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="first"]',
      );
      const secondOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="second"]',
      );
      const outsideOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="outside"]',
      );
      const firstContent = firstOuter?.querySelector<HTMLElement>(".bn-block-content");
      const secondContent = secondOuter?.querySelector<HTMLElement>(".bn-block-content");
      const firstInline = firstContent?.querySelector<HTMLElement>(".bn-inline-content");
      if (
        !firstOuter ||
        !secondOuter ||
        !outsideOuter ||
        !firstContent ||
        !secondContent ||
        !firstInline
      ) {
        throw new Error("Expected retained Block command fixture");
      }

      const showSelection = editor.getExtension(ShowSelectionExtension);
      const blockPresentation = editor.getExtension(SelectedBlockDecorationsExtension);
      if (!showSelection || !blockPresentation) {
        throw new Error("Expected selection presentation extensions");
      }

      await act(async () => {
        showSelection.showSelection(true, "competing-inline-owner");
        blockPresentation.showSelectionAsBlocks(true, "block-action-owner", ["first", "second"]);
        await settleEditor();
      });

      const retainedInlineDecoration =
        view.container.querySelector<HTMLElement>("[data-show-selection]");
      if (!retainedInlineDecoration) throw new Error("Expected retained inline decoration");

      expect(mountedView.dom.hasAttribute(BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE)).toBe(
        true,
      );
      expect(firstOuter.dataset.nodexSelectionKind).toBe("block-action");
      expect(secondOuter.dataset.nodexSelectionKind).toBe("block-action");
      expect(outsideOuter.classList.contains("nodex-selected-block")).toBe(false);
      expect(getComputedStyle(firstContent, "::after").opacity).toBe("1");
      expect(getComputedStyle(secondContent, "::after").opacity).toBe("1");
      expect(getComputedStyle(firstInline, "::selection").backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(retainedInlineDecoration).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(retainedInlineDecoration).paddingTop).toBe("0px");

      await act(async () => {
        await userEvent.click(view.getByRole("button", { name: "Outside retained selection" }));
        await settleEditor();
      });

      expect(mountedView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
      expect(getComputedStyle(firstContent, "::after").opacity).toBe("1");
      expect(getComputedStyle(secondContent, "::after").opacity).toBe("1");

      await act(async () => {
        blockPresentation.showSelectionAsBlocks(false, "block-action-owner");
        await settleEditor();
      });

      expect(mountedView.dom.hasAttribute(BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE)).toBe(
        false,
      );
      expect(firstOuter.classList.contains("nodex-selected-block")).toBe(false);
      expect(secondOuter.classList.contains("nodex-selected-block")).toBe(false);
      expect(getComputedStyle(retainedInlineDecoration).backgroundColor).toBe(
        "rgba(35, 131, 226, 0.28)",
      );
      expect(getComputedStyle(firstInline, "::selection").backgroundColor).toBe("rgba(0, 0, 0, 0)");

      showSelection.showSelection(false, "competing-inline-owner");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("presents Change block type as Blocks without an inline selection decoration", async () => {
    const editor = BlockNoteEditor.create({
      schema: testSchema,
      initialContent: [
        { id: "first", type: "paragraph", content: "first block" },
        { id: "second", type: "paragraph", content: "second block" },
        { id: "outside", type: "paragraph", content: "outside" },
      ],
      extensions: [NfmStructuredClipboardExtension(), selectedBlockDecorationsExtension()],
    });
    const view = render(
      <NodexTooltipProvider>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        >
          <NfmSideMenuOpenProvider>
            <NfmTextActionMenu />
          </NfmSideMenuOpenProvider>
        </BlockNoteView>
      </NodexTooltipProvider>,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        editor.focus();
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(
              doc,
              inlinePosition(doc, "first", 2),
              inlinePosition(doc, "second", 2),
            ),
          ),
        );
        await settleEditor();
      });

      const trigger = await view.findByRole("button", { name: "Normal Text" });
      await act(async () => {
        await userEvent.click(trigger);
        await settleEditor();
      });
      await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
      await act(settleEditor);

      const firstOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="first"]',
      );
      const secondOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="second"]',
      );
      const outsideOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="outside"]',
      );
      if (!firstOuter || !secondOuter || !outsideOuter) {
        throw new Error("Expected Change block type selection fixture");
      }

      expect(firstOuter.dataset.nodexSelectionKind).toBe("block-action");
      expect(secondOuter.dataset.nodexSelectionKind).toBe("block-action");
      expect(outsideOuter.classList.contains("nodex-selected-block")).toBe(false);
      expect(view.container.querySelector("[data-show-selection]")).toBeNull();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test.each(["Send to chat", "Move to"] as const)(
    "keeps the %s target presented as Blocks across the menu rerender",
    async (actionLabel) => {
      const editor = BlockNoteEditor.create({
        schema: testSchema,
        initialContent: [
          { id: "first", type: "paragraph", content: "first block" },
          { id: "second", type: "paragraph", content: "second block" },
          { id: "outside", type: "paragraph", content: "outside" },
        ],
        extensions: [NfmStructuredClipboardExtension(), selectedBlockDecorationsExtension()],
      });
      const view = render(
        <NodexTooltipProvider>
          <BlockNoteView
            editor={editor}
            className="nfm-editor"
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          >
            <BlockActionSelectionHarness />
          </BlockNoteView>
        </NodexTooltipProvider>,
      );

      try {
        await act(settleEditor);
        const mountedView = requireMountedEditorView(editor);
        await act(async () => {
          editor.focus();
          const doc = editor.prosemirrorState.doc;
          mountedView.dispatch(
            editor.prosemirrorState.tr.setSelection(
              TextSelection.create(
                doc,
                inlinePosition(doc, "first", 2),
                inlinePosition(doc, "second", 2),
              ),
            ),
          );
          await settleEditor();
        });

        await act(async () => {
          await userEvent.click(await view.findByRole("button", { name: actionLabel }));
          await settleEditor();
        });
        await view.findByText(
          actionLabel === "Send to chat" ? "Chat picker" : "Move destination picker",
        );
        await act(settleEditor);

        const firstOuter = view.container.querySelector<HTMLElement>(
          '.bn-block-outer[data-id="first"]',
        );
        const secondOuter = view.container.querySelector<HTMLElement>(
          '.bn-block-outer[data-id="second"]',
        );
        const outsideOuter = view.container.querySelector<HTMLElement>(
          '.bn-block-outer[data-id="outside"]',
        );
        if (!firstOuter || !secondOuter || !outsideOuter) {
          throw new Error(`Expected ${actionLabel} selection fixture`);
        }

        expect(firstOuter.dataset.nodexSelectionKind).toBe("block-action");
        expect(secondOuter.dataset.nodexSelectionKind).toBe("block-action");
        expect(outsideOuter.classList.contains("nodex-selected-block")).toBe(false);
        expect(view.container.querySelector("[data-show-selection]")).toBeNull();
      } finally {
        view.unmount();
        editor._tiptapEditor.destroy();
      }
    },
  );

  test("keeps the Image overlay in sync with the same authoritative selection", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        { id: "before", type: "paragraph", content: "123456789" },
        {
          id: "image",
          type: "image",
          props: {
            ...selectionImageProps,
            name: "fixture.png",
          },
        },
        { id: "after", type: "paragraph", content: "after" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const view = render(
      <>
        <button type="button">Outside editor</button>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </>,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        editor.focus();
        editor.setTextCursorPosition("image");
        await settleEditor();
      });

      const imageContainer = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="image"]',
      );
      const imageNodeView = imageContainer?.querySelector<HTMLElement>(".ProseMirror-selectednode");
      const imageContent = imageContainer?.querySelector<HTMLElement>(
        '.bn-block-content[data-content-type="image"]',
      );
      const imageWrapper = imageContent?.querySelector<HTMLElement>(
        ".bn-file-block-content-wrapper",
      );
      if (!imageContainer || !imageNodeView || !imageContent || !imageWrapper) {
        throw new Error("Expected the selected Image Block");
      }

      expect(imageContainer.dataset.nodexSelectionKind).toBe("structural");
      expect(getComputedStyle(imageContent, "::after").content).toBe("none");
      expect(getComputedStyle(imageWrapper, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(imageWrapper, "::after").opacity).toBe("1");
      expect(imageNodeView.getBoundingClientRect().width).toBeGreaterThan(
        imageWrapper.getBoundingClientRect().width,
      );
      expect(getComputedStyle(imageNodeView).outlineStyle).toBe("none");
      expect(getComputedStyle(imageNodeView, "::after").content).toBe("none");
      expect(getComputedStyle(imageWrapper, "::after").boxShadow).toBe("none");

      await act(async () => {
        await userEvent.click(view.getByRole("button", { name: "Outside editor" }));
        await settleEditor();
      });

      expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
      expect(imageContainer.classList.contains("nodex-selected-block")).toBe(true);
      expect(mountedView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
      expect(getComputedStyle(imageWrapper, "::after").opacity).toBe("0");

      await act(async () => {
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(
              doc,
              inlinePosition(doc, "before", 6),
              inlinePosition(doc, "before", 7),
            ),
          ),
        );
        await settleEditor();
      });

      imageNodeView.classList.add("ProseMirror-selectednode");
      expect(imageContainer.classList.contains("nodex-selected-block")).toBe(false);
      expect(getComputedStyle(imageWrapper, "::after").content).toBe("none");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("presents a side-menu parent selection as one subtree overlay", async () => {
    const editor = BlockNoteEditor.create({
      schema: testSchema,
      initialContent: [
        {
          id: "parent",
          type: "paragraph",
          content: "release again",
          children: [
            { id: "child-one", type: "paragraph", content: "release current" },
            { id: "child-two", type: "paragraph", content: "use prod nodex" },
          ],
        },
        { id: "after", type: "paragraph", content: "after" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const view = render(
      <BlockNoteView
        editor={editor}
        className="nfm-editor"
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />,
    );

    try {
      await act(settleEditor);
      const mountedView = requireMountedEditorView(editor);
      await act(async () => {
        editor.focus();
        const parent = editor.getBlock("parent");
        if (!parent) throw new Error("Missing parent Block");

        const sideMenuEditor = editor as unknown as SideMenuSelectionEditor;
        const intent = createSideMenuSelectionIntent(
          sideMenuEditor,
          parent as unknown as SideMenuSelectionBlock,
        );
        applySideMenuSelectionIntent(sideMenuEditor, intent);
        await settleEditor();
      });

      const parentOuter = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="parent"]',
      );
      const parentBlock = parentOuter?.querySelector<HTMLElement>(":scope > .bn-block");
      const parentContent = parentBlock?.querySelector<HTMLElement>(
        ':scope > .bn-block-content[data-content-type="paragraph"]',
      );
      const childContent = parentBlock?.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="child-two"] .bn-block-content[data-content-type="paragraph"]',
      );
      const parentInlineContent = parentContent?.querySelector<HTMLElement>(".bn-inline-content");
      const childInlineContent = childContent?.querySelector<HTMLElement>(".bn-inline-content");
      if (
        !parentOuter ||
        !parentBlock ||
        !parentContent ||
        !childContent ||
        !parentInlineContent ||
        !childInlineContent
      ) {
        throw new Error("Expected the selected parent subtree");
      }

      expect(parentOuter.dataset.nodexSelectedBlockScope).toBe("subtree");
      expect(editor.prosemirrorState.selection.visible).toBe(false);
      expect(mountedView.dom.classList.contains("ProseMirror-hideselection")).toBe(true);
      editor.getExtension(ShowSelectionExtension)?.showSelection(true, "structural-selection-test");
      await act(settleEditor);
      expect(parentBlock.querySelector("[data-show-selection]")).toBeNull();
      expect(parentBlock.querySelector("[data-nodex-selected-block-content]")).toBeNull();
      expect(getComputedStyle(parentBlock, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(parentBlock, "::after").opacity).toBe("1");
      expect(parentBlock.getBoundingClientRect().height).toBeGreaterThan(
        parentContent.getBoundingClientRect().height,
      );
      expect(parentBlock.getBoundingClientRect().top).toBeLessThan(
        childContent.getBoundingClientRect().top,
      );
      expect(getComputedStyle(parentInlineContent, "::selection").backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(childInlineContent, "::selection").backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("copies and cuts the side-menu Block selection while Search actions owns focus", async () => {
    const editor = BlockNoteEditor.create({
      schema: testSchema,
      initialContent: [
        {
          id: "parent",
          type: "paragraph",
          content: "parent block",
          children: [{ id: "child", type: "paragraph", content: "child block" }],
        },
        { id: "outside", type: "paragraph", content: "outside block" },
      ],
      extensions: [NfmStructuredClipboardExtension(), selectedBlockDecorationsExtension()],
    });
    const view = render(
      <BlockNoteView
        editor={editor}
        className="nfm-editor"
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      >
        <NfmSideMenuOpenProvider>
          <PointerSideMenuOpenHarness />
        </NfmSideMenuOpenProvider>
      </BlockNoteView>,
    );

    try {
      await act(settleEditor);
      await act(async () => {
        editor.setTextCursorPosition("parent");
        editor.focus();
        await settleEditor();
      });

      const menuTrigger = view.getByRole("button", { name: "Open pointer Block actions" });
      await act(async () => {
        fireEvent.click(menuTrigger);
        await settleEditor();
      });
      const firstMenu = await view.findByRole("dialog", { name: "Block actions" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("placeholder")).toBe("Search actions…"),
      );
      const searchInput = document.activeElement;
      if (!(searchInput instanceof HTMLInputElement)) {
        throw new Error("Expected Search actions to own focus");
      }
      expect(editor.prosemirrorState.selection.empty).toBe(false);

      const copiedData = new DataTransfer();
      const copyEvent = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: copiedData,
      });
      let copyDispatched = true;
      await act(async () => {
        copyDispatched = searchInput.dispatchEvent(copyEvent);
        await Promise.resolve();
      });
      expect(copyDispatched).toBe(false);

      expect(copiedData.getData("text/plain")).toContain("parent block");
      expect(copiedData.getData("text/plain")).toContain("child block");
      expect(copiedData.getData("text/plain")).not.toContain("outside block");
      await waitFor(() => expect(firstMenu.isConnected).toBe(false));
      await waitFor(() => expect(requireMountedEditorView(editor).hasFocus()).toBe(true));

      await act(async () => {
        await userEvent.keyboard("x");
        await settleEditor();
      });
      expect(editor.prosemirrorState.doc.textContent).toContain("x");
      expect(editor.prosemirrorState.doc.textContent).not.toContain("parent block");
      expect(editor.prosemirrorState.doc.textContent).not.toContain("child block");

      await act(async () => {
        const mountedView = requireMountedEditorView(editor);
        const doc = editor.prosemirrorState.doc;
        mountedView.dispatch(
          editor.prosemirrorState.tr.setSelection(
            TextSelection.create(doc, inlinePosition(doc, "outside", 0)),
          ),
        );
        editor.focus();
        await settleEditor();
      });
      await act(async () => {
        fireEvent.click(menuTrigger);
        await settleEditor();
      });
      const secondMenu = await view.findByRole("dialog", { name: "Block actions" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("placeholder")).toBe("Search actions…"),
      );
      const secondSearchInput = document.activeElement;
      if (!(secondSearchInput instanceof HTMLInputElement)) {
        throw new Error("Expected Search actions to regain focus");
      }

      const cutData = new DataTransfer();
      const cutEvent = new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData: cutData,
      });
      let cutDispatched = true;
      await act(async () => {
        cutDispatched = secondSearchInput.dispatchEvent(cutEvent);
        await Promise.resolve();
      });
      expect(cutDispatched).toBe(false);

      expect(cutData.getData("text/plain")).toContain("outside block");
      await waitFor(() => expect(secondMenu.isConnected).toBe(false));
      await waitFor(() => expect(requireMountedEditorView(editor).hasFocus()).toBe(true));
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("gives nested editors exclusive Block highlight ownership inside a dark Page context", async () => {
    const innerEditor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "image-one",
          type: "image",
          props: {
            ...selectionImageProps,
            name: "one.png",
          },
        },
        {
          id: "image-two",
          type: "image",
          props: {
            ...selectionImageProps,
            name: "two.png",
          },
        },
        { id: "divider", type: "divider" },
        { id: "inner-text", type: "paragraph", content: "inner text" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const nestedPageBlockSpec = createReactBlockSpec(testPageBlockConfig, {
      render: () => (
        <PageOutlinerFrame targetBlockId="nested-page" expanded active>
          <BlockNoteView
            editor={innerEditor}
            theme="dark"
            className="nfm-editor"
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          />
        </PageOutlinerFrame>
      ),
    });
    const outerSchema = BlockNoteSchema.create({
      blockSpecs: {
        paragraph: defaultBlockSpecs.paragraph,
        testPage: nestedPageBlockSpec(),
      },
    });
    const outerEditor = BlockNoteEditor.create({
      schema: outerSchema,
      initialContent: [
        { id: "before", type: "paragraph", content: "before" },
        { id: "page", type: "testPage" },
      ],
      extensions: [selectedBlockDecorationsExtension()],
    });
    const view = render(
      <>
        <button type="button">Outside nested editor</button>
        <BlockNoteView
          editor={outerEditor}
          theme="dark"
          className="nfm-editor dark bg-[var(--background)]"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </>,
    );

    try {
      await act(settleEditor);
      const outerView = requireMountedEditorView(outerEditor);
      const innerView = requireMountedEditorView(innerEditor);
      await act(async () => {
        outerEditor.focus();
        outerEditor.setTextCursorPosition("page");
        await settleEditor();
      });

      const pageContainer = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="page"]',
      );
      const pageContent = pageContainer?.querySelector<HTMLElement>(
        '.bn-block-content[data-content-type="testPage"]',
      );
      const pageFrame = pageContainer?.querySelector<HTMLElement>(
        '[data-page-outliner-target="nested-page"]',
      );
      if (!pageContainer || !pageContent || !pageFrame) {
        throw new Error("Expected the selected Page context");
      }

      expect(pageContainer.classList.contains("nodex-selected-block")).toBe(true);
      expect(outerView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);

      const firstImageWrapper = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="image-one"] .bn-file-block-content-wrapper',
      );
      const firstImage = firstImageWrapper?.querySelector<HTMLImageElement>("img");
      const secondImageWrapper = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="image-two"] .bn-file-block-content-wrapper',
      );
      const innerInline = view.container.querySelector<HTMLElement>(
        '.bn-block-outer[data-id="inner-text"] .bn-inline-content',
      );
      if (!firstImageWrapper || !firstImage || !secondImageWrapper || !innerInline) {
        throw new Error("Expected both nested Image Blocks");
      }

      await act(async () => {
        await userEvent.click(firstImage);
        await settleEditor();
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
      });

      expect(pageContainer.classList.contains("nodex-selected-block")).toBe(true);
      expect(outerView.hasFocus()).toBe(false);
      expect(innerView.hasFocus()).toBe(true);
      expect(outerView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
      expect(innerView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(true);
      const firstImageNodeView = firstImageWrapper.closest<HTMLElement>(
        ".bn-react-node-view-renderer",
      );
      if (!firstImageNodeView) throw new Error("Expected the nested Image NodeView");
      expect(getComputedStyle(firstImageNodeView, "::after").content).toBe("none");
      expect(getComputedStyle(firstImageNodeView).outlineStyle).toBe("none");
      const firstImageContent = firstImageWrapper.parentElement;
      if (!firstImageContent) throw new Error("Expected nested Image content");
      expect(getComputedStyle(firstImageContent, "::after").content).toBe("none");
      expect(firstImageNodeView.getBoundingClientRect().width).toBeGreaterThan(
        firstImage.getBoundingClientRect().width,
      );
      await waitFor(() => expect(firstImage.naturalWidth).toBe(selectionImageProps.sourceWidth));
      const imageWidth = firstImage.getBoundingClientRect().width;
      expect(imageWidth).toBe(selectionImageProps.previewWidth);
      expect(firstImageWrapper.getBoundingClientRect().width).toBe(imageWidth);
      expect(Number.parseFloat(getComputedStyle(firstImageWrapper, "::after").width)).toBe(
        imageWidth,
      );
      expect(getComputedStyle(firstImageWrapper, "::after").boxShadow).toBe("none");
      expect(getComputedStyle(pageContent, "::after").opacity).toBe("0");
      expect(getComputedStyle(firstImageWrapper, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(firstImageWrapper, "::after").opacity).toBe("1");
      expect(getComputedStyle(secondImageWrapper, "::after").content).toBe("none");
      expect(getComputedStyle(pageFrame, "::after").borderColor).toBe("rgb(83, 54, 31)");
      expect(getComputedStyle(pageFrame, "::after").opacity).toBe("1");
      expect(getComputedStyle(pageFrame, "::after").content).toBe('""');
      expect(getComputedStyle(pageFrame, "::after").backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(pageFrame, "::after").boxShadow).toBe("none");

      await act(async () => {
        await userEvent.click(view.getByRole("button", { name: "Outside nested editor" }));
        await settleEditor();
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
      });
      expect(innerView.dom.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)).toBe(false);
      expect(getComputedStyle(firstImageWrapper, "::after").opacity).toBe("0");
      expect(getComputedStyle(firstImageNodeView, "::after").content).toBe("none");
      expect(getComputedStyle(pageFrame, "::after").opacity).toBe("0");

      await act(async () => {
        await userEvent.click(innerInline);
        await settleEditor();
      });
      expect(getComputedStyle(firstImageWrapper, "::after").content).toBe("none");
      expect(getComputedStyle(firstImageNodeView, "::after").content).toBe("none");

      // Non-React atomic Blocks must not acquire the ancestor's default ring either.
      await act(async () => {
        innerEditor.setTextCursorPosition("divider");
        await settleEditor();
      });
      const dividerContent = innerView.dom.querySelector<HTMLElement>(
        '.bn-block-content[data-content-type="divider"]',
      );
      if (!dividerContent) throw new Error("Expected the nested Divider");
      expect(innerEditor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
      expect(getComputedStyle(dividerContent, "::after").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.14)",
      );
      expect(getComputedStyle(dividerContent, "::after").boxShadow).toBe("none");

      await act(async () => {
        innerEditor.setTextCursorPosition("inner-text");
        innerEditor.focus();
        await settleEditor();
      });
      expect(innerView.dom.classList.contains("ProseMirror-hideselection")).toBe(false);

      const outerBlockPresentation = outerEditor.getExtension(SelectedBlockDecorationsExtension);
      if (!outerBlockPresentation) throw new Error("Expected outer Block presentation extension");
      await act(async () => {
        outerBlockPresentation.showSelectionAsBlocks(true, "stale-outer-action", ["page"]);
        await settleEditor();
      });
      expect(outerView.dom.hasAttribute(BLOCK_ACTION_SELECTION_PRESENTATION_ATTRIBUTE)).toBe(true);
      expect(getComputedStyle(innerInline, "::selection").backgroundColor).toBe(
        "rgba(35, 131, 226, 0.28)",
      );
      await act(async () => {
        outerBlockPresentation.showSelectionAsBlocks(false, "stale-outer-action");
        await settleEditor();
      });
    } finally {
      view.unmount();
      innerEditor._tiptapEditor.destroy();
      outerEditor._tiptapEditor.destroy();
    }
  });
});
