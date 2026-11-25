import {
  hydrateCanonicalHistorySearchMatch,
  insertCanonicalHistorySearchDraft,
} from "./codex-canonical-history-search";
import { describe, expect, test, vi, it } from "vite-plus/test";
import { produce } from "immer";
import { discardCodexAcceptedServerQueueSubmission } from "../codex-native-queued-submission";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type {
  ThreadItem,
  Turn,
  ThreadTimelineListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalTurnState,
  type CodexCanonicalItem,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  residentConversationTurnEntries,
  residentConversationTurns,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
  type CodexHistoryTurnItemsPagination,
} from "./codex-history-topology";
import {
  CanonicalHistoryItemLoader,
  readCanonicalHistoryItems,
  listCanonicalHistoryTurns,
  loadCanonicalHistoryBoundaryPage,
  replaceCanonicalHistoryDraft,
  withCanonicalHistoryItemCompletion,
  type CanonicalHistoryClient,
  type CanonicalHistoryRequestOptions,
} from "./codex-canonical-history-loader";
import {
  applyCanonicalHistoryTimelineDraft,
  normalizeCanonicalHistoryTimelinePage,
} from "./codex-canonical-history-timeline";
import { buildCodexPromptRailPreviews } from "../codex-prompt-rail-history";
import {
  loadCanonicalPromptRailIndex,
  previewCanonicalPromptRailTurn,
} from "./codex-canonical-prompt-rail";
import { CanonicalCompleteHistoryLoader } from "./codex-complete-history-loader";
import {
  mergeCodexResumedItemsPagination,
  advanceCodexReconnectedItemsPagination,
} from "./codex-history-resume";
import { mergeCodexCanonicalHistoryItems } from "./codex-history-item-merge";

