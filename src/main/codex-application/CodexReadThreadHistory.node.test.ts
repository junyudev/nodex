import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationSnapshot } from "../../shared/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import {
  CodexReadThreadCursorRegistry,
  make as makeReadThreadHistory,
  serializeCodexReadThreadProtocolItem,
} from "./CodexReadThreadHistory";
import { CodexThreadDirectory } from "./CodexThreadDirectory";

const capability = (generation: number): CodexAppServerCapabilitySnapshot =>
  ({
    hostId: "local",
    generation,
    readiness: "ready",
    capabilities: { threadTurnsList: true, threadItemsList: true },
  }) as unknown as CodexAppServerCapabilitySnapshot;

const residentTurn = (turnId: string) =>
  ({
    turnId,
    status: "completed",
    errorMessage: null,
    startedAt: 1,
    turnStartedAtMs: 1,
    firstTurnWorkItemStartedAtMs: null,
    completedAt: 2,
    durationMs: 1,
    items: [],
  }) as unknown as CodexConversationSnapshot["turns"][number];

const snapshot = {
  threadId: "thread-1",
  threadName: "History",
  threadPreview: "Tail",
  statusType: "idle",
  statusActiveFlags: [],
  cwd: "/repo",
  createdAt: 1,
  updatedAt: 2,
  turns: [residentTurn("turn-tail")],
  turnPagination: {
    olderCursor: "opaque:tail-older",
    backwardsCursor: null,
    oldestLoadedTurnId: "turn-tail",
    isLoadingOlder: false,
    hasLoadedOldest: false,
    loadedTurnCount: 1,
    itemsView: "full",
  },
} as unknown as CodexConversationSnapshot;

const protocolTurn = (id: string): Turn =>
  ({
    id,
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    itemsView: "full",
    items: [],
  }) as unknown as Turn;

describe("CodexReadThreadCursorRegistry", () => {
  it("is bounded, expires entries, and rejects a replacement host generation", () => {
    let now = 1;
    const registry = new CodexReadThreadCursorRegistry(() => now, 2, 10);
    const set = (publicCursor: string, appServerCursor: string) =>
      registry.set({
        threadId: "thread-1",
        publicCursor,
        appServerCursor,
        hostId: "local",
        hostGeneration: 7,
      });

    set("turn-1", "opaque-1");
    set("turn-2", "opaque-2");
    expect(
      registry.get({
        threadId: "thread-1",
        publicCursor: "turn-1",
        hostId: "local",
        hostGeneration: 7,
      }),
    ).toBe("opaque-1");
    set("turn-3", "opaque-3");
    expect(
      registry.get({
        threadId: "thread-1",
        publicCursor: "turn-2",
        hostId: "local",
        hostGeneration: 7,
      }),
    ).toBeNull();
    expect(
      registry.get({
        threadId: "thread-1",
        publicCursor: "turn-1",
        hostId: "local",
        hostGeneration: 8,
      }),
    ).toBeNull();
    now = 12;
    expect(
      registry.get({
        threadId: "thread-1",
        publicCursor: "turn-3",
        hostId: "local",
        hostGeneration: 7,
      }),
    ).toBeNull();
  });

  it("keeps the one admitted cursor readable at an exact capacity of one", () => {
    const registry = new CodexReadThreadCursorRegistry(() => 1, 1, 10);
    registry.set({
      threadId: "thread-1",
      publicCursor: "turn-1",
      appServerCursor: "opaque-1",
      hostId: "local",
      hostGeneration: 7,
    });

    expect(
      registry.get({
        threadId: "thread-1",
        publicCursor: "turn-1",
        hostId: "local",
        hostGeneration: 7,
      }),
    ).toBe("opaque-1");
  });
});

describe("CodexReadThreadHistory", () => {
  effectIt.effect(
    "translates its public Turn-id cursor back to exactly one opaque physical page",
    () =>
      Effect.gen(function* () {
        const physicalRequests: Array<{ cursor: string | null; limit?: number }> = [];
        const directory = CodexThreadDirectory.of({
          resolve: () =>
            Effect.succeed({
              durable: { executionHostId: "local" },
              snapshot,
            } as never),
        } as never);
        const capabilities = CodexAppServerCapabilities.of({
          forThread: () => Effect.succeed(capability(7)),
          isCurrent: () => Effect.succeed(true),
        } as never);
        const pages = CodexHistoryPageAdapter.of({
          loadTurnPage: (input) => {
            physicalRequests.push({ cursor: input.cursor, limit: input.limit });
            return Effect.succeed({
              turns: [protocolTurn("turn-older")],
              nextCursor: "opaque:next",
              backwardsCursor: null,
              itemsPaginationByTurnId: {},
              itemSegmentsByTurnId: {},
              loadedItemCount: 0,
            });
          },
          loadTurnItemsPage: () => Effect.die("read_thread must not load an extra item page"),
        });
        const service = yield* makeReadThreadHistory.pipe(
          Effect.provideService(CodexAppServerCapabilities, capabilities),
          Effect.provideService(CodexHistoryPageAdapter, pages),
          Effect.provideService(CodexThreadDirectory, directory),
        );

        const tail = yield* service.read({ threadId: "thread-1", turnLimit: 1 });
        expect(tail.turns.map((turn) => turn.id)).toEqual(["turn-tail"]);
        expect(tail.page.nextCursor).toBe("turn-tail");
        expect(physicalRequests).toEqual([]);

        const older = yield* service.read({
          threadId: "thread-1",
          cursor: "turn-tail",
          turnLimit: 1,
        });
        expect(physicalRequests).toEqual([{ cursor: "opaque:tail-older", limit: 1 }]);
        expect(older.turns.map((turn) => turn.id)).toEqual(["turn-older"]);
        expect(older.page.nextCursor).toBe("turn-older");
      }),
  );

  effectIt.effect("rejects a physical page from a replaced host generation", () =>
    Effect.gen(function* () {
      const directory = CodexThreadDirectory.of({
        resolve: () =>
          Effect.succeed({
            durable: { executionHostId: "local" },
            snapshot,
          } as never),
      } as never);
      const capabilities = CodexAppServerCapabilities.of({
        forThread: () => Effect.succeed(capability(7)),
        isCurrent: () => Effect.succeed(false),
      } as never);
      const pages = CodexHistoryPageAdapter.of({
        loadTurnPage: () =>
          Effect.succeed({
            turns: [protocolTurn("turn-older")],
            nextCursor: "opaque:next",
            backwardsCursor: null,
            itemsPaginationByTurnId: {},
            itemSegmentsByTurnId: {},
            loadedItemCount: 0,
          }),
        loadTurnItemsPage: () => Effect.die("read_thread must not load an extra item page"),
      });
      const service = yield* makeReadThreadHistory.pipe(
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexHistoryPageAdapter, pages),
        Effect.provideService(CodexThreadDirectory, directory),
      );

      yield* service.read({ threadId: "thread-1", turnLimit: 1 });
      const failure = yield* service
        .read({ threadId: "thread-1", cursor: "turn-tail", turnLimit: 1 })
        .pipe(Effect.flip);

      expect(failure.reason).toBe("request-failed");
      expect(String(failure.cause)).toContain("generation changed");
    }),
  );

  it("bounds textual protocol fields before they enter a dynamic-tool response", () => {
    expect(
      serializeCodexReadThreadProtocolItem(
        {
          type: "agentMessage",
          id: "item-1",
          text: "abcdefghij",
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
        false,
        6,
      ),
    ).toMatchObject({ text: "abc..." });
  });
});
