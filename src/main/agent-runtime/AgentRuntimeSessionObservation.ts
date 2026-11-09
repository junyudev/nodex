import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentEvent } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";

export type SessionObservationSignal =
  | { readonly kind: "event"; readonly event: AgentEvent }
  | { readonly kind: "reset" };

class SessionObservationUnavailable extends Data.TaggedError("SessionObservationUnavailable") {}

/** Attaches at the caller's snapshot watermark with one Runtime generation and scoped cleanup. */
export const makeSessionObservation = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  const supervisor = yield* AgentRuntimeSupervisor;
  return (sessionId: string, afterSequence: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* application.resolveTarget({ sessionId });
        const connection = yield* supervisor.get();
        if (connection.identity.runtimeId !== target.runtimeId)
          return yield* new SessionObservationUnavailable();
        const notifications = yield* connection.subscribeNotifications;
        // A watcher can leave while execution is too busy to answer; the connection releases an
        // observer abandoned that way, and an unanswered release does not hold the watcher back.
        const admitted = yield* Effect.acquireRelease(
          connection
            .request("events.observe", { threadId: target.threadId, afterSequence })
            .pipe(Effect.interruptible),
          ({ subscriptionId }) =>
            connection
              .request("events.unobserve", { subscriptionId })
              .pipe(Effect.timeout("2 seconds"), Effect.ignoreCause),
        );
        let previous: number | undefined;
        const events = notifications.pipe(
          Stream.map((delivery): SessionObservationSignal | "ended" | null => {
            const gap = previous !== undefined && previous + 1 !== delivery.delivery;
            previous = delivery.delivery;
            if (gap) return { kind: "reset" };
            const event = delivery.notification;
            if (event.type !== "event" && event.type !== "event.error") return null;
            if (event.subscriptionId !== admitted.subscriptionId) return null;
            return event.type === "event" ? { kind: "event", event: event.event } : "ended";
          }),
          Stream.filter((signal) => signal !== null),
          // A failed observer delivers nothing more, so the watch ends with a reset and the
          // watcher attaches again from its snapshot instead of waiting on a silent stream.
          Stream.takeUntil((signal) => signal === "ended"),
          Stream.map((signal): SessionObservationSignal =>
            signal === "ended" ? { kind: "reset" } : signal,
          ),
        );
        return Stream.merge(
          events,
          Stream.fromEffect(connection.terminated.pipe(Effect.as({ kind: "reset" as const }))),
          { haltStrategy: "either" },
        );
      }),
    );
});
