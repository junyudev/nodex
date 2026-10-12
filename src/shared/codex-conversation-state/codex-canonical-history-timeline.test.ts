import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import type {
  ThreadItem,
  ThreadTimelineListResponse,
  Turn,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  listCanonicalHistoryTurns,
  type CanonicalHistoryClient,
} from "./codex-canonical-history-loader";
import {
  applyCanonicalHistoryTimelineDraft,
  normalizeCanonicalHistoryTimelinePage,
} from "./codex-canonical-history-timeline";

const shell = (id = "turn"): Turn => ({
  id,
  rootTurnId: "root",
  items: [],
  itemsView: "notLoaded",
  status: "inProgress",
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
});
const plan = (id: string): ThreadItem => ({ type: "plan", id, text: "large payload" });
const metadata = () =>
  createCodexCanonicalHydratedConversationState(
    { ...buildAgentActivityV2CorpusThread([]), id: "thread", turns: [] },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
function fixture(
  pages: readonly ThreadTimelineListResponse[],
  voice = false,
  shells: readonly (readonly Turn[])[] = [[shell()]],
) {
  const state = { ...metadata(), canonicalVoiceHistory: voice };
  const calls: { method: string; params: unknown }[] = [];
  let timelineReads = 0;
  let shellReads = 0;
  const client: CanonicalHistoryClient = {
    hostId: "local",
    supportsPaginatedHistory: () => true,
    supportsThreadTimeline: () => true,
    getConversation: () => state,
    sendTimelineRequest: async (params) => {
      calls.push({ method: "thread/timeline/list", params });
      return pages[
        timelineReads++
      ]! as unknown as ClientRequestResponsesByMethod["thread/timeline/list"];
    },
    sendRequest: async <M extends "thread/turns/list" | "thread/items/list">(
      method: M,
      params: ClientRequestParamsByMethod[M],
    ): Promise<ClientRequestResponsesByMethod[M]> => {
      calls.push({ method, params });
      if (method === "thread/turns/list") {
        const data = shells[shellReads++] ?? [];
        return {
          data,
          nextCursor: shellReads < shells.length ? `shell-${shellReads}` : null,
          backwardsCursor: null,
        } as unknown as ClientRequestResponsesByMethod[M];
      }
      return {
        data: [
          {
            turnId: "turn",
            item: {
              type: "userMessage",
              id: "opening",
              clientId: "client",
              content: [{ type: "text", text: "input", text_elements: [] }],
            },
            startedAtMs: 1,
            completedAtMs: 2,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      } as unknown as ClientRequestResponsesByMethod[M];
    },
    updateConversation: () => {
      throw new Error("read must not install");
    },
    broadcastSnapshot: () => {
      throw new Error("read must not publish");
    },
    mapTurns: () => {
      throw new Error("read must not materialize");
    },
  };
  return { client, calls, state };
}

describe("canonical timeline history page", () => {
  test("an opaque noninitial cursor needs its declared API source even when timeline policy is enabled", async () => {
    const turnCursor = JSON.stringify({
      requestedThreadId: "thread",
      rolloutOrdinal: 37,
      includeAnchor: true,
      scope: { kind: "turns" },
    });
    const timelineCursor = JSON.stringify({
      threadId: "thread",
      position: 38,
      kind: 1,
      id: "item",
    });
    const page: ThreadTimelineListResponse = {
      data: [{ type: "item", position: 35, turnId: "turn", item: plan("older") }],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    };
    const { client, calls } = fixture([page]);
    await expect(
      listCanonicalHistoryTurns(client, "thread", { cursor: turnCursor }),
    ).rejects.toThrow("native source");
    expect(calls).toEqual([]);
    await listCanonicalHistoryTurns(client, "thread", { source: "ordinary", cursor: turnCursor });
    expect(calls[0]).toMatchObject({ method: "thread/turns/list", params: { cursor: turnCursor } });
    expect(calls.some(({ method }) => method === "thread/timeline/list")).toBe(false);
    const timeline = fixture([page]);
    const older = await listCanonicalHistoryTurns(timeline.client, "thread", {
      source: "timeline",
      cursor: timelineCursor,
    });
    expect(timeline.calls[0]).toMatchObject({
      method: "thread/timeline/list",
      params: { cursor: timelineCursor },
    });
    expect(older.response.data[0]?.items[0]?.id).toBe("older");
  });
  test("a qualified native root retains and installs a realtime-only history page", async () => {
    const qualified = createCodexCanonicalHydratedConversationState(
      {
        ...buildAgentActivityV2CorpusThread([]),
        id: "thread",
        turns: [],
        cliVersion: "0.162.0-alpha.17.2",
        historyMode: "paginated",
        forkedFromId: null,
      },
      {
        hostId: "local",
        model: "model",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
      },
    );
    const realtime: ThreadTimelineListResponse = {
      data: [
        {
          type: "realtime",
          position: 0,
          item: { type: "realtimeSessionStarted", id: "rt", realtimeSessionId: "session" },
        },
      ],
      nextCursor: "older",
      activeRealtimeSessionAtPageStart: "session",
    };
    const f = fixture([realtime], false, [[]]);
    const page = await listCanonicalHistoryTurns(
      { ...f.client, getConversation: () => qualified },
      "thread",
    );
    expect(page.timeline).toEqual(realtime);
    expect(page.response.data).toEqual([]);
    const installed = produce(qualified, (draft) => {
      applyCanonicalHistoryTimelineDraft(draft, page.timeline, "replace");
    });
    expect(installed.itemTimeline?.entries).toEqual(realtime.data);
    expect(installed.realtimeItems?.rt?.completed).toBe(true);
    expect(f.calls.map(({ method }) => method)).toEqual([
      "thread/timeline/list",
      "thread/turns/list",
    ]);
  });
  test("native decoded timeline values cross one generated validation boundary", () => {
    const decode = (response: unknown) =>
      normalizeCanonicalHistoryTimelinePage(
        response as ClientRequestResponsesByMethod["thread/timeline/list"],
      );
    const valid = { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    expect(() => decode({ ...valid, nextCursor: 2 })).toThrow("metadata");
    expect(() =>
      decode({
        ...valid,
        data: [
          { type: "item", position: 1, turnId: "turn", item: { type: "plan", id: "p", text: 2 } },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...valid,
        data: [
          {
            type: "realtime",
            position: 1,
            item: { type: "realtimeSessionStarted", realtimeSessionId: "session" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...valid,
        data: [
          {
            type: "turnCompleted",
            position: 1,
            turnId: "turn",
            status: "invalid",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        ],
      }),
    ).toThrow();
  });
  test("requests 500 entries, preserves effective response size and hydrates only 5 shells", async () => {
    const timeline = {
      data: Array.from({ length: 100 }, (_, position) => ({
        type: "item" as const,
        position,
        turnId: "turn",
        item: plan(String(position)),
      })),
      nextCursor: "older-timeline",
      activeRealtimeSessionAtPageStart: null,
    };
    const { client, calls } = fixture([timeline]);
    const page = await listCanonicalHistoryTurns(client, "thread");
    expect(page.source).toBe("timeline");
    expect(page.timeline).toEqual(timeline);
    expect(page.response.data[0]!.items).toHaveLength(100);
    expect(page.response.data[0]!.rootTurnId).toBe("root");
    expect(page.itemsPaginationByTurnId.turn).toMatchObject({
      source: "timeline",
      hasLoadedOldest: false,
      oldestUserInput: [{ type: "text", text: "input", text_elements: [] }],
      openingUserMessageId: "opening",
    });
    expect(calls).toEqual([
      { method: "thread/timeline/list", params: { threadId: "thread", cursor: null, limit: 500 } },
      {
        method: "thread/turns/list",
        params: { threadId: "thread", limit: 5, itemsView: "notLoaded", sortDirection: "desc" },
      },
      {
        method: "thread/items/list",
        params: {
          threadId: "thread",
          turnId: "turn",
          cursor: null,
          limit: 2,
          sortDirection: "asc",
        },
      },
    ]);
    expect(page.completedItemIdsByTurnId?.turn?.["99"]).toBe(true);
  });

  test("turn boundaries supply terminal metadata and chronological multi-Turn item groups", async () => {
    const timeline: ThreadTimelineListResponse = {
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
      data: [
        { type: "turnStarted", position: 0, turnId: "older", startedAt: 1 },
        { type: "item", position: 1, turnId: "older", item: plan("a") },
        {
          type: "turnCompleted",
          position: 2,
          turnId: "older",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
        { type: "item", position: 3, turnId: "turn", item: plan("b") },
      ],
    };
    const { client, calls } = fixture([timeline]);
    const page = await listCanonicalHistoryTurns(client, "thread");
    expect(page.response.data.map((turn) => turn.id)).toEqual(["turn", "older"]);
    expect(page.response.data[1]).toMatchObject({
      status: "completed",
      completedAt: 2,
      durationMs: 1000,
    });
    expect(page.itemsPaginationByTurnId.older?.hasLoadedOldest).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("supplements missing metadata with 100-shell pages and rejects cursor stalls", async () => {
    const timeline: ThreadTimelineListResponse = {
      data: [{ type: "item", position: 1, turnId: "missing", item: plan("a") }],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    };
    const { client, calls } = fixture([timeline], false, [[shell("other")], [shell("missing")]]);
    const page = await listCanonicalHistoryTurns(client, "thread");
    expect(page.response.data[0]!.id).toBe("missing");
    expect(calls[2]).toEqual({
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor: "shell-1",
        limit: 100,
        itemsView: "notLoaded",
        sortDirection: "desc",
      },
    });
    const stalled = fixture([{ ...timeline, nextCursor: "same" }]);
    await expect(
      listCanonicalHistoryTurns(stalled.client, "thread", { source: "timeline", cursor: "same" }),
    ).rejects.toThrow("repeated cursor");
  });

  test("ordinary conversations skip realtime-only pages; voice conversations retain them", async () => {
    const realtime: ThreadTimelineListResponse = {
      data: [
        {
          type: "realtime",
          position: 0,
          item: { type: "realtimeSessionStarted", id: "rt", realtimeSessionId: "session" },
        },
      ],
      nextCursor: "older",
      activeRealtimeSessionAtPageStart: "session",
    };
    const item: ThreadTimelineListResponse = {
      data: [{ type: "item", position: 1, turnId: "turn", item: plan("a") }],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    };
    const ordinary = fixture([realtime, item]);
    expect((await listCanonicalHistoryTurns(ordinary.client, "thread")).timeline).toEqual(item);
    const voice = fixture([realtime], true);
    const page = await listCanonicalHistoryTurns(voice.client, "thread");
    expect(page.timeline).toEqual(realtime);
    expect(page.response.data).toEqual([]);
  });

  test("voice order retains identity, prevents duplicate prepend and preserves live realtime tail", () => {
    const state = { ...metadata(), canonicalVoiceHistory: true };
    const first: ThreadTimelineListResponse = {
      data: [
        { type: "item", position: 1, turnId: "turn", item: plan("a") },
        {
          type: "realtime",
          position: 2,
          item: {
            type: "transcriptSegment",
            id: "rt",
            realtimeSessionId: "session",
            role: "assistant",
            text: "voice",
          },
        },
      ],
      nextCursor: "older",
      activeRealtimeSessionAtPageStart: null,
    };
    const installed = produce(state, (draft) => {
      applyCanonicalHistoryTimelineDraft(draft, first, "replace");
    });
    expect(installed.itemTimeline?.entries[0]).toEqual({
      type: "item",
      position: 1,
      turnId: "turn",
      item: { id: "a", type: "plan", completed: true },
    });
    expect(installed.itemTimeline?.entries[0]).not.toHaveProperty("item.text");
    const prepended = produce(installed, (draft) => {
      applyCanonicalHistoryTimelineDraft(
        draft,
        {
          ...first,
          data: [{ type: "turnStarted", position: 0, turnId: "turn", startedAt: 1 }, ...first.data],
        },
        "prepend",
      );
    });
    expect(prepended.itemTimeline?.entries.map((entry) => entry.type)).toEqual([
      "turnStarted",
      "item",
      "realtime",
    ]);
    expect(prepended.realtimeItems?.rt?.completed).toBe(true);
    const live = produce(prepended, (draft) => {
      draft.realtimeItems!.rt!.completed = false;
    });
    const replaced = produce(live, (draft) => {
      applyCanonicalHistoryTimelineDraft(
        draft,
        { ...first, nextCursor: null, data: [first.data[0]!] },
        "replace",
      );
    });
    expect(replaced.itemTimeline?.entries.at(-1)?.type).toBe("realtime");
    expect(replaced.realtimeItems?.rt?.completed).toBe(false);
  });

  test("capability+policy routing refuses unsupported timeline and keeps search cursors ordinary", async () => {
    const initial = fixture([]);
    const disabled = { ...initial.client, supportsThreadTimeline: () => false };
    await expect(
      listCanonicalHistoryTurns(disabled, "thread", { source: "timeline" }),
    ).rejects.toThrow("unsupported");
    await listCanonicalHistoryTurns(disabled, "thread", {
      source: "ordinary",
      itemsView: "notLoaded",
    });
    expect(initial.calls[0]?.method).toBe("thread/turns/list");
    const durable = { ...initial.client, hostId: "durable" };
    await expect(
      listCanonicalHistoryTurns(durable, "thread", { source: "timeline" }),
    ).rejects.toThrow("unsupported");
  });
});
