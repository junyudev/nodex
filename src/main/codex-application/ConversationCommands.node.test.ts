import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexConversationArchive } from "./CodexConversationArchive";
import {
  CodexConversationProjection,
  CodexConversationProjectionError,
} from "./CodexConversationProjection";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadDirectory, CodexThreadDirectoryError } from "./CodexThreadDirectory";
import { CodexSubagentDirectory, CodexSubagentDirectoryError } from "./CodexSubagentDirectory";
import { ConversationCommands, live } from "./ConversationCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const threadDirectory = CodexThreadDirectory.of({
  resolve: ({ threadId }: { readonly threadId: string }) =>
    Effect.succeed(threadId === "acp-thread" ? null : ({} as never)),
} as unknown as CodexThreadDirectory["Service"]);

it.effect("commits interruption without waking queued work before terminal completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: string[] = [];
      const backgroundTerminalRequests: unknown[] = [];
      const unsupported = () => Effect.die(new Error("Unsupported test operation"));
      const requestForThread: CodexGateway["Service"]["requestForThread"] = (
        threadId,
        method,
        params,
      ) => {
        events.push(`remote:${method}:${threadId}`);
        if (method === "thread/backgroundTerminals/list") {
          backgroundTerminalRequests.push(params);
          return Effect.succeed({ data: [], nextCursor: null }) as never;
        }
        return Effect.succeed({}) as never;
      };
      const gateway = CodexGateway.of({
        localHostId: "local",
        requestRawOnHost: unsupported,
        requestRawForThread: unsupported,
        events: Stream.empty,
        requestLocal: unsupported,
        requestOnHost: unsupported,
        requestForThread,
        notifyLocal: unsupported,
        connection: unsupported,
        connectionChanges: () => Stream.empty,
        awaitReady: () => Effect.void,
        reconcileHost: unsupported,
        removeHost: unsupported,
        restartHost: unsupported,
      });
      const projection = CodexConversationProjection.of({
        resolveInterruptTurn: (_threadId: string, requestedTurnId?: string) =>
          Effect.sync(() => {
            events.push(`resolve:${requestedTurnId ?? "inferred"}`);
            return requestedTurnId ?? "turn-inferred";
          }),
        commitInterruptedTurn: ({ threadId, turnId }: { threadId: string; turnId: string }) =>
          Effect.sync(() => events.push(`projection:${threadId}:${turnId}`)).pipe(
            Effect.andThen(
              Effect.fail(
                new CodexConversationProjectionError({
                  operation: "commit-interrupted-turn",
                  threadId,
                  cause: new Error("durable projection unavailable"),
                }),
              ),
            ),
          ),
      } as unknown as CodexConversationProjection["Service"]);
      const goals = CodexThreadGoalRuntime.of({
        get: (threadId: string) =>
          Effect.sync(() => {
            events.push(`goal:get:${threadId}`);
            return { status: "active" } as never;
          }),
        set: ({ threadId }: { threadId: string }) =>
          Effect.sync(() => {
            events.push(`goal:pause:${threadId}`);
            return null;
          }),
      } as unknown as CodexThreadGoalRuntime["Service"]);
      const responses = CodexServerRequestResponses.of({
        declineAllInTransaction: (threadId: string) =>
          Effect.sync(() => events.push(`requests:decline:${threadId}`)),
      } as unknown as CodexServerRequestResponses["Service"]);
      const runCommand: ConversationEntityMap["Service"]["runCommand"] = (threadId, operation) =>
        Effect.sync(() => events.push(`lane:${threadId}`)).pipe(Effect.andThen(operation));
      const runtimes = ConversationEntityMap.of({
        runCommand,
      } as unknown as ConversationEntityMap["Service"]);
      const context = yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                CodexConversationArchive,
                CodexConversationArchive.of({
                  archive: () => Effect.succeed(true),
                  deleteArchived: () => Effect.succeed(true),
                  unarchive: () => Effect.succeed(null),
                }),
              ),
              Layer.succeed(CodexConversationProjection, projection),
              Layer.succeed(CodexGateway, gateway),
              Layer.succeed(CodexServerRequestResponses, responses),
              Layer.succeed(
                CodexSubagentDirectory,
                CodexSubagentDirectory.of({
                  settleInterruptedSubtree: () =>
                    Effect.succeed({
                      discoveryComplete: true,
                      interruptedThreadIds: [],
                      failed: [],
                      unresolvedThreadIds: [],
                    }),
                } as unknown as CodexSubagentDirectory["Service"]),
              ),
              Layer.succeed(CodexThreadGoalRuntime, goals),
              Layer.succeed(CodexThreadDirectory, threadDirectory),
              Layer.succeed(ConversationEntityMap, runtimes),
            ),
          ),
        ),
      );
      const commands = Context.get(context, ConversationCommands);

      assert.isTrue(yield* commands.interrupt("thread-a", "turn-remote-only"));
      assert.deepEqual(events, [
        "lane:thread-a",
        "resolve:turn-remote-only",
        "goal:get:thread-a",
        "goal:pause:thread-a",
        "requests:decline:thread-a",
        "remote:turn/interrupt:thread-a",
        "projection:thread-a:turn-remote-only",
      ]);
      yield* commands.listBackgroundTerminalsPage("thread-a", { cursor: null });
      assert.deepEqual(backgroundTerminalRequests, [{ threadId: "thread-a", cursor: null }]);
      assert.isFalse(Object.hasOwn(backgroundTerminalRequests[0] as object, "limit"));

      const denied = yield* commands.setMemoryMode("acp-thread", "disabled").pipe(Effect.flip);
      assert.instanceOf(denied, CodexThreadDirectoryError);
      assert.isFalse(events.some((event) => event.includes("thread/memoryMode/set")));
    }),
  ),
);

