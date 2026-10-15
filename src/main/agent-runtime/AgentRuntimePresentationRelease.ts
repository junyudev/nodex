import type { AgentThreadAuthority } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";

const isRevokedRun = (status: string) =>
  status === "cancelled" || status === "interrupted" || status === "rolled_back";

/**
 * Binds Runtime Turns to their submitted presentation and releases it when the execution ends
 * without completing. Main tracks only Runs that hold a presentation, so a skipped delivery
 * rechecks live work, never history.
 */
export const make = Effect.fn("AgentRuntimePresentationRelease.make")(function* (
  connection: AgentRuntimeProcessConnection,
  presentation: Pick<
    CodexTurnPresentation["Service"],
    "observeRuntimeMessage" | "finishRuntimeSource" | "finishRuntimeLease" | "finish"
  >,
) {
  const { runtimeId, runtimeGeneration } = connection.identity;
  const deliveries = yield* connection.subscribeExecutionNotifications;
  let subscriptionId = (yield* connection.request("execution.observe", {
    afterSequence: connection.identity.lastSequence,
  })).subscriptionId;
  yield* Effect.addFinalizer(() =>
    connection.request("events.unobserve", { subscriptionId }).pipe(Effect.ignore),
  );
  const tracked = new Map<string, { readonly threadId: string; readonly runId: string }>();
  const keyOf = (threadId: string, runId: string) => JSON.stringify([threadId, runId]);
  const release = (threadId: string, runId: string) => {
    tracked.delete(keyOf(threadId, runId));
    presentation.finish(threadId, runId);
  };
  const recheck = Effect.fn("AgentRuntimePresentationRelease.recheck")(function* (
    threadId: string,
    runId: string,
  ) {
    // The engine answers only for live, uncancelled Runs of its current process.
    const proof = yield* connection.request("thread.authority", { threadId, runId });
    if (!proof || proof.runtimeGeneration !== runtimeGeneration) release(threadId, runId);
  });
  const recheckAll = Effect.suspend(() =>
    Effect.forEach([...tracked.values()], (run) => recheck(run.threadId, run.runId), {
      concurrency: 2,
      discard: true,
    }),
  );
  let lastDelivery: number | null = null;
  yield* deliveries.pipe(
    Stream.runForEach((delivery) =>
      Effect.gen(function* () {
        if (lastDelivery !== null && delivery.delivery !== lastDelivery + 1) yield* recheckAll;
        lastDelivery = delivery.delivery;
        const notification = delivery.notification;
        if (notification.type === "execution.native-session.closed") {
          if (
            notification.runtimeId === runtimeId &&
            notification.runtimeGeneration === runtimeGeneration
          )
            presentation.finishRuntimeSource({
              runtimeId,
              runtimeGeneration,
              providerSessionId: notification.providerSessionId,
              nativeGeneration: notification.nativeGeneration,
            });
          return;
        }
        if (notification.type === "event.error" && notification.subscriptionId === subscriptionId) {
          subscriptionId = (yield* connection.request("execution.observe", {})).subscriptionId;
          return yield* recheckAll;
        }
        if (
          notification.type !== "execution.lifecycle" ||
          notification.subscriptionId !== subscriptionId ||
          notification.runtimeGeneration !== runtimeGeneration ||
          !notification.runId ||
          !notification.runStatus
        )
          return;
        if (isRevokedRun(notification.runStatus))
          release(notification.threadId, notification.runId);
        else if (notification.runStatus === "completed" || notification.runStatus === "failed")
          tracked.delete(keyOf(notification.threadId, notification.runId));
      }),
    ),
    // Without lifecycle evidence no presentation of this process can be released exactly.
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.sync(() => presentation.finishRuntimeLease(runtimeId, runtimeGeneration)),
    ),
    Effect.forkScoped,
  );
  return {
    observe: Effect.fn("AgentRuntimePresentationRelease.observe")(function* (
      proof: AgentThreadAuthority,
    ) {
      yield* presentation.observeRuntimeMessage(proof.threadId, proof.runId, proof.userMessageId, {
        runtimeId,
        runtimeGeneration,
        providerSessionId: proof.providerSessionId,
        nativeGeneration: proof.nativeGeneration,
      });
      tracked.set(keyOf(proof.threadId, proof.runId), {
        threadId: proof.threadId,
        runId: proof.runId,
      });
      // Cancellation may have been delivered before the presentation existed.
      yield* recheck(proof.threadId, proof.runId);
    }),
  };
});
