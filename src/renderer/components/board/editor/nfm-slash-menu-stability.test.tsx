import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";

import type {
  ChatCatalogEntry,
  ChatMessageSearchResult,
  ChatSearchMatch,
  ChatSearchResult,
} from "../../../../shared/chat-search";
import { render } from "@/test/dom";
import {
  type NfmMentionGetItemsLoaders,
  type NfmSuggestionItem,
  useNfmMentionGetItems,
} from "./nfm-slash-menu";

type GetItems = (query: string) => Promise<NfmSuggestionItem[]>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const fakeEditor = {
  insertInlineContent: () => undefined,
};

function makeMatch(chat: Partial<ChatCatalogEntry> = {}): ChatSearchMatch {
  return {
    chat: {
      sessionId: "session-1",
      threadId: "thr-1",
      projectId: "project-1",
      projectName: "Project",
      title: "Mention thread",
      cwd: "/tmp/project",
      branch: null,
      pullRequests: [],
      pinned: false,
      pinnedOrder: null,
      activity: "idle",
      createdAt: 1,
      recencyAt: 2,
      ...chat,
    },
    titleRanges: [],
    hint: null,
    excerpt: null,
  };
}

function makeMessageMatch(chat: Partial<ChatCatalogEntry> = {}): ChatSearchMatch {
  return {
    ...makeMatch(chat),
    excerpt: { text: "Review context", ranges: [{ start: 0, end: 6 }], role: "user" },
  };
}

