import { assert, it } from "@effect/vitest";
import type { ThreadItem, ThreadSearchOccurrence, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { make } from "./CodexHistorySearchAdapter";

const occurrence: ThreadSearchOccurrence = {
  turnId: "turn-5",
  itemId: "selected-item",
  snippet: "a selected match",
  snippetMatchRange: { start: 2, end: 10 },
  turnCursor: "turns:anchor",
};

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

const agentItem = (id: string, text = id): ThreadItem => ({
  questions: null,
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
});

const userItem = (id: string, text = id): ThreadItem => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

const capabilitySnapshot = (
  searchOccurrences = true,
  generation = 7,
): CodexAppServerCapabilitySnapshot => ({
  hostId: "remote-a",
  generation,
  userAgent: "Codex Desktop/0.147.0",
  version: "0.147.0",
  nativeAppTools: false,
  flags: {
    turnApprovalsReviewer: false,

    turnToolOutput: false,
    forkLastTurnId: true,
    paginatedFork: true,
    paginatedHistory: true,
    searchOccurrences,
    ephemeralFork: true,
    multiAgentV2Protocol: false,
    sideConversation: true,
    subagentAncestorFilter: false,
    threadRevert: false,
    threadQueue: false,
  },
});

const capabilityService = (input?: {
  readonly searchOccurrences?: boolean;
  readonly generation?: number;
  readonly isCurrent?: () => boolean;
}) => {
  const snapshot = capabilitySnapshot(input?.searchOccurrences ?? true, input?.generation ?? 7);
  return CodexAppServerCapabilities.of({
    forThread: () => Effect.succeed(snapshot),
    forHost: () => Effect.succeed(snapshot),
    isCurrent: () => Effect.sync(() => input?.isCurrent?.() ?? true),
  });
};

const provideAdapter = <A, E>(
  effect: Effect.Effect<A, E, CodexGateway | CodexAppServerCapabilities>,
  gateway: CodexGateway["Service"],
  capabilities = capabilityService(),
) =>
  effect.pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexAppServerCapabilities, capabilities),
  );

it.effect("searches one literal 250-occurrence page and reports a capped result", () =>
  Effect.gen(function* () {
    const requests: Array<{
      readonly method: string;
      readonly params: unknown;
      readonly scheduling: unknown;
    }> = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          requests.push({ method, params, scheduling });
          return { data: [occurrence], nextCursor: "occurrences:next" };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const page = yield* adapter.search({
      threadId: "thread-a",
      searchTerm: "  exact literal  ",
    });

    assert.deepStrictEqual(page, {
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrences: [occurrence],
      isCapped: true,
    });
    assert.deepStrictEqual(requests, [
      {
        method: "thread/searchOccurrences",
        params: {
          threadId: "thread-a",
          searchTerm: "  exact literal  ",
          cursor: null,
          limit: 250,
        },
        scheduling: {
          priority: "interactive",
          source: "thread",
          expectedHostId: "remote-a",
          expectedGeneration: 7,
        },
      },
    ]);
  }),
);