describe("codex canonical history loader", () => {
  type Method = "thread/turns/list" | "thread/items/list";

  test("history completion advances monotonically alongside live item evidence", () => {
    const state = createCodexCanonicalHydratedConversationState(
      { ...buildAgentActivityV2CorpusThread([]), turns: [rawTurn("turn")] },
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
    const live = { ...state.turns[0]!, completedItemIds: { finished: true, started: false } };
    const [result] = withCanonicalHistoryItemCompletion([live], {
      completedItemIdsByTurnId: { turn: { finished: false, started: true, historyOnly: true } },
    });
    expect(result!.completedItemIds).toEqual({ finished: true, started: true, historyOnly: true });
  });
  type Request = {
    method: Method;
    params: ClientRequestParamsByMethod[Method];
    options?: CanonicalHistoryRequestOptions;
  };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const tick = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const rawTurn = (id: string): Turn => ({
    rootTurnId: null,
    id,
    items: [],
    itemsView: "notLoaded",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
  const item = (id: string): ThreadItem => ({ type: "plan", id, text: id });
  const itemsPage = (turnId: string, items: ThreadItem[], nextCursor: string | null = null) => ({
    data: items.map((item) => ({ turnId, item })),
    nextCursor,
  });

  function harness(ids = ["turn"], hostId = "local") {
    const thread = {
      ...buildAgentActivityV2CorpusThread([]),
      id: "conversation",
      turns: ids.map(rawTurn),
    };
    const initial = createCodexCanonicalHydratedConversationState(thread, {
      hostId,
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    });
    let state = produce(initial, (draft) => {
      replaceCanonicalHistoryDraft(
        draft,
        initial.turns.map((turn) => ({
          ...turn,
          itemsPagination: {
            olderCursor: "older",
            isLoadingOlder: false,
            hasLoadedOldest: false,
            itemsView: "summary",
          },
        })),
        false,
      );
      draft.paginatedHistory = { turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    });
    const calls: Request[] = [];
    let broadcasts = 0;
    let handler: (request: Request) => Promise<unknown> = async () => {
      throw new Error("Unexpected history request");
    };
    const client: CanonicalHistoryClient = {
      hostId,
      supportsPaginatedHistory: () => true,
      getConversation: () => state,
      async sendRequest<M extends Method>(
        method: M,
        params: ClientRequestParamsByMethod[M],
        options?: CanonicalHistoryRequestOptions,
      ): Promise<ClientRequestResponsesByMethod[M]> {
        const request = { method, params, options };
        calls.push(request);
        return (await handler(request)) as ClientRequestResponsesByMethod[M];
      },
      updateConversation: (_id, recipe) => {
        state = produce(state, recipe);
      },
      broadcastSnapshot: () => {
        broadcasts += 1;
      },
      mapTurns: (_id, turns, pagination) =>
        turns.map((turn) => ({
          ...createCodexCanonicalTurnState(turn, initial.turns[0]!.params),
          ...(pagination[turn.id] ? { itemsPagination: pagination[turn.id] } : {}),
        })),
    };
    return {
      client,
      calls,
      read: () => state,
      broadcasts: () => broadcasts,
      handle: (next: typeof handler) => {
        handler = next;
      },
      mutate: (recipe: Parameters<CanonicalHistoryClient["updateConversation"]>[1]) => {
        state = produce(state, recipe);
      },
    };
  }

  describe("canonical history operation ownership", () => {
    test("loading a completed historical compaction preserves the current passive injection key", async () => {
      const f = harness();
      f.mutate((draft) => {
        draft.lastInjectedPassiveContextKey = "confirmed-live-context";
      });
      f.handle(async () => ({
        data: [
          {
            turnId: "turn",
            item: { type: "contextCompaction", id: "historical-compaction" },
            startedAtMs: 10,
            completedAtMs: 20,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      }));
      using loader = new CanonicalHistoryItemLoader(f.client);
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(residentConversationTurns(f.read())[0]?.items[0]).toMatchObject({
        type: "contextCompaction",
        id: "historical-compaction",
        completed: true,
      });
      expect(f.read().lastInjectedPassiveContextKey).toBe("confirmed-live-context");
    });
    test.each(["owner", "readonly", "lost-owner", "started-echo"] as const)(
      "native queue cleanup recovery follows the actual history owner: %s",
      async (role) => {
        const f = harness();
        let owns = role !== "readonly";
        f.client.canRecordQueueAcceptance = () => owns;
        const input = [{ type: "text" as const, text: "Stored native input", text_elements: [] }];
        const raw = {
          id: "native-queue",
          clientUserMessageId: "queue-client",
          input,
          responsesapiClientMetadata: null,
        };
        f.mutate((draft) => {
          const turn = conversationTurnDraft(
            draft,
            residentConversationTurnEntries(draft)[0]!.address,
          )!;
          turn.status = "inProgress";
          turn.itemsPagination!.openingUserMessageId = "original-opening";
          turn.itemsPagination!.oldestUserInput = [
            { type: "text", text: "Original opening", text_elements: [] },
          ];
          turn.items = [
            {
              type: "steeringUserMessage",
              id: "pending",
              status: "pending",
              targetTurnId: "turn",
              targetTurnStartedAtMs: null,
              clientUserMessageId: raw.clientUserMessageId,
              input,
              serverQueuedSubmission: raw,
              attachments: [],
              restoreMessage: { context: { commentAttachments: [] } },
              compareKey: { rawText: input[0]!.text, imageCount: 0 },
            },
          ];
        });
        const entered = deferred<void>();
        const released = deferred<void>();
        f.handle(async () => {
          entered.resolve();
          await released.promise;
          return {
            data: [
              {
                turnId: "turn",
                item: {
                  type: "userMessage",
                  id: "echo",
                  clientId: raw.clientUserMessageId,
                  content: input,
                },
                startedAtMs: 10,
                completedAtMs: role === "started-echo" ? null : 20,
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
          };
        });
        using loader = new CanonicalHistoryItemLoader(f.client);
        const pending = loader.loadTurnItems("conversation", "turn", false, {
          priority: "interactive",
        });
        await entered.promise;
        if (role === "lost-owner") owns = false;
        released.resolve();
        await pending;
        expect(f.read().unconfirmedServerQueueMessages).toEqual(
          role === "owner" ? [raw] : undefined,
        );
        const steer = residentConversationTurns(f.read())[0]?.items.find(
          (item) => item.type === "steeringUserMessage",
        );
        expect(steer).toMatchObject({
          status: "accepted",
          acceptedInput: input,
          serverQueuedSubmission: raw,
        });
      },
    );

    test("a restored started echo advances to completed evidence without another dispatch", async () => {
      const f = harness();
      f.client.canRecordQueueAcceptance = () => true;
      const input = [{ type: "text" as const, text: "Stored native input", text_elements: [] }];
      const raw = {
        id: "native-queue",
        clientUserMessageId: "queue-client",
        input,
        responsesapiClientMetadata: null,
      };
      f.mutate((draft) => {
        const turn = conversationTurnDraft(
          draft,
          residentConversationTurnEntries(draft)[0]!.address,
        )!;
        turn.status = "inProgress";
        turn.itemsPagination!.openingUserMessageId = "original-opening";
        turn.itemsPagination!.oldestUserInput = [
          { type: "text", text: "Original opening", text_elements: [] },
        ];
        turn.items = [
          {
            type: "steeringUserMessage",
            id: "pending",
            status: "pending",
            targetTurnId: "turn",
            targetTurnStartedAtMs: null,
            clientUserMessageId: raw.clientUserMessageId,
            input,
            serverQueuedSubmission: raw,
            attachments: [],
            restoreMessage: { context: { commentAttachments: [] } },
            compareKey: { rawText: input[0]!.text, imageCount: 0 },
          },
        ];
      });
      let read = 0;
      f.handle(async () => {
        read++;
        return {
          data: [
            {
              turnId: "turn",
              item: {
                type: "userMessage",
                id: "echo",
                clientId: raw.clientUserMessageId,
                content: input,
              },
              startedAtMs: 10,
              completedAtMs: read === 2 ? 20 : null,
            },
          ],
          nextCursor: read === 3 ? null : `page-${read}`,
          backwardsCursor: null,
        };
      });
      using loader = new CanonicalHistoryItemLoader(f.client);
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.read().unconfirmedServerQueueMessages).toBeUndefined();
      expect(residentConversationTurns(f.read())[0]?.completedItemIds?.echo).toBe(false);
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.read().unconfirmedServerQueueMessages).toEqual([raw]);
      expect(residentConversationTurns(f.read())[0]?.completedItemIds?.echo).toBe(true);
      f.mutate((draft) => discardCodexAcceptedServerQueueSubmission(draft, raw));
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.read().unconfirmedServerQueueMessages).toBeUndefined();
      expect(residentConversationTurns(f.read())[0]?.completedItemIds?.echo).toBe(true);
      expect(f.calls.map((call) => call.method)).toEqual([
        "thread/items/list",
        "thread/items/list",
        "thread/items/list",
      ]);
    });

    test("retries the same item anchor with smaller pages and preserves wrapper evidence", async () => {
      const f = harness();
      const anchor = { type: "item" as const, itemId: "anchor" };
      f.handle(async ({ params }) => {
        if (params.limit! > 2) throw new Error("decoded message length too large");
        return {
          data: [{ turnId: "turn", item: item("a"), startedAtMs: 12, completedAtMs: 15 }],
          nextCursor: "older",
          backwardsCursor: "newer",
        };
      });
      const page = await readCanonicalHistoryItems(
        f.client,
        "conversation",
        "turn",
        anchor,
        undefined,
        9,
      );
      expect(f.calls.map(({ params }) => params.limit)).toEqual([9, 4, 2]);
      expect(f.calls.every(({ params }) => params.cursor === anchor)).toBe(true);
      expect(page).toMatchObject({
        pageSize: 2,
        nextCursor: "older",
        backwardsCursor: "newer",
        entries: [{ startedAtMs: 12, completedAtMs: 15 }],
      });
    });

    test("stops oversize retry at one item and propagates other failures", async () => {
      const f = harness();
      f.handle(async () => {
        throw new Error("decoded message length too large");
      });
      await expect(
        readCanonicalHistoryItems(f.client, "conversation", "turn", null, undefined, 4),
      ).rejects.toThrow("decoded message length");
      expect(f.calls.map(({ params }) => params.limit)).toEqual([4, 2, 1]);
    });

    test("foreground item loading supersedes a suspended background preview", async () => {
      const f = harness();
      const background = deferred<unknown>();
      f.handle(({ options }) =>
        options?.priority === "background"
          ? background.promise
          : Promise.resolve(itemsPage("turn", [item("foreground")])),
      );
      using loader = new CanonicalHistoryItemLoader(f.client);
      const preview = loader.loadTurnItems("conversation", "turn", false, {
        priority: "background",
      });
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.calls).toHaveLength(2);
      expect(residentConversationTurns(f.read())[0]?.items.map(({ id }) => id)).toEqual([
        "foreground",
      ]);
      background.resolve(itemsPage("turn", [item("retired")]));
      await preview;
      expect(residentConversationTurns(f.read())[0]?.items.map(({ id }) => id)).toEqual([
        "foreground",
      ]);
      expect(residentConversationTurns(f.read())[0]?.itemsPagination?.isLoadingOlder).toBe(false);
    });

    test.each(["interactive", "critical"] as const)(
      "%s item recovery bypasses saturated preview slots and keeps opening reads foreground",
      async (priority) => {
        const f = harness(["a", "b", "foreground"]);
        f.mutate((draft) => {
          for (const entry of residentConversationTurnEntries(draft))
            conversationTurnDraft(draft, entry.address)!.itemsPagination!.summaryItemIds = [];
        });
        const background = deferred<unknown>();
        f.handle(({ params, options }) => {
          if (options?.priority === "background") return background.promise;
          return Promise.resolve(
            itemsPage(
              "foreground",
              [item(params.sortDirection === "asc" ? "opening" : "visible")],
              "older-foreground",
            ),
          );
        });
        using loader = new CanonicalHistoryItemLoader(f.client);
        const previews = ["a", "b"].map((turnId) =>
          loader.loadTurnItems("conversation", turnId, false, { priority: "background" }),
        );
        const foreground = loader.loadTurnItems("conversation", "foreground", false, { priority });
        try {
          await tick();
          expect(f.calls.map(({ params }) => ("turnId" in params ? params.turnId : ""))).toEqual([
            "a",
            "b",
            "foreground",
            "foreground",
          ]);
          expect(
            f.calls.slice(2).map(({ params, options }) => [params.limit, options?.priority]),
          ).toEqual([
            [98, priority],
            [2, priority],
          ]);
          await foreground;
          const turns = residentConversationTurns(f.read());
          expect(
            turns.find((turn) => turn.turnId === "foreground")?.items.map(({ id }) => id),
          ).toEqual(["visible"]);
          expect(
            turns
              .filter((turn) => turn.turnId !== "foreground")
              .every((turn) => turn.itemsPagination?.isLoadingOlder),
          ).toBe(true);
        } finally {
          loader.cancelLoads();
          background.resolve(itemsPage("a", []));
          await Promise.all([...previews, foreground]);
        }
      },
    );

    test("released items read back through their anchor and keep their place around retained items", async () => {
      const f = harness();
      f.mutate((draft) => {
        const turn = conversationTurnDraft(
          draft,
          residentConversationTurnEntries(draft)[0]!.address,
        )!;
        turn.items = [item("kept-plan"), item("anchor")] as typeof turn.items;
        turn.itemsPagination = {
          ...turn.itemsPagination!,
          itemsView: "summary",
          olderCursor: { type: "item", itemId: "anchor" },
          olderPageBeforeItemId: "anchor",
          hasLoadedOldest: false,
        };
      });
      f.handle(async () => ({
        ...itemsPage("turn", [item("older-b"), item("older-a")]),
        nextCursor: "next",
      }));
      using loader = new CanonicalHistoryItemLoader(f.client);
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.calls[0]?.params.cursor).toEqual({ type: "item", itemId: "anchor" });
      const turn = residentConversationTurns(f.read())[0]!;
      expect(turn.items.map(({ id }) => id)).toEqual(["kept-plan", "older-a", "older-b", "anchor"]);
      expect(turn.itemsPagination).toMatchObject({
        olderCursor: "next",
        olderPageBeforeItemId: "older-a",
        hasLoadedOldest: false,
      });
    });

    test("a host without item anchors rereads a released Turn from its tail", async () => {
      const f = harness();
      f.client.supportsThreadItemAnchors = () => false;
      f.mutate((draft) => {
        const turn = conversationTurnDraft(
          draft,
          residentConversationTurnEntries(draft)[0]!.address,
        )!;
        turn.items = [item("anchor")] as typeof turn.items;
        turn.itemsPagination = {
          ...turn.itemsPagination!,
          itemsView: "summary",
          olderCursor: { type: "item", itemId: "anchor" },
          hasLoadedOldest: false,
        };
      });
      f.handle(async () => itemsPage("turn", [item("anchor"), item("older")]));
      using loader = new CanonicalHistoryItemLoader(f.client);
      await loader.loadTurnItems("conversation", "turn", false, { priority: "interactive" });
      expect(f.calls[0]?.params.cursor).toBeNull();
      expect(residentConversationTurns(f.read())[0]!.items.map(({ id }) => id)).toEqual([
        "older",
        "anchor",
      ]);
    });

    test("retires an item response when its pagination object changes during I/O", async () => {
      const f = harness();
      const response = deferred<unknown>();
      f.handle(() => response.promise);
      using loader = new CanonicalHistoryItemLoader(f.client);
      const pending = loader.loadTurnItems("conversation", "turn");
      expect(f.calls).toHaveLength(1);
      f.mutate((draft) => {
        const entry = residentConversationTurnEntries(draft)[0]!;
        const turn = conversationTurnDraft(draft, entry.address)!;
        turn.itemsPagination = { ...turn.itemsPagination!, olderCursor: "replacement" };
      });
      response.resolve(itemsPage("turn", [item("retired-item")]));
      await pending;
      expect(residentConversationTurns(f.read())[0]?.items).toEqual([]);
      expect(residentConversationTurns(f.read())[0]?.itemsPagination?.olderCursor).toBe(
        "replacement",
      );
      expect(f.broadcasts()).toBe(0);
    });

    test("keeps two preview slots and hands a retired active slot to the queued preview", async () => {
      const f = harness(["a", "b", "c"]);
      f.mutate((draft) => {
        for (const entry of residentConversationTurnEntries(draft))
          conversationTurnDraft(draft, entry.address)!.itemsPagination!.summaryItemIds = [];
      });
      const responses = new Map<string, ReturnType<typeof deferred<unknown>>>();
      f.handle(async ({ params }) => {
        const id =
          "turnId" in params && typeof params.turnId === "string" ? params.turnId : "unexpected";
        const response = deferred<unknown>();
        responses.set(id, response);
        return response.promise;
      });
      using loader = new CanonicalHistoryItemLoader(f.client);
      const a = loader.loadTurnItems("conversation", "a");
      const b = loader.loadTurnItems("conversation", "b");
      const c = loader.loadTurnItems("conversation", "c");
      expect(f.calls.map(({ params }) => ("turnId" in params ? params.turnId : ""))).toEqual([
        "a",
        "b",
      ]);
      // Replacing a's pagination retires it while its physical request still owns its slot.
      f.mutate((draft) => {
        const entry = residentConversationTurnEntries(draft)[0]!;
        const turn = conversationTurnDraft(draft, entry.address)!;
        turn.itemsPagination = { ...turn.itemsPagination! };
      });
      responses.get("a")!.resolve(itemsPage("a", []));
      await a;
      await tick();
      expect(f.calls.map(({ params }) => ("turnId" in params ? params.turnId : ""))).toEqual([
        "a",
        "b",
        "c",
      ]);
      responses.get("b")!.resolve(itemsPage("b", []));
      responses.get("c")!.resolve(itemsPage("c", []));
      await Promise.all([b, c]);
      expect(f.broadcasts()).toBe(2);
    });

    test("rejects a boundary page whose cursor changes while its request is outstanding", async () => {
      const f = harness();
      f.mutate((draft) => {
        draft.turnHistory!.history.islands[0]!.olderBoundary = availableCodexHistoryBoundary(
          "boundary",
          { cursor: "page-one", oldestLoadedTurnId: "turn" },
        );
      });
      const history = f.read().turnHistory!.history;
      const boundary = history.islands[0]!.olderBoundary;
      if (boundary.status !== "available") throw new Error("Expected page boundary");
      const ref = createCodexHistoryBoundaryRef(
        history.generation,
        history.islands[0]!.id,
        "older",
        boundary,
      );
      const response = deferred<unknown>();
      f.handle(() => response.promise);
      const pending = loadCanonicalHistoryBoundaryPage(f.client, "conversation", ref, {
        itemsView: "notLoaded",
      });
      f.mutate((draft) => {
        draft.turnHistory!.history.islands[0]!.olderBoundary = availableCodexHistoryBoundary(
          "boundary",
          { cursor: "page-two", oldestLoadedTurnId: "turn" },
        );
      });
      response.resolve({ data: [rawTurn("old")], nextCursor: null });
      expect(await pending).toBe("stale");
      expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual(["turn"]);
      expect(f.broadcasts()).toBe(0);
    });

    test("an older timeline boundary prepends missing items and retires ordinary item recovery", async () => {
      const f = harness();
      const residentItem = { type: "plan" as const, id: "resident", text: "latest" };
      f.mutate((draft) => {
        const entry = residentConversationTurnEntries(draft)[0]!;
        const turn = conversationTurnDraft(draft, entry.address)!;
        turn.items = [residentItem];
        turn.itemsPagination!.reconnect = {
          beforeItemId: "resident",
          stopItemId: "older-anchor",
          olderCursorAfterReconnect: "ordinary-older",
        };
        draft.turnHistory!.history.islands[0]!.olderBoundary = availableCodexHistoryBoundary(
          "timeline-boundary",
          { source: "timeline", cursor: "timeline-page", oldestLoadedTurnId: "turn" },
        );
        draft.turnsPagination = {
          source: "timeline",
          olderCursor: "timeline-page",
          oldestLoadedTurnId: "turn",
          isLoadingOlder: false,
          hasLoadedOldest: false,
        };
      });
      const history = f.read().turnHistory!.history;
      const boundary = history.islands[0]!.olderBoundary;
      if (boundary.status !== "available") throw new Error("Expected timeline boundary");
      const ref = createCodexHistoryBoundaryRef(
        history.generation,
        history.islands[0]!.id,
        "older",
        boundary,
      );
      const client: CanonicalHistoryClient = {
        ...f.client,
        supportsThreadTimeline: () => true,
        sendTimelineRequest: async (params) => {
          expect(params.cursor).toBe("timeline-page");
          return {
            data: [
              { type: "turnStarted", position: 0, turnId: "turn", startedAt: 1 },
              { type: "item", position: 1, turnId: "turn", item: item("older") },
            ],
            nextCursor: "timeline-next",
            activeRealtimeSessionAtPageStart: null,
          } as ClientRequestResponsesByMethod["thread/timeline/list"];
        },
      };
      await expect(loadCanonicalHistoryBoundaryPage(client, "conversation", ref)).resolves.toBe(
        "applied",
      );
      const turn = residentConversationTurns(f.read())[0]!;
      expect(turn.items.map(({ id }) => id)).toEqual(["older", "resident"]);
      expect(turn.items[1]).toBe(residentItem);
      expect(turn.itemsPagination).toMatchObject({
        source: "timeline",
        olderCursor: null,
        hasLoadedOldest: true,
      });
      expect(turn.itemsPagination?.reconnect).toBeUndefined();
      expect(f.read().turnsPagination).toMatchObject({
        source: "timeline",
        olderCursor: "timeline-next",
      });
      expect(f.broadcasts()).toBe(1);
    });

    test("an admitted ordinary boundary retains its cursor source when timeline becomes enabled", async () => {
      const f = harness();
      f.mutate((draft) => {
        draft.historyMode = "legacy";
        draft.turnHistory!.history.islands[0]!.olderBoundary = availableCodexHistoryBoundary(
          "ordinary-boundary",
          { cursor: "ordinary-page", oldestLoadedTurnId: "turn" },
        );
      });
      f.handle(async ({ params }) => {
        expect(params.cursor).toBe("ordinary-page");
        return { data: [rawTurn("older")], nextCursor: null };
      });
      const history = f.read().turnHistory!.history;
      const boundary = history.islands[0]!.olderBoundary;
      if (boundary.status !== "available") throw new Error("Expected ordinary boundary");
      const ref = createCodexHistoryBoundaryRef(
        history.generation,
        history.islands[0]!.id,
        "older",
        boundary,
      );
      const client: CanonicalHistoryClient = {
        ...f.client,
        supportsThreadTimeline: () => true,
        sendTimelineRequest: async () => {
          throw new Error("Ordinary cursor cannot address timeline");
        },
      };
      await expect(loadCanonicalHistoryBoundaryPage(client, "conversation", ref)).resolves.toBe(
        "applied",
      );
      expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual([
        "older",
        "turn",
      ]);
      expect(f.calls).toHaveLength(1);
    });

    test("rejects a boundary page when its original island disappears during I/O", async () => {
      const f = harness();
      f.mutate((draft) => {
        draft.turnHistory!.history.islands[0]!.olderBoundary = availableCodexHistoryBoundary(
          "boundary",
          { cursor: "page-one", oldestLoadedTurnId: "turn" },
        );
      });
      const history = f.read().turnHistory!.history;
      const island = history.islands[0]!;
      const boundary = island.olderBoundary;
      if (boundary.status !== "available") throw new Error("Expected page boundary");
      const ref = createCodexHistoryBoundaryRef(history.generation, island.id, "older", boundary);
      const response = deferred<unknown>();
      f.handle(() => response.promise);
      const pending = loadCanonicalHistoryBoundaryPage(f.client, "conversation", ref, {
        itemsView: "notLoaded",
      });

      // A coalesced history island may retain the same boundary identity. Physical page
      // admission is stricter: the island selected before I/O must still be present.
      f.mutate((draft) => {
        draft.turnHistory!.history.islands[0]!.id = "coalesced-island";
      });
      response.resolve({ data: [rawTurn("old")], nextCursor: null });

      expect(await pending).toBe("stale");
      expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual(["turn"]);
      expect(f.broadcasts()).toBe(0);
    });

    test("durable history limits item workers to five and halves oversized requests at the same cursor", async () => {
      const f = harness([], "durable");
      const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
      let active = 0;
      let peak = 0;
      let oversize = true;
      f.handle(async ({ method, params }) => {
        if (method === "thread/turns/list")
          return {
            data: Array.from({ length: 7 }, (_, index) => rawTurn(String(index))),
            nextCursor: null,
          };
        if (!("turnId" in params) || typeof params.turnId !== "string")
          throw new Error("Expected item request");
        if (params.turnId === "0" && oversize) {
          oversize = false;
          throw new Error("decoded message length too large");
        }
        active += 1;
        peak = Math.max(peak, active);
        const response = deferred<unknown>();
        gates.set(params.turnId, response);
        try {
          return await response.promise;
        } finally {
          active -= 1;
        }
      });
      const pending = listCanonicalHistoryTurns(f.client, "conversation");
      await tick();
      expect(peak).toBe(5);
      const first = f.calls.filter(({ params }) => "turnId" in params && params.turnId === "0");
      expect(first.map(({ params }) => params.limit)).toEqual([500, 250]);
      expect(first.map(({ params }) => params.cursor)).toEqual([null, null]);
      for (let index = 0; index < 5; index += 1)
        gates.get(String(index))!.resolve(itemsPage(String(index), [item(`i${index}`)]));
      await tick();
      gates.get("5")!.resolve(itemsPage("5", [item("i5")]));
      gates.get("6")!.resolve(itemsPage("6", [item("i6")]));
      const result = await pending;
      expect(result.response.data.map((turn) => turn.id)).toEqual([
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);
      expect(peak).toBe(5);
    });
    test("shares a 500-item budget across turns and carries known opening input without another lookup", async () => {
      const f = harness(["a", "b"]);
      f.mutate((draft) => {
        draft.historyMode = "paginated";
        for (const entry of residentConversationTurnEntries(draft)) {
          const pagination = conversationTurnDraft(draft, entry.address)!.itemsPagination!;
          pagination.oldestUserInput = [{ type: "text", text: "opening", text_elements: [] }];
          pagination.openingUserMessageId = "opening-id";
          pagination.openingUserMessageClientId = "opening-client";
        }
      });
      let page = 0;
      f.handle(async ({ method, params }) => {
        if (method === "thread/turns/list")
          return { data: [rawTurn("a"), rawTurn("b")], nextCursor: "older-turns" };
        if (!("turnId" in params) || typeof params.turnId !== "string")
          throw new Error("Expected item request");
        page += 1;
        return itemsPage(
          params.turnId,
          Array.from({ length: 100 }, (_, index) => item(`${page}-${index}`)),
          `cursor-${page}`,
        );
      });
      const result = await listCanonicalHistoryTurns(f.client, "conversation");
      expect(f.calls.filter(({ method }) => method === "thread/items/list")).toHaveLength(5);
      expect(result.response.data.map((turn) => turn.items.length)).toEqual([500, 0]);
      expect(result.itemsPaginationByTurnId.a).toMatchObject({
        olderCursor: "cursor-5",
        hasLoadedOldest: false,
        openingUserMessageId: "opening-id",
        openingUserMessageClientId: "opening-client",
        oldestUserInput: [{ type: "text", text: "opening", text_elements: [] }],
      });
      expect(result.itemsPaginationByTurnId.b).toMatchObject({
        olderCursor: null,
        hasLoadedOldest: false,
        openingUserMessageId: "opening-id",
      });
    });

    test("durable item pages accept direct protocol items as well as wrapped items", async () => {
      const f = harness(["turn"], "durable");
      f.handle(async ({ method }) =>
        method === "thread/turns/list"
          ? { data: [rawTurn("turn")], nextCursor: null }
          : { data: [item("direct"), { item: item("wrapped") }], nextCursor: null },
      );
      const result = await listCanonicalHistoryTurns(f.client, "conversation");
      expect(result.response.data[0]?.items.map((entry) => entry.id)).toEqual([
        "direct",
        "wrapped",
      ]);
    });

    test("search hydrates both cursor directions before inserting and broadcasts only after placement", async () => {
      const f = harness(["turn"]);
      f.mutate((draft) => {
        draft.historyMode = "legacy";
      });
      f.handle(async ({ method, params, options }) => {
        expect(method).toBe("thread/turns/list");
        expect(params.cursor).toBe("match-cursor");
        expect(params.limit).toBe(5);
        expect(options).toEqual({ priority: "interactive", source: "thread_hydration" });
        const match = { ...rawTurn("turn"), items: [item("match-item")], itemsView: "full" };
        return {
          data:
            params.sortDirection === "desc"
              ? [match, rawTurn("before")]
              : [match, rawTurn("after")],
          nextCursor: null,
        };
      });
      await hydrateCanonicalHistorySearchMatch(
        f.client,
        {
          conversationId: "conversation",
          itemId: "match-item",
          turnId: "turn",
          turnCursor: "match-cursor",
        },
        () => "search-window",
      );
      expect(f.calls.map(({ params }) => params.sortDirection)).toEqual(["desc", "asc"]);
      expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual([
        "before",
        "turn",
        "after",
      ]);
      expect(f.broadcasts()).toBe(1);
    });

    test("search navigation uses an exact resident item without depending on another native read", async () => {
      const f = harness();
      f.mutate((draft) => {
        const entry = residentConversationTurnEntries(draft)[0]!;
        conversationTurnDraft(draft, entry.address)!.items = [
          { type: "plan", id: "match", text: "visible" },
        ];
      });
      f.handle(async () => {
        throw new Error("Native history temporarily unavailable");
      });
      const before = f.read();
      await hydrateCanonicalHistorySearchMatch(
        f.client,
        { conversationId: "conversation", turnId: "turn", itemId: "match", turnCursor: "cursor" },
        () => "unused",
      );
      expect(f.calls).toEqual([]);
      expect(f.read()).toBe(before);
      expect(f.broadcasts()).toBe(0);
    });

    test("search navigation still hydrates a resident summary placeholder with the same item identity", async () => {
      const f = harness();
      f.mutate((draft) => {
        draft.historyMode = "legacy";
        const entry = residentConversationTurnEntries(draft)[0]!;
        const turn = conversationTurnDraft(draft, entry.address)!;
        turn.items = [{ type: "plan", id: "match", text: "placeholder" }];
        turn.itemsPagination!.summaryItemIds = ["match"];
      });
      f.handle(async () => ({
        data: [
          {
            ...rawTurn("turn"),
            items: [{ ...item("match"), text: "hydrated" }],
            itemsView: "full",
          },
        ],
        nextCursor: null,
      }));
      await hydrateCanonicalHistorySearchMatch(
        f.client,
        { conversationId: "conversation", turnId: "turn", itemId: "match", turnCursor: "cursor" },
        () => "selected",
      );
      expect(f.calls.map(({ params }) => params.sortDirection)).toEqual(["desc", "asc"]);
      expect(f.broadcasts()).toBe(1);
      expect(residentConversationTurns(f.read())[0]?.items[0]?.id).toBe("match");
    });
  });

  test("item pages recover envelope starts without allowing older commentary to replace the reply", async () => {
    const f = harness();
    const reply: ThreadItem = {
      type: "agentMessage",
      moderation: null,
      id: "reply",
      text: "Done",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    f.handle(async () => ({
      data: [{ turnId: "turn", item: reply, startedAtMs: 5000, completedAtMs: 9000 }],
      nextCursor: "earlier",
      backwardsCursor: null,
    }));
    using loader = new CanonicalHistoryItemLoader(f.client);
    await loader.loadTurnItems("conversation", "turn", false);
    expect(residentConversationTurns(f.read())[0]?.finalAssistantStartedAtMs).toBe(5000);
    expect(residentConversationTurns(f.read())[0]?.items[0]).toMatchObject({
      startedAtMs: 5000,
      completedAtMs: 9000,
    });
    f.handle(async () => ({
      data: [
        {
          turnId: "turn",
          item: { ...reply, id: "commentary", phase: "commentary", startedAtMs: 70_000 },
          startedAtMs: 2000,
          completedAtMs: 3000,
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }));
    await loader.loadTurnItems("conversation", "turn", false);
    expect(residentConversationTurns(f.read())[0]?.finalAssistantStartedAtMs).toBe(5000);
    expect(residentConversationTurns(f.read())[0]?.items[0]).toMatchObject({ startedAtMs: 70_000 });
  });

  test("completed-only item history does not invent a response start", async () => {
    const f = harness();
    f.handle(async () => ({
      data: [
        {
          turnId: "turn",
          item: {
            type: "agentMessage",
            moderation: null,
            id: "reply",
            text: "Done",
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
          startedAtMs: null,
          completedAtMs: 9000,
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }));
    using loader = new CanonicalHistoryItemLoader(f.client);
    await loader.loadTurnItems("conversation", "turn", false);
    expect(residentConversationTurns(f.read())[0]?.finalAssistantStartedAtMs).toBeNull();
  });
});

describe("codex canonical history search", () => {
  function fixture() {
    const thread = buildAgentActivityV2CorpusThread([]);
    const state = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    });
    const template = state.turns[0]!;
    const turn = (turnId: string, turnStartedAtMs: number | null) => ({
      ...template,
      turnId,
      turnStartedAtMs,
      items: [],
    });
    return { state, turn };
  }

  describe("persisted search history placement", () => {
    test("overlap preserves resident entry identity and places surrounding turns without timestamps", () => {
      const f = fixture();
      const before = produce(f.state, (draft) => {
        replaceCanonicalHistoryDraft(draft, [f.turn("anchor", null)], false);
        const history = draft.turnHistory!.history;
        const resident = history.entitiesByKey["turn:anchor"]!;
        delete history.entitiesByKey["turn:anchor"];
        history.entitiesByKey["local-stable"] = resident;
        history.islands[0]!.entries = [{ key: "visible-stable", value: "local-stable" }];
      });
      let applied = false;
      const after = produce(before, (draft) => {
        applied = insertCanonicalHistorySearchDraft(draft, () => "window", {
          turns: [f.turn("older", null), f.turn("anchor", null), f.turn("newer", null)],
          olderCursor: "older-page",
          newerCursor: "newer-page",
        });
      });
      expect(applied).toBe(true);
      expect(residentConversationTurns(after).map((turn) => turn.turnId)).toEqual([
        "older",
        "anchor",
        "newer",
      ]);
      expect(after.turnHistory!.history.islands[0]!.entries[1]).toEqual({
        key: "visible-stable",
        value: "local-stable",
      });
      expect(after.turnHistory!.history.entitiesByKey["turn:anchor"]).toBeUndefined();
      expect(after.turnHistory!.history.isComplete).toBe(false);
    });

    test("refuses disconnected windows when any resident timestamp is unknown", () => {
      const f = fixture();
      const before = produce(f.state, (draft) =>
        replaceCanonicalHistoryDraft(draft, [f.turn("resident", null)], false),
      );
      let applied = true;
      const after = produce(before, (draft) => {
        applied = insertCanonicalHistorySearchDraft(draft, () => "window", {
          turns: [f.turn("match", 10)],
          olderCursor: null,
          newerCursor: null,
        });
      });
      expect(applied).toBe(false);
      expect(after).toBe(before);
    });

    test("orders disconnected windows by timestamp with deterministic Turn identity ties", () => {
      const f = fixture();
      const before = produce(f.state, (draft) =>
        replaceCanonicalHistoryDraft(draft, [f.turn("z", 20)], false),
      );
      const after = produce(before, (draft) => {
        insertCanonicalHistorySearchDraft(draft, () => "window", {
          turns: [f.turn("a", 20)],
          olderCursor: "older",
          newerCursor: "newer",
        });
      });
      expect(residentConversationTurns(after).map((turn) => turn.turnId)).toEqual(["a", "z"]);
      expect(after.turnHistory!.history.islands).toHaveLength(2);
    });
  });
});

describe("codex canonical history timeline", () => {
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
  const plan = (id: string): ThreadItem => ({
    type: "plan",
    id,
    text: "large payload",
    startedAtMs: null,
    completedAtMs: null,
  });
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
      expect(calls[0]).toMatchObject({
        method: "thread/turns/list",
        params: { cursor: turnCursor },
      });
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
        {
          method: "thread/timeline/list",
          params: { threadId: "thread", cursor: null, limit: 500 },
        },
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
            data: [
              { type: "turnStarted", position: 0, turnId: "turn", startedAt: 1 },
              ...first.data,
            ],
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
});

describe("codex canonical prompt rail", () => {
  type Method = "thread/turns/list" | "thread/items/list";
  const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
    rootTurnId: null,
    id,
    status,
    items: [],
    itemsView: "full",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
  function client(
    handler: (method: Method, params: ClientRequestParamsByMethod[Method]) => unknown,
  ) {
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

  test("a rail preview keeps its ordinary cursor and 30-item budget while timeline is enabled", async () => {
    const state = createCodexCanonicalHydratedConversationState(
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
    const opening = {
      type: "userMessage" as const,
      id: "opening",
      clientId: null,
      content: [{ type: "text" as const, text: "hello", text_elements: [] }],
    };
    const f = client((method, params) => {
      if (method === "thread/turns/list")
        return {
          data: [{ ...turn("target"), itemsView: "notLoaded" }],
          backwardsCursor: "anchor",
          nextCursor: null,
        };
      if (params.sortDirection === "asc")
        return { data: [{ turnId: "target", item: opening }], nextCursor: null };
      return {
        data: [
          ...Array.from({ length: 29 }, (_, index) => ({
            turnId: "target",
            item: { type: "plan", id: String(index), text: "work" },
          })),
          {
            turnId: "target",
            item: {
              type: "agentMessage",
              moderation: null,
              id: "answer",
              text: "answer",
              phase: "final_answer",
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          },
        ],
        nextCursor: "older-items",
      };
    });
    const timeline = vi.fn(async () => {
      throw new Error("Ordinary cursor cannot address timeline");
    });
    const actual: CanonicalHistoryClient = {
      ...f.value,
      getConversation: () => ({
        ...state,
        historyMode: "paginated",
        paginatedHistory: { turnsBackwardsCursor: null, itemsBackwardsCursor: null },
      }),
      supportsThreadTimeline: () => true,
      sendTimelineRequest: timeline,
    };
    const preview = await previewCanonicalPromptRailTurn(actual, "thread", {
      turnId: "target",
      pageBackwardsCursor: "rail-cursor",
      descendingOffset: 0,
    });
    expect(preview).toEqual({
      turnCursor: "anchor",
      previews: [
        {
          itemId: "opening",
          promptPreview: "hello",
          responsePreview: "answer",
          isHeartbeat: false,
        },
      ],
    });
    expect(timeline).not.toHaveBeenCalled();
    expect(f.requests.map(({ method, params }) => [method, params.limit])).toEqual([
      ["thread/turns/list", 1],
      ["thread/items/list", 30],
      ["thread/items/list", 2],
    ]);
    expect(f.requests[0]?.params.cursor).toBe("rail-cursor");
    expect(f.requests.every(({ options }) => options?.priority === "interactive")).toBe(true);
    expect(f.updateConversation).not.toHaveBeenCalled();
    expect(f.broadcastSnapshot).not.toHaveBeenCalled();
  });

  test("preview carries an opening prompt omitted from partial items and pairs its response", () => {
    const result = buildCodexPromptRailPreviews({
      turn: {
        ...turn("target"),
        itemsView: "summary",
        items: [
          {
            type: "agentMessage",
            moderation: null,
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
      {
        itemId: "opening",
        promptPreview: "question",
        responsePreview: "answer",
        isHeartbeat: false,
      },
    ]);
  });
});

describe("codex complete history loader", () => {
  const rawTurn = (id: string): Turn => ({
    rootTurnId: null,
    id,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  });
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  function fixture() {
    const initial = createCodexCanonicalHydratedConversationState(
      { ...buildAgentActivityV2CorpusThread([]), id: "conversation", turns: [rawTurn("tail")] },
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
    const params = residentConversationTurns(initial)[0]!.params;
    let state = produce(initial, (draft) => {
      const boundary = { cursor: "older", oldestLoadedTurnId: "tail" };
      replaceCanonicalHistoryDraft(draft, residentConversationTurns(initial), false, boundary);
      draft.resumeState = "resumed";
      draft.turnsPagination = {
        olderCursor: "older",
        oldestLoadedTurnId: "tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
      };
    });
    const calls: { params: unknown; options: unknown }[] = [];
    let snapshots = 0;
    let patches = 0;
    let handler: (params: unknown) => Promise<unknown> = async () => {
      throw new Error("Unexpected request");
    };
    const client: CanonicalHistoryClient = {
      hostId: "local",
      supportsPaginatedHistory: () => true,
      getConversation: () => state,
      async sendRequest<M extends "thread/turns/list" | "thread/items/list">(
        _method: M,
        params: ClientRequestParamsByMethod[M],
        options?: Parameters<CanonicalHistoryClient["sendRequest"]>[2],
      ): Promise<ClientRequestResponsesByMethod[M]> {
        calls.push({ params, options });
        return (await handler(params)) as ClientRequestResponsesByMethod[M];
      },
      updateConversation: (_id, recipe, broadcast = true) => {
        state = produce(state, recipe);
        if (broadcast) patches += 1;
      },
      broadcastSnapshot: () => {
        snapshots += 1;
      },
      mapTurns: (_id, turns, pagination) =>
        turns.map((turn) => ({
          ...createCodexCanonicalTurnState(turn, params),
          ...(pagination[turn.id] ? { itemsPagination: pagination[turn.id] } : {}),
        })),
    };
    return {
      client,
      calls,
      read: () => state,
      snapshots: () => snapshots,
      patches: () => patches,
      handle: (fn: typeof handler) => {
        handler = fn;
      },
      mutate: (recipe: Parameters<CanonicalHistoryClient["updateConversation"]>[1]) => {
        state = produce(state, recipe);
      },
    };
  }

  test("coalesces complete tail demand and publishes one snapshot after all pages", async () => {
    const f = fixture();
    const firstPage = deferred<unknown>();
    f.handle(async () =>
      f.calls.length === 1 ? firstPage.promise : { data: [rawTurn("oldest")], nextCursor: null },
    );
    using loader = new CanonicalCompleteHistoryLoader(f.client);
    const first = loader.load("conversation");
    const second = loader.load("conversation");
    expect(f.calls).toHaveLength(1);
    f.mutate((draft) => {
      draft.cwd = "/live-update";
    });
    firstPage.resolve({ data: [rawTurn("middle")], nextCursor: "last" });
    const [left, right] = await Promise.all([first, second]);
    expect(left.map((turn) => turn.turnId)).toEqual(["oldest", "middle", "tail"]);
    expect(right.map((turn) => turn.turnId)).toEqual(["oldest", "middle", "tail"]);
    expect(f.read().cwd).toBe("/live-update");
    expect(f.calls.map(({ params }) => (params as { limit: number }).limit)).toEqual([5, 5]);
    expect(f.calls.map(({ options }) => options)).toEqual([
      { priority: "background", source: "tail_history" },
      { priority: "background", source: "tail_history" },
    ]);
    expect(f.snapshots()).toBe(1);
    expect(f.patches()).toBe(0);
    expect(f.read().turnHistory?.history.isComplete).toBe(true);
  });

  test("disposal suppresses late complete-history mutation and snapshot", async () => {
    const f = fixture();
    const page = deferred<unknown>();
    f.handle(() => page.promise);
    const loader = new CanonicalCompleteHistoryLoader(f.client);
    const pending = loader.load("conversation");
    loader[Symbol.dispose]();
    page.resolve({ data: [rawTurn("late")], nextCursor: null });
    await expect(pending).rejects.toThrow("Failed to load complete");
    expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual(["tail"]);
    expect(f.snapshots()).toBe(0);
  });

  test("reconnect separates identical-cursor loads and rejects the late old response without publishing it", async () => {
    const f = fixture();
    const oldPage = deferred<unknown>();
    f.handle(async () =>
      f.calls.length === 1
        ? oldPage.promise
        : { data: [rawTurn("current-older")], nextCursor: null },
    );
    using loader = new CanonicalCompleteHistoryLoader(f.client);
    const old = loader.load("conversation").then(
      () => "accepted",
      () => "retired",
    );
    loader.resetAfterReconnect();
    const current = await loader.load("conversation");
    expect(current.map((turn) => turn.turnId)).toEqual(["current-older", "tail"]);
    oldPage.resolve({ data: [rawTurn("stale-older")], nextCursor: "old-more" });
    expect(await old).toBe("retired");
    expect(f.calls).toHaveLength(2);
    expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual([
      "current-older",
      "tail",
    ]);
    expect(f.snapshots()).toBe(1);
  });

  test("restarts complete loading from the new tail when its generation changes during I/O", async () => {
    const f = fixture();
    const page = deferred<unknown>();
    f.handle(async () =>
      f.calls.length === 1 ? page.promise : { data: [rawTurn("current-older")], nextCursor: null },
    );
    using loader = new CanonicalCompleteHistoryLoader(f.client);
    const pending = loader.load("conversation");
    f.mutate((draft) => {
      replaceCanonicalHistoryDraft(draft, residentConversationTurns(draft), false, {
        cursor: "replacement",
        oldestLoadedTurnId: "tail",
      });
      draft.turnsPagination = {
        olderCursor: "replacement",
        oldestLoadedTurnId: "tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
      };
    });
    page.resolve({ data: [rawTurn("retired-older")], nextCursor: null });
    const turns = await pending;
    expect(turns.map((turn) => turn.turnId)).toEqual(["current-older", "tail"]);
    expect(f.calls.map(({ params }) => (params as { cursor: string }).cursor)).toEqual([
      "older",
      "replacement",
    ]);
    expect(f.snapshots()).toBe(1);
  });
});

describe("codex history resume", () => {
  const item = (id: string, text = id): CodexCanonicalItem => ({
    type: "agentMessage",
    moderation: null,
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
  const pagination: CodexHistoryTurnItemsPagination = {
    olderCursor: "previous-older",
    hasLoadedOldest: false,
    isLoadingOlder: false,
    itemsView: "summary",
    oldestUserInput: null,
    openingUserMessageId: null,
    newestSnapshotItemId: "resident-last",
  };

  describe("resumed item history", () => {
    it.each([false, true])(
      "a timeline resume retires ordinary reconnect even when the previous prefix is complete=%s",
      (complete) => {
        const incoming = {
          ...pagination,
          source: "timeline" as const,
          olderCursor: null,
          hasLoadedOldest: false,
          newestSnapshotItemId: "timeline",
        };
        const result = mergeCodexResumedItemsPagination(
          {
            ...pagination,
            hasLoadedOldest: complete,
            reconnect: {
              beforeItemId: "previous",
              stopItemId: "resident-last",
              olderCursorAfterReconnect: "ordinary-cursor",
            },
          },
          incoming,
          [item("timeline")],
        );
        expect(result).toEqual({ ...incoming, reconnect: undefined });
      },
    );
    it("reuses the previous older cursor when the new snapshot overlaps its resident anchor", () => {
      const result = mergeCodexResumedItemsPagination(
        pagination,
        { ...pagination, olderCursor: "snapshot-older", newestSnapshotItemId: "new" },
        [item("resident-last"), item("new")],
      );
      expect(result.olderCursor).toBe("previous-older");
      expect(result.reconnect).toBeUndefined();
      expect(result.hasLoadedOldest).toBe(false);
    });
    it("retains a reconnect anchor across consecutive resumes and stops scanning when it is reached", () => {
      const first = mergeCodexResumedItemsPagination(
        pagination,
        { ...pagination, olderCursor: "snapshot-older", newestSnapshotItemId: "new" },
        [item("new")],
      );
      const second = mergeCodexResumedItemsPagination(
        first,
        { ...pagination, olderCursor: "second-snapshot", newestSnapshotItemId: "newest" },
        [item("newest")],
      );
      expect(second.reconnect).toEqual({
        beforeItemId: "newest",
        stopItemId: "resident-last",
        olderCursorAfterReconnect: "previous-older",
      });
      const gap = advanceCodexReconnectedItemsPagination(second, [item("gap")], "gap-cursor");
      expect(gap.reconnect?.beforeItemId).toBe("gap");
      const joined = advanceCodexReconnectedItemsPagination(
        gap,
        [item("resident-last"), item("bridge")],
        "discard-this-cursor",
      );
      expect(joined.olderCursor).toBe("previous-older");
      expect(joined.reconnect).toBeUndefined();
    });
    it("recognizes a complete resident prefix after overlap and does not mistake summary ids for coverage", () => {
      const complete = { ...pagination, olderCursor: null, hasLoadedOldest: true };
      const incoming = { ...pagination, olderCursor: "snapshot" };
      expect(
        mergeCodexResumedItemsPagination(complete, incoming, [item("resident-last")])
          .hasLoadedOldest,
      ).toBe(true);
      expect(
        mergeCodexResumedItemsPagination(
          complete,
          { ...incoming, summaryItemIds: ["resident-last"] },
          [item("resident-last")],
        ).reconnect,
      ).toBeDefined();
    });
    it("snapshot merges refresh assistant values without aliasing text and insert reconnect items at their snapshot boundary", () => {
      const result = mergeCodexCanonicalHistoryItems(
        [item("old", "same"), item("snapshot", "before")],
        [item("renamed", "same"), item("snapshot", "after")],
        { snapshotBeforeItemId: null },
      );
      expect(result.items.map((value) => value.id)).toEqual(["old", "renamed", "snapshot"]);
      expect(result.items.at(-1)).toEqual(item("snapshot", "after"));
      expect(result.aliases.size).toBe(0);
      expect(
        mergeCodexCanonicalHistoryItems([item("old"), item("snapshot")], [item("bridge")], {
          snapshotBeforeItemId: "snapshot",
        }).items.map((value) => value.id),
      ).toEqual(["old", "bridge", "snapshot"]);
    });
  });
});
