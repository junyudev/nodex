import { assert, it } from "@effect/vitest";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import { createCodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  CodexHistorySearchAdapter,
  CodexHistorySearchAdapterError,
} from "./CodexHistorySearchAdapter";
import { CodexThreadHistoryFeatures } from "./CodexThreadHistoryFeatures";
import { make as makePersistedHistorySearchRuntime } from "./CodexPersistedHistorySearchRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
const runtimeThreadId = "search-thread";
const makeFixture = () => {
  const registry = makeConversationEntityStateRegistry();
  const canonical = createCodexCanonicalConversationState(
    {
      id: runtimeThreadId,
      historyMode: "paginated",
      turns: [],
    } as unknown as Thread,
    { hostId: "host-search", turnParamsById: {} },
  );
  const install = () => {
    const entity = registry.acquire(runtimeThreadId);
    entity.installFollowerCanonicalState(canonical);
    return entity;
  };
  install();
  const conversations = ConversationEntityMap.of({
    subscribeRetired: registry.subscribeRetired,
    registerThreadMetadata: registry.registerThreadMetadata,
    readThreadMetadata: registry.readThreadMetadata,
    entity: registry.acquire,
    current: registry.current,
    forHost: registry.forHost,
    subscribeCanonicalMutations: registry.subscribeCanonicalMutations,
    runCommand: (_threadId, operation) => operation,
    markAllNeedsResume: registry.markAllNeedsResume,
    retire: () => Effect.void,
  });
  return { registry, conversations, install };
};
const { conversations } = makeFixture();
const availableHistoryFeatures = CodexThreadHistoryFeatures.of({
  resolve: (threadId, feature) =>
    Effect.succeed({
      status: "available",
      feature,
      threadId,
      historyMode: "paginated",
      capability: {
        hostId: "host-search",
        generation: 4,
        userAgent: "Codex Desktop/test",
        version: "test",
        nativeAppTools: false,
        flags: {
          turnApprovalsReviewer: false,

          turnToolOutput: false,
          forkLastTurnId: true,
          paginatedFork: true,
          paginatedHistory: true,
          searchOccurrences: true,
          ephemeralFork: true,
          multiAgentV2Protocol: false,
          sideConversation: true,
          subagentAncestorFilter: false,
          threadRevert: true,
          threadQueue: true,
        },
      },
    }),
});

const makeRuntime = (input: {
  readonly conversations: ConversationEntityMap["Service"];
  readonly searchAdapter: CodexHistorySearchAdapter["Service"];
  readonly historyFeatures?: CodexThreadHistoryFeatures["Service"];
}) =>
  makePersistedHistorySearchRuntime.pipe(
    Effect.provideService(ConversationEntityMap, input.conversations),
    Effect.provideService(CodexHistorySearchAdapter, input.searchAdapter),
    Effect.provideService(
      CodexThreadHistoryFeatures,
      input.historyFeatures ?? availableHistoryFeatures,
    ),
  );

it.effect("returns persisted-search unavailability without calling the physical adapter", () =>
  Effect.gen(function* () {
    const installed = { conversations };
    let physicalSearches = 0;
    const unavailable = {
      status: "unavailable",
      feature: "persisted-search",
      reason: "capability-unproven",
      threadId: runtimeThreadId,
      hostId: "host-search",
      hostGeneration: 4,
      sourceEpoch: "epoch-search",
      appServerVersion: "0.0.0",
      historyMode: "paginated",
    } as const;
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () =>
          Effect.sync(() => {
            physicalSearches += 1;
            return {} as never;
          }),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
      historyFeatures: CodexThreadHistoryFeatures.of({
        resolve: () => Effect.succeed(unavailable),
      }),
    });

    const result = yield* runtime.search(runtimeThreadId, "needle");

    assert.deepStrictEqual(result, unavailable);
    assert.strictEqual(physicalSearches, 0);
  }),
);