it.effect("follows advancing empty and inclusive pages beyond twenty requests", () =>
  Effect.gen(function* () {
    const itemRequestLimits: number[] = [];
    let cursorSequence = 0;
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn(occurrence.turnId)],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        const itemParams = params as { readonly turnId: string; readonly limit: number };
        itemRequestLimits.push(itemParams.limit);
        cursorSequence += 1;
        return Effect.succeed({
          data:
            cursorSequence % 3 === 0
              ? []
              : [
                  {
                    turnId: itemParams.turnId,
                    item: userItem(occurrence.itemId, "inclusive anchor"),
                  },
                ],
          nextCursor: cursorSequence >= 54 ? null : `items:${cursorSequence}`,
          backwardsCursor: null,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const hydration = yield* adapter.hydrateOccurrence({
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrence,
    });

    assert.isAtLeast(itemRequestLimits.length, 54);
    assert.isTrue(itemRequestLimits.every((limit) => limit === 100));
    assert.deepStrictEqual(
      hydration.turns[0]?.items.map((item) => item.id),
      [occurrence.itemId],
    );
    assert.strictEqual(hydration.selection.status, "found");
  }),
);

it.effect("hydrates a deduped nine-turn island around the inclusive search cursor", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            const direction = (params as { readonly sortDirection: "asc" | "desc" }).sortDirection;
            return direction === "desc"
              ? {
                  data: [5, 4, 3, 2, 1].map((index) => completedTurn(`turn-${index}`)),
                  nextCursor: "turns:older",
                  backwardsCursor: "turns:newer-anchor",
                }
              : {
                  data: [5, 6, 7, 8, 9].map((index) => completedTurn(`turn-${index}`)),
                  nextCursor: "turns:newer",
                  backwardsCursor: "turns:older-anchor",
                };
          }
          const turnId = (params as { readonly turnId: string }).turnId;
          return {
            data: [
              {
                turnId,
                item:
                  turnId === occurrence.turnId
                    ? userItem(occurrence.itemId, "selected")
                    : agentItem(`item:${turnId}`),
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const hydration = yield* adapter.hydrateOccurrence({
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrence,
    });

    assert.deepStrictEqual(
      hydration.turns.map((turn) => turn.id),
      ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9"],
    );
    assert.strictEqual(hydration.selection.status, "found");
    if (hydration.selection.status === "found") {
      assert.strictEqual(hydration.selection.item.id, occurrence.itemId);
    }
    assert.deepStrictEqual(
      hydration.island.entities.map((entity) => entity.key),
      hydration.turns.map((turn) => turn.id),
    );
    assert.deepStrictEqual(hydration.island.olderBoundary, {
      status: "available",
      boundaryId: "search:7:1:older",
      handle: { cursor: "turns:older", oldestLoadedTurnId: "turn-1" },
      progressKey: JSON.stringify(["turns:older", "turn-1"]),
    });
    assert.deepStrictEqual(hydration.island.newerBoundary, {
      status: "available",
      boundaryId: "search:7:1:newer",
      handle: { cursor: "turns:newer", oldestLoadedTurnId: "turn-1" },
      progressKey: JSON.stringify(["turns:newer", "turn-1"]),
    });
  }),
);

it.effect("pages the selected turn until the occurrence item is present", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            return {
              data: [completedTurn(occurrence.turnId)],
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          const itemParams = params as { readonly turnId: string; readonly cursor: string | null };
          return itemParams.cursor === null
            ? {
                data: [{ turnId: itemParams.turnId, item: agentItem("newest-item") }],
                nextCursor: "items:older",
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: itemParams.turnId, item: userItem(occurrence.itemId) }],
                nextCursor: null,
                backwardsCursor: null,
              };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make({ directionItemLimit: 1 }), gateway);

    const hydration = yield* adapter.hydrateOccurrence({
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrence,
    });

    assert.strictEqual(hydration.selection.status, "found");
    assert.deepStrictEqual(
      hydration.turns[0]?.items.map((item) => item.id),
      [occurrence.itemId, "newest-item"],
    );
    assert.deepStrictEqual(hydration.itemsPaginationByTurnId[occurrence.turnId], {
      olderCursor: null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      oldestUserInput: [],
      openingUserMessageId: null,
      itemsView: "full",
    });
  }),
);

it.effect("rejects stale generations and unsupported occurrence search", () =>
  Effect.gen(function* () {
    let gatewayCalls = 0;
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.sync(() => {
          gatewayCalls += 1;
          return { data: [occurrence], nextCursor: null };
        }) as never,
    } as unknown as CodexGateway["Service"]);

    const unsupportedAdapter = yield* provideAdapter(
      make(),
      gateway,
      capabilityService({ searchOccurrences: false }),
    );
    const unsupported = yield* Effect.result(
      unsupportedAdapter.search({ threadId: "thread-a", searchTerm: "match" }),
    );
    assert(Result.isFailure(unsupported));
    assert.strictEqual(unsupported.failure.reason, "unsupported-capability");
    assert.strictEqual(gatewayCalls, 0);

    let fenceChecks = 0;
    const staleAdapter = yield* provideAdapter(
      make(),
      gateway,
      capabilityService({
        isCurrent: () => {
          fenceChecks += 1;
          return fenceChecks === 1;
        },
      }),
    );
    const stale = yield* Effect.result(
      staleAdapter.search({ threadId: "thread-a", searchTerm: "match" }),
    );
    assert(Result.isFailure(stale));
    assert.strictEqual(stale.failure.reason, "stale-generation");
    assert.strictEqual(gatewayCalls, 1);
    assert.strictEqual(fenceChecks, 2);
  }),
);

