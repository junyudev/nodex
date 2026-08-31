import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import type { CodexConversationSnapshot } from "../../shared/types";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexHistoryPageAdapter } from "./CodexHistoryPageAdapter";
import { make } from "./CodexThreadRollbackCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const unused = () => Effect.die(new Error("Unsupported test operation"));

const makeGateway = (
  requestForThread: CodexGateway["Service"]["requestForThread"],
): CodexGateway["Service"] =>
  CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    events: Stream.empty,
    requestForThread,
    requestRawForThread: () => Effect.die("unused"),
    requestLocal: unused,
    requestOnHost: unused,
    notifyLocal: unused,
    connection: unused,
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unused,
    removeHost: unused,
    restartHost: unused,
  } as unknown as CodexGateway["Service"]);

const ownerDrain = (events: string[]): CodexOwnerNotificationDrainRuntime["Service"] =>
  CodexOwnerNotificationDrainRuntime.of({
    next: () => 1,
    canAck: () => true,
    ack: () => true,
    awaitCurrent: (threadId) => Effect.sync(() => events.push(`drain:${threadId}`)),
    resetOwner: () => undefined,
    release: () => undefined,
    clear: () => undefined,
  });

const conversationLane = (events: string[]): ConversationEntityMap["Service"] => {
  const conversations = makeConversationEntityStateRegistry();
  return ConversationEntityMap.of({
    entity: conversations.acquire,
    current: conversations.current,
    runCommand: (threadId, operation) =>
      Effect.sync(() => events.push(`lane:${threadId}`)).pipe(Effect.andThen(operation)),
    markAllNeedsResume: conversations.markAllNeedsResume,
    retire: () => Effect.void,
  });
};

const editableSnapshot = {
  cwd: "/repo",
  turns: [
    {
      turnId: "turn-a",
      status: "completed",
      items: [{ turnId: "turn-a", semanticKind: "userMessage", kind: "userMessage" }],
    },
  ],
} as unknown as CodexConversationSnapshot;

const projectionForHistoryMode = (
  historyMode: "legacy" | "paginated",
): CodexConversationProjection["Service"] =>
  CodexConversationProjection.of({
    read: () =>
      Effect.succeed({
        canonical: { protocol: { historyMode } } as never,
        snapshot: editableSnapshot,
      }),
  } as unknown as CodexConversationProjection["Service"]);

const projection = projectionForHistoryMode("paginated");

const capabilityService = (userAgent: string): CodexAppServerCapabilities["Service"] => {
  const snapshot = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 1,
    userAgent,
  });
  return CodexAppServerCapabilities.of({
    forHost: () => Effect.succeed(snapshot),
    forThread: () => Effect.succeed(snapshot),
    isCurrent: () => Effect.succeed(true),
  });
};

const emptyHistoryPage = CodexHistoryPageAdapter.of({
  loadTurnPage: ({ cursor }) =>
    Effect.succeed({
      turns: [],
      nextCursor: null,
      backwardsCursor: cursor,
      itemsPaginationByTurnId: {},
      itemSegmentsByTurnId: {},
      loadedItemCount: 0,
    }),
  loadTurnItemsPage: () => Effect.die("unused"),
});

it.effect("runs owner drain, validation, Gateway, and projection commit in the Thread lane", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const directory = CodexThreadDirectory.of({
      acceptRollbackResult: ({
        expectedThreadId,
        pagination,
      }: {
        readonly expectedThreadId: string;
        readonly pagination?: { readonly backwardsCursor: string | null };
      }) =>
        Effect.sync(() => {
          events.push(`commit:${expectedThreadId}:${pagination?.backwardsCursor ?? "none"}`);
          return {} as never;
        }),
      acceptForkResult: () => Effect.die("unused"),
      observeMetadata: () => Effect.die("unused"),
      acceptStandaloneStart: () => Effect.die("unused"),
      acceptResumeResult: () => Effect.die("unused"),
      acceptSessionStart: () => Effect.die("unused"),
    } as unknown as CodexThreadDirectory["Service"]);
    const commands = yield* make.pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(((threadId, method, params, scheduling) =>
          Effect.sync(() => {
            const revert = params as { readonly beforeTurnId: string };
            assert.deepEqual(scheduling, { expectedHostId: "local", expectedGeneration: 1 });
            events.push(`request:${threadId}:${method}:${revert.beforeTurnId}`);
            return {
              thread: { id: threadId, turns: [] },
              turnsBackwardsCursor: "turns:before-a",
              itemsBackwardsCursor: "items:before-a",
            } as never;
          })) as CodexGateway["Service"]["requestForThread"]),
      ),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilityService("codex-app-server/0.148.0-alpha.13"),
      ),
      Effect.provideService(CodexHistoryPageAdapter, emptyHistoryPage),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexOwnerNotificationDrainRuntime, ownerDrain(events)),
      Effect.provideService(ConversationEntityMap, conversationLane(events)),
    );

    const response = yield* commands.revertLatestForEdit({
      threadId: "thread-a",
      turnId: "turn-a",
      numTurns: 1,
    });

    assert.strictEqual(response.thread.id, "thread-a");
    assert.deepEqual(events, [
      "lane:thread-a",
      "drain:thread-a",
      "request:thread-a:thread/revert:turn-a",
      "commit:thread-a:turns:before-a",
    ]);
  }),
);

