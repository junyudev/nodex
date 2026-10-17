import * as BoundedQueue from "@t3tools/shared/BoundedQueue";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "closes overflowing SDK intake without an application reader and resumes through a fresh query",
  () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      let produced = 0;
      const message: ClaudeSdk.SDKMessage = {
        type: "system",
        subtype: "status",
        status: null,
        uuid: "10000000-0000-0000-0000-000000000001",
        session_id: "native-original",
      };
      const original = {
        next: async () => {
          produced++;
          return { done: false, value: message };
        },
        close: () => {
          Deferred.doneUnsafe(closed, Effect.void);
        },
      } as unknown as ClaudeSdk.Query;
      const query = vi
        .spyOn(ClaudeSdk, "query")
        .mockReturnValueOnce(original)
        .mockReturnValueOnce({
          next: async () => ({ done: true, value: undefined }),
          close: () => {},
        } as unknown as ClaudeSdk.Query);
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        const input = {
          threadId: ThreadId.make("thread-pressure"),
          providerSessionId: ProviderSessionId.make("session-pressure"),
          options: {
            sessionId: "native-original",
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "bypassPermissions" as const,
          },
        };
        const original = yield* runner.open(input);
        yield* Deferred.await(closed);
        assert.equal(produced, BoundedQueue.DEFAULT_MAX_ITEMS + 1);
        const exit = yield* Effect.exit(original.messages.pipe(Stream.runCollect));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit))
          assert.equal(
            (Cause.squash(exit.cause) as { method?: string }).method,
            "message.admission",
          );
        yield* original.close;
        const recovered = yield* runner.open({
          ...input,
          options: {
            model: input.options.model,
            tools: input.options.tools,
            permissionMode: input.options.permissionMode,
            resume: "native-original",
          },
        });
        assert.isEmpty(yield* recovered.messages.pipe(Stream.runCollect));
        yield* recovered.close;
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "admits a supported multi-image prompt and its SDK echo before rejecting oversized input",
  () =>
    Effect.gen(function* () {
      const message: ClaudeSdk.SDKUserMessage = {
        type: "user",
        parent_tool_use_id: null,
        session_id: "native-images",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "a".repeat(28 * 1024 * 1024),
              },
            },
          ],
        },
      };
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        if (typeof prompt === "string") throw new Error("Expected streaming native prompt");
        const input = prompt[Symbol.asyncIterator]();
        return { next: () => input.next(), close: () => {} } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        const session = yield* runner.open({
          threadId: ThreadId.make("thread-images"),
          providerSessionId: ProviderSessionId.make("session-images"),
          options: {
            sessionId: "native-images",
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "bypassPermissions",
          },
        });
        yield* session.offer(message);
        const echo = yield* session.messages.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(echo, [message]);
        const oversized: ClaudeSdk.SDKUserMessage = {
          ...message,
          message: { role: "user", content: "a".repeat(BoundedQueue.MAX_PROMPT_BYTES) },
        };
        assert.isTrue(Exit.isFailure(yield* Effect.exit(session.offer(oversized))));
        yield* session.close;
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("ends its messages when closed while the CLI is idle", () =>
  Effect.gen(function* () {
    // An idle CLI never answers the pending read; only closing the Query releases it.
    const idle = {
      next: () => new Promise<never>(() => {}),
      return: async () => ({ done: true as const, value: undefined }),
      close: () => {},
    } as unknown as ClaudeSdk.Query;
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue(idle);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId: ThreadId.make("thread-idle"),
        providerSessionId: ProviderSessionId.make("session-idle"),
        options: {
          sessionId: "native-idle",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      yield* session.close;
      // A stopped Turn settles when this stream ends, not after a close timeout.
      const ended = yield* session.messages.pipe(
        Stream.runCollect,
        Effect.timeoutOption("1 second"),
      );
      assert.isTrue(ended._tag === "Some");
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
