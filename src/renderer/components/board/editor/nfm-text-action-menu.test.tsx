import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type {
  ChatCatalogEntry,
  ChatMessageSearchResult,
  ChatSearchInput,
  ChatSearchMatch,
  ChatSearchResult,
} from "../../../../shared/chat-search";
import type { CodexThreadSummary, PageChatItem } from "@/lib/types";
import type { FindRequest, FindPhase } from "../../../../shared/find";
import { chatFindHit, findFixture } from "@/test/find-fixture";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../../../shared/command-keybindings";
import { queryKeys } from "@/lib/query-keys";
import { TEXT_ACTION_RECENT_COLOR_STORAGE_KEY } from "@/lib/text-action-color-recents";
import { render, settleAsyncRender } from "@/test/dom";
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
  search = ({ query, limit, startedOnly, preferredProjectId }) => ({
    matches: chats
      .filter(
        (chat) =>
          (!startedOnly || chat.threadId !== null) &&
          chat.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.projectId === preferredProjectId) - Number(a.projectId === preferredProjectId) ||
          b.recencyAt - a.recencyAt,
      )
      .slice(0, limit)
      .map((chat) => chatMatch(chat)),
    complete: true,
  }),
  messages = () => ({ matches: [], truncated: false, sources: [] }),
}: {
  chats?: readonly ChatCatalogEntry[];
  linkedChats?: PageChatItem[];
  search?: (input: ChatSearchInput) => ChatSearchResult | Promise<ChatSearchResult>;
  messages?: (input: {
    query: string;
    limit: number;
  }) => ChatMessageSearchResult | Promise<ChatMessageSearchResult>;
} = {}): void {
  chatQueryMock.mockImplementation(async (channel, input, phaseValue) => {
    if (channel === "find:search") {
      const request = input as FindRequest;
      const phase = phaseValue as FindPhase;
      const catalog = await search({ ...request, startedOnly: request.startedChatsOnly });
      const history = phase === "complete" && request.query ? await messages(request) : null;
      return findFixture(
        phase,
        [...catalog.matches, ...(history?.matches ?? [])].map(chatFindHit),
        {
          coverage: [
            { source: "chat_catalog", state: catalog.complete ? "complete" : "partial" },
            ...(history?.sources ?? []),
          ],
        },
      );
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
    chatQueryMock.mockReset();
    mockChatQueries();
  });

  async function openColorMenu(view: ReturnType<typeof renderTextActionMenu>["view"]) {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Color" }));
      await settleAsyncRender();
    });
  }

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
      report: null,
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

  test("offers no chat actions when the Page cannot send", () => {
    const { view } = renderTextActionMenu({ chat: null });

    expect(view.queryByRole("button", { name: "Send to chat" })).toBe(null);
    expect(Boolean(view.getByRole("button", { name: "Normal Text" }))).toBe(true);
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
    await waitFor(() =>
      expect(chatQueryMock).toHaveBeenCalledWith(
        "find:search",
        expect.objectContaining({ query: "unmatched", limit: 24 }),
        "complete",
        expect.any(String),
      ),
    );
    expect(view.getByText("Searching chat history…")).toBeTruthy();
    await act(async () => {
      history.resolve({
        matches: [],
        truncated: false,
        sources: [{ source: "runtime", state: "complete" }],
      });
      await Promise.resolve();
    });
    await view.findByText("No matching chats");
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