it.effect(
  "treats a renderer-owned resident conversation as normal persisted-search unavailability",
  () =>
    Effect.gen(function* () {
      const f = makeFixture();
      const current = f.registry.current(runtimeThreadId);
      if (!current) throw new Error("Expected fixture conversation");
      f.registry.releaseGeneration(runtimeThreadId, current.generation);
      let featureReads = 0;
      let physicalSearches = 0;
      const runtime = yield* makeRuntime({
        conversations: f.conversations,
        searchAdapter: CodexHistorySearchAdapter.of({
          search: () =>
            Effect.sync(() => {
              physicalSearches += 1;
              return {} as never;
            }),
          hydrateOccurrence: () => Effect.die("unused"),
        }),
        historyFeatures: CodexThreadHistoryFeatures.of({
          resolve: () =>
            Effect.sync(() => {
              featureReads += 1;
              return {} as never;
            }),
        }),
      });

      const result = yield* runtime.search(runtimeThreadId, "needle");

      assert.deepStrictEqual(result, {
        status: "unavailable",
        feature: "persisted-search",
        reason: "resident-only",
        threadId: runtimeThreadId,
      });
      assert.strictEqual(featureReads, 0);
      assert.strictEqual(physicalSearches, 0);
    }),
);

it.effect("preserves physical search failures instead of disguising them as unavailability", () =>
  Effect.gen(function* () {
    const installed = { conversations };
    const runtime = yield* makeRuntime({
      conversations: installed.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () =>
          Effect.fail(
            new CodexHistorySearchAdapterError({
              operation: "search",
              threadId: runtimeThreadId,
              turnId: null,
              reason: "request-failed",
              cause: new Error("transport closed"),
            }),
          ),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
    });

    const failure = yield* runtime.search(runtimeThreadId, "needle").pipe(Effect.flip);

    assert.strictEqual(failure.reason, "request-failed");
    assert.strictEqual(failure.operation, "search");
  }),
);

const searchPage = {
  threadId: runtimeThreadId,
  hostId: "host-search",
  generation: 4,
  occurrences: [],
  isCapped: false,
};

it.effect("returns persisted search results from a canonical-only conversation", () =>
  Effect.gen(function* () {
    const f = makeFixture();
    const runtime = yield* makeRuntime({
      conversations: f.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () => Effect.succeed(searchPage),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
    });
    const result = yield* runtime.search(runtimeThreadId, "needle");
    assert.strictEqual(result.status, "completed");
    if (result.status !== "completed") return;
    assert.strictEqual(result.page.query, "needle");
    assert.strictEqual(result.page.hostGeneration, 4);
    assert.isNull(f.registry.current(runtimeThreadId)?.readSnapshot());
  }),
);

it.effect.each(["availability", "search"] as const)(
  "does not attach persisted results to a replacement conversation during %s",
  (stage) =>
    Effect.gen(function* () {
      const f = makeFixture();
      let searches = 0;
      const replace = () => {
        const entity = f.registry.current(runtimeThreadId)!;
        f.registry.releaseGeneration(runtimeThreadId, entity.generation);
        f.install();
      };
      const runtime = yield* makeRuntime({
        conversations: f.conversations,
        historyFeatures: CodexThreadHistoryFeatures.of({
          resolve: (id, feature) =>
            Effect.sync(() => {
              if (stage === "availability") replace();
            }).pipe(Effect.andThen(availableHistoryFeatures.resolve(id, feature))),
        }),
        searchAdapter: CodexHistorySearchAdapter.of({
          search: () =>
            Effect.sync(() => {
              searches += 1;
              if (stage === "search") replace();
              return searchPage;
            }),
          hydrateOccurrence: () => Effect.die("unused"),
        }),
      });
      const failure = yield* runtime.search(runtimeThreadId, "needle").pipe(Effect.flip);
      assert.strictEqual(failure.reason, "superseded");
      assert.strictEqual(searches, stage === "availability" ? 0 : 1);
      assert.isNull(f.registry.current(runtimeThreadId)?.readSnapshot());
    }),
);

it.effect("rejects a search page from a later native generation", () =>
  Effect.gen(function* () {
    const f = makeFixture();
    const runtime = yield* makeRuntime({
      conversations: f.conversations,
      searchAdapter: CodexHistorySearchAdapter.of({
        search: () => Effect.succeed({ ...searchPage, generation: 5 }),
        hydrateOccurrence: () => Effect.die("unused"),
      }),
    });
    const failure = yield* runtime.search(runtimeThreadId, "needle").pipe(Effect.flip);
    assert.strictEqual(failure.reason, "stale-generation");
  }),
);