it.effect("shares one absolute deadline across the root interrupt and Subagent settlement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let receivedDeadlineAtMs: number | undefined;
      const unsupported = () => Effect.die(new Error("Unsupported test operation"));
      const requestForThread: CodexGateway["Service"]["requestForThread"] = (_threadId, method) =>
        method === "turn/interrupt"
          ? Effect.sleep("300 millis").pipe(Effect.as({} as never))
          : unsupported();
      const settleInterruptedSubtree: CodexSubagentDirectory["Service"]["settleInterruptedSubtree"] =
        (_threadId, options) =>
          Effect.gen(function* () {
            receivedDeadlineAtMs = options?.deadlineAtMs;
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(`${Math.max(0, (receivedDeadlineAtMs ?? now) - now)} millis`);
            return {
              discoveryComplete: true,
              interruptedThreadIds: [],
              failed: [],
              unresolvedThreadIds: ["child-a"],
            };
          });
      const runCommand: ConversationEntityMap["Service"]["runCommand"] = (_threadId, operation) =>
        operation;
      const context = yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                CodexConversationArchive,
                CodexConversationArchive.of({
                  archive: () => Effect.succeed(true),
                  deleteArchived: () => Effect.succeed(true),
                  unarchive: () => Effect.succeed(null),
                }),
              ),
              Layer.succeed(
                CodexConversationProjection,
                CodexConversationProjection.of({
                  resolveInterruptTurn: () => Effect.succeed("turn-a"),
                  commitInterruptedTurn: () => Effect.void,
                } as unknown as CodexConversationProjection["Service"]),
              ),
              Layer.succeed(
                CodexGateway,
                CodexGateway.of({
                  localHostId: "local",
                  requestRawOnHost: unsupported,
                  requestRawForThread: unsupported,
                  events: Stream.empty,
                  requestLocal: unsupported,
                  requestOnHost: unsupported,
                  requestForThread,
                  notifyLocal: unsupported,
                  connection: unsupported,
                  connectionChanges: () => Stream.empty,
                  awaitReady: () => Effect.void,
                  reconcileHost: unsupported,
                  removeHost: unsupported,
                  restartHost: unsupported,
                }),
              ),
              Layer.succeed(
                CodexServerRequestResponses,
                CodexServerRequestResponses.of({
                  declineAllInTransaction: () => Effect.void,
                } as unknown as CodexServerRequestResponses["Service"]),
              ),
              Layer.succeed(
                CodexSubagentDirectory,
                CodexSubagentDirectory.of({
                  settleInterruptedSubtree,
                } as unknown as CodexSubagentDirectory["Service"]),
              ),
              Layer.succeed(
                CodexThreadGoalRuntime,
                CodexThreadGoalRuntime.of({
                  get: () => Effect.succeed(null),
                } as unknown as CodexThreadGoalRuntime["Service"]),
              ),
              Layer.succeed(CodexThreadDirectory, threadDirectory),
              Layer.succeed(
                ConversationEntityMap,
                ConversationEntityMap.of({
                  runCommand,
                } as unknown as ConversationEntityMap["Service"]),
              ),
            ),
          ),
        ),
      );
      const commands = Context.get(context, ConversationCommands);
      const interrupted = yield* commands
        .interrupt("root-a", "turn-a")
        .pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("300 millis");
      assert.strictEqual(receivedDeadlineAtMs, 4_750);
      yield* TestClock.adjust("4450 millis");

      const failure = yield* Fiber.join(interrupted);
      assert.instanceOf(failure, CodexSubagentDirectoryError);
      assert.match(String(failure.cause), /1 unresolved descendants/);
    }),
  ),
);
