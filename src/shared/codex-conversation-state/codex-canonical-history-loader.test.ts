import { hydrateCanonicalHistorySearchMatch } from "./codex-canonical-history-search";
import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalTurnState,
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
} from "./codex-history-topology";
import {
  CanonicalHistoryItemLoader,
  listCanonicalHistoryTurns,
  loadCanonicalHistoryBoundaryPage,
  replaceCanonicalHistoryDraft,
  type CanonicalHistoryClient,
  type CanonicalHistoryRequestOptions,
} from "./codex-canonical-history-loader";

type Method = "thread/turns/list" | "thread/items/list";
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
    expect(result.response.data[0]?.items.map((entry) => entry.id)).toEqual(["direct", "wrapped"]);
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
          params.sortDirection === "desc" ? [match, rawTurn("before")] : [match, rawTurn("after")],
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
});
