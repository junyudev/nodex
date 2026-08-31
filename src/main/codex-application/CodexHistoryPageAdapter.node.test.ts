import { assert, it } from "@effect/vitest";
import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CODEX_HISTORY_ITEM_PAGE_SIZE,
  CODEX_HISTORY_INITIAL_BYTE_BUDGET,
  CODEX_HISTORY_INITIAL_MAX_ITEM_PAGE_REQUESTS,
  estimateCodexHistoryProjectedItemPageBytes,
  make,
} from "./CodexHistoryPageAdapter";

const CAPABILITY = createCodexAppServerCapabilitySnapshot({
  hostId: "local",
  generation: 7,
  userAgent: "codex-cli/0.148.0-alpha.13",
});

const completedTurn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const agentItem = (id: string): ThreadItem => ({
  type: "agentMessage",
  id,
  text: id,
  phase: null,
  memoryCitation: null,
  delivery: null,
});

const userItem = (id: string, text: string): ThreadItem => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

it.effect("hydrates a five-turn skeleton page through one shared item budget", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
    const scheduling: unknown[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown, options: unknown) =>
        Effect.sync(() => {
          requests.push({ method, params });
          scheduling.push(options);
          if (method === "thread/turns/list") {
            return {
              data: [completedTurn("turn-2"), completedTurn("turn-1")],
              nextCursor: "turns:older",
              backwardsCursor: "turns:newer",
            };
          }
          const itemParams = params as {
            readonly turnId: string;
            readonly cursor: string | null;
            readonly sortDirection: "asc" | "desc";
          };
          if (itemParams.turnId === "turn-2") {
            return itemParams.cursor === "items:tail"
              ? {
                  data: [{ turnId: "turn-2", item: agentItem("assistant-2") }],
                  nextCursor: "turn-2:older",
                  backwardsCursor: null,
                }
              : {
                  data: [{ turnId: "turn-2", item: userItem("user-2", "two") }],
                  nextCursor: null,
                  backwardsCursor: "turn-2:newer",
                };
          }
          if (itemParams.sortDirection === "asc") {
            return itemParams.cursor === null
              ? {
                  data: [
                    { turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } },
                  ],
                  nextCursor: "opening:user",
                  backwardsCursor: null,
                }
              : {
                  data: [{ turnId: "turn-1", item: userItem("user-1", "one") }],
                  nextCursor: "items:newer",
                  backwardsCursor: null,
                };
          }
          return {
            data: [{ turnId: "turn-1", item: agentItem("assistant-1") }],
            nextCursor: "items:older",
            backwardsCursor: null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const page = yield* adapter.loadTurnPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      cursor: "turns:tail",
      initialItemsCursor: "items:tail",
      limit: 2,
      itemBudget: 3,
    });

    assert.deepStrictEqual(
      page.turns.map((turn) => [turn.id, turn.itemsView, turn.items.map((item) => item.id)]),
      [
        ["turn-1", "summary", ["assistant-1"]],
        ["turn-2", "full", ["user-2", "assistant-2"]],
      ],
    );
    assert.strictEqual(page.loadedItemCount, 3);
    assert.deepStrictEqual(
      scheduling,
      Array(6).fill({
        priority: "interactive",
        source: "thread_hydration",
        expectedHostId: "local",
        expectedGeneration: 7,
      }),
    );
    assert.deepStrictEqual(page.itemsPaginationByTurnId["turn-1"], {
      olderCursor: "items:older",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      oldestUserInput: [{ type: "text", text: "one", text_elements: [] }],
      openingUserMessageId: "user-1",
      itemsView: "summary",
    });
    assert.deepStrictEqual(page.itemSegmentsByTurnId, {
      "turn-1": [
        {
          itemIds: ["assistant-1"],
          approximateBytes: estimateCodexHistoryProjectedItemPageBytes([agentItem("assistant-1")]),
          olderCursor: "items:older",
          newerCursor: null,
        },
      ],
      "turn-2": [
        {
          itemIds: ["user-2"],
          approximateBytes: estimateCodexHistoryProjectedItemPageBytes([userItem("user-2", "two")]),
          olderCursor: null,
          newerCursor: "turn-2:newer",
        },
        {
          itemIds: ["assistant-2"],
          approximateBytes: estimateCodexHistoryProjectedItemPageBytes([agentItem("assistant-2")]),
          olderCursor: "turn-2:older",
          newerCursor: null,
        },
      ],
    });
    assert.deepStrictEqual(
      requests.map(({ method, params }) => ({ method, params })),
      [
        {
          method: "thread/turns/list",
          params: {
            threadId: "thread-a",
            cursor: "turns:tail",
            limit: 2,
            itemsView: "notLoaded",
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-a",
            turnId: "turn-2",
            cursor: "items:tail",
            limit: 1,
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-a",
            turnId: "turn-2",
            cursor: "turn-2:older",
            limit: 2,
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-a",
            turnId: "turn-1",
            cursor: "items:tail",
            limit: 1,
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-a",
            turnId: "turn-1",
            cursor: null,
            limit: 1,
            sortDirection: "asc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-a",
            turnId: "turn-1",
            cursor: "opening:user",
            limit: 1,
            sortDirection: "asc",
          },
        },
      ],
    );
  }),
);

