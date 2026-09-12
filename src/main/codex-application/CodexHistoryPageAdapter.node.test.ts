import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { assert, it } from "@effect/vitest";
import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CODEX_HISTORY_ITEM_PAGE_SIZE,
  CODEX_HISTORY_INITIAL_BYTE_BUDGET,
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
  questions: null,
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

it.effect(
  "durable history drains ascending items beyond a shared budget and shrinks oversized requests",
  () =>
    Effect.gen(function* () {
      const requests: Array<{
        turnId?: string;
        cursor?: string | null;
        limit?: number;
        sortDirection?: string;
      }> = [];
      const capability = createCodexAppServerCapabilitySnapshot({
        hostId: "durable",
        generation: 4,
        userAgent: "codex-cli/0.148.0",
      });
      const items = Array.from({ length: 501 }, (_, index) => agentItem(`item-${index}`));
      let oversized = true;
      const gateway = CodexGateway.of({
        requestForThread: (
          _threadId: string,
          method: string,
          params: {
            turnId?: string;
            cursor?: string | null;
            limit?: number;
            sortDirection?: string;
          },
          options: {
            timeoutMs?: number;
            priority?: string;
            expectedHostId?: string;
            expectedGeneration?: number;
          },
        ) =>
          Effect.gen(function* () {
            requests.push(params);
            assert.strictEqual(options.timeoutMs, 30_000);
            assert.strictEqual(options.priority, "critical");
            assert.strictEqual(options.expectedHostId, "durable");
            assert.strictEqual(options.expectedGeneration, 4);
            if (method === "thread/turns/list")
              return {
                data: [completedTurn("newer"), completedTurn("older")],
                nextCursor: "turns:older",
                backwardsCursor: null,
              };
            assert.strictEqual(params.sortDirection, "asc");
            if (params.turnId === "older")
              return {
                data: [{ turnId: "older", item: agentItem("older-item") }],
                nextCursor: null,
                backwardsCursor: null,
              };
            if (oversized) {
              oversized = false;
              return yield* Effect.fail(
                codexRuntimeError({
                  operation: "items",
                  reason: "request",
                  retryable: false,
                  cause: new Error("decoded message length too large"),
                }),
              );
            }
            const offset = params.cursor === null ? 0 : Number(params.cursor);
            const data = items.slice(offset, offset + params.limit!);
            const next = offset + data.length;
            return {
              data: data.map((item) => ({ turnId: "newer", item })),
              nextCursor: next < items.length ? String(next) : null,
              backwardsCursor: null,
            };
          }),
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const result = yield* adapter.loadTurnPage({
        capability,
        threadId: "thread",
        cursor: null,
        initialItemsCursor: "ignored-for-durable",
        itemBudget: 1,
        requestOptions: { priority: "critical", source: "thread_hydration" },
      });
      assert.deepEqual(
        requests
          .filter((request) => request.turnId === "newer")
          .map((request) => [request.cursor, request.limit]),
        [
          [null, 500],
          [null, 250],
          ["250", 250],
          ["500", 250],
        ],
      );
      assert.deepEqual(
        result.turns.map((turn) => [turn.id, turn.itemsView, turn.items.length]),
        [
          ["older", "full", 1],
          ["newer", "full", 501],
        ],
      );
      assert.deepEqual(result.turns[1]!.items, items);
      assert.strictEqual(result.loadedItemCount, 502);
      assert.strictEqual(result.nextCursor, "turns:older");
      assert.deepEqual(result.itemsPaginationByTurnId, {});
    }),
);

it.effect.each(["repeat", "other-error", "minimum-limit"] as const)(
  "durable item history terminates on %s",
  (mode) =>
    Effect.gen(function* () {
      const capability = createCodexAppServerCapabilitySnapshot({
        hostId: "durable",
        generation: 4,
        userAgent: "codex-cli/0.148.0",
      });
      const requests: Array<{ cursor: string | null; limit: number }> = [];
      const gateway = CodexGateway.of({
        requestForThread: (
          _threadId: string,
          method: string,
          params: { cursor: string | null; limit: number },
          options: { timeoutMs?: number },
        ) =>
          Effect.gen(function* () {
            assert.strictEqual(options.timeoutMs, 45_000);
            if (method === "thread/turns/list")
              return { data: [completedTurn("turn")], nextCursor: null, backwardsCursor: null };
            requests.push(params);
            if (mode !== "repeat")
              return yield* Effect.fail(
                codexRuntimeError({
                  operation: "items",
                  reason: "request",
                  retryable: false,
                  cause: new Error(
                    mode === "minimum-limit"
                      ? "decoded message length too large"
                      : "unrelated failure",
                  ),
                }),
              );
            return { data: [], nextCursor: "repeated", backwardsCursor: null };
          }),
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const result = yield* adapter
        .loadTurnPage({
          capability,
          threadId: "thread",
          cursor: null,
          initialItemsCursor: null,
          requestOptions: { timeoutMs: 45_000 },
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (!Result.isFailure(result)) return;
      assert.strictEqual(
        result.failure.reason,
        mode === "repeat" ? "cursor-stalled" : "request-failed",
      );
      assert.deepEqual(
        requests.map((request) => request.limit),
        mode === "minimum-limit"
          ? [500, 250, 125, 62, 31, 15, 7, 3, 1]
          : mode === "repeat"
            ? [500, 500]
            : [500],
      );
    }),
);

it.effect.each(["complete", "cancel"] as const)(
  "durable history keeps five strided workers within page lifetime: %s",
  (outcome) =>
    Effect.gen(function* () {
      const capability = createCodexAppServerCapabilitySnapshot({
        hostId: "durable",
        generation: 4,
        userAgent: "codex-cli/0.148.0",
      });
      const started = yield* Effect.forEach(Array.from({ length: 7 }), () => Deferred.make<void>());
      const finish = yield* Effect.forEach(Array.from({ length: 7 }), () => Deferred.make<void>());
      const requests: number[] = [];
      const released: number[] = [];
      let active = 0;
      let peak = 0;
      const gateway = CodexGateway.of({
        requestForThread: (_threadId: string, method: string, params: { turnId: string }) =>
          Effect.gen(function* () {
            if (method === "thread/turns/list")
              return {
                data: Array.from({ length: 7 }, (_, index) => completedTurn(String(index))),
                nextCursor: null,
                backwardsCursor: null,
              };
            const index = Number(params.turnId);
            requests.push(index);
            active += 1;
            peak = Math.max(peak, active);
            yield* Deferred.succeed(started[index]!, undefined);
            yield* Deferred.await(finish[index]!).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active -= 1;
                  released.push(index);
                }),
              ),
            );
            return {
              data: [{ turnId: params.turnId, item: agentItem(`item-${index}`) }],
              nextCursor: null,
              backwardsCursor: null,
            };
          }),
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const pending = yield* adapter
        .loadTurnPage({
          capability,
          threadId: "thread",
          cursor: null,
          initialItemsCursor: null,
          limit: 7,
        })
        .pipe(Effect.forkChild);
      yield* Effect.forEach(started.slice(0, 5), (gate) => Deferred.await(gate));
      assert.deepEqual(requests, [0, 1, 2, 3, 4]);
      yield* Deferred.succeed(finish[1]!, undefined);
      yield* Deferred.await(started[6]!);
      assert.deepEqual(requests, [0, 1, 2, 3, 4, 6]);
      assert.isFalse(yield* Deferred.isDone(started[5]!));
      if (outcome === "cancel") {
        yield* Fiber.interrupt(pending);
        assert.strictEqual(active, 0);
        assert.deepEqual(
          released.slice().sort((left, right) => left - right),
          [0, 1, 2, 3, 4, 6],
        );
        assert.isFalse(yield* Deferred.isDone(started[5]!));
        return;
      }
      yield* Deferred.succeed(finish[0]!, undefined);
      yield* Deferred.await(started[5]!);
      yield* Effect.forEach(finish, (gate) => Deferred.succeed(gate, undefined));
      const page = yield* Fiber.join(pending);
      assert.strictEqual(active, 0);
      assert.strictEqual(peak, 5);
      assert.deepEqual(
        page.turns.map((turn) => turn.id),
        ["6", "5", "4", "3", "2", "1", "0"],
      );
    }),
);

it.effect.each([undefined, "critical", "interactive"] as const)(
  "hydrates a five-turn skeleton page with shared budget and caller priority %s",
  (priority) =>
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
              return {
                data: [
                  { turnId: "turn-1", item: { type: "contextCompaction", id: "compact-1" } },
                  { turnId: "turn-1", item: userItem("user-1", "one") },
                ],
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
        ...(priority === undefined
          ? {}
          : { requestOptions: { priority, source: "thread_hydration" } }),
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
        Array(5).fill({
          priority: priority ?? "interactive",
          source: "thread_hydration",
          expectedHostId: "local",
          expectedGeneration: 7,
        }),
      );
      assert.deepStrictEqual(page.itemsPaginationByTurnId["turn-1"], {
        newestSnapshotItemId: "assistant-1",
        olderCursor: "items:older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        oldestUserInput: [{ type: "text", text: "one", text_elements: [] }],
        openingUserMessageId: "user-1",
        openingUserMessageClientId: null,
        itemsView: "summary",
      });
      assert.deepStrictEqual(page.itemSegmentsByTurnId, {
        "turn-1": [
          {
            itemIds: ["assistant-1"],
            approximateBytes: estimateCodexHistoryProjectedItemPageBytes([
              agentItem("assistant-1"),
            ]),
            olderCursor: "items:older",
            newerCursor: null,
          },
        ],
        "turn-2": [
          {
            itemIds: ["user-2"],
            approximateBytes: estimateCodexHistoryProjectedItemPageBytes([
              userItem("user-2", "two"),
            ]),
            olderCursor: null,
            newerCursor: "turn-2:newer",
          },
          {
            itemIds: ["assistant-2"],
            approximateBytes: estimateCodexHistoryProjectedItemPageBytes([
              agentItem("assistant-2"),
            ]),
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
              limit: 3,
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
              limit: 2,
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

    assert.deepStrictEqual(itemLimits, [2, 1, 1]);
    assert.deepStrictEqual(
      page.turns[0]?.items.map((item) => item.id),
      ["older", "newer"],
    );
    assert.strictEqual(page.loadedItemCount, 2);
    assert.isTrue(page.itemsPaginationByTurnId["turn-1"]?.hasLoadedOldest);
  }),
);

it.effect(
  "continues through advancing duplicate-only and empty pages until unique history arrives",
  () =>
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
            data:
              itemRequests === 25
                ? [{ turnId: "turn-1", item: agentItem("older") }]
                : itemRequests % 2 === 0
                  ? []
                  : [{ turnId: "turn-1", item: agentItem("inclusive-anchor") }],
            nextCursor: itemRequests === 25 ? null : `items:${itemRequests}`,
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

      assert.strictEqual(itemRequests, 25);
      assert.strictEqual(page.loadedItemCount, 2);
      assert.deepStrictEqual(
        page.turns[0]?.items.map((item) => item.id),
        ["older", "inclusive-anchor"],
      );
      assert.strictEqual(page.itemsPaginationByTurnId["turn-1"]?.olderCursor, null);
    }),
);

it.effect(
  "hydrates complete large Unicode tool output without rejecting or skipping physical items",
  () =>
    Effect.gen(function* () {
      const large = { ...agentItem("large"), text: "运行🙂".repeat(1_000_000) } as ThreadItem;
      const batch = [
        large,
        ...Array.from({ length: 99 }, (_, index) => agentItem(`item-${index}`)),
      ];
      const requests: Array<{ cursor: string | null; limit: number }> = [];
      const gateway = CodexGateway.of({
        requestForThread: (_threadId: string, method: string, params: unknown) => {
          if (method === "thread/turns/list")
            return Effect.succeed({
              data: [completedTurn("turn-1")],
              nextCursor: null,
              backwardsCursor: null,
            }) as never;
          const request = params as { cursor: string | null; limit: number };
          requests.push(request);
          return Effect.succeed({
            data: (request.cursor === null ? batch : [agentItem("oldest")]).map((item) => ({
              turnId: "turn-1",
              item,
            })),
            nextCursor: request.cursor === null ? "exact:older" : null,
            backwardsCursor: request.cursor === null ? null : "exact:newer",
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
      assert.deepEqual(
        requests.map(({ cursor, limit }) => ({ cursor, limit })),
        [
          { cursor: null, limit: 100 },
          { cursor: "exact:older", limit: 100 },
        ],
      );
      assert.strictEqual(page.loadedItemCount, 101);
      assert.strictEqual(
        page.turns[0]?.items.find((item) => item.id === "large"),
        large,
      );
      assert.isTrue(page.itemsPaginationByTurnId["turn-1"]?.hasLoadedOldest);
      const older = yield* adapter.loadTurnItemsPage({
        capability: CAPABILITY,
        threadId: "thread-a",
        turnId: "turn-1",
        cursor: null,
      });
      assert.strictEqual(older.items.length, 100);
      assert.strictEqual(older.nextCursor, "exact:older");
      assert.isAbove(older.approximateBytes, CODEX_HISTORY_INITIAL_BYTE_BUDGET);
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

it.effect.each(["failed", "pending", "empty-completed", "non-user", "user"] as const)(
  "preserves opening-message knowledge for %s history",
  (mode) =>
    Effect.gen(function* () {
      const gateway = CodexGateway.of({
        requestForThread: (
          _threadId: string,
          method: string,
          params: { sortDirection?: string },
        ) => {
          if (method === "thread/turns/list")
            return Effect.succeed({
              data: [
                {
                  ...completedTurn("turn"),
                  status: mode === "pending" ? "inProgress" : "completed",
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            });
          if (params.sortDirection !== "asc")
            return Effect.succeed({
              data: [{ turnId: "turn", item: agentItem("latest") }],
              nextCursor: "older",
              backwardsCursor: null,
            });
          if (mode === "failed")
            return Effect.fail(
              codexRuntimeError({ operation: "read", reason: "request", retryable: false }),
            );
          const item =
            mode === "user"
              ? { ...userItem("opening", "prompt"), clientId: "client-opening" }
              : mode === "non-user"
                ? agentItem("earliest-assistant")
                : null;
          return Effect.succeed({
            data: item ? [{ turnId: "turn", item }] : [],
            nextCursor: null,
            backwardsCursor: null,
          });
        },
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const page = yield* adapter.loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread",
        cursor: null,
        initialItemsCursor: null,
        limit: 1,
        itemBudget: 1,
      });
      const metadata = page.itemsPaginationByTurnId.turn!;
      if (mode === "failed" || mode === "pending") {
        assert.isUndefined(metadata.openingUserMessageId);
        assert.isUndefined(metadata.oldestUserInput);
        assert.isUndefined(metadata.openingUserMessageClientId);
        return;
      }
      assert.strictEqual(metadata.openingUserMessageId, mode === "user" ? "opening" : null);
      assert.strictEqual(
        metadata.openingUserMessageClientId,
        mode === "user" ? "client-opening" : null,
      );
      assert.deepEqual(
        metadata.oldestUserInput,
        mode === "user" ? [{ type: "text", text: "prompt", text_elements: [] }] : [],
      );
    }),
);

it.effect.each(["known-user", "known-empty", "unknown-failed"] as const)(
  "reuses resident opening metadata for %s after receiving the Turn page",
  (mode) =>
    Effect.gen(function* () {
      const events: string[] = [];
      const gateway = CodexGateway.of({
        requestForThread: (_threadId: string, method: string, params: { sortDirection?: string }) =>
          Effect.gen(function* () {
            if (method === "thread/turns/list") {
              events.push("turns");
              return {
                data: [completedTurn("turn")],
                nextCursor: null,
                backwardsCursor: null,
              };
            }
            events.push(params.sortDirection ?? "missing-direction");
            if (params.sortDirection === "asc")
              return yield* Effect.fail(
                codexRuntimeError({ operation: "read", reason: "request", retryable: false }),
              );
            return {
              data: [{ turnId: "turn", item: agentItem("latest") }],
              nextCursor: "older",
              backwardsCursor: null,
            };
          }),
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const input =
        mode === "known-empty"
          ? []
          : [{ type: "text" as const, text: "resident prompt", text_elements: [] }];
      const page = yield* adapter.loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread",
        cursor: null,
        initialItemsCursor: null,
        limit: 1,
        itemBudget: 1,
        readResidentHistory: () => {
          events.push("resident");
          return {
            canonicalState: null,
            turnItemsPaginationById: {
              turn: {
                olderCursor: "resident-older",
                isLoadingOlder: false,
                hasLoadedOldest: false,
                itemsView: "summary",
                oldestUserInput: input,
                openingUserMessageId:
                  mode === "known-user" ? "opening" : mode === "known-empty" ? null : undefined,
                openingUserMessageClientId: mode === "known-empty" ? null : "opening-client",
              },
            },
          };
        },
      });
      assert.deepEqual(
        events,
        mode === "unknown-failed"
          ? ["turns", "resident", "desc", "asc"]
          : ["turns", "resident", "desc"],
      );
      const pagination = page.itemsPaginationByTurnId.turn!;
      assert.strictEqual(pagination.oldestUserInput, input);
      assert.strictEqual(
        pagination.openingUserMessageId,
        mode === "known-user" ? "opening" : mode === "known-empty" ? null : undefined,
      );
      assert.strictEqual(
        pagination.openingUserMessageClientId,
        mode === "known-empty" ? null : "opening-client",
      );
    }),
);

it.effect.each(["resolve", "cancel"] as const)(
  "owns the pending opening probe until page %s",
  (completion) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const gateway = CodexGateway.of({
        requestForThread: (_threadId: string, method: string, params: { sortDirection?: string }) =>
          Effect.gen(function* () {
            if (method === "thread/turns/list")
              return { data: [completedTurn("turn")], nextCursor: null, backwardsCursor: null };
            if (params.sortDirection !== "asc")
              return {
                data: [{ turnId: "turn", item: agentItem("tail") }],
                nextCursor: "older",
                backwardsCursor: null,
              };
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish).pipe(
              Effect.ensuring(Deferred.succeed(released, undefined)),
            );
            return {
              data: [{ turnId: "turn", item: userItem("opening", "prompt") }],
              nextCursor: null,
              backwardsCursor: null,
            };
          }),
      } as never);
      const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
      const pageFiber = yield* adapter
        .loadTurnPage({
          capability: CAPABILITY,
          threadId: "thread",
          cursor: null,
          initialItemsCursor: null,
          itemBudget: 1,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (completion === "cancel") {
        yield* Fiber.interrupt(pageFiber);
        assert.isTrue(yield* Deferred.isDone(released));
        return;
      }
      assert.isFalse(yield* Deferred.isDone(released));
      yield* Deferred.succeed(finish, undefined);
      const page = yield* Fiber.join(pageFiber);
      assert.strictEqual(page.itemsPaginationByTurnId.turn?.openingUserMessageId, "opening");
      assert.isTrue(yield* Deferred.isDone(released));
    }),
);

it.effect("starts later Turn reads while earlier opening probes are pending", () =>
  Effect.gen(function* () {
    const bothStarted = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const events: string[] = [];
    let probeCount = 0;
    const gateway = CodexGateway.of({
      requestForThread: (
        _threadId: string,
        method: string,
        params: { turnId: string; sortDirection: string; limit: number },
      ) =>
        Effect.gen(function* () {
          if (method === "thread/turns/list")
            return {
              data: [completedTurn("newer"), completedTurn("older")],
              nextCursor: null,
              backwardsCursor: null,
            };
          events.push(`${params.turnId}:${params.sortDirection}`);
          if (params.sortDirection === "asc") {
            probeCount += 1;
            if (probeCount === 2) yield* Deferred.succeed(bothStarted, undefined);
            yield* Deferred.await(finish);
            return {
              data: [
                { turnId: params.turnId, item: userItem(`opening:${params.turnId}`, "prompt") },
              ],
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          assert.strictEqual(params.limit, 1);
          return {
            data: [{ turnId: params.turnId, item: agentItem(`tail:${params.turnId}`) }],
            nextCursor: `cursor:${params.turnId}`,
            backwardsCursor: null,
          };
        }),
    } as never);
    const adapter = yield* make.pipe(Effect.provideService(CodexGateway, gateway));
    const pending = yield* adapter
      .loadTurnPage({
        capability: CAPABILITY,
        threadId: "thread",
        cursor: null,
        initialItemsCursor: null,
        itemBudget: 2,
        turnItemLimit: 1,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(bothStarted);
    assert.deepEqual(events, ["newer:desc", "newer:asc", "older:desc", "older:asc"]);
    yield* Deferred.succeed(finish, undefined);
    const page = yield* Fiber.join(pending);
    assert.deepEqual(
      page.turns.map((turn) => turn.id),
      ["older", "newer"],
    );
    assert.strictEqual(page.itemsPaginationByTurnId.newer?.openingUserMessageId, "opening:newer");
    assert.strictEqual(page.itemsPaginationByTurnId.older?.openingUserMessageId, "opening:older");
  }),
);
