import * as Effect from "effect/Effect";
import { z } from "zod";
import {
  sessionQueueSchema,
  sessionQueueOwnerResultSchema,
  type SessionQueueInput,
} from "../../shared/nodex-app-tools/session-control-schemas";
import { SessionQueueError } from "../../shared/nodex-app-tools/session-queue";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
} from "./CodexMainConversationManagers";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexMainConversationInterrupt } from "./CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexTurnCommands } from "./CodexTurnCommands";

export const queueOwnerRequestSchema = z.strictObject({
  conversationId: z.string().min(1),
  input: sessionQueueSchema,
});
export const makeQueueOwner = Effect.gen(function* () {
  const queues = yield* CodexQueuedFollowUps;
  const turns = yield* CodexTurnCommands;
  const managers = yield* CodexMainConversationManagers;
  return (hostId: string, threadId: string, input: SessionQueueInput) =>
    queues.controlAsOwner(hostId, threadId, input, (message, native) =>
      Effect.gen(function* () {
        const id = native?.clientUserMessageId ?? message.id;
        const prepared = yield* turns.prepareNativeQueuedMessage(threadId, message, "steer", {
          runtimeWorkspaceRoots:
            message.context.workspaceRoots ?? (message.cwd ? [message.cwd] : []),
          clientUserMessageId: id,
          ...(native ? { serverQueuedSubmission: native } : {}),
        });
        if (prepared.requiresIdle)
          return yield* Effect.fail(
            new SessionQueueError("unsupported", "This queued message requires a separate turn"),
          );
        yield* managers.dispatchFollowerRequest(hostId, {
          method: "thread-follower-steer-turn",
          params: prepared.steer,
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            turns.releasePreparedNativeSteer(native?.clientUserMessageId ?? message.id),
          ),
        ),
      ),
    );
});

/** Native controls route to the current execution peer, including an attached remote owner. */
export const make = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const resume = yield* CodexMainConversationResume;
  const interrupts = yield* CodexMainConversationInterrupt;
  const queueOwner = yield* makeQueueOwner;
  const select = Effect.fn("CodexSessionControls.select")(function* (
    hostId: string,
    threadId: string,
  ) {
    const manager = yield* managers.get(hostId);
    if (!manager.stream.getRole(threadId)) {
      const result = yield* resume.resume(threadId);
      if (result.status !== "ready")
        return yield* new MainConversationManagerError({
          hostId,
          cause: new Error("Native execution owner is unavailable"),
        });
    }
    return { manager, role: manager.stream.getRole(threadId) };
  });
  const forward = Effect.fn("CodexSessionControls.forward")(function* (
    hostId: string,
    threadId: string,
    request: { method: string; params: unknown },
    beforeControl: Effect.Effect<void, unknown>,
  ) {
    const { manager, role } = yield* select(hostId, threadId);
    yield* beforeControl;
    if (role?.role !== "follower") return null;
    const generation = manager.generation;
    yield* Effect.try(() => manager.assertCurrent(generation));
    const result = yield* Effect.tryPromise(() =>
      manager.coordination.requestThreadFollower({
        hostId,
        targetClientId: role.ownerClientId,
        request,
      }),
    );
    yield* Effect.try(() => manager.assertCurrent(generation));
    if (result.resultType !== "success")
      return yield* new MainConversationManagerError({
        hostId,
        cause: new Error(
          result.resultType === "error" ? result.error : "Native execution owner is unavailable",
        ),
      });
    return { result: result.result };
  });
  return {
    stop: Effect.fn("CodexSessionControls.stop")(function* (
      hostId: string,
      threadId: string,
      beforeControl: Effect.Effect<void, unknown> = Effect.void,
    ) {
      const forwarded = yield* forward(
        hostId,
        threadId,
        {
          method: "thread-follower-interrupt-turn",
          params: { conversationId: threadId, mode: "user-stop" },
        },
        beforeControl,
      );
      const result = forwarded
        ? yield* Effect.try(() =>
            z.object({ interruptedTurnId: z.string().nullable() }).parse(forwarded.result),
          )
        : yield* interrupts.interrupt(hostId, threadId, "user-stop");
      return result.interruptedTurnId !== null;
    }),
    queue: Effect.fn("CodexSessionControls.queue")(function* (
      hostId: string,
      threadId: string,
      input: SessionQueueInput,
      beforeControl: Effect.Effect<void, unknown> = Effect.void,
    ) {
      if (hostId === "local")
        return yield* Effect.fail(
          new SessionQueueError(
            "unsupported",
            "Queue controls are unavailable for local native Sessions",
          ),
        );
      const forwarded = yield* forward(
        hostId,
        threadId,
        {
          method: "thread-follower-session-queue",
          params: { conversationId: threadId, input },
        },
        beforeControl,
      );
      if (!forwarded) return yield* queueOwner(hostId, threadId, input);
      const response = yield* Effect.try(() =>
        sessionQueueOwnerResultSchema.parse(forwarded.result),
      );
      if ("error" in response)
        return yield* Effect.fail(
          new SessionQueueError(response.error.reason, response.error.message),
        );
      return response.value;
    }),
  };
});
