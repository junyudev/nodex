import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { flattenCodexHistoryTopology } from "../../shared/codex-conversation-state/codex-history-topology";
import { createCodexConversationHistoryTurnItemsRef } from "../../shared/codex-conversation-history-page";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { make } from "./CodexConversationHistoryRuntime";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.150.0",
});

const capabilities = CodexAppServerCapabilities.of({
  forHost: () => Effect.die("unused"),
  forThread: () => Effect.succeed(capabilitySnapshot),
  isCurrent: () => Effect.succeed(true),
});

const historyTurn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const historyThread = (turns: Turn[]): Thread => ({
  id: "thread-history",
  extra: null,
  sessionId: "session-history",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns,
});

it.effect("deduplicates one exact boundary request onto one physical page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const currentTurn = historyTurn("turn-current");
      const olderTurn = historyTurn("turn-older");
      const hydration: Parameters<typeof createCodexCanonicalHydratedConversationState>[1] = {
        model: "gpt-test",
        reasoningEffort: "high",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
      };
      const canonical = createCodexCanonicalHydratedConversationState(
        historyThread([currentTurn]),
        hydration,
      );
      const aggregates = makeConversationEntityStateRegistry();
      const aggregate = aggregates.acquire("thread-history");
      aggregate.acceptCanonicalState(canonical);
      const pagination = {
        olderCursor: "cursor-older",
        backwardsCursor: null,
        oldestLoadedTurnId: "turn-current",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 1,
        itemsView: "full" as const,
      };
      aggregate.installSnapshot({
        threadId: "thread-history",
        canonicalState: canonical,
        turns: [
          {
            threadId: "thread-history",
            turnId: "turn-current",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
        turnPagination: pagination,
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 0,
          projectionRevision: 0,
          entries: [],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
      } as unknown as CodexConversationSnapshot);
      aggregate.initializeHistory(pagination, 1);
      const conversations = ConversationEntityMap.of({
        entity: aggregates.acquire,
        current: aggregates.current,
        runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
      } as unknown as ConversationEntityMap["Service"]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let requests = 0;
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: () => {
          requests += 1;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              turns: [olderTurn],
              nextCursor: null,
              backwardsCursor: null,
              itemsPaginationByTurnId: {
                [olderTurn.id]: {
                  olderCursor: null,
                  isLoadingOlder: false,
                  hasLoadedOldest: true,
                  oldestUserInput: null,
                  openingUserMessageId: null,
                  itemsView: "full" as const,
                },
              },
              itemSegmentsByTurnId: { [olderTurn.id]: [] },
              loadedItemCount: 0,
            }),
          );
        },
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const runtime = yield* make.pipe(
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
      );

      const boundaryRow = flattenCodexHistoryTopology(aggregate.readHistoryTopology()).find(
        (row) => row.kind === "gap" && row.newerBoundary?.edge === "older",
      );
      if (boundaryRow?.kind !== "gap" || !boundaryRow.newerBoundary) {
        return yield* Effect.die(new Error("Missing exact older boundary"));
      }
      const request = {
        threadId: "thread-history",
        expectedConversationGeneration: aggregate.generation,
        expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
        target: { kind: "turnBoundary" as const, boundary: boundaryRow.newerBoundary },
      };
      const first = yield* Effect.forkChild(runtime.loadPage(request));
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(runtime.loadPage(request));
      yield* Effect.yieldNow;
      assert.strictEqual(requests, 1);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);

      const committedRevision = results[0]?.mutation.historyMutationRevision;
      for (const result of results) {
        assert.strictEqual(result.status, "applied");
        assert.strictEqual(result.mutation.historyMutationRevision, committedRevision);
      }
      assert.isAbove(committedRevision ?? 0, 0);
      assert.deepEqual(
        aggregate.readSnapshot()?.turns.map((turn) => turn.turnId),
        ["turn-older", "turn-current"],
      );
      assert.isTrue(aggregate.readSnapshot()?.turnPagination?.hasLoadedOldest);
      assert.strictEqual(aggregate.readCanonicalState()?.turns[0]?.protocol.id, "turn-older");
    }),
  ),
);

