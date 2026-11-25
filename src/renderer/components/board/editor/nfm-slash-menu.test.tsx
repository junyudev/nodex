import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { createIntl } from "react-intl";
import { render, settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  buildPageSearchUnavailableSuggestionItem,
  buildDateMentionSuggestionItems,
  buildNfmNodexAgentSuggestionItems,
  buildNfmThreadMentionSuggestionItems,
  createNfmTypedSuggestionShouldOpen,
  createNfmTypedSuggestionControllerConfig,
  getNfmSlashMenuCustomItems,
  isPageReferenceInsertionBookmarkValid,
  NfmSuggestionMenuSurface,
  type NfmSuggestionItem,
  selectNfmMentionSuggestionItems,
  startNfmMentionAtCursor,
} from "./nfm-slash-menu";

import type { BlockNoteEditor } from "@blocknote/core";
import {
  BlockNoteContext,
  SuggestionMenuWrapper,
  type SuggestionMenuProps,
} from "@blocknote/react";
import type { ChatCatalogEntry, ChatSearchMatch } from "../../../../shared/chat-search";
import { loadAppMessages } from "../../../../shared/i18n/catalog";
import { codeLanguagePreference } from "@/lib/editor-model/code-language-preference";

describe("Page reference insertion bookmark", () => {
  test("accepts only the still-current source Block", () => {
    const editor = {
      getBlock: (blockId: string) => (blockId === "source" ? { id: blockId } : undefined),
      getTextCursorPosition: () => ({ block: { id: "source" } }),
    };

    expect(isPageReferenceInsertionBookmarkValid(editor, { blockId: "source" })).toBe(true);
    expect(isPageReferenceInsertionBookmarkValid(editor, { blockId: "missing" })).toBe(false);
    expect(isPageReferenceInsertionBookmarkValid(editor, null)).toBe(false);
  });

  test("fails closed after the selection moves", () => {
    const editor = {
      getBlock: () => ({ id: "source" }),
      getTextCursorPosition: () => ({ block: { id: "other" } }),
    };

    expect(isPageReferenceInsertionBookmarkValid(editor, { blockId: "source" })).toBe(false);
  });
});

describe("NFM suggestion transaction adapter", () => {
  function transactionWithPrefix(
    textBeforeTrigger: string,
    options: { code?: boolean; tableContent?: boolean; empty?: boolean } = {},
  ) {
    return {
      selection: {
        empty: options.empty ?? true,
        $from: {
          parentOffset: textBeforeTrigger.length,
          parent: {
            type: {
              spec: { code: options.code ?? false },
              isInGroup: (group: string) =>
                group === "tableContent" && options.tableContent === true,
            },
            textBetween: () => textBeforeTrigger,
          },
        },
      },
    };
  }

  test("treats an inline atom before the caret as a non-boundary", () => {
    const shouldOpen = createNfmTypedSuggestionShouldOpen({
      kind: "page-mention",
      trigger: "@",
      locale: "en-US",
    });

    expect(shouldOpen(transactionWithPrefix("\ufffc") as never)).toBe(false);
  });

  test("rejects expanded selections, Code Blocks, and slash input in table content", () => {
    const shouldOpen = createNfmTypedSuggestionShouldOpen({
      kind: "slash",
      trigger: "/",
      locale: "en-US",
    });

    expect(shouldOpen(transactionWithPrefix("", { empty: false }) as never)).toBe(false);
    expect(shouldOpen(transactionWithPrefix("", { code: true }) as never)).toBe(false);
    expect(shouldOpen(transactionWithPrefix("", { tableContent: true }) as never)).toBe(false);
  });

  test("wires locale aliases, Page mention entries, and emoji through one typed-controller contract", () => {
    const controllers = createNfmTypedSuggestionControllerConfig("ja-JP");

    expect(controllers.slash.map(({ triggerCharacter }) => triggerCharacter)).toEqual([
      "/",
      "／",
      "；",
    ]);
    expect(controllers.slash.map(({ temporaryInput }) => temporaryInput)).toEqual([
      { enabled: true, emptyCompletion: "Type to search" },
      { enabled: true, emptyCompletion: "Type to search" },
      { enabled: true, emptyCompletion: "Type to search" },
    ]);
    expect(controllers.pageMention.map(({ triggerCharacter }) => triggerCharacter)).toEqual([
      "@",
      "+",
      "[[",
    ]);
    expect(controllers.pageMention.map(({ profile }) => profile.entry)).toEqual([
      "broad",
      "create_first",
      "wiki_link",
    ]);
    expect(controllers.pageMention.every(({ autoCloseWhenNoItems }) => !autoCloseWhenNoItems)).toBe(
      true,
    );
    expect(controllers.emoji).toMatchObject({
      triggerCharacter: ":",
      columns: 10,
      minQueryLength: 2,
    });
    expect(controllers.emoji.shouldOpen(transactionWithPrefix("abc") as never)).toBe(false);
    expect(controllers.emoji.shouldOpen(transactionWithPrefix("abc ") as never)).toBe(true);
    const readOnlyControllers = createNfmTypedSuggestionControllerConfig("en-US", {
      canCreatePageMention: false,
    });
    expect(
      readOnlyControllers.pageMention
        .find(({ triggerCharacter }) => triggerCharacter === "+")
        ?.shouldOpen(transactionWithPrefix("") as never),
    ).toBe(false);
    expect(
      readOnlyControllers.pageMention
        .find(({ triggerCharacter }) => triggerCharacter === "[[")
        ?.shouldOpen(transactionWithPrefix("abc") as never),
    ).toBe(true);
  });
});

