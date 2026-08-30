import { BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import {
  GridSuggestionMenuController,
  SuggestionMenuController,
  type GridSuggestionMenuProps,
  type SuggestionMenuProps,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type CSSProperties } from "react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../../globals.css";
import {
  BlockReferenceRuntimeProvider,
  type BlockReferenceHostRuntime,
} from "../../block-documents/block-reference-runtime-context";
import { NfmSlashMenu, createNfmTypedSuggestionControllerConfig } from "./nfm-slash-menu";
import { nfmSchema } from "./nfm-schema";
import { TestQueryProvider } from "@/test/query";

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

const getItems = async () => ["item"];
const acceptItem = () => undefined;

function SlashMenu(_props: SuggestionMenuProps<string>) {
  return <div data-testid="slash-menu" />;
}

function MentionMenu(_props: SuggestionMenuProps<string>) {
  return <div data-testid="mention-menu" />;
}

function EmojiMenu(_props: GridSuggestionMenuProps<string>) {
  return <div data-testid="emoji-menu" />;
}

describe("NFM typed suggestion sessions in Chromium", () => {
  test("replaces an accepted emoji query instead of appending to it", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [{ id: "paragraph-0", type: "paragraph", content: "" }],
    });
    const controllers = createNfmTypedSuggestionControllerConfig("en-US");
    const view = render(
      <BlockNoteView
        editor={editor}
        emojiPicker={false}
        formattingToolbar={false}
        linkToolbar={false}
        sideMenu={false}
        slashMenu={false}
        tableHandles={false}
      >
        <GridSuggestionMenuController
          triggerCharacter={controllers.emoji.triggerCharacter}
          columns={controllers.emoji.columns}
          getItems={async () => ["😀"]}
          gridSuggestionMenuComponent={EmojiMenu}
          minQueryLength={controllers.emoji.minQueryLength}
          onItemClick={(emoji) => editor.insertInlineContent(emoji)}
          shouldOpen={controllers.emoji.shouldOpen}
        />
      </BlockNoteView>,
    );

    try {
      editor.setTextCursorPosition("paragraph-0", "start");
      editor.focus();

      await act(async () => {
        await userEvent.keyboard(":sm");
        await settleEditor();
      });
      expect(await view.findByTestId("emoji-menu")).toBeTruthy();

      await act(async () => {
        await userEvent.keyboard("{Enter}");
        await settleEditor();
      });

      expect(editor.prosemirrorState.doc.textContent).toBe("😀");
      expect(editor.getExtension(SuggestionMenu)?.getLastCloseReason()).toBe("accepted");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("replaces an accepted linear suggestion query", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "paragraph-0", type: "paragraph", content: "" }],
    });
    const controllers = createNfmTypedSuggestionControllerConfig("en-US");
    const mentionController = controllers.pageMention[0]!;
    const view = render(
      <BlockNoteView
        editor={editor}
        emojiPicker={false}
        formattingToolbar={false}
        linkToolbar={false}
        sideMenu={false}
        slashMenu={false}
        tableHandles={false}
      >
        <SuggestionMenuController
          triggerCharacter={mentionController.triggerCharacter}
          getItems={async () => ["mention"]}
          onItemClick={() => editor.insertInlineContent("MENTION")}
          shouldOpen={mentionController.shouldOpen}
          suggestionMenuComponent={MentionMenu}
        />
      </BlockNoteView>,
    );

    try {
      editor.setTextCursorPosition("paragraph-0", "start");
      editor.focus();

      await act(async () => {
        await userEvent.keyboard("@me");
        await settleEditor();
      });
      expect(await view.findByTestId("mention-menu")).toBeTruthy();

      await act(async () => {
        await userEvent.keyboard("{Enter}");
        await settleEditor();
      });

      expect(editor.prosemirrorState.doc.textContent).toBe("MENTION");
      expect(editor.getExtension(SuggestionMenu)?.getLastCloseReason()).toBe("accepted");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("connects lexical policy, live sessions, popup gates, and editor transitions", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [
        { id: "paragraph-0", type: "paragraph", content: "" },
        { id: "paragraph-1", type: "paragraph", content: "next" },
        { id: "code-0", type: "codeBlock", content: "code" },
      ],
    });
    const controllers = createNfmTypedSuggestionControllerConfig("ja-JP");
    const view = render(
      <div
        className="nfm-editor"
        style={{ "--color-token-foreground": "rgb(32 40 48)" } as CSSProperties}
      >
        <BlockNoteView
          editor={editor}
          emojiPicker={false}
          formattingToolbar={false}
          linkToolbar={false}
          sideMenu={false}
          slashMenu={false}
          tableHandles={false}
        >
          {controllers.slash.map(({ triggerCharacter, shouldOpen, temporaryInput }) => (
            <SuggestionMenuController
              key={triggerCharacter}
              triggerCharacter={triggerCharacter}
              getItems={getItems}
              onItemClick={acceptItem}
              shouldOpen={shouldOpen}
              suggestionMenuComponent={SlashMenu}
              temporaryInput={temporaryInput}
            />
          ))}
          {controllers.pageMention.map((controller) => (
            <SuggestionMenuController
              key={controller.triggerCharacter}
              triggerCharacter={controller.triggerCharacter}
              autoCloseWhenNoItems={controller.autoCloseWhenNoItems}
              deferPopupWhenQueryEmpty={controller.profile.emptyQueryPopup === "defer"}
              getItems={getItems}
              onItemClick={acceptItem}
              shouldOpen={controller.shouldOpen}
              suggestionMenuComponent={MentionMenu}
              temporaryInput={{
                enabled: true,
                emptyCompletion:
                  controller.profile.entry === "create_first"
                    ? "Type to add or link page…"
                    : undefined,
                getCompletion: (_item, query) => (query === "dra" ? "g-a" : null),
              }}
            />
          ))}
          <GridSuggestionMenuController
            triggerCharacter={controllers.emoji.triggerCharacter}
            columns={controllers.emoji.columns}
            getItems={getItems}
            gridSuggestionMenuComponent={EmojiMenu}
            minQueryLength={controllers.emoji.minQueryLength}
            onItemClick={acceptItem}
            shouldOpen={controllers.emoji.shouldOpen}
          />
        </BlockNoteView>
      </div>,
    );
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;

    const prepareParagraph = async (text: string) => {
      await act(async () => {
        suggestionMenu.closeMenu("programmatic");
        editor.updateBlock("paragraph-0", { content: text || [] });
        editor.setTextCursorPosition("paragraph-0", "end");
        editor.focus();
        await settleEditor();
      });
    };
    const type = async (keys: string) => {
      await act(async () => {
        await userEvent.keyboard(keys);
        await settleEditor();
      });
    };

    try {
      await act(settleEditor);

      await prepareParagraph("abc");
      await type("/");
      expect(suggestionMenu.getMenuState()).toBeUndefined();

      await prepareParagraph("abc ");
      await type("/");
      await waitFor(() => {
        expect(suggestionMenu.getMenuState()?.triggerCharacter).toBe("/");
      });
      expect(await view.findByTestId("slash-menu")).toBeTruthy();
      const slashTemporaryInput = editor.prosemirrorView?.dom.querySelector<HTMLElement>(
        ".bn-suggestion-temporary-input",
      );
      expect(slashTemporaryInput?.textContent).toBe("/");
      expect(slashTemporaryInput?.getAttribute("data-suggestion-completion")).toBe(
        "Type to search",
      );
      expect(getComputedStyle(slashTemporaryInput!, "::after").content).toContain("Type to search");
      await type("co");
      const slashQueryInput = editor.prosemirrorView?.dom.querySelector<HTMLElement>(
        ".bn-suggestion-temporary-input",
      );
      expect(slashQueryInput?.textContent).toBe("/co");
      expect(slashQueryInput?.hasAttribute("data-suggestion-completion")).toBe(false);

      await prepareParagraph("abc");
      await type("@");
      expect(suggestionMenu.getMenuState()).toBeUndefined();

      await prepareParagraph("abc ");
      await type("@");
      expect(suggestionMenu.getMenuState()?.triggerCharacter).toBe("@");
      expect(await view.findByTestId("mention-menu")).toBeTruthy();

      await prepareParagraph("");
      await type("@dra");
      const titleCompletionInput = editor.prosemirrorView?.dom.querySelector<HTMLElement>(
        ".bn-suggestion-temporary-input",
      );
      expect(titleCompletionInput?.getAttribute("data-suggestion-completion")).toBe("g-a");
      expect(getComputedStyle(titleCompletionInput!, "::after").content).toContain("g-a");

      await prepareParagraph("");
      await type("+");
      expect(suggestionMenu.getMenuState()).toMatchObject({
        triggerCharacter: "+",
        query: "",
      });
      expect(view.queryByTestId("mention-menu")).toBeNull();
      expect(
        editor.prosemirrorView?.dom.querySelector(".bn-suggestion-temporary-input")?.textContent,
      ).toBe("+");
      expect(
        editor.prosemirrorView?.dom
          .querySelector(".bn-suggestion-temporary-input")
          ?.getAttribute("data-suggestion-completion"),
      ).toBe("Type to add or link page…");
      const temporaryInput = editor.prosemirrorView?.dom.querySelector<HTMLElement>(
        ".bn-suggestion-temporary-input",
      );
      if (!temporaryInput) {
        throw new Error("Expected the complete temporary Page input annotation");
      }
      expect(getComputedStyle(temporaryInput, "::after").content).toContain(
        "Type to add or link page…",
      );
      expect(Number.parseFloat(getComputedStyle(temporaryInput).outlineWidth)).toBeGreaterThan(4.5);
      await type("page");
      expect(await view.findByTestId("mention-menu")).toBeTruthy();
      expect(
        editor.prosemirrorView?.dom.querySelector(".bn-suggestion-temporary-input")?.textContent,
      ).toBe("+page");

      await prepareParagraph("abc");
      await type("[BracketLeft]");
      await type("[BracketLeft]");
      expect(suggestionMenu.getMenuState()).toMatchObject({
        triggerCharacter: "[[",
        query: "",
      });
      expect(await view.findByTestId("mention-menu")).toBeTruthy();
      expect(
        editor.prosemirrorView?.dom.querySelector(".bn-suggestion-temporary-input")?.textContent,
      ).toBe("[[");
      await type("wiki");
      expect(
        editor.prosemirrorView?.dom.querySelector(".bn-suggestion-temporary-input")?.textContent,
      ).toBe("[[wiki");
      await type("{Escape}");
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      expect(
        editor.prosemirrorView?.dom.querySelector(".bn-suggestion-temporary-input"),
      ).toBeNull();

      await prepareParagraph("abc");
      await type("[BracketLeft]");
      await type("[BracketLeft]");
      await type("wiki{Enter}");
      expect(editor.getBlock("paragraph-0")?.content).toMatchObject([
        { type: "text", text: "abc" },
      ]);
      expect(suggestionMenu.getLastCloseReason()).toBe("accepted");

      await prepareParagraph("");
      await act(async () => {
        const editorDom = editor.prosemirrorView?.dom;
        if (!editorDom) throw new Error("Expected a mounted editor view");
        await userEvent.type(editorDom, ":", { skipClick: true });
        await settleEditor();
      });
      expect(suggestionMenu.getMenuState()?.triggerCharacter).toBe(":");
      expect(view.queryByTestId("emoji-menu")).toBeNull();
      await type("sm");
      expect(await view.findByTestId("emoji-menu")).toBeTruthy();
      await type("{Escape}");
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      expect(suggestionMenu.getLastCloseReason()).toBe("escape");

      await prepareParagraph("");
      await type("/");
      await type("@");
      expect(suggestionMenu.getMenuState()).toMatchObject({
        triggerCharacter: "/",
        query: "@",
      });

      await act(async () => {
        editor.setTextCursorPosition("paragraph-1", "start");
        await settleEditor();
      });
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      expect(suggestionMenu.getLastCloseReason()).toBe("cross-block");

      await prepareParagraph("");
      await type("/");
      await act(async () => {
        editor.setTextCursorPosition("code-0", "end");
        await settleEditor();
      });
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      expect(suggestionMenu.getLastCloseReason()).toBe("code-block");
      await type("/");
      expect(suggestionMenu.getMenuState()).toBeUndefined();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("settles Page creation through one deferred suggestion lease", async () => {
    const originalBridge = window.api;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string) => {
          if (channel === "projects:list") {
            return {
              storeEpoch: "epoch:test",
              projectionRevision: 0,
              items: [],
              nextCursor: null,
            };
          }
          throw new Error(`Unexpected renderer request: ${channel}`);
        },
        on: () => () => undefined,
      },
    });
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        { id: "paragraph-0", type: "paragraph", content: "" },
        { id: "paragraph-1", type: "paragraph", content: "" },
      ],
    });
    const createCalls: Parameters<
      NonNullable<BlockReferenceHostRuntime["createPageMention"]>
    >[0][] = [];
    let rejectCreation = false;
    let releaseFirstCreation: () => void = () => undefined;
    const firstCreationGate = new Promise<void>((resolve) => {
      releaseFirstCreation = resolve;
    });
    const runtime: BlockReferenceHostRuntime = {
      contentAccessContext: { kind: "library" },
      projectName: null,
      projectWorkspacePath: null,
      hostPageId: "page:host",
      ancestorPageIds: ["page:host"],
      ancestorDocumentOwnerBlockIds: [],
      isActiveSurface: true,
      createPageMention: async (input) => {
        createCalls.push(input);
        if (createCalls.length === 1) await firstCreationGate;
        if (rejectCreation) throw new Error("The Page changed; try again.");
        editor.updateBlock(input.blockId, {
          content: [{ type: "pageMention", props: { targetPageId: input.pageId } }, " "],
        });
        return { pageId: input.pageId };
      },
    };
    const originalWindowType = document.documentElement.getAttribute("data-codex-window-type");
    document.documentElement.setAttribute("data-codex-window-type", "electron");
    const view = render(
      <StrictMode>
        <TestQueryProvider>
          <BlockReferenceRuntimeProvider value={runtime}>
            <BlockNoteView
              editor={editor}
              emojiPicker={false}
              formattingToolbar={false}
              linkToolbar={false}
              sideMenu={false}
              slashMenu={false}
              tableHandles={false}
            >
              <NfmSlashMenu executionProjectId={null} allowPageReferences={false} locale="en-US" />
            </BlockNoteView>
          </BlockReferenceRuntimeProvider>
        </TestQueryProvider>
      </StrictMode>,
    );
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;

    const type = async (keys: string) => {
      await act(async () => {
        await userEvent.keyboard(keys);
        await settleEditor();
      });
    };

    try {
      editor.setTextCursorPosition("paragraph-0", "start");
      editor.focus();
      await type("[BracketLeft]");
      await type("[BracketLeft]");
      expect(await view.findByText("Add new sub-page")).toBeTruthy();
      const chooseDestination = await view.findByText("Add new page in…");
      await act(async () => {
        await userEvent.click(chooseDestination);
        await settleEditor();
      });
      const destinationInput = await view.findByRole("combobox", { name: "Create page in" });
      expect(view.queryByText("Add new sub-page")).toBeNull();
      const destinationDialog = destinationInput.closest<HTMLElement>('[role="dialog"]');
      if (!destinationDialog?.parentElement) {
        throw new Error("Expected the destination picker to own a visible menu surface");
      }
      const destinationSurfaceStyle = getComputedStyle(destinationDialog.parentElement);
      expect(destinationSurfaceStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      await act(async () => {
        // A pointer into another Block resolves to this cross-Block selection
        // before the editor receives the next text-input event.
        editor.setTextCursorPosition("paragraph-1", "start");
        editor.focus();
        await settleEditor();
      });
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      expect(view.queryByRole("combobox", { name: "Create page in" })).toBeNull();
      expect(editor.isFocused()).toBe(true);
      await type("[BracketLeft]");
      await type("[BracketLeft]");
      expect(await view.findByText("Add new sub-page")).toBeTruthy();
      expect(view.queryByRole("combobox", { name: "Create page in" })).toBeNull();
      expect(editor.isFocused()).toBe(true);
      await type("{Escape}");
      await act(async () => {
        editor.updateBlock("paragraph-0", { content: [] });
        editor.updateBlock("paragraph-1", { content: [] });
        editor.setTextCursorPosition("paragraph-0", "start");
        editor.focus();
        await settleEditor();
      });
      await type("@");
      const chooseDestinationAgain = await view.findByText("Add new page in…");
      await act(async () => {
        await userEvent.click(chooseDestinationAgain);
        await settleEditor();
      });
      expect(await view.findByRole("combobox", { name: "Create page in" })).toBeTruthy();
      expect(suggestionMenu.getMenuState()?.acceptancePhase).toBe("pending_authoritative");
      await type("{Escape}");
      expect(suggestionMenu.getMenuState()).toMatchObject({
        query: "",
        acceptancePhase: "editing",
      });

      await type("{Escape}");
      expect(suggestionMenu.getMenuState()).toBeUndefined();
      await act(async () => {
        editor.updateBlock("paragraph-0", { content: [] });
        editor.setTextCursorPosition("paragraph-0", "start");
        editor.focus();
        await settleEditor();
      });
      await type("+plan");
      expect(await view.findByText("New “plan” sub-page")).toBeTruthy();

      await type("{Enter}");
      await waitFor(() => expect(createCalls).toHaveLength(1));
      expect(suggestionMenu.getMenuState()?.acceptancePhase).toBe("pending_authoritative");
      expect(editor.prosemirrorState.doc.textContent).toBe("+plan");
      await type("{Enter}");
      expect(createCalls).toHaveLength(1);

      releaseFirstCreation();
      await waitFor(() => expect(suggestionMenu.getMenuState()).toBeUndefined());
      expect(createCalls[0]).toMatchObject({
        title: "plan",
        blockId: "paragraph-0",
        expectedContent: [{ type: "text", text: "+plan", styles: {} }],
        replacementContent: [{ type: "pageMention" }, { type: "text", text: " ", styles: {} }],
      });
      expect(editor.getBlock("paragraph-0")?.content).toMatchObject([
        { type: "pageMention", props: { targetPageId: createCalls[0]!.pageId } },
        { type: "text", text: " " },
      ]);

      rejectCreation = true;
      await act(async () => {
        editor.updateBlock("paragraph-0", { content: [] });
        editor.setTextCursorPosition("paragraph-0", "start");
        editor.focus();
        await settleEditor();
      });
      await type("+retry");
      await type("{Enter}");
      await waitFor(() => {
        expect(createCalls).toHaveLength(2);
        expect(suggestionMenu.getMenuState()).toMatchObject({
          query: "retry",
          acceptancePhase: "editing",
        });
      });
      expect(editor.prosemirrorState.doc.textContent).toBe("+retry");
    } finally {
      releaseFirstCreation();
      view.unmount();
      editor._tiptapEditor.destroy();
      if (originalBridge) {
        Object.defineProperty(window, "api", { configurable: true, value: originalBridge });
      } else {
        Reflect.deleteProperty(window, "api");
      }
      if (originalWindowType) {
        document.documentElement.setAttribute("data-codex-window-type", originalWindowType);
      } else {
        document.documentElement.removeAttribute("data-codex-window-type");
      }
    }
  });
});
