import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  buildPageReferenceCandidateSuggestionItems,
  buildPageSearchUnavailableSuggestionItem,
  buildDateMentionInlineContent,
  buildDateMentionSuggestionItems,
  buildNfmPageMentionCreateSuggestionItems,
  buildNfmSlashMenuItems,
  buildNfmThreadMentionInlineContent,
  buildNfmThreadMentionSuggestionItems,
  createNfmTypedSuggestionShouldOpen,
  createNfmTypedSuggestionControllerConfig,
  getNfmSlashMenuCustomItems,
  isPageReferenceInsertionBookmarkValid,
  NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS,
  NfmSuggestionMenuSurface,
  type NfmSuggestionItem,
  resolveThreadMentionSubtext,
  resolveNfmSuggestionHint,
  resolveNfmPageMentionCompletion,
  selectNfmMentionSuggestionItems,
  scrollElementIntoContainerView,
  shouldCloseNfmSlashQuery,
  startNfmMentionAtCursor,
} from "./nfm-slash-menu";

import {
  NFM_SUGGESTION_MENU_TOOLTIP_Z_INDEX,
  NFM_SUGGESTION_MENU_Z_INDEX,
} from "./nfm-blocknote-floating-ui";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  BlockNoteContext,
  SuggestionMenuWrapper,
  type DefaultReactSuggestionItem,
  type SuggestionMenuProps,
} from "@blocknote/react";
import type { ChatCatalogEntry, ChatSearchMatch } from "../../../../shared/chat-search";
import type { Project } from "@/lib/types";
import { codeLanguagePreference } from "@/lib/editor-model/code-language-preference";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../../shared/project-appearance";

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

  test("terminates only a slash query with consecutive spaces", () => {
    expect(shouldCloseNfmSlashQuery(" ")).toBe(false);
    expect(shouldCloseNfmSlashQuery("query ")).toBe(false);
    expect(shouldCloseNfmSlashQuery("query  ")).toBe(true);
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

describe("Page mention creation actions", () => {
  test("builds semantic current-Page and destination actions from one normalized title", () => {
    const createCurrent = vi.fn();
    const chooseDestination = vi.fn();
    const items = buildNfmPageMentionCreateSuggestionItems({
      query: "  Plan  ",
      canCreate: true,
      onCreateInCurrentPage: createCurrent,
      onChooseDestination: chooseDestination,
    });

    expect(items).toMatchObject([
      {
        key: "create-page-mention-current",
        title: "New “Plan” sub-page",
        mentionCreate: { kind: "current_page" },
      },
      {
        key: "create-page-mention-destination",
        title: "New “Plan” page in…",
        mentionCreate: { kind: "choose_destination" },
      },
    ]);
    items[0]!.onItemClick();
    items[1]!.onItemClick();
    expect(createCurrent).toHaveBeenCalledOnce();
    expect(chooseDestination).toHaveBeenCalledOnce();
    expect(
      buildNfmPageMentionCreateSuggestionItems({
        query: "",
        canCreate: true,
        onCreateInCurrentPage: createCurrent,
        onChooseDestination: chooseDestination,
      }),
    ).toMatchObject([{ title: "Add new sub-page" }, { title: "Add new page in…" }]);
    expect(
      buildNfmPageMentionCreateSuggestionItems({
        query: "",
        canCreate: false,
        onCreateInCurrentPage: createCurrent,
        onChooseDestination: chooseDestination,
      }),
    ).toEqual([]);
  });
});

describe("NFM Page mention completion", () => {
  test("shows only the untyped suffix of a prefix-matching row", () => {
    const item = {
      title: "Roadmap",
      onItemClick: () => undefined,
    } satisfies NfmSuggestionItem;

    expect(resolveNfmPageMentionCompletion(item, "road")).toBe("map");
    expect(resolveNfmPageMentionCompletion(item, "map")).toBeNull();
    expect(resolveNfmPageMentionCompletion(item, "Roadmap")).toBeNull();
    expect(resolveNfmPageMentionCompletion(item, "")).toBeNull();
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

function defineElementRect(
  element: HTMLElement,
  rect: { top: number; bottom: number; height: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

function defineClientHeight(element: HTMLElement, value: number) {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value,
  });
}

function createMentionProject(): Project {
  return {
    id: "project-1",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Alpha",
    description: "",
    appearance: DEFAULT_PROJECT_APPEARANCE,
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-06-20T00:00:00.000Z"),
    updated: new Date("2026-06-20T00:00:00.000Z"),
  };
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
  test("owns the complete slash catalog vocabulary, grouping, order, and icons", () => {
    const defaultKeys = [
      "image",
      "heading_6",
      "quote",
      "paragraph",
      "heading",
      "heading_2",
      "heading_3",
      "heading_4",
      "heading_5",
      "toggle_heading",
      "toggle_heading_2",
      "toggle_heading_3",
      "toggle_list",
      "numbered_list",
      "bullet_list",
      "check_list",
      "code_block",
      "divider",
      "table",
      "emoji",
      "unknown_upstream_item",
    ];
    const defaults = defaultKeys.map(
      (key) =>
        ({
          key,
          title: `Legacy ${key}`,
          aliases: [],
          group: "Legacy",
          icon: <span data-legacy-slash-icon="true" />,
          onItemClick: () => undefined,
        }) satisfies NfmSuggestionItem,
    );
    const customItems = getNfmSlashMenuCustomItems(
      {},
      {
        createCanvasAtEmptyParagraph: async () => ({ canvasBlockId: "canvas-1" }),
        startMentionFlow: () => undefined,
        openEmbedPagePicker: () => undefined,
        openSubpageCreator: () => undefined,
      },
    );

    const items = buildNfmSlashMenuItems(defaults, customItems);

    expect(items.map(({ title }) => title)).toEqual([
      "Text",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Toggle heading 1",
      "Toggle heading 2",
      "Toggle heading 3",
      "Emoji",
      "Bulleted list",
      "Numbered list",
      "To-do list",
      "Toggle list",
      "Quote",
      "Callout",
      "Code",
      "Code - Mermaid",
      "Divider",
      "Table",
      "Image",
      "Subpage",
      "Mention a page",
      "Embed page",
      "Canvas",
      "Prompt",
      "Agent Config",
    ]);
    expect(
      items
        .filter((item, index) => index === 0 || item.group !== items[index - 1]?.group)
        .map(({ group }) => group),
    ).toEqual(["Text", "Lists", "Blocks", "Pages", "Agent"]);
    expect(items.some(({ key }) => key === "heading_4" || key === "heading_5")).toBe(false);
    expect(items.some(({ key }) => key === "heading_6" || key === "unknown_upstream_item")).toBe(
      false,
    );

    const codeIconView = render(<>{items.find(({ key }) => key === "code_block")?.icon}</>);
    const mermaidIconView = render(<>{items.find(({ key }) => key === "code_mermaid")?.icon}</>);
    const codeSvg = codeIconView.container.querySelector("svg");
    const mermaidSvg = mermaidIconView.container.querySelector("svg");
    expect(mermaidSvg?.getAttribute("viewBox")).toBe(codeSvg?.getAttribute("viewBox"));
    expect(mermaidSvg?.querySelector("path")?.getAttribute("d")).toBe(
      codeSvg?.querySelector("path")?.getAttribute("d"),
    );

    const view = renderSuggestionMenu({
      items,
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });
    expect(view.container.querySelector("[data-legacy-slash-icon]")).toBeNull();
    expect(view.getAllByRole("option").every((row) => row.querySelector("svg") !== null)).toBe(
      true,
    );
  });

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

  test("keeps action aliases searchable without presenting them as syntax hints", () => {
    const items = getNfmSlashMenuCustomItems(
      {},
      {
        createCanvasAtEmptyParagraph: async () => ({
          canvasBlockId: "canvas-1",
        }),
        startMentionFlow: () => undefined,
        openEmbedPagePicker: () => undefined,
        openSubpageCreator: () => undefined,
      },
    ) as NfmSuggestionItem[];
    const actionKeys = [
      "callout",
      "code_block",
      "table",
      "canvas",
      "mention_page",
      "embed_page",
      "subpage",
      "agent_config",
    ];
    const actionItems = items.filter((item) => (item.key ? actionKeys.includes(item.key) : false));

    expect(actionItems.map((item) => item.key)).toEqual(actionKeys);
    for (const item of actionItems) {
      expect(item.aliases ?? []).not.toHaveLength(0);
      expect(resolveNfmSuggestionHint(item)).toBe(null);
    }
  });

  test("inserts Callout through the same slash replacement boundary as other blocks", () => {
    let currentBlock = { id: "block-1", type: "paragraph", content: [] as unknown[] };
    const updateBlock = vi.fn((block: typeof currentBlock, patch: { type: string }) => {
      currentBlock = { ...block, ...patch };
      return currentBlock;
    });
    const editor = {
      getTextCursorPosition: () => ({ block: currentBlock }),
      updateBlock,
      setTextCursorPosition: vi.fn(),
      schema: {
        blockSchema: {
          paragraph: { content: "inline" },
          callout: { content: "inline" },
        },
      },
    };
    const calloutItem = getNfmSlashMenuCustomItems(editor).find((item) => item.key === "callout");

    expect(calloutItem).toMatchObject({ title: "Callout", group: "Blocks" });
    calloutItem?.onItemClick();

    expect(updateBlock).toHaveBeenCalledTimes(1);
    expect(updateBlock.mock.calls[0]?.[1]).toEqual({ type: "callout" });
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

  test("thread mention subtext suppresses default idle labels but keeps actionable states", () => {
    const project = createMentionProject();

    expect(resolveThreadMentionSubtext(makeChat({ threadId: "019-thread" }), project)).toBe(
      "Alpha / 019-thread",
    );
    expect(
      resolveThreadMentionSubtext(
        makeChat({ threadId: "019-thread", activity: "waitingOnUserInput" }),
        project,
      ),
    ).toBe("Alpha / Waiting / 019-thread");
  });

  test("Page candidates expose only disambiguation or content-match detail", () => {
    const insertInlineContent = vi.fn();
    const items = buildPageReferenceCandidateSuggestionItems(
      { insertInlineContent },
      [
        {
          pageId: "page-title",
          title: "Projection notes",
          pageKey: "NDX-42",
          status: { optionId: "doing", label: "In progress" },
          locationLabel: "Product / Editor",
          lifecycle: "active",
          matchExcerpt: "Projection notes",
          matchSource: "title",
          titleParts: [
            { text: "Projection", highlighted: true },
            { text: " notes", highlighted: false },
          ],
          matchExcerptParts: [],
          matches: [
            {
              source: "title",
              quality: "exact",
              parts: [
                { text: "Projection", highlighted: true },
                { text: " notes", highlighted: false },
              ],
            },
          ],
          disabledReason: null,
        },
        {
          pageId: "page-content",
          title: "Architecture",
          pageKey: "NDX-7",
          status: null,
          locationLabel: "Product / Foundations",
          lifecycle: "active",
          matchExcerpt: "The affected projection window stays bounded.",
          matchSource: "content",
          titleParts: [{ text: "Architecture", highlighted: false }],
          matchExcerptParts: [
            { text: "The affected ", highlighted: false },
            { text: "projection", highlighted: true },
            { text: " window stays bounded.", highlighted: false },
          ],
          matches: [
            {
              source: "body",
              quality: "exact",
              blockId: "block:projection",
              blockType: "paragraph",
              parts: [
                { text: "The affected ", highlighted: false },
                { text: "projection", highlighted: true },
                { text: " window stays bounded.", highlighted: false },
              ],
            },
          ],
          disabledReason: null,
        },
      ],
      "mention",
    );

    expect(items[0]).toMatchObject({
      title: "Projection notes",
      detail: null,
      group: "Mention a page",
    });
    expect(items[0]?.tooltipContent).not.toBeNull();
    expect(items[1]).toMatchObject({
      title: "Architecture",
      detail: "The affected projection window stays bounded.",
      group: "Mention a page",
    });
    expect(items[1]?.tooltipContent).not.toBeNull();
    const view = renderSuggestionMenu({
      items,
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });
    const [statusRow, genericPageRow] = view.getAllByRole("option");
    expect(statusRow?.querySelector("svg")?.classList.contains("size-4")).toBe(true);
    expect(statusRow?.querySelector("svg")?.getAttribute("style")).toContain("--status-doing-dot");
    expect(genericPageRow?.querySelector("svg")?.classList.contains("icon-xs")).toBe(true);
    items[1]?.onItemClick();
    expect(insertInlineContent).toHaveBeenCalledWith(
      [{ type: "pageMention", props: { targetPageId: "page-content" } }, " "],
      { updateSelection: true },
    );
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

  test("mention payload helpers preserve thread and date inline storage shapes", () => {
    const threadContent = buildNfmThreadMentionInlineContent(
      makeChat({ threadId: "thr-payload" }),
    ) as Array<{ type?: string; props?: { uuid?: string } } | string>;
    const firstThreadContent = threadContent[0];
    expect(typeof firstThreadContent === "string").toBe(false);
    if (typeof firstThreadContent === "string") return;
    expect(firstThreadContent?.type).toBe("threadMention");
    expect(firstThreadContent?.props?.uuid).toBe("session-1");
    expect(threadContent[1]).toBe(" ");
  });

  test("thread rows disclose only duplicate-title context or content excerpts", () => {
    const insertInlineContent = vi.fn();
    const items = buildNfmThreadMentionSuggestionItems(
      { insertInlineContent },
      [
        makeChatMatch(
          {
            threadId: "other-thread",
            title: "Weekly planning",
            projectId: "project-2",
            projectName: "Beta",
          },
          { inActiveProject: false },
        ),
        makeChatMatch({ threadId: "active-thread", title: "Weekly planning" }),
        makeChatMatch(
          {
            threadId: "content-thread",
            sessionId: "content-session",
            title: "Architecture review",
          },
          {
            excerpt: {
              text: "Only transcript content matched vector clocks.",
              ranges: [{ start: 32, end: 38 }],
              role: "assistant",
            },
          },
        ),
      ],
      "vector",
    );

    expect(items[0]?.detail).toBe("Beta");
    expect(items[1]?.detail).toBe("Alpha");
    expect(items[2]?.detail).toBe("Only transcript content matched vector clocks.");
    expect(items[2]?.detailSegments).toEqual([
      { text: "Only transcript content matched ", highlight: false },
      { text: "vector", highlight: true },
      { text: " clocks.", highlight: false },
    ]);
    expect(items[0]?.mentionRank?.activeContext).toBe(false);
    expect(items[1]?.mentionRank?.activeContext).toBe(true);
    expect(items[2]?.mentionRank?.match).toBe("content");
    expect(items.every((item) => item.tooltipContent !== null)).toBe(true);
    items[2]?.onItemClick();
    expect(insertInlineContent).toHaveBeenCalledWith(
      [{ type: "threadMention", props: { uuid: "content-session" } }, " "],
      { updateSelection: true },
    );
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

  test("excludes chats without a Thread and falls back to a short Thread id for empty titles", () => {
    const chat = makeChat({ threadId: null });
    expect(buildNfmThreadMentionSuggestionItems({}, [makeChatMatch(chat)], "")).toEqual([]);
    expect(buildNfmThreadMentionInlineContent(chat)).toEqual([]);
    const [item] = buildNfmThreadMentionSuggestionItems(
      {},
      [makeChatMatch({ title: "", threadId: "019-thread" })],
      "",
    );
    expect(item?.title).toBe("019-thread");
    expect(item?.mentionRank?.match).toBe("recent");
  });

  test("date mention suggestions are first for date-like queries and insert inline content", () => {
    expect(buildDateMentionSuggestionItems({}, "").map(({ title }) => title)).toEqual([
      "Today",
      "Now",
    ]);
    const items = selectNfmMentionSuggestionItems("today", [
      ...buildNfmThreadMentionSuggestionItems(
        {},
        [makeChatMatch({ title: "Today planning" })],
        "today",
      ),
      ...buildDateMentionSuggestionItems({}, "today"),
    ]);

    expect(items.length > 0).toBe(true);
    expect(items[0]?.title).toBe("Today");
    expect(items[0]?.group).toBe("Date");
    expect(items[1]?.title).toBe("Remind today");
    expect(items[1]?.group).toBe("Date");
    expect(items[2]?.title).toBe("Today planning");
    expect(items[2]?.group).toBe("Mention a chat");

    const inlineContent = buildDateMentionInlineContent({
      type: "dateMention",
      start: "2026-06-28",
      format: "relative",
    }) as Array<{ type?: string; props?: Record<string, string> } | string>;
    const first = inlineContent[0];
    expect(typeof first === "string").toBe(false);
    if (typeof first === "string") return;
    expect(first.type).toBe("dateMention");
    expect(first.props?.start).toBe("2026-06-28");
    expect(first.props?.format).toBe("relative");
    expect(inlineContent[1]).toBe(" ");
  });

  test("agent config item inserts a plan-mode chip", () => {
    let insertedContent: unknown[] | null = null;
    let insertedUpdateSelection: boolean | null = null;
    const editor = {
      insertInlineContent: (content: unknown[], options?: { updateSelection?: boolean }) => {
        insertedContent = content;
        insertedUpdateSelection = options?.updateSelection ?? null;
      },
    };

    const item = getNfmSlashMenuCustomItems(editor).find(
      (candidate) => candidate.title === "Agent Config",
    );
    expect(item !== undefined).toBe(true);
    if (!item) return;

    item.onItemClick();

    expect(Array.isArray(insertedContent)).toBe(true);
    const chip = insertedContent?.[0] as
      | { type?: string; props?: Record<string, string> }
      | undefined;
    expect(chip?.type).toBe("agentConfig");
    expect(chip?.props?.mode).toBe("plan");
    expect(chip?.props?.model).toBe("");
    expect(chip?.props?.reasoning).toBe("");
    expect(insertedContent?.[1]).toBe(" ");
    expect(insertedUpdateSelection).toBe(true);
  });

  test("renders grouped compact suggestion items with stable option ids", () => {
    const view = renderSuggestionMenu({
      items: makeItems(),
      loadingState: "loaded",
      selectedIndex: 1,
      onItemClick: () => undefined,
    });

    const list = view.getByRole("listbox");
    expect(list.id).toBe("bn-suggestion-menu");
    expect(view.getByText("Basic").textContent).toBe("Basic");
    expect(view.getByText("Others").textContent).toBe("Others");
    expect(view.queryByText("Plain text block")).toBe(null);

    const selected = view.container.querySelector("#bn-suggestion-menu-item-1");
    expect(selected).not.toBeNull();
    expect(selected?.getAttribute("role")).toBe("option");
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(selected?.textContent?.includes("Agent Config")).toBe(true);
    expect(selected?.textContent?.includes("/agent-config")).toBe(false);
  });

  test("pins suggestion menu controllers to the body-level portal target", () => {
    expect(NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS.portalElement).toBe(null);
    expect(
      NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS.floatingUIOptions.useFloatingOptions?.strategy,
    ).toBe("fixed");
    expect(
      NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS.floatingUIOptions.elementProps?.style?.zIndex,
    ).toBe(NFM_SUGGESTION_MENU_Z_INDEX);
  });

  test("scrolls selected suggestion rows within the menu list only", () => {
    const container = document.createElement("div");
    const item = document.createElement("button");
    container.appendChild(item);
    defineClientHeight(container, 100);
    defineElementRect(container, { top: 0, bottom: 100, height: 100 });

    container.scrollTop = 0;
    defineElementRect(item, { top: 20, bottom: 50, height: 30 });
    scrollElementIntoContainerView(container, item);
    expect(container.scrollTop).toBe(0);

    container.scrollTop = 80;
    defineElementRect(item, { top: -40, bottom: -10, height: 30 });
    scrollElementIntoContainerView(container, item);
    expect(container.scrollTop).toBe(40);

    container.scrollTop = 0;
    defineElementRect(item, { top: 120, bottom: 150, height: 30 });
    scrollElementIntoContainerView(container, item);
    expect(container.scrollTop).toBe(50);

    container.scrollTop = 0;
    defineElementRect(item, { top: 20, bottom: 180, height: 160 });
    scrollElementIntoContainerView(container, item);
    expect(container.scrollTop).toBe(0);
  });

  test("selected suggestion rows do not call native scrollIntoView", () => {
    const elementPrototype = HTMLElement.prototype as unknown as {
      scrollIntoView?: (options?: unknown) => void;
    };
    const originalScrollIntoView = elementPrototype.scrollIntoView;
    let scrollIntoViewCalls = 0;

    elementPrototype.scrollIntoView = function scrollIntoViewMock() {
      scrollIntoViewCalls += 1;
    };

    try {
      const view = renderSuggestionMenu({
        items: makeItems(),
        loadingState: "loaded",
        selectedIndex: undefined,
        onItemClick: () => undefined,
      });

      const list = view.container.querySelector(
        '[data-nfm-suggestion-menu-scroll-list="true"]',
      ) as HTMLElement | null;
      const row = view.container.querySelector("#bn-suggestion-menu-item-1") as HTMLElement | null;
      expect(list).not.toBeNull();
      expect(row).not.toBeNull();
      if (!list || !row) return;

      defineClientHeight(list, 40);
      defineElementRect(list, { top: 0, bottom: 40, height: 40 });
      defineElementRect(row, { top: 60, bottom: 88, height: 28 });

      view.rerender(
        <NodexTooltipProvider>
          <NfmSuggestionMenuSurface
            items={makeItems()}
            loadingState="loaded"
            selectedIndex={1}
            onItemClick={() => undefined}
          />
        </NodexTooltipProvider>,
      );

      expect(scrollIntoViewCalls).toBe(0);
      expect(list.scrollTop).toBe(48);
    } finally {
      if (originalScrollIntoView) {
        elementPrototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete elementPrototype.scrollIntoView;
      }
    }
  });

  test("resolves syntax hints from known keys, badges, and slash aliases", () => {
    expect(
      resolveNfmSuggestionHint({
        title: "Heading 2",
        key: "heading_2",
      } as DefaultReactSuggestionItem & { key: string }),
    ).toBe("##");
    expect(
      resolveNfmSuggestionHint({
        title: "Custom",
        aliases: ["custom-command"],
        onItemClick: () => undefined,
      }),
    ).toBe("/custom-command");
    expect(
      resolveNfmSuggestionHint({
        title: "Mention page",
        badge: "@",
        onItemClick: () => undefined,
      }),
    ).toBe("@");
  });

  test("clicking a suggestion item dispatches the selected item", () => {
    let clickedTitle = "";
    const view = renderSuggestionMenu({
      items: makeItems(),
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: (item) => {
        clickedTitle = item.title;
      },
    });

    fireEvent.click(view.getByText("Agent Config"));

    expect(clickedTitle).toBe("Agent Config");
  });

  test("renders compact empty and loading states", () => {
    const emptyView = renderSuggestionMenu({
      items: [],
      loadingState: "loaded",
      selectedIndex: undefined,
      onItemClick: () => undefined,
    });

    expect(emptyView.getByText("No matching commands").textContent).toBe("No matching commands");
    emptyView.unmount();

    const loadingView = renderSuggestionMenu({
      items: [],
      loadingState: "loading",
      selectedIndex: undefined,
      onItemClick: () => undefined,
    });

    expect(loadingView.getByText("Loading...").textContent).toBe("Loading...");
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

  test("long labels render without exposing subtext in the menu row", () => {
    const longTitle =
      "Very long command label that should stay inside the compact suggestion menu row";
    const longSubtext =
      "Very long description that should not force the menu to become chunky or overflow the viewport";
    const view = renderSuggestionMenu({
      items: [
        {
          title: longTitle,
          subtext: longSubtext,
          aliases: [],
          group: "Long",
          onItemClick: () => undefined,
        },
      ],
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });

    expect(view.getByText(longTitle).textContent).toBe(longTitle);
    expect(view.queryByText(longSubtext)).toBe(null);
  });

  test("mention rows render only explicit inline detail", () => {
    const view = renderSuggestionMenu({
      items: [
        {
          key: "page:target",
          title: "Projection notes",
          subtext: "This legacy field is not row detail",
          detail: "Product / Editor",
          tooltipContent: null,
          aliases: [],
          group: "Pages",
          onItemClick: () => undefined,
        } as NfmSuggestionItem,
      ],
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });

    expect(view.getByText("Projection notes").textContent).toBe("Projection notes");
    expect(view.getByText("Product / Editor").textContent).toBe("Product / Editor");
    expect(view.queryByText("This legacy field is not row detail")).toBe(null);
  });

  test("description details are disclosed through the item tooltip", async () => {
    const view = renderSuggestionMenu({
      items: makeItems(),
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });

    const row = view.container.querySelector("#bn-suggestion-menu-item-0") as HTMLElement | null;
    expect(row).not.toBeNull();
    if (!row) return;

    await act(async () => {
      fireEvent.focus(row);
      await settleAsyncRender();
    });

    const tooltip = view.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toBe("Plain text block");
    expect(tooltip?.textContent?.includes("Paragraph")).toBe(false);
    const tooltipLayer = tooltip?.closest('[data-slot="tooltip-positioner"]') as HTMLElement | null;
    expect(tooltipLayer?.style.zIndex).toBe(String(NFM_SUGGESTION_MENU_TOOLTIP_Z_INDEX));
  });

  test("mention details render Main excerpts and highlighting in rows and tooltips", async () => {
    const excerpt = "…Earlier context Compact transcript snippet. Later context…";
    const start = excerpt.indexOf("Compact");
    const items = buildNfmThreadMentionSuggestionItems(
      {},
      [
        makeChatMatch(
          { title: "Searchable thread" },
          {
            excerpt: {
              text: excerpt,
              ranges: [{ start, end: start + "Compact".length }],
              role: "assistant",
            },
          },
        ),
      ],
      "compact",
    );
    const view = renderSuggestionMenu({
      items,
      loadingState: "loaded",
      selectedIndex: 0,
      onItemClick: () => undefined,
    });

    const row = view.getByRole("option");
    const highlighted = view.getByText("Compact");
    expect(highlighted.parentElement?.textContent).toBe(excerpt);

    await act(async () => {
      fireEvent.focus(row);
      await settleAsyncRender();
    });

    const tooltip = view.container.ownerDocument.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toBe(`Searchable threadAlpha${excerpt}`);
  });

  test("lets pointer and keyboard selection expand a section without selecting a mention", () => {
    const query = "weekly";
    const sourceItems = Array.from({ length: 9 }, (_, index) => ({
      ...buildNfmThreadMentionSuggestionItems(
        {},
        [
          makeChatMatch({
            sessionId: `session-${index}`,
            threadId: `thread-${index}`,
            title: `Weekly ${index}`,
          }),
        ],
        "weekly",
      )[0]!,
      mentionRank: {
        family: "chat" as const,
        match: "title" as const,
        activeContext: true,
        sourceOrder: index,
      },
    }));
    let expandedFamily: "chat" | null = null;
    const items = selectNfmMentionSuggestionItems(query, sourceItems, {
      onExpandSection: (family) => {
        expandedFamily = family as "chat";
      },
    });
    const view = renderSuggestionMenu({
      items,
      loadingState: "loaded",
      selectedIndex: 4,
      onItemClick: (item) => {
        item.onItemClick();
      },
    });

    expect(view.getAllByRole("option")).toHaveLength(5);
    const moreRow = view.getByRole("option", { name: "5 more results" });
    expect(moreRow.getAttribute("data-selected")).toBe("true");
    expect(moreRow.getAttribute("data-mention-utility")).toBe("expand_section");
    fireEvent.click(moreRow);
    expect(expandedFamily).toBe("chat");

    view.unmount();
    const expandedItems = selectNfmMentionSuggestionItems(query, sourceItems, {
      expandedFamilies: new Set(["chat"]),
    });
    const expandedView = renderSuggestionMenu({
      items: expandedItems,
      loadingState: "loaded",
      selectedIndex: 4,
      onItemClick: () => undefined,
    });
    expect(expandedView.getAllByRole("option")).toHaveLength(9);
    expect(expandedView.queryByText("5 more results")).toBeNull();
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

  test("keeps a long no-result mention query open for correction", async () => {
    let closeMenuCalls = 0;
    const suggestionMenu = {
      getMenuState: () => ({
        triggerCharacter: "@",
        query: "zzzz",
        show: true,
      }),
    };
    const editorElement = document.createElement("div");
    const editor = {
      domElement: editorElement,
      prosemirrorView: { dom: editorElement },
      onMount: () => () => undefined,
      onUnmount: () => () => undefined,
      _tiptapEditor: { on: () => undefined, off: () => undefined },
      getExtension: () => suggestionMenu,
    } as unknown as BlockNoteEditor;
    const EmptyMentionMenu = () => <div>No matching mentions</div>;
    const contextValue = { editor, setContentEditableProps: () => undefined };
    const view = render(
      <BlockNoteContext.Provider value={contextValue}>
        <SuggestionMenuWrapper
          triggerCharacter="@"
          query="zzzz"
          closeMenu={() => {
            closeMenuCalls += 1;
          }}
          acceptMenu={() => false}
          getItems={async () => []}
          autoCloseWhenNoItems={false}
          suggestionMenuComponent={EmptyMentionMenu}
        />
      </BlockNoteContext.Provider>,
    );

    await act(async () => {
      await settleAsyncRender();
    });

    expect(view.getByText("No matching mentions")).toBeTruthy();
    expect(closeMenuCalls).toBe(0);
  });

  test("supports a mention-specific empty state", () => {
    const view = renderSuggestionMenu({
      items: [],
      loadingState: "loaded",
      selectedIndex: undefined,
      onItemClick: () => undefined,
      emptyMessage: "No matching mentions",
    });

    expect(view.getByText("No matching mentions").textContent).toBe("No matching mentions");
  });
});
