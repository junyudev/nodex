import { buildCodexPromptRailPreviews } from "../codex-prompt-rail-history";
import { expect, test, vi } from "vite-plus/test";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type {
  CanonicalHistoryClient,
  CanonicalHistoryRequestOptions,
} from "./codex-canonical-history-loader";
import {
  loadCanonicalPromptRailIndex,
  previewCanonicalPromptRailTurn,
} from "./codex-canonical-prompt-rail";

type Method = "thread/turns/list" | "thread/items/list";
const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
  id,
  status,
  items: [],
  itemsView: "full",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});
function client(handler: (method: Method, params: ClientRequestParamsByMethod[Method]) => unknown) {
  const requests: Array<{
    method: Method;
    params: ClientRequestParamsByMethod[Method];
    options?: CanonicalHistoryRequestOptions;
  }> = [];
  const updateConversation = vi.fn();
  const broadcastSnapshot = vi.fn();
  const value: CanonicalHistoryClient = {
    hostId: "local",
    supportsPaginatedHistory: () => true,
    getConversation: () => null,
    sendRequest: async <M extends Method>(
      method: M,
      params: ClientRequestParamsByMethod[M],
      options?: CanonicalHistoryRequestOptions,
    ): Promise<ClientRequestResponsesByMethod[M]> => {
      requests.push({ method, params, options });
      return handler(method, params) as ClientRequestResponsesByMethod[M];
    },
    updateConversation,
    broadcastSnapshot,
    mapTurns: () => {
      throw new Error("Preview must not map resident history");
    },
  };
  return { value, requests, updateConversation, broadcastSnapshot };
}

test("rail shell indexing reads at most ten 100-Turn pages and preserves native locators", async () => {
  let page = 0;
  const f = client((_method, params) => {
    expect(params.limit).toBe(100);
    expect("itemsView" in params ? params.itemsView : undefined).toBe("notLoaded");
    expect(params.sortDirection).toBe("desc");
    expect(params.cursor).toBe(page === 0 ? null : `next-${page}`);
    const offset = page++ * 100;
    return {
      data: Array.from({ length: 100 }, (_, index) => turn(String(offset + index))),
      backwardsCursor: `back-${page}`,
      nextCursor: `next-${page}`,
    };
  });
  const result = await loadCanonicalPromptRailIndex(f.value, "thread");
  expect(f.requests).toHaveLength(10);
  expect(result.complete).toBe(false);
  expect(result.items).toHaveLength(1000);
  expect(result.items[0]).toEqual({
    turnId: "999",
    pageBackwardsCursor: "back-10",
    descendingOffset: 99,
  });
  expect(result.items.at(-1)).toEqual({
    turnId: "0",
    pageBackwardsCursor: "back-1",
    descendingOffset: 0,
  });
});

test("an exhausted shell page marks the chronological index complete", async () => {
  const f = client(() => ({
    data: [turn("new"), turn("old")],
    backwardsCursor: "anchor",
    nextCursor: null,
  }));
  expect(await loadCanonicalPromptRailIndex(f.value, "thread")).toEqual({
    items: [
      { turnId: "old", pageBackwardsCursor: "anchor", descendingOffset: 1 },
      { turnId: "new", pageBackwardsCursor: "anchor", descendingOffset: 0 },
    ],
    complete: true,
  });
});

test("preview uses the page's backwards cursor and offset, then returns the exact navigation cursor without installing history", async () => {
  const f = client((_method, params) =>
    ("itemsView" in params ? params.itemsView : undefined) === "notLoaded"
      ? { data: [turn("skip")], nextCursor: "exact-cursor" }
      : {
          data: [
            {
              ...turn("target"),
              items: [
                {
                  type: "userMessage",
                  id: "prompt",
                  clientId: null,
                  content: [{ type: "text", text: "hello", text_elements: [] }],
                },
              ],
            },
          ],
          backwardsCursor: "returned-anchor",
          nextCursor: null,
        },
  );
  const result = await previewCanonicalPromptRailTurn(f.value, "thread", {
    turnId: "target",
    pageBackwardsCursor: "page-anchor",
    descendingOffset: 3,
  });
  expect(
    f.requests.map(({ params }) => ({
      cursor: params.cursor,
      limit: params.limit,
      itemsView: "itemsView" in params ? params.itemsView : undefined,
    })),
  ).toEqual([
    { cursor: "page-anchor", limit: 3, itemsView: "notLoaded" },
    { cursor: "exact-cursor", limit: 1, itemsView: "full" },
  ]);
  expect(f.requests.map(({ options }) => options)).toEqual([
    { priority: "interactive", source: "thread_hydration" },
    { priority: "interactive", source: "thread_hydration" },
  ]);
  expect(result).toEqual({
    turnCursor: "returned-anchor",
    previews: [
      { itemId: "prompt", promptPreview: "hello", responsePreview: "", isHeartbeat: false },
    ],
  });
  expect(f.updateConversation).not.toHaveBeenCalled();
  expect(f.broadcastSnapshot).not.toHaveBeenCalled();
});

test("empty in-progress previews remain unavailable while a completed empty Turn remains navigable", async () => {
  const active = client(() => ({ data: [turn("target", "inProgress")], nextCursor: null }));
  expect(
    await previewCanonicalPromptRailTurn(active.value, "thread", {
      turnId: "target",
      pageBackwardsCursor: "anchor",
      descendingOffset: 0,
    }),
  ).toBeNull();
  const completed = client(() => ({ data: [turn("target")], nextCursor: null }));
  expect(
    await previewCanonicalPromptRailTurn(completed.value, "thread", {
      turnId: "target",
      pageBackwardsCursor: "anchor",
      descendingOffset: 0,
    }),
  ).toEqual({ turnCursor: "anchor", previews: [] });
});

test("preview carries an opening prompt omitted from partial items and pairs its response", () => {
  const result = buildCodexPromptRailPreviews({
    turn: {
      ...turn("target"),
      itemsView: "summary",
      items: [
        {
          type: "agentMessage",
          id: "response",
          text: "answer",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      ],
    },
    pagination: {
      itemsView: "summary",
      olderCursor: "older",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      openingUserMessageId: "opening",
      oldestUserInput: [{ type: "text", text: "question", text_elements: [] }],
    },
  });
  expect(result).toEqual([
    { itemId: "opening", promptPreview: "question", responsePreview: "answer", isHeartbeat: false },
  ]);
});
