import type { components } from "@nodex/core-protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AgentBackendApplication } from "../agent-backend/AgentBackendApplication";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import {
  SessionObservation,
  type SessionInspection,
  type SessionObservationResult,
} from "./SessionObservation";

type Provenance = components["schemas"]["AgentTurnProvenance"];
export interface SessionWaitInput {
  readonly targets: readonly { readonly sessionId: string; readonly afterCursor?: string }[];
  readonly timeoutMs: number;
}

type Observation =
  | { readonly kind: "snapshot"; readonly value: SessionInspection; readonly changed: boolean }
  | { readonly kind: "error"; readonly sessionId: string; readonly reason: string };
type WaitTarget = SessionInspection & {
  readonly changed: boolean;
  readonly history?: SessionObservationResult["history"];
};
export interface SessionWaitResult {
  readonly reason: "snapshot" | "ready" | "timeout";
  readonly targets: readonly WaitTarget[];
  readonly errors: readonly Extract<Observation, { kind: "error" }>[];
}

export class SessionWaiter extends Context.Service<
  SessionWaiter,
  {
    readonly wait: (
      input: SessionWaitInput,
      provenance: Provenance,
    ) => Effect.Effect<SessionWaitResult>;
  }
>()("nodex/main/app-tools/SessionWaiter") {}

/** Subscribe before inspecting; notifications invalidate bounded state reads, never stream transcripts. */
export const make = Effect.gen(function* () {
  const observations = yield* SessionObservation;
  const database = yield* DatabaseNotifierRuntime;
  const codex = yield* CodexApplicationEventHub;
  const backends = yield* AgentBackendApplication;
  const sources = [
    database.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
    codex.events.pipe(
      Stream.filter(
        (event) =>
          event.kind === "threadNotification" ||
          event.kind === "codex" ||
          event.kind === "conversationRelationshipsInvalidated",
      ),
      Stream.map(() => undefined),
    ),
    backends.changes.pipe(Stream.map(() => undefined)),
  ];
  const inspect = Effect.fn("SessionWaiter.inspect")(function* (
    input: SessionWaitInput,
    provenance: Provenance,
  ) {
    return yield* Effect.forEach(
      input.targets,
      (target): Effect.Effect<Observation> =>
        observations.inspect(target.sessionId, provenance).pipe(
          Effect.timeout("10 seconds"),
          Effect.map((value): Observation => ({
            kind: "snapshot",
            value,
            changed: target.afterCursor !== value.cursor,
          })),
          Effect.catch((error) =>
            Effect.succeed<Observation>({
              kind: "error",
              sessionId: target.sessionId,
              reason: "reason" in error ? error.reason : "timeout",
            }),
          ),
        ),
      { concurrency: 4 },
    );
  });
  const deliver = Effect.fn("SessionWaiter.deliver")(function* (
    values: readonly Observation[],
    reason: SessionWaitResult["reason"],
    provenance: Provenance,
  ): Effect.fn.Return<SessionWaitResult> {
    const targets = yield* Effect.forEach(
      values.filter((value) => value.kind === "snapshot"),
      (target): Effect.Effect<WaitTarget> => {
        const summary = { ...target.value, changed: target.changed };
        if (
          !target.changed ||
          (target.value.disposition !== "complete" &&
            target.value.disposition !== "needs_attention")
        )
          return Effect.succeed(summary);
        return observations
          .read(
            {
              sessionId: target.value.sessionId,
              turnLimit: 1,
              includeOutputs: false,
              maxOutputCharsPerItem: 300,
            },
            provenance,
          )
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.map((result) => ({ ...summary, history: result.history })),
            Effect.catch(() => Effect.succeed(summary)),
          );
      },
      { concurrency: 4 },
    );
    return { reason, targets, errors: values.filter((value) => value.kind === "error") };
  });
  return SessionWaiter.of({
    wait: Effect.fn("SessionWaiter.wait")(function* (input, provenance) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs;
          const wakeups = yield* Queue.sliding<void>(1);
          yield* Effect.addFinalizer(() => Queue.shutdown(wakeups));
          // These owner streams acquire PubSub subscriptions synchronously on their first pull.
          // Start each consumer immediately so the baseline cannot overtake subscription.
          for (const source of sources) {
            yield* source.pipe(
              Stream.runForEach(() => Queue.offer(wakeups, undefined)),
              Effect.forkScoped({ startImmediately: true }),
            );
          }
          const nextEvent = Queue.take(wakeups).pipe(Effect.as("event" as const));
          let values = yield* inspect(input, provenance);
          if (input.timeoutMs === 0) return yield* deliver(values, "snapshot", provenance);
          for (;;) {
            const ready = values.some(
              (value) =>
                value.kind === "error" ||
                (value.changed &&
                  (value.value.disposition === "complete" ||
                    value.value.disposition === "needs_attention")),
            );
            if (ready) return yield* deliver(values, "ready", provenance);
            const remaining = deadline - (yield* Clock.currentTimeMillis);
            if (remaining <= 0)
              return yield* deliver(yield* inspect(input, provenance), "timeout", provenance);
            const wake = yield* Effect.race(
              nextEvent,
              Effect.sleep(remaining).pipe(Effect.as("timeout" as const)),
            );
            if (wake === "timeout")
              return yield* deliver(yield* inspect(input, provenance), "timeout", provenance);
            values = yield* inspect(input, provenance);
          }
        }),
      );
    }),
  });
});

export const live = Layer.effect(SessionWaiter, make);