it.effect("charges the shared item budget only for unique retained items", () =>
  Effect.gen(function* () {
    const itemLimits: number[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn("turn-1")],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        const itemParams = params as { readonly cursor: string | null; readonly limit: number };
        itemLimits.push(itemParams.limit);
        if (itemParams.cursor === null) {
          return Effect.succeed({
            data: [{ turnId: "turn-1", item: agentItem("newer") }],
            nextCursor: "items:duplicate",
            backwardsCursor: null,
          }) as never;
        }
        if (itemParams.cursor === "items:duplicate") {
          return Effect.succeed({
            data: [{ turnId: "turn-1", item: agentItem("newer") }],
            nextCursor: "items:older",
            backwardsCursor: null,
          }) as never;
        }
        return Effect.succeed({
          data: [{ turnId: "turn-1", item: agentItem("older") }],
          nextCursor: null,
          backwardsCursor: null,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const page = yield* adapter.loadTurnPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      cursor: null,
      initialItemsCursor: null,
      limit: 1,
      itemBudget: 2,
    });

    assert.deepStrictEqual(itemLimits, [1, 1, 1]);
    assert.deepStrictEqual(
      page.turns[0]?.items.map((item) => item.id),
      ["older", "newer"],
    );
    assert.strictEqual(page.loadedItemCount, 2);
    assert.isTrue(page.itemsPaginationByTurnId["turn-1"]?.hasLoadedOldest);
  }),
);

it.effect("caps fresh-cursor duplicate-only item chains by physical request count", () =>
  Effect.gen(function* () {
    let itemRequests = 0;
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn("turn-1")],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        itemRequests += 1;
        return Effect.succeed({
          data: [{ turnId: "turn-1", item: agentItem("inclusive-anchor") }],
          nextCursor: `items:${itemRequests}`,
          backwardsCursor: (params as { readonly cursor: string | null }).cursor,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const page = yield* adapter.loadTurnPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      cursor: null,
      initialItemsCursor: null,
    });

    assert.strictEqual(itemRequests, CODEX_HISTORY_INITIAL_MAX_ITEM_PAGE_REQUESTS);
    assert.strictEqual(page.loadedItemCount, 1);
    assert.deepStrictEqual(
      page.turns[0]?.items.map((item) => item.id),
      ["inclusive-anchor"],
    );
    assert.strictEqual(
      page.itemsPaginationByTurnId["turn-1"]?.olderCursor,
      `items:${CODEX_HISTORY_INITIAL_MAX_ITEM_PAGE_REQUESTS}`,
    );
  }),
);

it.effect("rejects an oversized cold item from residency without advancing its cursor", () =>
  Effect.gen(function* () {
    const requests: unknown[] = [];
    const oversized = {
      ...agentItem("oversized"),
      text: "x".repeat(CODEX_HISTORY_INITIAL_BYTE_BUDGET + 1),
    } as ThreadItem;
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        requests.push({ method, params });
        return Effect.succeed(
          method === "thread/turns/list"
            ? {
                data: [completedTurn("turn-1")],
                nextCursor: null,
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: "turn-1", item: oversized }],
                nextCursor: "items:older",
                backwardsCursor: null,
              },
        ) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const page = yield* adapter.loadTurnPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      cursor: null,
      initialItemsCursor: "items:tail",
    });

    assert.strictEqual(page.loadedItemCount, 0);
    assert.deepStrictEqual(page.turns[0]?.items, []);
    assert.deepStrictEqual(page.itemSegmentsByTurnId["turn-1"], []);
    assert.deepStrictEqual(page.itemsPaginationByTurnId["turn-1"], {
      olderCursor: "items:tail",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView: "summary",
    });
    assert.strictEqual(requests.length, 2);
  }),
);

it.effect("fails closed when an oversized first item has no retryable boundary cursor", () =>
  Effect.gen(function* () {
    const oversized = {
      ...agentItem("oversized"),
      text: "x".repeat(CODEX_HISTORY_INITIAL_BYTE_BUDGET + 1),
    } as ThreadItem;
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string) =>
        Effect.succeed(
          method === "thread/turns/list"
            ? {
                data: [completedTurn("turn-1")],
                nextCursor: null,
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: "turn-1", item: oversized }],
                nextCursor: "items:older",
                backwardsCursor: null,
              },
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const failure = yield* adapter
      .loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        cursor: null,
        initialItemsCursor: null,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "item-byte-limit");
  }),
);

