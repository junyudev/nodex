import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { clearChatSearchCacheForTests } from "@/lib/chat-search";
import type {
  ChatCatalogEntry,
  ChatMessageSearchResult,
  ChatSearchInput,
  ChatSearchMatch,
  ChatSearchResult,
} from "../../../../shared/chat-search";
import type { CodexThreadSummary, PageChatItem } from "@/lib/types";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../../../shared/command-keybindings";
import { queryKeys } from "@/lib/query-keys";
import {
  TEXT_ACTION_RECENT_COLOR_STORAGE_KEY,
  writeTextActionRecentColors,
} from "@/lib/text-action-color-recents";
import { hoverWithMouse, render, settleAsyncRender } from "@/test/dom";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { NfmSendToThreadMenu } from "./nfm-send-to-thread-menu";
import type { NfmSendToThreadRequest } from "./nfm-send-to-thread-menu-model";
import {
  NfmTextActionMenuSurface,
  type NfmTextActionMenuSurfaceProps,
  type TextActionChat,
} from "./nfm-text-action-menu";

const chatQueryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: (...args: unknown[]) => chatQueryMock(...args),
}));

function makeSendToThreadItem(overrides: Partial<ChatCatalogEntry> = {}): ChatCatalogEntry {
  return {
    threadId: "thread-existing",
    sessionId: "session-existing",
    projectId: "default",
    projectName: "Default",
    title: "Existing implementation",
    cwd: "/repo",
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

function chatMatch(
  chat: ChatCatalogEntry,
  overrides: Partial<Omit<ChatSearchMatch, "chat">> = {},
): ChatSearchMatch {
  return { chat, titleRanges: [], hint: null, excerpt: null, ...overrides };
}

function makePreferredThreadFromItem(
  item: ChatCatalogEntry,
  overrides: Partial<CodexThreadSummary> = {},
): CodexThreadSummary {
  if (!item.threadId) throw new Error("Preferred chat must have a Thread.");
  return {
    threadId: item.threadId,
    projectId: item.projectId,
    source: null,
    threadName: item.title,
    threadPreview: "",
    modelProvider: "openai",
    cwd: item.cwd,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: item.createdAt,
    updatedAt: item.recencyAt,
    linkedAt: new Date(item.recencyAt).toISOString(),
    ...overrides,
  };
}

const SEND_TO_THREAD_CHATS = [makeSendToThreadItem()];

/** A deterministic Main catalog stand-in; individual tests can hold either search open. */
function mockChatQueries({
  chats = SEND_TO_THREAD_CHATS,
  linkedChats = [],
  search = ({ query, limit, startedOnly }) => ({
    matches: chats
      .filter(
        (chat) =>
          (!startedOnly || chat.threadId !== null) &&
          chat.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
      .slice(0, limit)
      .map((chat) => chatMatch(chat)),
    complete: true,
  }),
  messages = () => ({ matches: [], sources: [] }),
}: {
  chats?: readonly ChatCatalogEntry[];
  linkedChats?: PageChatItem[];
  search?: (input: ChatSearchInput) => ChatSearchResult | Promise<ChatSearchResult>;
  messages?: (input: {
    query: string;
    limit: number;
  }) => ChatMessageSearchResult | Promise<ChatMessageSearchResult>;
} = {}): void {
  chatQueryMock.mockImplementation(async (channel, input) => {
    if (channel === "chats:search") return search(input as ChatSearchInput);
    if (channel === "chats:search-messages") {
      return messages(input as { query: string; limit: number });
    }
    if (channel === "page-chats:list") {
      return { items: linkedChats, nextCursor: null, hasMore: false, projectionRevision: 1 };
    }
    throw new Error(`Unexpected query: ${String(channel)}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderTextActionMenu(
  props?: Partial<Omit<NfmTextActionMenuSurfaceProps, "chat">> & {
    readonly chat?: Partial<TextActionChat> | null;
    readonly keymapState?: CommandKeymapState;
  },
) {
  const actions = {
    blockTypes: [] as string[],
    styles: [] as string[],
    textColors: [] as string[],
    backgroundColors: [] as string[],
    clearFormat: 0,
    equations: 0,
    blockActions: 0,
    sendRequests: [] as NfmSendToThreadRequest[],
    composerAdds: 0,
    selectionPresentations: [] as string[],
  };

  const {
    chat: chatOverrides,
    keymapState = createCommandKeymapState({}, "linux"),
    ...surfaceProps
  } = props ?? {};
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.settings.commandKeymap(), keymapState);
  const chat: TextActionChat | null =
    chatOverrides === null
      ? null
      : {
          projectId: "default",
          projectNameById: { default: "Default" },
          contextualTarget: null,
          onSend: (request) => {
            actions.sendRequests.push(request);
          },
          ...chatOverrides,
        };

  function StatefulTextActionMenuSurface() {
    const [, setRenderedSelectionPresentation] = useState("none");

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
          {
            key: "heading-1",
            label: "Heading 1",
            type: "heading",
            props: { level: 1, isToggleable: false },
            isSelected: false,
          },
        ]}
        activeStyles={{
          bold: true,
          italic: false,
          underline: false,
          strike: false,
          code: false,
        }}
        textColor="default"
        backgroundColor="default"
        canUseTextColor={true}
        canUseBackgroundColor={true}
        canClearFormat={true}
        canConvertToEquation={true}
        linkControl={
          <button type="button" aria-label="Link">
            Link
          </button>
        }
        chat={chat}
        onSelectBlockType={(item) => {
          actions.blockTypes.push(item.key);
        }}
        onToggleStyle={(style) => {
          actions.styles.push(style);
        }}
        onSetTextColor={(color) => {
          actions.textColors.push(color);
        }}
        onSetBackgroundColor={(color) => {
          actions.backgroundColors.push(color);
        }}
        onClearFormat={() => {
          actions.clearFormat += 1;
        }}
        onConvertToEquation={() => {
          actions.equations += 1;
        }}
        onOpenBlockActions={() => {
          actions.blockActions += 1;
        }}
        {...surfaceProps}
        onSelectionPresentationChange={(presentation) => {
          actions.selectionPresentations.push(presentation);
          setRenderedSelectionPresentation(presentation);
          surfaceProps.onSelectionPresentationChange?.(presentation);
        }}
      />
    );
  }

  const view = renderWithAppMaitai(
    <TestQueryProvider client={client}>
      <NodexTooltipProvider>
        <StatefulTextActionMenuSurface />
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );

  return { actions, view };
}

describe("markdown text action menu surface", () => {
  beforeEach(() => {
    localStorage.removeItem(TEXT_ACTION_RECENT_COLOR_STORAGE_KEY);
    clearChatSearchCacheForTests();
    chatQueryMock.mockReset();
    mockChatQueries();
  });

  async function openColorMenu(view: ReturnType<typeof renderTextActionMenu>["view"]) {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Color" }));
      await settleAsyncRender();
    });
  }

  function installFocusProbe() {
    const focusProbe = document.createElement("button");
    focusProbe.type = "button";
    focusProbe.textContent = "Focus probe";
    document.body.appendChild(focusProbe);
    focusProbe.focus();
    return focusProbe;
  }

  test("opens the block type menu and delegates Turn into selections", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Normal Text" }));
      await settleAsyncRender();
    });

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Heading 1" }));
      await settleAsyncRender();
    });

    expect(actions.blockTypes.join(",")).toBe("heading-1");
  });

  test("reports Block presentation while the block type picker is active", async () => {
    const { actions, view } = renderTextActionMenu();
    const trigger = view.getByRole("button", { name: "Normal Text" });

    await act(async () => {
      trigger.focus();
      fireEvent.focus(trigger);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );

    await act(async () => {
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    const headingItem = view.getByRole("menuitem", { name: "Heading 1" });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "blocks",
    );

    await act(async () => {
      headingItem.focus();
      fireEvent.focus(headingItem);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "blocks",
    );
  });

  test("keeps inline presentation while the Color picker owns focus", async () => {
    const { actions, view } = renderTextActionMenu();

    await openColorMenu(view);
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );

    const colorOptions = view.getByRole("menu", { name: "Color options" });
    await act(async () => {
      colorOptions.focus();
      fireEvent.focus(colorOptions);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );
  });

  test("invokes supported annotation and Nodex actions", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Bold" }));
      fireEvent.click(view.getByRole("button", { name: "Clear format" }));
      fireEvent.click(view.getByRole("button", { name: "Equation" }));
      await settleAsyncRender();
    });

    expect(actions.styles.join(",")).toBe("bold");
    expect(actions.clearFormat).toBe(1);
    expect(actions.equations).toBe(1);
  });

  function preferredChat() {
    const existingThread = SEND_TO_THREAD_CHATS[0];
    if (!existingThread) throw new Error("missing send-to-thread fixture");
    return {
      kind: "thread" as const,
      thread: makePreferredThreadFromItem(existingThread),
      sessionId: "session-preferred",
      meta: "This chat",
    };
  }

  const renderPicker: NonNullable<NfmTextActionMenuSurfaceProps["renderSendToThreadMenu"]> = (
    props,
  ) => <NfmSendToThreadMenu {...props} />;

  test("sends the selection to the chat beside the Page in one step", async () => {
    const { actions, view } = renderTextActionMenu({
      chat: { contextualTarget: preferredChat() },
      renderSendToThreadMenu: renderPicker,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to chat" }));
      await settleAsyncRender();
    });

    await waitFor(() => {
      expect(actions.sendRequests.length).toBe(1);
    });
    expect(actions.sendRequests).toEqual([
      {
        target: {
          kind: "thread",
          threadId: "thread-existing",
          sessionId: "session-preferred",
        },
      },
    ]);
    expect(view.queryByRole("dialog", { name: "Send to chat" })).toBe(null);
  });

  test("chooses another chat from the picker beside Send", async () => {
    const { actions, view } = renderTextActionMenu({
      chat: { contextualTarget: preferredChat() },
      renderSendToThreadMenu: renderPicker,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to another chat" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
    expect(view.getByRole("combobox", { name: "Search chats" }).getAttribute("placeholder")).toBe(
      "Search chats…",
    );
    expect(view.getByText("Send to", { exact: true })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Send & wrap" })).toBe(null);
    expect(view.getAllByRole("option")).toEqual([
      view.getByRole("option", { name: /^Existing implementation\s*This chat$/ }),
      view.getByRole("option", { name: /^New chat\s*This project$/ }),
    ]);

    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: /New chat/ }));
      await settleAsyncRender();
    });

    await waitFor(() => {
      expect(actions.sendRequests.length).toBe(1);
    });
    expect(actions.sendRequests).toEqual([{ target: { kind: "new-thread" } }]);
    await waitFor(() => {
      expect(view.queryByRole("dialog", { name: "Send to chat" })).toBe(null);
    });
  });

  test("sends to another existing chat using the picker result's Session", async () => {
    mockChatQueries({
      chats: [
        ...SEND_TO_THREAD_CHATS,
        makeSendToThreadItem({
          threadId: "thread-other",
          sessionId: "session-other",
          title: "Other work",
        }),
      ],
    });
    const { actions, view } = renderTextActionMenu({
      chat: { contextualTarget: preferredChat() },
      renderSendToThreadMenu: renderPicker,
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to another chat" }));
      await Promise.resolve();
    });
    const destination = await view.findByRole("option", { name: /^Other work\s*Default$/ });
    await act(async () => {
      fireEvent.click(destination);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(actions.sendRequests).toEqual([
        {
          target: { kind: "thread", threadId: "thread-other", sessionId: "session-other" },
        },
      ]),
    );
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Send to chat" })).toBeNull());
  });

  test("loads the source Page's older Linked chats after this chat and hides them during search", async () => {
    const existing = SEND_TO_THREAD_CHATS[0];
    if (!existing) throw new Error("missing chat fixture");
    const recent = makeSendToThreadItem({
      threadId: "thread-recent",
      sessionId: "session-recent",
      title: "Recent work",
      recencyAt: 50,
    });
    const linked: PageChatItem = {
      sessionId: "session-linked",
      projectId: "default",
      projectName: "Default",
      displayTitle: "Old linked work",
      threadId: "thread-linked",
      executionRef: null,
      threadPreview: "",
      threadStatus: null,
      threadArchived: false,
      sessionArchived: false,
      unread: false,
      conversationRecencyAt: 0,
      linkedAt: "2026-01-01T00:00:00.000Z",
    };
    mockChatQueries({ chats: [recent, existing], linkedChats: [linked] });
    const { actions, view } = renderTextActionMenu({
      chat: { sourcePageId: "source-page", contextualTarget: preferredChat() },
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to another chat" }));
      await Promise.resolve();
    });
    const linkedRow = await view.findByRole("option", { name: /^Old linked work\s*Linked$/ });
    expect(chatQueryMock).toHaveBeenCalledWith("page-chats:list", {
      pageId: "source-page",
      includeArchived: false,
      after: null,
      first: 20,
    });
    expect(view.getAllByRole("option")).toEqual([
      view.getByRole("option", { name: /^Existing implementation\s*This chat$/ }),
      linkedRow,
      view.getByRole("option", { name: /^Recent work\s*Default$/ }),
      view.getByRole("option", { name: /^New chat\s*This project$/ }),
    ]);
    const input = view.getByRole("combobox", { name: "Search chats" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Re" } });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.queryByRole("option", { name: /^Old linked work\s*Linked$/ })).toBeNull(),
    );
    expect(view.getAllByRole("option")).toEqual([
      view.getByRole("option", { name: /^Recent work\s*Default$/ }),
      view.getByRole("option", { name: /^New chat\s*This project$/ }),
    ]);
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
      await Promise.resolve();
    });
    const restoredLink = await view.findByRole("option", { name: /^Old linked work\s*Linked$/ });
    await act(async () => {
      fireEvent.click(restoredLink);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(actions.sendRequests).toEqual([
        {
          target: { kind: "thread", threadId: "thread-linked", sessionId: "session-linked" },
        },
      ]),
    );
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Send to chat" })).toBeNull());
  });

  test("opens the picker from Send when no chat is beside the Page", async () => {
    const { actions, view } = renderTextActionMenu({ renderSendToThreadMenu: renderPicker });

    expect(view.queryByRole("button", { name: "Send to another chat" })).toBe(null);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to chat" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
    expect(actions.sendRequests.length).toBe(0);
  });

  test("adds the selection to the beside chat's composer only when it has one", async () => {
    const withComposer = renderTextActionMenu({
      chat: {
        contextualTarget: preferredChat(),
        onAddToComposer: () => {
          withComposer.actions.composerAdds += 1;
        },
      },
    });

    await act(async () => {
      fireEvent.click(withComposer.view.getByRole("button", { name: "Add to composer" }));
      await settleAsyncRender();
    });
    expect(withComposer.actions.composerAdds).toBe(1);
    withComposer.view.unmount();

    const withoutComposer = renderTextActionMenu();
    expect(withoutComposer.view.queryByRole("button", { name: "Add to composer" })).toBe(null);
  });

  test("chat tooltips display the current command bindings", async () => {
    const { view } = renderTextActionMenu({
      keymapState: createCommandKeymapState(
        { pageEditorSendToChat: ["Ctrl+Alt+Y"], pageEditorAddToComposer: ["Ctrl+Shift+U"] },
        "windows",
      ),
      chat: { contextualTarget: preferredChat(), onAddToComposer: () => {} },
    });
    await act(async () => {
      hoverWithMouse(view.getByRole("button", { name: "Send to chat" }));
    });
    expect((await view.findByRole("tooltip")).textContent).toContain("Ctrl+Alt+Y");
    await act(async () => {
      fireEvent.pointerLeave(view.getByRole("button", { name: "Send to chat" }));
      hoverWithMouse(view.getByRole("button", { name: "Add to composer" }));
    });
    await waitFor(() => expect(view.getByRole("tooltip").textContent).toContain("Ctrl+Shift+U"));
  });

  test("offers no chat actions when the Page cannot send", () => {
    const { view } = renderTextActionMenu({ chat: null });

    expect(view.queryByRole("button", { name: "Send to chat" })).toBe(null);
    expect(Boolean(view.getByRole("button", { name: "Normal Text" }))).toBe(true);
  });
  test("selected-block picker puts this chat first, then the active Project, and New chat last", async () => {
    const existingThread = SEND_TO_THREAD_CHATS[0];
    if (!existingThread) {
      throw new Error("missing send-to-thread fixture");
    }

    mockChatQueries({
      chats: [
        makeSendToThreadItem({
          threadId: "thread-other-project",
          sessionId: "session-other-project",
          projectId: "other",
          projectName: "Other project",
          title: "Other project chat",
          recencyAt: 10,
        }),
        { ...existingThread, recencyAt: 1 },
        makeSendToThreadItem({
          threadId: "thread-newer",
          sessionId: "session-newer",
          title: "Recently updated",
          recencyAt: 5,
        }),
      ],
    });

    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            projectNameById={{ default: "Default" }}
            preferredTarget={{
              kind: "thread",
              thread: makePreferredThreadFromItem(existingThread, { updatedAt: 1 }),
              sessionId: "session-preferred",
              meta: "This chat",
            }}
            onAccept={() => undefined}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();

    await view.findByRole("option", { name: /^Recently updated\s*Default$/ });
    const options = view.getAllByRole("option");
    expect(options).toEqual([
      view.getByRole("option", { name: /^Existing implementation\s*This chat$/ }),
      view.getByRole("option", { name: /^Recently updated\s*Default$/ }),
      view.getByRole("option", { name: /^Other project chat\s*Other project$/ }),
      view.getByRole("option", { name: /^New chat\s*This project$/ }),
    ]);
  });

  test("selected-block picker shows the highlighted excerpt of a message-only chat match", async () => {
    const chat = makeSendToThreadItem();
    mockChatQueries({
      messages: () => ({
        matches: [
          chatMatch(chat, {
            excerpt: {
              text: "Review handoff notes before sending.",
              ranges: [{ start: 7, end: 14 }],
              role: "assistant",
            },
          }),
        ],
        sources: [{ source: "runtime", state: "complete" }],
      }),
    });
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            initialQuery="handoff"
            onAccept={() => undefined}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );

    const match = await view.findByRole("option", {
      name: /Existing implementation/,
    });
    expect(within(match).getByText("handoff").parentElement?.textContent).toBe(
      "Review handoff notes before sending.",
    );
    expect(view.getAllByRole("option")).toEqual([
      match,
      view.getByRole("option", { name: /^New chat\s*This project$/ }),
    ]);
    expect(chatQueryMock).toHaveBeenCalledWith("chats:search", {
      query: "handoff",
      limit: 24,
      startedOnly: true,
    });
    expect(chatQueryMock).toHaveBeenCalledWith("chats:search-messages", {
      query: "handoff",
      limit: 24,
    });
  });

  test("selected-block picker displays current session new chat first when the session has no thread", async () => {
    const acceptedRequests: NfmSendToThreadRequest[] = [];
    mockChatQueries({
      chats: [
        makeSendToThreadItem({
          threadId: "thread-newer",
          sessionId: "session-newer",
          title: "Recently updated",
          recencyAt: 5,
        }),
      ],
    });

    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            projectNameById={{ default: "Default" }}
            preferredTarget={{
              kind: "new-thread",
              sessionId: "session-current",
              meta: "This chat",
            }}
            onAccept={(request) => {
              acceptedRequests.push(request);
            }}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options).toEqual([
      view.getByRole("option", { name: /^New chat\s*This chat$/ }),
      view.getByRole("option", { name: /^Recently updated\s*Default$/ }),
    ]);

    await act(async () => {
      fireEvent.click(options[0] as HTMLElement);
      await settleAsyncRender();
    });
    expect(acceptedRequests).toEqual([
      {
        target: { kind: "new-thread", sessionId: "session-current" },
      },
    ]);
  });

  test("Send to chat can use the current Session new chat target", async () => {
    mockChatQueries({
      chats: [
        makeSendToThreadItem({
          threadId: "thread-session-other",
          sessionId: "session-other",
          title: "Other session",
          recencyAt: 10,
        }),
      ],
    });

    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            projectNameById={{ default: "Default" }}
            preferredTarget={{
              kind: "new-thread",
              sessionId: "session-current",
              meta: "This chat",
            }}
            onAccept={() => undefined}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options).toEqual([
      view.getByRole("option", { name: /^New chat\s*This chat$/ }),
      view.getByRole("option", { name: /^Other session\s*Default$/ }),
    ]);
  });

  test("keeps New chat available at the bottom for empty search results", async () => {
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            initialQuery="nothing matches"
            onAccept={() => undefined}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();

    expect(await view.findByText("No matching chats")).toBeTruthy();
    const options = view.getAllByRole("option");
    expect(options).toEqual([view.getByRole("option", { name: /^New chat\s*This project$/ })]);
  });

  test("consumes stale navigation and queues Enter until the live catalog answer arrives", async () => {
    const nextAnswer = deferred<ChatSearchResult>();
    const oldChat = makeSendToThreadItem({ title: "Previous destination" });
    const nextChat = makeSendToThreadItem({
      threadId: "thread-build",
      sessionId: "session-build",
      title: "Build flow",
    });
    mockChatQueries({
      search: ({ query }) =>
        query ? nextAnswer.promise : { matches: [chatMatch(oldChat)], complete: true },
    });
    const onAccept = vi.fn();
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu projectId="default" onAccept={onAccept} onClose={() => undefined} />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    const oldRow = await view.findByRole("option", { name: /^Previous destination\s*Default$/ });
    const input = view.getByRole("combobox", { name: "Search chats" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(oldRow.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.change(input, { target: { value: "Build" } });
      await Promise.resolve();
    });
    expect(view.getByRole("option", { name: /^Previous destination\s*Default$/ })).toBe(oldRow);
    expect(view.queryByRole("option", { selected: true })).toBeNull();
    await act(async () => {
      expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(false);
      expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(false);
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { selected: true })).toBeNull();
    expect(view.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(onAccept).not.toHaveBeenCalled();

    await act(async () => {
      nextAnswer.resolve({ matches: [chatMatch(nextChat)], complete: true });
      await Promise.resolve();
    });
    await view.findByRole("option", { name: /^Build flow\s*Default$/ });
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "thread", threadId: "thread-build", sessionId: "session-build" },
      }),
    );
    expect(view.queryByRole("option", { name: /^Previous destination\s*Default$/ })).toBeNull();
  });

  test("cancels queued acceptance when the query changes and ignores a late catalog answer", async () => {
    const obsolete = deferred<ChatSearchResult>();
    const current = deferred<ChatSearchResult>();
    mockChatQueries({
      search: ({ query }) => {
        if (query === "build") return obsolete.promise;
        if (query === "release") return current.promise;
        return { matches: [], complete: true };
      },
    });
    const onAccept = vi.fn();
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu projectId="default" onAccept={onAccept} onClose={() => undefined} />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await view.findByText("No chats yet");
    const input = view.getByRole("combobox", { name: "Search chats" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "build" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "release" } });
      await Promise.resolve();
    });
    const releaseChat = makeSendToThreadItem({
      threadId: "thread-release",
      sessionId: "session-release",
      title: "Release plan",
    });
    await act(async () => {
      current.resolve({ matches: [chatMatch(releaseChat)], complete: true });
      await Promise.resolve();
    });
    await view.findByRole("option", { name: /^Release plan\s*Default$/ });
    expect(onAccept).not.toHaveBeenCalled();
    await act(async () => {
      obsolete.resolve({
        matches: [chatMatch(makeSendToThreadItem({ title: "Build plan" }))],
        complete: true,
      });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: /^Build plan\s*Default$/ })).toBeNull();
    expect(view.getByRole("option", { name: /^Release plan\s*Default$/ })).toBeTruthy();
    expect(onAccept).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "thread", threadId: "thread-release", sessionId: "session-release" },
      }),
    );
  });

  test("accepts New chat once the live catalog settles without waiting for message history", async () => {
    const catalog = deferred<ChatSearchResult>();
    const history = deferred<ChatMessageSearchResult>();
    mockChatQueries({
      search: ({ query }) => (query ? catalog.promise : { matches: [], complete: true }),
      messages: () => history.promise,
    });
    const onAccept = vi.fn();
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu projectId="default" onAccept={onAccept} onClose={() => undefined} />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await view.findByText("No chats yet");
    const input = view.getByRole("combobox", { name: "Search chats" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "unmatched" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    await view.findByText("Searching chat history…");
    await waitFor(() =>
      expect(chatQueryMock).toHaveBeenCalledWith("chats:search-messages", {
        query: "unmatched",
        limit: 24,
      }),
    );
    expect(onAccept).not.toHaveBeenCalled();
    await act(async () => {
      catalog.resolve({ matches: [], complete: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "new-thread" },
      }),
    );
    expect(view.getByText("Searching chat history…")).toBeTruthy();
    await act(async () => {
      history.resolve({ matches: [], sources: [{ source: "runtime", state: "complete" }] });
      await Promise.resolve();
    });
    await view.findByText("No matching chats");
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["", "No chats yet"],
    ["xy", "No matching chats"],
  ])("shows catalog loading before the first answer for query %j", async (query, emptyState) => {
    const catalog = deferred<ChatSearchResult>();
    mockChatQueries({ search: () => catalog.promise });
    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NfmSendToThreadMenu
            projectId="default"
            initialQuery={query}
            onAccept={() => undefined}
            onClose={() => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    expect(view.getByText("Loading chats...")).toBeTruthy();
    expect(view.queryByText(emptyState)).toBeNull();
    await act(async () => {
      catalog.resolve({ matches: [], complete: true });
      await Promise.resolve();
    });
    await view.findByText(emptyState);
    expect(view.queryByText("Loading chats...")).toBeNull();
    expect(view.getByRole("option", { name: /^New chat\s*This project$/ })).toBeTruthy();
  });

  test("hands More off to block actions without opening the legacy dropdown", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "More" }));
      await settleAsyncRender();
    });

    expect(actions.blockActions).toBe(1);
    expect(view.queryByRole("menuitem", { name: "Block actions" }) === null).toBe(true);
    expect(view.queryByRole("menuitem", { name: "Duplicate" }) === null).toBe(true);
  });

  test("opens the send-to-chat picker only after activation", async () => {
    const focusProbe = installFocusProbe();
    try {
      const { view } = renderTextActionMenu({
        renderSendToThreadMenu: (props) => <NfmSendToThreadMenu {...props} />,
      });

      await act(async () => {
        fireEvent.pointerEnter(view.getByRole("button", { name: "Send to chat" }));
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);
      expect(document.activeElement === focusProbe).toBe(true);

      const sendToChatRow = view.getByRole("button", { name: "Send to chat" });
      await act(async () => {
        sendToChatRow.focus();
        fireEvent.focus(sendToChatRow);
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);

      await act(async () => {
        fireEvent.click(sendToChatRow);
        await settleAsyncRender();
      });

      const searchInput = view.getByRole("combobox", { name: "Search chats" });
      expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
      expect(document.activeElement === sendToChatRow).toBe(true);
      expect(document.activeElement === searchInput).toBe(false);
    } finally {
      focusProbe.remove();
    }
  });

  test("reports Block presentation while a Block action picker is active", async () => {
    const focusProbe = installFocusProbe();
    try {
      const { actions, view } = renderTextActionMenu({
        renderSendToThreadMenu: (props) => <NfmSendToThreadMenu {...props} />,
      });

      const sendToChatRow = view.getByRole("button", { name: "Send to chat" });
      await act(async () => {
        sendToChatRow.focus();
        fireEvent.focus(sendToChatRow);
        await settleAsyncRender();
      });
      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "inline",
      );

      await act(async () => {
        fireEvent.click(sendToChatRow);
        expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
          "blocks",
        );
        await settleAsyncRender();
      });

      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "blocks",
      );

      const searchInput = view.getByRole("combobox", { name: "Search chats" });
      await act(async () => {
        searchInput.focus();
        fireEvent.focus(searchInput);
        await settleAsyncRender();
      });
      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "blocks",
      );

      await act(async () => {
        fireEvent.keyDown(searchInput, { key: "Escape" });
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);

      await act(async () => {
        view.unmount();
        await settleAsyncRender();
      });

      await waitFor(() => {
        expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
          "none",
        );
      });
    } finally {
      focusProbe.remove();
    }
  });

  test("shows hover tooltips for icon-only formatting buttons", async () => {
    const { view } = renderTextActionMenu();

    await act(async () => {
      const italic = view.getByRole("button", { name: "Italic" });
      fireEvent.pointerEnter(italic, { pointerType: "mouse" });
      fireEvent.mouseEnter(italic);
      await settleAsyncRender();
    });

    expect(view.getAllByText("Italic").length > 0).toBe(true);
  });

  test("renders the color trigger as a DOM A over the selected background", () => {
    const { view } = renderTextActionMenu({
      textColor: "blue",
      backgroundColor: "yellow",
    });

    const colorButton = view.getByRole("button", { name: "Color" });

    expect(colorButton.textContent).toBe("A");
    expect(colorButton.querySelector("svg") === null).toBe(true);
  });

  test("opens the Notion-style color grid in fixture order", async () => {
    const { view } = renderTextActionMenu();

    await openColorMenu(view);

    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
    expect(Boolean(view.getByText("Recently used"))).toBe(true);
    expect(Boolean(view.getByText("Text color"))).toBe(true);
    expect(Boolean(view.getByText("Background color"))).toBe(true);

    const itemLabels = view
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label"))
      .join("|");

    expect(itemLabels).toBe(
      "Recently used: Yellow background" +
        "|Text color: Default|Text color: Gray|Text color: Brown|Text color: Orange|Text color: Yellow|Text color: Green|Text color: Blue|Text color: Purple|Text color: Pink|Text color: Red" +
        "|Background color: Default|Background color: Gray|Background color: Brown|Background color: Orange|Background color: Yellow|Background color: Green|Background color: Blue|Background color: Purple|Background color: Pink|Background color: Red",
    );
  });

  test("renders five persisted recently-used color slots before the color grids", async () => {
    writeTextActionRecentColors([
      { kind: "text", color: "blue" },
      { kind: "text", color: "pink" },
      { kind: "background", color: "red" },
      { kind: "background", color: "purple" },
      { kind: "background", color: "green" },
    ]);
    const { view } = renderTextActionMenu();

    await openColorMenu(view);

    const firstSixItemLabels = view
      .getAllByRole("menuitem")
      .slice(0, 6)
      .map((item) => item.getAttribute("aria-label"))
      .join("|");

    expect(firstSixItemLabels).toBe(
      "Recently used: Blue text" +
        "|Recently used: Pink text" +
        "|Recently used: Red background" +
        "|Recently used: Purple background" +
        "|Recently used: Green background" +
        "|Text color: Default",
    );
  });

  test("delegates color swatches and reuses the persisted recent color", async () => {
    const { actions, view } = renderTextActionMenu();

    await openColorMenu(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Text color: Blue" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("blue");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Recently used: Blue text" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("blue,blue");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Background color: Yellow" }));
      await settleAsyncRender();
    });

    expect(actions.backgroundColors.join(",")).toBe("yellow");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
  });

  test("toggles the active text and background colors back to default without closing", async () => {
    const { actions, view } = renderTextActionMenu({
      textColor: "blue",
      backgroundColor: "yellow",
    });

    await openColorMenu(view);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Text color: Blue" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("default");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Background color: Yellow" }));
      await settleAsyncRender();
    });

    expect(actions.backgroundColors.join(",")).toBe("default");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
  });

  test("keeps unsupported color controls inert", async () => {
    writeTextActionRecentColors([{ kind: "text", color: "blue" }]);
    const { actions, view } = renderTextActionMenu({
      canUseTextColor: false,
      canUseBackgroundColor: true,
    });

    await openColorMenu(view);

    expect(view.queryByText("Text color") === null).toBe(true);
    expect(
      view
        .getByRole("menuitem", { name: "Recently used: Blue text" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Recently used: Blue text" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.length).toBe(0);
    expect(actions.backgroundColors.length).toBe(0);
  });

  test("disables the color trigger when no color style is supported", async () => {
    const { view } = renderTextActionMenu({
      canUseTextColor: false,
      canUseBackgroundColor: false,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Color" }));
      await settleAsyncRender();
    });

    expect(view.getByRole("button", { name: "Color" }).getAttribute("aria-disabled")).toBe("true");
    expect(view.queryByRole("dialog", { name: "Color" }) === null).toBe(true);
  });
});
