import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ChatMessageSearchResult, ChatSearchMatch } from "../../shared/chat-search";

import {
  chatFieldHighlightSegments,
  chatHighlightSegments,
  clearChatSearchCacheForTests,
  mergeChatSearchMatches,
  preferChatProject,
  searchChatMessages,
  searchesChatMessages,
} from "./chat-search";

const invoke = vi.hoisted(() => vi.fn<(channel: string, input: unknown) => Promise<unknown>>());
vi.mock("./renderer-command", () => ({ invokeRendererQuery: invoke }));

function match(sessionId: string, projectId: string | null = null): ChatSearchMatch {
  return {
    chat: {
      sessionId,
      threadId: `thread-${sessionId}`,
      title: sessionId,
      projectId,
      projectName: null,
      cwd: null,
      branch: null,
      pullRequests: [],
      pinned: false,
      pinnedOrder: null,
      unread: false,
      activity: "idle",
      createdAt: 0,
      recencyAt: 0,
    },
    titleRanges: [],
    hint: null,
    excerpt: null,
  };
}

const ids = (matches: readonly ChatSearchMatch[]) => matches.map(({ chat }) => chat.sessionId);

beforeEach(() => {
  invoke.mockReset();
  clearChatSearchCacheForTests();
});

describe("chat search presentation", () => {
  test("searches message history from three letters or two CJK characters", () => {
    expect(searchesChatMessages("ab")).toBe(false);
    expect(searchesChatMessages("abc")).toBe(true);
    expect(searchesChatMessages("服务")).toBe(true);
    expect(searchesChatMessages("服")).toBe(false);
  });

  test("lists catalog matches before message-only chats, once each, within the limit", () => {
    const merged = mergeChatSearchMatches(
      [match("title"), match("both")],
      [match("both"), match("message"), match("overflow")],
      3,
    );
    expect(ids(merged)).toEqual(["title", "both", "message"]);
  });

  test("keeps each group's order when the active Project comes first", () => {
    const ordered = preferChatProject(
      [match("other-1", "other"), match("active-1", "active"), match("projectless")],
      "active",
    );
    expect(ids(ordered)).toEqual(["active-1", "other-1", "projectless"]);
  });

  test("cuts CJK text at its matched ranges without splitting characters", () => {
    expect(chatHighlightSegments("帮我把我的服务器配置一下", [{ start: 5, end: 8 }])).toEqual([
      { text: "帮我把我的", highlight: false },
      { text: "服务器", highlight: true },
      { text: "配置一下", highlight: false },
    ]);
    expect(chatHighlightSegments("No match", [])).toBeNull();
  });

  test("offsets a branch hint past the worktree prefix it omits", () => {
    const hint = { label: "Branch", text: "fix-search", ranges: [{ start: 4, end: 10 }] };
    expect(chatFieldHighlightSegments("nodex/runtime/fix-search", hint, "Branch")).toEqual([
      { text: "nodex/runtime/fix-", highlight: false },
      { text: "search", highlight: true },
    ]);
    expect(chatFieldHighlightSegments("Nodex", hint, "Project")).toBeNull();
  });
});

describe("searchChatMessages", () => {
  const answer = (states: ChatMessageSearchResult["sources"][number]["state"][]) =>
    ({
      matches: [match("message")],
      sources: states.map((state, index) => ({
        source: index === 0 ? "runtime" : "codex",
        state,
      })),
    }) satisfies ChatMessageSearchResult;

  test("shares one request among concurrent callers and reuses a complete answer", async () => {
    invoke.mockResolvedValue(answer(["complete", "complete"]));
    await Promise.all([
      searchChatMessages({ query: "deploy", limit: 25 }),
      searchChatMessages({ query: " deploy ", limit: 25 }),
    ]);
    await searchChatMessages({ query: "deploy", limit: 25 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("chats:search-messages", { query: "deploy", limit: 25 });
  });

  test("asks again after an answer that could not search every history source", async () => {
    invoke.mockResolvedValue(answer(["complete", "timed_out"]));
    await searchChatMessages({ query: "deploy", limit: 25 });
    await searchChatMessages({ query: "deploy", limit: 25 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