it.effect(
  "classifies an occurrence from an older host generation as stale before capability checks",
  () =>
    Effect.gen(function* () {
      let gatewayCalls = 0;
      const gateway = CodexGateway.of({
        requestForThread: () =>
          Effect.sync(() => {
            gatewayCalls += 1;
            return { data: [], nextCursor: null };
          }) as never,
      } as unknown as CodexGateway["Service"]);
      const adapter = yield* provideAdapter(
        make(),
        gateway,
        capabilityService({ searchOccurrences: false, generation: 8 }),
      );

      const hydration = yield* Effect.result(
        adapter.hydrateOccurrence({
          threadId: "thread-a",
          hostId: "remote-a",
          generation: 7,
          occurrence,
        }),
      );

      assert(Result.isFailure(hydration));
      assert.strictEqual(hydration.failure.reason, "stale-generation");
      assert.strictEqual(gatewayCalls, 0);
    }),
);

it.effect("keeps a hydrated match when the optional opening-user probe fails", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            return {
              data: [completedTurn(occurrence.turnId)],
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          const itemParams = params as {
            readonly turnId: string;
            readonly sortDirection: "asc" | "desc";
          };
          return itemParams.sortDirection === "desc"
            ? {
                data: [
                  {
                    turnId: itemParams.turnId,
                    item: userItem(occurrence.itemId, "selected"),
                  },
                ],
                nextCursor: "items:older",
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: "turn-foreign", item: userItem("foreign", "foreign") }],
                nextCursor: null,
                backwardsCursor: null,
              };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make({ directionItemLimit: 1 }), gateway);

    const hydration = yield* Effect.result(
      adapter.hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      }),
    );

    assert(Result.isSuccess(hydration));
    assert.strictEqual(hydration.success.selection.status, "found");
    assert.strictEqual(
      hydration.success.itemsPaginationByTurnId[occurrence.turnId]?.openingUserMessageId,
      null,
    );
  }),
);

it.effect("fails closed on foreign items and stalled item cursors", () =>
  Effect.gen(function* () {
    const foreignGateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string) =>
        Effect.succeed(
          method === "thread/turns/list"
            ? {
                data: [completedTurn(occurrence.turnId)],
                nextCursor: null,
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: "turn-other", item: agentItem("foreign") }],
                nextCursor: null,
                backwardsCursor: null,
              },
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const foreignAdapter = yield* provideAdapter(make(), foreignGateway);
    const foreign = yield* Effect.result(
      foreignAdapter.hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      }),
    );
    assert(Result.isFailure(foreign));
    assert.strictEqual(foreign.failure.reason, "foreign-item");

    const stalledGateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "thread/turns/list") {
            return {
              data: [completedTurn(occurrence.turnId)],
              nextCursor: null,
              backwardsCursor: null,
            };
          }
          const itemParams = params as { readonly turnId: string; readonly cursor: string | null };
          return itemParams.cursor === null
            ? {
                data: [{ turnId: itemParams.turnId, item: agentItem("not-selected") }],
                nextCursor: "items:same",
                backwardsCursor: null,
              }
            : {
                data: [{ turnId: itemParams.turnId, item: agentItem("still-not-selected") }],
                nextCursor: "items:same",
                backwardsCursor: null,
              };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const stalledAdapter = yield* provideAdapter(make({ directionItemLimit: 1 }), stalledGateway);
    const stalled = yield* Effect.result(
      stalledAdapter.hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      }),
    );
    assert(Result.isFailure(stalled));
    assert.strictEqual(stalled.failure.reason, "cursor-stalled");
  }),
);

it.effect("finds a distant selected item beyond two thousand items and sixteen MiB", () =>
  Effect.gen(function* () {
    const requests: number[] = [];
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "thread/turns/list")
            return {
              data: [completedTurn(occurrence.turnId)],
              nextCursor: null,
              backwardsCursor: null,
            };
          const input = params as { cursor: string | null; limit: number; sortDirection: string };
          if (input.sortDirection === "asc")
            return { data: [], nextCursor: null, backwardsCursor: null };
          const offset = Number(input.cursor ?? 0);
          requests.push(input.limit);
          const count = Math.min(input.limit, 2_101 - offset);
          return {
            data: Array.from({ length: count }, (_, index) => ({
              turnId: occurrence.turnId,
              item: agentItem(
                offset + index === 2_100 ? occurrence.itemId : `item:${offset + index}`,
                "x".repeat(8_192),
              ),
            })),
            nextCursor: offset + count === 2_101 ? null : String(offset + count),
            backwardsCursor: null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);
    const hydration = yield* adapter.hydrateOccurrence({
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrence,
    });
    assert.strictEqual(hydration.selection.item.id, occurrence.itemId);
    assert.strictEqual(hydration.turns[0]?.items.length, 2_101);
    assert.isAbove(hydration.selection.inspectedBytes, 16 * 1024 * 1024);
    assert.isTrue(requests.every((limit) => limit === 100));
  }),
);