function makeItems(): NfmSuggestionItem[] {
  return [
    {
      title: "Paragraph",
      subtext: "Plain text block",
      badge: "text",
      aliases: [],
      group: "Basic",
      icon: <span aria-hidden="true">P</span>,
      onItemClick: () => undefined,
    },
    {
      title: "Agent Config",
      subtext: "Insert a one-send plan-mode config chip",
      hint: null,
      aliases: ["agent-config"],
      group: "Others",
      icon: <span aria-hidden="true">A</span>,
      onItemClick: () => undefined,
    },
  ];
}

function renderSuggestionMenu(props: Parameters<typeof NfmSuggestionMenuSurface>[0]) {
  return render(
    <NodexTooltipProvider>
      <NfmSuggestionMenuSurface {...props} />
    </NodexTooltipProvider>,
  );
}

function makeChat(overrides: Partial<ChatCatalogEntry> = {}): ChatCatalogEntry {
  return {
    sessionId: "session-1",
    threadId: "thr-mention",
    projectId: "project-1",
    projectName: "Alpha",
    title: "Mention search thread",
    cwd: "/tmp/project",
    branch: null,
    pullRequests: [],
    pinned: false,
    pinnedOrder: null,
    unread: false,
    activity: "idle",
    createdAt: 1,
    recencyAt: 2,
    ...overrides,
  };
}

function makeChatMatch(
  chat: Partial<ChatCatalogEntry> = {},
  match: Partial<ChatSearchMatch & { inActiveProject: boolean }> = {},
): ChatSearchMatch & { inActiveProject: boolean } {
  return {
    chat: makeChat(chat),
    titleRanges: [],
    hint: null,
    excerpt: null,
    inActiveProject: true,
    ...match,
  };
}