function messageResults(matches: readonly ChatSearchMatch[] = []): ChatMessageSearchResult {
  return { matches, sources: [{ source: "runtime", state: "complete" }] };
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeLoaders(options: Partial<NfmMentionGetItemsLoaders> = {}): NfmMentionGetItemsLoaders {
  return {
    searchChats: vi.fn(async () => ({ matches: [makeMatch()], complete: true })),
    searchChatMessages: vi.fn(async () => messageResults()),
    ...options,
  };
}

function MentionGetItemsHarness({
  getItemsSnapshots,
  loaders,
  activeProjectId = "project-1",
}: {
  getItemsSnapshots: GetItems[];
  loaders: NfmMentionGetItemsLoaders;
  activeProjectId?: string | null;
}) {
  const getItems = useNfmMentionGetItems({
    editor: fakeEditor,
    activeProjectId,
    loaders,
  });
  getItemsSnapshots.push(getItems);

  return <div>ready</div>;
}

async function getMentionItems(getItems: GetItems, query: string): Promise<NfmSuggestionItem[]> {
  let items: NfmSuggestionItem[] = [];
  await act(async () => {
    items = await getItems(query);
  });
  return items;
}

describe("useNfmMentionGetItems", () => {
  test("keeps getItems stable until history refreshes and reuses the fast answer", async () => {
    const getItemsSnapshots: GetItems[] = [];
    const catalog = createDeferred<ChatSearchResult>();
    const messages = createDeferred<ChatMessageSearchResult>();
    const loaders = makeLoaders({
      searchChats: vi.fn(() => catalog.promise),
      searchChatMessages: vi.fn(() => messages.promise),
    });
    const view = render(
      <MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />,
    );
    const firstGetItems = getItemsSnapshots.at(-1)!;

    view.rerender(
      <MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />,
    );
    expect(getItemsSnapshots.at(-1)).toBe(firstGetItems);

    let firstRequest!: ReturnType<GetItems>;
    let secondRequest!: ReturnType<GetItems>;
    await act(async () => {
      firstRequest = firstGetItems("review");
      secondRequest = firstGetItems("review");
      await Promise.resolve();
    });
    expect(loaders.searchChats).toHaveBeenCalledExactlyOnceWith({
      query: "review",
      limit: 24,
      startedOnly: true,
    });
    expect(loaders.searchChatMessages).toHaveBeenCalledExactlyOnceWith({
      query: "review",
      limit: 24,
    });

    await act(async () => {
      catalog.resolve({ matches: [makeMatch()], complete: true });
      await Promise.all([firstRequest, secondRequest]);
    });
    expect((await firstRequest).map((item) => item.title)).toEqual(["Mention thread"]);
    expect((await secondRequest).map((item) => item.title)).toEqual(["Mention thread"]);
    expect(getItemsSnapshots.at(-1)).toBe(firstGetItems);

    await act(async () => {
      messages.resolve(
        messageResults([
          makeMessageMatch({ sessionId: "session-2", threadId: "thr-2", title: "History match" }),
        ]),
      );
      await Promise.resolve();
    });

    const refreshedGetItems = getItemsSnapshots.at(-1)!;
    expect(refreshedGetItems).not.toBe(firstGetItems);
    const refreshedItems = await getMentionItems(refreshedGetItems, "review");
    expect(refreshedItems.map((item) => item.title)).toEqual(["Mention thread", "History match"]);
    expect(loaders.searchChats).toHaveBeenCalledTimes(1);
    expect(loaders.searchChatMessages).toHaveBeenCalledTimes(1);
  });

  test("@now returns the date affordance while message history is still loading", async () => {
    const getItemsSnapshots: GetItems[] = [];
    const messages = createDeferred<ChatMessageSearchResult>();
    const loaders = makeLoaders({
      searchChats: vi.fn(async () => ({ matches: [], complete: true })),
      searchChatMessages: vi.fn(() => messages.promise),
    });
    render(<MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />);

    const items = await getMentionItems(getItemsSnapshots.at(-1)!, "now");
    expect(items.map((item) => item.title)).toEqual(["Now"]);
    expect(items[0]?.group).toBe("Date");
    expect(loaders.searchChatMessages).toHaveBeenCalledTimes(1);
  });

  test("slow message results only supplement the latest query", async () => {
    const getItemsSnapshots: GetItems[] = [];
    const oldMessages = createDeferred<ChatMessageSearchResult>();
    const nowMessages = createDeferred<ChatMessageSearchResult>();
    const loaders = makeLoaders({
      searchChats: vi.fn(async () => ({ matches: [], complete: true })),
      searchChatMessages: vi.fn(({ query }) =>
        query === "old" ? oldMessages.promise : nowMessages.promise,
      ),
    });
    render(<MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />);
    const getItems = getItemsSnapshots.at(-1)!;

    await getMentionItems(getItems, "old");
    expect((await getMentionItems(getItems, "now")).map((item) => item.title)).toEqual(["Now"]);

    await act(async () => {
      oldMessages.resolve(messageResults([makeMessageMatch({ title: "Old search thread" })]));
      await Promise.resolve();
    });
    expect(getItemsSnapshots.at(-1)).toBe(getItems);
    expect((await getMentionItems(getItems, "now")).map((item) => item.title)).toEqual(["Now"]);

    await act(async () => {
      nowMessages.resolve(messageResults([makeMessageMatch({ title: "Async search thread" })]));
      await Promise.resolve();
    });
    const refreshedGetItems = getItemsSnapshots.at(-1)!;
    expect((await getMentionItems(refreshedGetItems, "now")).map((item) => item.title)).toEqual([
      "Async search thread",
      "Now",
    ]);
    expect(loaders.searchChats).toHaveBeenCalledTimes(2);
  });

  test("changing Projects invalidates the cached request and ignores the old history", async () => {
    const getItemsSnapshots: GetItems[] = [];
    const messages = createDeferred<ChatMessageSearchResult>();
    const loaders = makeLoaders({ searchChatMessages: vi.fn(() => messages.promise) });
    const view = render(
      <MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />,
    );
    const getItems = getItemsSnapshots.at(-1)!;
    await getMentionItems(getItems, "review");

    view.rerender(
      <MentionGetItemsHarness
        getItemsSnapshots={getItemsSnapshots}
        loaders={loaders}
        activeProjectId="project-2"
      />,
    );
    await act(async () => {
      messages.resolve(messageResults([makeMessageMatch({ title: "Old Project history" })]));
      await Promise.resolve();
    });
    expect(getItemsSnapshots.at(-1)).toBe(getItems);

    const items = await getMentionItems(getItems, "review");
    expect(loaders.searchChats).toHaveBeenCalledTimes(2);
    expect(items[0]?.mentionRank?.activeContext).toBe(false);
  });

  test("prefers the active Project while preserving each group's catalog and history order", async () => {
    const getItemsSnapshots: GetItems[] = [];
    const messages = createDeferred<ChatMessageSearchResult>();
    const match = (sessionId: string, projectId: string, threadId: string | null = sessionId) =>
      makeMatch({ sessionId, threadId, projectId, title: sessionId });
    const catalog = [
      match("other-1", "project-2"),
      match("active-1", "project-1"),
      match("other-2", "project-2"),
      match("active-2", "project-1"),
    ];
    const loaders = makeLoaders({
      searchChats: vi.fn(async () => ({ matches: catalog, complete: true })),
      searchChatMessages: vi.fn(() => messages.promise),
    });
    render(<MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />);
    const items = await getMentionItems(getItemsSnapshots.at(-1)!, "review");
    expect(items.map((item) => item.title)).toEqual(["active-1", "active-2", "other-1", "other-2"]);

    await act(async () => {
      messages.resolve(
        messageResults([
          makeMessageMatch({ sessionId: "unstarted", threadId: null }),
          makeMessageMatch({ sessionId: "active-1" }),
          makeMessageMatch({ sessionId: "other-3", title: "other-3", projectId: "project-2" }),
          makeMessageMatch({ sessionId: "active-3", title: "active-3" }),
        ]),
      );
      await Promise.resolve();
    });
    const refreshedItems = await getMentionItems(getItemsSnapshots.at(-1)!, "review");
    expect(refreshedItems.map((item) => item.title)).toEqual([
      "active-1",
      "active-2",
      "active-3",
      "other-1",
      "other-2",
      "other-3",
    ]);
    expect(refreshedItems.map((item) => item.mentionRank?.activeContext)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test.each(["", "ab", "中"])("skips message history for an ineligible query %j", async (query) => {
    const getItemsSnapshots: GetItems[] = [];
    const loaders = makeLoaders();
    render(<MentionGetItemsHarness getItemsSnapshots={getItemsSnapshots} loaders={loaders} />);

    await getMentionItems(getItemsSnapshots.at(-1)!, query);
    expect(loaders.searchChatMessages).not.toHaveBeenCalled();
    expect(loaders.searchChats).toHaveBeenCalledExactlyOnceWith({
      query,
      limit: 24,
      startedOnly: true,
    });
  });
});