it.effect("loads one exact partial-Turn page without advancing the Turn boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const latestItem = {
        type: "agentMessage",
        id: "item-latest",
        text: "latest answer",
        phase: "final_answer",
        memoryCitation: null,
      } satisfies ThreadItem;
      const openingItem = {
        type: "userMessage",
        id: "item-opening",
        clientId: null,
        content: [{ type: "text", text: "opening prompt", text_elements: [] }],
      } satisfies ThreadItem;
      const partialTurn: Turn = {
        ...historyTurn("turn-partial"),
        items: [latestItem],
        itemsView: "summary",
      };
      const itemPagination = {
        olderCursor: "items:older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        oldestUserInput: openingItem.content,
        openingUserMessageId: openingItem.id,
        itemsView: "summary" as const,
      };
      const hydration: Parameters<typeof createCodexCanonicalHydratedConversationState>[1] = {
        model: "gpt-test",
        reasoningEffort: "high",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace"],
        turnItemsPaginationById: { [partialTurn.id]: itemPagination },
      };
      const canonical = createCodexCanonicalHydratedConversationState(
        historyThread([partialTurn]),
        hydration,
      );
      const aggregates = makeConversationEntityStateRegistry();
      const aggregate = aggregates.acquire("thread-history");
      aggregate.acceptCanonicalState(canonical);
      const turnPagination = {
        olderCursor: "turns:older",
        backwardsCursor: null,
        oldestLoadedTurnId: partialTurn.id,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 1,
        itemsView: "summary" as const,
      };
      aggregate.installSnapshot({
        threadId: "thread-history",
        canonicalState: canonical,
        turns: [
          {
            threadId: "thread-history",
            turnId: partialTurn.id,
            status: "completed",
            itemIds: [latestItem.id],
            items: [],
          },
        ],
        turnPagination,
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 0,
          projectionRevision: 0,
          entries: [],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
      } as unknown as CodexConversationSnapshot);
      aggregate.initializeHistory(turnPagination, 1, { [partialTurn.id]: itemPagination });
      const conversations = ConversationEntityMap.of({
        entity: aggregates.acquire,
        current: aggregates.current,
        runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
      } as unknown as ConversationEntityMap["Service"]);
      const itemRequests: unknown[] = [];
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: () => Effect.die("Turn pagination advanced before partial items"),
        loadTurnItemsPage: (input) => {
          itemRequests.push(input);
          return Effect.succeed({
            items: [openingItem],
            nextCursor: null,
            backwardsCursor: "items:newer-anchor",
            approximateBytes: 128,
          });
        },
      });
      const runtime = yield* make.pipe(
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
      );

      const topologyGeneration = aggregate.readHistoryTopology().generation;
      const itemRef = createCodexConversationHistoryTurnItemsRef({
        turnId: partialTurn.id,
        expectedTopologyGeneration: topologyGeneration,
        pagination: itemPagination,
      });
      if (!itemRef) return yield* Effect.die(new Error("Missing exact item boundary"));
      yield* runtime.loadPage({
        threadId: "thread-history",
        expectedConversationGeneration: aggregate.generation,
        expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
        target: { kind: "turnItems", items: itemRef },
      });

      assert.deepEqual(itemRequests, [
        {
          capability: capabilitySnapshot,
          threadId: "thread-history",
          turnId: partialTurn.id,
          cursor: "items:older",
          sortDirection: "desc",
          purpose: "older",
        },
      ]);
      assert.deepEqual(
        aggregate.readCanonicalState()?.turns[0]?.items.map((item) => item.id),
        [openingItem.id, latestItem.id],
      );
      assert.strictEqual(aggregate.readTurnPagination().olderCursor, "turns:older");
      assert.deepEqual(aggregate.readTurnItemsPagination(partialTurn.id), {
        ...itemPagination,
        olderCursor: null,
        hasLoadedOldest: true,
        itemsView: "full",
      });
    }),
  ),
);