describe("NfmSlashMenu", () => {
  test("turns the slash command into the normal visible @ mention flow", () => {
    const openSuggestionMenu = vi.fn();

    startNfmMentionAtCursor({
      getExtension: () => ({ openSuggestionMenu }),
    });

    expect(openSuggestionMenu).toHaveBeenCalledWith("@", {
      deleteTriggerCharacter: true,
      ensureLeadingSpace: true,
      ignoreQueryLength: true,
    });
  });

  test("slash commands never create unresolved Page or legacy Database references", () => {
    const items = getNfmSlashMenuCustomItems({});
    const keys = items.map((item) => (item as { key?: string }).key ?? "").join(",");

    expect(keys.includes("card_reference")).toBe(false);
    expect(keys.includes("toggle_list_inline_view")).toBe(false);
    expect(keys.includes("agent_config")).toBe(true);
    expect(keys.includes("canvas")).toBe(false);
    expect(
      getNfmSlashMenuCustomItems(
        {},
        {
          createCanvasAtEmptyParagraph: async () => ({
            canvasBlockId: "canvas-1",
          }),
        },
      ).some((item) => (item as { key?: string }).key === "canvas"),
    ).toBe(true);

    let mentionOpened = false;
    let embedOpened = false;
    const pageItems = getNfmSlashMenuCustomItems(
      {},
      {
        startMentionFlow: () => {
          mentionOpened = true;
        },
        openEmbedPagePicker: () => {
          embedOpened = true;
        },
      },
    );
    const mentionPageItem = pageItems.find(
      (item) => (item as { key?: string }).key === "mention_page",
    );
    expect(mentionPageItem?.title).toBe("Mention a page");
    mentionPageItem?.onItemClick();
    expect(mentionOpened).toBe(true);

    const embedPageItem = pageItems.find((item) => (item as { key?: string }).key === "embed_page");
    expect(embedPageItem?.title).toBe("Embed page");
    embedPageItem?.onItemClick();
    expect(embedOpened).toBe(true);
  });

  test("creates Code through slash with the validated recent language", () => {
    let currentBlock = { id: "block-1", type: "paragraph", content: [] as unknown[] };
    const updateBlock = vi.fn(
      (block: typeof currentBlock, patch: { type: string; props?: Record<string, unknown> }) => {
        currentBlock = { ...block, ...patch };
        return currentBlock;
      },
    );
    const editor = {
      getTextCursorPosition: () => ({ block: currentBlock }),
      updateBlock,
      setTextCursorPosition: vi.fn(),
      schema: {
        blockSchema: {
          paragraph: { content: "inline" },
          codeBlock: { content: "inline" },
        },
      },
    };

    codeLanguagePreference.set("Python");
    try {
      getNfmSlashMenuCustomItems(editor)
        .find((item) => item.key === "code_block")
        ?.onItemClick();
    } finally {
      codeLanguagePreference.set("text");
    }

    expect(updateBlock).toHaveBeenCalledTimes(1);
    expect(updateBlock.mock.calls[0]?.[1]).toEqual({
      type: "codeBlock",
      props: { language: "python" },
    });
  });

  test("renders Core Page-search failure as an explicit disabled provider row", () => {
    const item = buildPageSearchUnavailableSuggestionItem("mention");
    expect(item).toMatchObject({
      title: "Pages unavailable",
      subtext: "Page search is unavailable. Try again.",
      group: "Mention a page",
      disabled: true,
      mentionRank: { family: "page", match: "recent" },
    });

    const view = renderSuggestionMenu({
      items: [item],
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });
    expect(view.getByRole("option").getAttribute("aria-disabled")).toBe("true");
  });

  test("uses Main title ranges and keeps metadata ahead of content without re-matching", () => {
    const items = buildNfmThreadMentionSuggestionItems(
      {},
      [
        makeChatMatch({ title: "Searchable thread" }, { titleRanges: [{ start: 0, end: 6 }] }),
        makeChatMatch(
          { title: "Branch review" },
          { hint: { label: "Branch", text: "serch", ranges: [{ start: 0, end: 5 }] } },
        ),
        makeChatMatch(
          { title: "Opening prompt" },
          { excerpt: { text: "serch", ranges: [{ start: 0, end: 5 }], role: "user" } },
        ),
      ],
      "serch",
    );

    expect(items[0]?.titleSegments).toEqual([
      { text: "Search", highlight: true },
      { text: "able thread", highlight: false },
    ]);
    expect(items[1]?.titleSegments).toBeNull();
    expect(items[1]?.detail).toBeNull();
    expect(items.map((item) => item.mentionRank?.match)).toEqual(["title", "title", "content"]);
    expect(selectNfmMentionSuggestionItems("serch", items).map((item) => item.title)).toEqual([
      "Searchable thread",
      "Branch review",
      "Opening prompt",
    ]);

    const [unhighlighted] = buildNfmThreadMentionSuggestionItems(
      {},
      [makeChatMatch({ title: "serch title without ranges" })],
      "serch",
    );
    expect(unhighlighted?.titleSegments).toBeNull();
  });

  test("localized date queries keep the same suggestion keys and document payload", async () => {
    const intl = createIntl({
      locale: "zh-CN",
      messages: await loadAppMessages("zh-CN"),
    });
    const insertInlineContent = vi.fn();
    const editor = { insertInlineContent };
    const now = new Date(2026, 5, 28, 9);
    const localized = buildDateMentionSuggestionItems(editor, "今天", now, intl);
    const english = buildDateMentionSuggestionItems(editor, "today", now);

    expect(localized.map(({ key }) => key)).toEqual(english.map(({ key }) => key));
    expect(localized.map(({ title, dateMentionGroup }) => [title, dateMentionGroup])).toEqual([
      ["今天", "Dates"],
      ["今天提醒", "Reminders"],
    ]);
    localized[0]!.onItemClick();
    english[0]!.onItemClick();
    expect(insertInlineContent).toHaveBeenCalledTimes(2);
    expect(insertInlineContent.mock.calls[0]).toEqual(insertInlineContent.mock.calls[1]);
  });

  test("marks populated stale suggestion results as updating", () => {
    const view = renderSuggestionMenu({
      items: makeItems(),
      loadingState: "loaded",
      itemsStale: true,
      selectedIndex: 0,
      onItemClick: () => undefined,
    });

    expect(view.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(view.getByText("Updating...").textContent).toBe("Updating...");
  });

  test("keeps the live suggestion menu open for pointer and Enter on utility rows", async () => {
    let closeMenuCalls = 0;
    let acceptMenuCalls = 0;
    let activationCalls = 0;
    const editorElement = document.createElement("div");
    const suggestionMenu = {
      getMenuState: () => ({
        triggerCharacter: "@",
        query: "weekly",
        show: true,
      }),
    };
    const editor = {
      domElement: editorElement,
      prosemirrorView: { dom: editorElement },
      onMount: () => () => undefined,
      onUnmount: () => () => undefined,
      _tiptapEditor: { on: () => undefined, off: () => undefined },
      getExtension: () => suggestionMenu,
    } as unknown as BlockNoteEditor;
    const UtilityMenu = ({ items, onItemClick }: SuggestionMenuProps<string>) => (
      <button type="button" onClick={() => onItemClick?.(items[0]!)}>
        5 more results
      </button>
    );
    const contextValue = { editor, setContentEditableProps: () => undefined };
    const view = render(
      <BlockNoteContext.Provider value={contextValue}>
        <SuggestionMenuWrapper
          triggerCharacter="@"
          query="weekly"
          closeMenu={() => {
            closeMenuCalls += 1;
          }}
          acceptMenu={() => {
            acceptMenuCalls += 1;
            return true;
          }}
          getItems={async () => ["expand"]}
          onItemClick={() => {
            activationCalls += 1;
          }}
          shouldCloseOnItemClick={() => false}
          suggestionMenuComponent={UtilityMenu}
        />
      </BlockNoteContext.Provider>,
    );

    await act(async () => {
      await settleAsyncRender();
    });
    fireEvent.click(view.getByText("5 more results"));
    await act(async () => {
      editorElement.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    expect(activationCalls).toBe(2);
    expect(closeMenuCalls).toBe(0);
    expect(acceptMenuCalls).toBe(0);
  });
});

test("offers Nodex in the @ menu, turning the caret's block into a Prompt", () => {
  const updateBlock = vi.fn();
  const editor = {
    getTextCursorPosition: () => ({ block: { id: "block-1" } }),
    updateBlock,
  };
  const [nodex] = buildNfmNodexAgentSuggestionItems(editor, "no");
  expect(nodex?.key).toBe("agent:nodex");
  nodex?.onItemClick();
  expect(updateBlock).toHaveBeenCalledWith("block-1", { type: "prompt" });
  expect(buildNfmNodexAgentSuggestionItems(editor, "landing")).toEqual([]);
});