it.effect("rejects a mismatched response before committing canonical state", () =>
  Effect.gen(function* () {
    let commits = 0;
    const events: string[] = [];
    const directory = CodexThreadDirectory.of({
      acceptRollbackResult: () =>
        Effect.sync(() => {
          commits += 1;
          return {} as never;
        }),
      acceptForkResult: () => Effect.die("unused"),
      observeMetadata: () => Effect.die("unused"),
      acceptStandaloneStart: () => Effect.die("unused"),
      acceptResumeResult: () => Effect.die("unused"),
      acceptSessionStart: () => Effect.die("unused"),
    } as unknown as CodexThreadDirectory["Service"]);
    const commands = yield* make.pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway((() =>
          Effect.succeed({
            thread: { id: "thread-other" },
          } as never)) as CodexGateway["Service"]["requestForThread"]),
      ),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilityService("codex-app-server/0.148.0-alpha.13"),
      ),
      Effect.provideService(CodexHistoryPageAdapter, emptyHistoryPage),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexOwnerNotificationDrainRuntime, ownerDrain(events)),
      Effect.provideService(ConversationEntityMap, conversationLane(events)),
    );

    const exit = yield* Effect.exit(
      commands.revertLatestForEdit({
        threadId: "thread-a",
        turnId: "turn-a",
        numTurns: 1,
      }),
    );

    assert.isTrue(exit._tag === "Failure");
    assert.strictEqual(commits, 0);
  }),
);

it.effect("fails closed before deprecated count rollback on a legacy host generation", () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const directory = CodexThreadDirectory.of({
      acceptRollbackResult: () => Effect.succeed({} as never),
    } as unknown as CodexThreadDirectory["Service"]);
    const commands = yield* make.pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(((threadId, method, params) =>
          Effect.sync(() => {
            methods.push(method);
            assert.deepEqual(params as unknown, { threadId, numTurns: 1 });
            return { thread: { id: threadId, turns: [] } } as never;
          })) as CodexGateway["Service"]["requestForThread"]),
      ),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilityService("codex-app-server/0.147.0"),
      ),
      Effect.provideService(CodexHistoryPageAdapter, emptyHistoryPage),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexOwnerNotificationDrainRuntime, ownerDrain([])),
      Effect.provideService(ConversationEntityMap, conversationLane([])),
    );

    const exit = yield* Effect.exit(
      commands.revertLatestForEdit({
        threadId: "thread-a",
        turnId: "turn-a",
        numTurns: 1,
      }),
    );

    assert.deepEqual(methods, []);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("fails closed for a legacy Thread even on a modern host", () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const directory = CodexThreadDirectory.of({
      acceptRollbackResult: () => Effect.succeed({} as never),
    } as unknown as CodexThreadDirectory["Service"]);
    const commands = yield* make.pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(((threadId, method, params) =>
          Effect.sync(() => {
            methods.push(method);
            assert.deepEqual(params as unknown, { threadId, numTurns: 1 });
            return {
              thread: { id: threadId, historyMode: "legacy", turns: [] },
            } as never;
          })) as CodexGateway["Service"]["requestForThread"]),
      ),
      Effect.provideService(
        CodexAppServerCapabilities,
        capabilityService("codex-app-server/0.148.0-alpha.13"),
      ),
      Effect.provideService(CodexHistoryPageAdapter, emptyHistoryPage),
      Effect.provideService(CodexConversationProjection, projectionForHistoryMode("legacy")),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexOwnerNotificationDrainRuntime, ownerDrain([])),
      Effect.provideService(ConversationEntityMap, conversationLane([])),
    );

    const exit = yield* Effect.exit(
      commands.revertLatestForEdit({
        threadId: "thread-a",
        turnId: "turn-a",
        numTurns: 1,
      }),
    );

    assert.deepEqual(methods, []);
    assert.strictEqual(exit._tag, "Failure");
  }),
);
