import { assert, it } from "@effect/vitest";
import type { ThreadItem, ThreadSearchOccurrence, Turn } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CODEX_HISTORY_SEARCH_OCCURRENCE_CURSOR_MAX_LENGTH,
  CODEX_HISTORY_SEARCH_OCCURRENCE_PAGE_MAX_BYTES,
  CODEX_HISTORY_SEARCH_MAX_ITEM_PAGE_REQUESTS_PER_DIRECTION,
  CODEX_HISTORY_SEARCH_TERM_MAX_BYTES,
  make,
} from "./CodexHistorySearchAdapter";

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
  flags: {
    forkLastTurnId: true,
    paginatedHistory: true,
    searchOccurrences,
    ephemeralFork: true,
    multiAgentV2Protocol: false,
    sideConversation: true,
    subagentAncestorFilter: false,
    threadRevert: false,
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

it.effect("rejects a persisted-search response above its exact requested limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: Array.from({ length: 251 }, () => occurrence),
          nextCursor: "occurrences:next",
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const failure = yield* adapter
      .search({ threadId: "thread-a", searchTerm: "match" })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-size-exceeded");
    assert.strictEqual(failure.operation, "search");
  }),
);

it.effect("rejects an oversized query before it reaches the host", () =>
  Effect.gen(function* () {
    let requested = false;
    const gateway = CodexGateway.of({
      requestForThread: () => {
        requested = true;
        return Effect.die("oversized query must not be dispatched");
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const failure = yield* adapter
      .search({
        threadId: "thread-a",
        searchTerm: "x".repeat(CODEX_HISTORY_SEARCH_TERM_MAX_BYTES),
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "invalid-search-term");
    assert.isFalse(requested);
  }),
);

it.effect("rejects a count-valid occurrence index above its byte budget", () =>
  Effect.gen(function* () {
    const snippet = "x".repeat(Math.ceil(CODEX_HISTORY_SEARCH_OCCURRENCE_PAGE_MAX_BYTES / 200));
    const gateway = CodexGateway.of({
      requestForThread: () =>
        Effect.succeed({
          data: Array.from({ length: 250 }, (_, index) => ({
            ...occurrence,
            itemId: `item-${index}`,
            snippet,
            snippetMatchRange: { start: 0, end: 1 },
          })),
          nextCursor: null,
        }) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const failure = yield* adapter
      .search({ threadId: "thread-a", searchTerm: "match" })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-byte-limit");
  }),
);

it.effect("rejects a forged giant occurrence cursor before hydration RPC", () =>
  Effect.gen(function* () {
    let requested = false;
    const gateway = CodexGateway.of({
      requestForThread: () => {
        requested = true;
        return Effect.die("forged cursor must not be dispatched");
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const failure = yield* adapter
      .hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence: {
          ...occurrence,
          turnCursor: "x".repeat(CODEX_HISTORY_SEARCH_OCCURRENCE_CURSOR_MAX_LENGTH + 1),
        },
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "invalid-occurrence");
    assert.isFalse(requested);
  }),
);

it.effect("rejects a search Turn-radius response above its exact requested limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string) =>
        Effect.succeed(
          method === "thread/turns/list"
            ? {
                data: Array.from({ length: 6 }, (_, index) => completedTurn(`turn-${index}`)),
                nextCursor: null,
                backwardsCursor: null,
              }
            : { data: [], nextCursor: null, backwardsCursor: null },
        ) as never,
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make(), gateway);

    const failure = yield* adapter
      .hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-size-exceeded");
    assert.strictEqual(failure.operation, "turns");
  }),
);

it.effect("rejects a search item response above its exact requested limit", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn(occurrence.turnId)],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        const itemParams = params as { readonly turnId: string };
        return Effect.succeed({
          data: [
            { turnId: itemParams.turnId, item: agentItem("first") },
            { turnId: itemParams.turnId, item: agentItem("second") },
          ],
          nextCursor: null,
          backwardsCursor: null,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make({ directionItemLimit: 1 }), gateway);

    const failure = yield* adapter
      .hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "page-size-exceeded");
    assert.strictEqual(failure.operation, "items");
  }),
);

it.effect("caps fresh-cursor inclusive duplicate chains in both hydration directions", () =>
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
          data: [
            {
              turnId: itemParams.turnId,
              item: userItem(occurrence.itemId, "inclusive anchor"),
            },
          ],
          nextCursor: `items:${cursorSequence}`,
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

    assert.strictEqual(
      itemRequestLimits.filter((limit) => limit === 100).length,
      CODEX_HISTORY_SEARCH_MAX_ITEM_PAGE_REQUESTS_PER_DIRECTION * 2 - 2,
    );
    assert.strictEqual(itemRequestLimits.filter((limit) => limit === 1).length, 2);
    assert.deepStrictEqual(
      hydration.turns[0]?.items.map((item) => item.id),
      [occurrence.itemId],
    );
    assert.strictEqual(hydration.selection.status, "found");
  }),
);

it.effect("fails closed when an oversized search anchor has no retryable item cursor", () =>
  Effect.gen(function* () {
    const gateway = CodexGateway.of({
      requestForThread: (_threadId: string, method: string, params: unknown) => {
        if (method === "thread/turns/list") {
          return Effect.succeed({
            data: [completedTurn(occurrence.turnId)],
            nextCursor: null,
            backwardsCursor: null,
          }) as never;
        }
        const turnId = (params as { readonly turnId: string }).turnId;
        return Effect.succeed({
          data: [{ turnId, item: agentItem("oversized", "x".repeat(256)) }],
          nextCursor: "items:older",
          backwardsCursor: null,
        }) as never;
      },
    } as unknown as CodexGateway["Service"]);
    const adapter = yield* provideAdapter(make({ directionByteLimit: 1 }), gateway);

    const failure = yield* adapter
      .hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      })
      .pipe(Effect.flip);

    assert.strictEqual(failure.reason, "item-byte-limit");
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
      oldestUserInput: null,
      openingUserMessageId: null,
      itemsView: "full",
    });
  }),
);

it.effect("returns a count-bounded outcome and fails closed without a byte retry cursor", () =>
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
          return {
            data: [{ turnId: itemParams.turnId, item: agentItem("not-selected", "x".repeat(64)) }],
            nextCursor: "items:older",
            backwardsCursor: null,
          };
        }) as never,
    } as unknown as CodexGateway["Service"]);

    const countAdapter = yield* provideAdapter(
      make({ directionItemLimit: 1, selectedItemLimit: 1 }),
      gateway,
    );
    const countResult = yield* countAdapter.hydrateOccurrence({
      threadId: "thread-a",
      hostId: "remote-a",
      generation: 7,
      occurrence,
    });
    assert.deepStrictEqual(countResult.selection, {
      status: "bounded-incomplete",
      reason: "item-count-limit",
      inspectedItemCount: 1,
      inspectedBytes: countResult.selection.inspectedBytes,
      nextCursor: "items:older",
    });

    const byteAdapter = yield* provideAdapter(
      make({ directionByteLimit: 1, selectedByteLimit: 8 }),
      gateway,
    );
    const byteFailure = yield* byteAdapter
      .hydrateOccurrence({
        threadId: "thread-a",
        hostId: "remote-a",
        generation: 7,
        occurrence,
      })
      .pipe(Effect.flip);
    assert.strictEqual(byteFailure.reason, "item-byte-limit");
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

it.effect("fails closed when the bounded opening-user probe returns a foreign item", () =>
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

    assert(Result.isFailure(hydration));
    assert.strictEqual(hydration.failure.reason, "foreign-item");
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