it.effect("rejects a mixed oversized cold page without skipping its cursor", () =>
  Effect.gen(function* () {
    const oversized = {
      ...agentItem("oversized"),
      text: "x".repeat(CODEX_HISTORY_INITIAL_BYTE_BUDGET + 1),
    } as ThreadItem;
    const batch = [
      oversized,
      ...Array.from({ length: 99 }, (_, index) => agentItem(`item-${index}`)),
    ];
    const itemLimits: number[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn("turn-1")],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        const limit = (params as { readonly limit: number }).limit;
        itemLimits.push(limit);
        return Effect.succeed({
          data: batch.slice(0, limit).map((item) => ({ turnId: "turn-1", item })),
          nextCursor: "items:after-protected",
          backwardsCursor: null,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const page = yield* adapter.loadTurnPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      cursor: null,
      initialItemsCursor: "items:tail",
    });

    assert.deepStrictEqual(itemLimits, [1]);
    assert.deepStrictEqual(page.turns[0]?.items, []);
    assert.strictEqual(page.itemsPaginationByTurnId["turn-1"]?.olderCursor, "items:tail");
  }),
);

it.effect("rejects a server item page that exceeds the requested physical limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: [
            { turnId: "turn-1", item: agentItem("first") },
            { turnId: "turn-1", item: agentItem("second") },
          ],
          nextCursor: null,
          backwardsCursor: null,
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const failure = yield* adapter
      .loadTurnItemsPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        turnId: "turn-1",
        cursor: null,
        limit: 1,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-size-exceeded");
  }),
);

it.effect("rejects unchanged turn cursors before installing a page", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: [completedTurn("turn-1")],
          nextCursor: "turns:same",
          backwardsCursor: null,
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
    const result = yield* Effect.result(
      adapter.loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        cursor: "turns:same",
        initialItemsCursor: null,
      }),
    );
    assert(Result.isFailure(result));
    assert.strictEqual(result.failure.reason, "cursor-stalled");
  }),
);

it.effect("rejects a server Turn page that exceeds the requested physical limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: [completedTurn("turn-1"), completedTurn("turn-2")],
          nextCursor: null,
          backwardsCursor: null,
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    const failure = yield* adapter
      .loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        cursor: null,
        initialItemsCursor: null,
        limit: 1,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-size-exceeded");
  }),
);

it.effect("rejects items that escape their requested turn", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string) =>
        Effect.succeed(
          method === "thread/turns/list"
            ? { data: [completedTurn("turn-1")], nextCursor: null, backwardsCursor: null }
            : {
                data: [{ turnId: "turn-other", item: agentItem("foreign") }],
                nextCursor: null,
                backwardsCursor: null,
              },
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
    const result = yield* Effect.result(
      adapter.loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        cursor: null,
        initialItemsCursor: null,
      }),
    );
    assert(Result.isFailure(result));
    assert.strictEqual(result.failure.reason, "foreign-item");
  }),
);

it.effect("schedules visible scroll-back item pages at interactive priority", () =>
  Effect.gen(function* () {
    const scheduling: unknown[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (
        _threadId: string,
        _method: string,
        _params: unknown,
        options: unknown,
      ) => {
        scheduling.push(options);
        return Effect.succeed({ data: [], nextCursor: null, backwardsCursor: null }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    yield* adapter.loadTurnItemsPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      turnId: "turn-a",
      cursor: "items:older",
      purpose: "older",
    });

    assert.deepStrictEqual(scheduling, [
      {
        priority: "interactive",
        source: "visible_history",
        expectedHostId: "local",
        expectedGeneration: 7,
      },
    ]);
  }),
);

it.effect("hard-caps every physical item request even when a caller asks for more", () =>
  Effect.gen(function* () {
    const limits: number[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, _method: string, params: unknown) => {
        limits.push((params as { readonly limit: number }).limit);
        return Effect.succeed({ data: [], nextCursor: null, backwardsCursor: null }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    yield* adapter.loadTurnItemsPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      turnId: "turn-a",
      cursor: null,
      limit: 500,
    });

    assert.deepStrictEqual(limits, [CODEX_HISTORY_ITEM_PAGE_SIZE]);
  }),
);

it.effect("schedules explicit export pages in their bounded background lane", () =>
  Effect.gen(function* () {
    const scheduling: unknown[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (
        _threadId: string,
        _method: string,
        _params: unknown,
        options: unknown,
      ) => {
        scheduling.push(options);
        return Effect.succeed({ data: [], nextCursor: null, backwardsCursor: null }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));

    yield* adapter.loadTurnItemsPage({
      capability: CAPABILITY,
      threadId: "thread-a",
      turnId: "turn-a",
      cursor: null,
      purpose: "export",
    });

    assert.deepStrictEqual(scheduling, [
      {
        priority: "background",
        source: "history_export",
        expectedHostId: "local",
        expectedGeneration: 7,
      },
    ]);
  }),
);
