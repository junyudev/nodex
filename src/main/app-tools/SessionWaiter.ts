import type { components } from "@nodex/core-protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { subscribe as subscribeExecutionChanges } from "../agent-runtime/AgentRuntimeExecutionChanges";
import { SessionObservation, type SessionInspection } from "./SessionObservation";
import type { SessionProgress } from "../../shared/nodex-app-tools/session-history";

type Provenance = components["schemas"]["AgentTurnProvenance"];
export interface SessionWaitInput {
  readonly targets: readonly {
    readonly sessionId: string;
    readonly execution?: { readonly threadId: string };
    readonly runId?: string | null;
    readonly afterCursor?: string;
  }[];
  readonly timeoutMs: number;
}

type Observation =
  | { readonly kind: "snapshot"; readonly value: SessionInspection; readonly changed: boolean }
  | {
      readonly kind: "error";
      readonly sessionId: string;
      readonly execution?: { readonly threadId: string };
      readonly reason: string;
    };
type WaitTarget = Omit<
  SessionInspection,
  "executionRevision" | "selectionPending" | "continuationPending"
> & {
  readonly changed: boolean;
  readonly progress?: SessionProgress;
};
export interface SessionWaitResult {
  readonly reason: "snapshot" | "ready" | "timeout";
  readonly targets: readonly WaitTarget[];
  readonly errors: readonly Extract<Observation, { kind: "error" }>[];
}

const hasChangedCompletion = (values: readonly Observation[]) =>
  values.some(
    (value) =>
      value.kind === "snapshot" &&
      value.changed &&
      !value.value.continuationPending &&
      (value.value.disposition === "complete" ||
        value.value.disposition === "unavailable" ||
        ["failed", "systemError", "cancelled", "interrupted", "rolled_back", "completed"].includes(
          value.value.status,
        )),
  );

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
export const makeWithSources = (
  sources: readonly Stream.Stream<void>[],
  options?: {
    readonly prepareSources?: Effect.Effect<readonly Stream.Stream<void>[], never, Scope.Scope>;
  },
) =>
  Effect.gen(function* () {
    const observations = yield* SessionObservation;
    const inspect = Effect.fn("SessionWaiter.inspect")(function* (
      input: SessionWaitInput,
      provenance: Provenance,
    ) {
      return yield* Effect.forEach(
        input.targets,
        (target): Effect.Effect<Observation> =>
          observations.inspect(target.sessionId, provenance, target.runId, target.execution).pipe(
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
                ...(target.execution ? { execution: target.execution } : {}),
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
      const delivered = yield* Effect.forEach(
        values.filter((value) => value.kind === "snapshot"),
        (target): Effect.Effect<WaitTarget | Extract<Observation, { kind: "error" }>> => {
          const {
            executionRevision: _internal,
            selectionPending: _pending,
            continuationPending: _continuationPending,
            ...publicTarget
          } = target.value;
          const summary = { ...publicTarget, changed: target.changed };
          if (!target.changed && (reason !== "timeout" || target.value.disposition !== "running"))
            return Effect.succeed(summary);
          return observations
            .progress(
              target.value.sessionId,
              provenance,
              target.value.runId,
              target.value.execution,
            )
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.map((progress) => ({ ...summary, progress })),
              Effect.catch(
                (error): Effect.Effect<WaitTarget | Extract<Observation, { kind: "error" }>> => {
                  if (
                    "reason" in error &&
                    (error.reason === "authorization" || error.reason === "authority_changed")
                  )
                    return Effect.succeed({
                      kind: "error" as const,
                      sessionId: summary.sessionId,
                      reason: error.reason,
                    });
                  return Effect.succeed({
                    ...summary,
                    progress: {
                      availability: "unavailable" as const,
                      coverage: "unavailable" as const,
                      nextCursor: null,
                      latestMessage: null,
                      latestTool: null,
                    },
                  });
                },
              ),
            );
        },
        { concurrency: 4 },
      );
      return {
        reason,
        targets: delivered.filter((value): value is WaitTarget => !("kind" in value)),
        errors: [
          ...values.filter((value) => value.kind === "error"),
          ...delivered.filter(
            (value): value is Extract<Observation, { kind: "error" }> => "kind" in value,
          ),
        ],
      };
    });
    return SessionWaiter.of({
      wait: Effect.fn("SessionWaiter.wait")(function* (input, provenance) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs;
            const wakeups = yield* Queue.sliding<void>(1);
            yield* Effect.addFinalizer(() => Queue.shutdown(wakeups));
            const prepared = options?.prepareSources ? yield* options.prepareSources : [];
            // Prepared streams own their subscription before the first state inspection.
            // These owner streams acquire PubSub subscriptions synchronously on their first pull.
            // Start each consumer immediately so the baseline cannot overtake subscription.
            for (const source of [...sources, ...prepared]) {
              yield* source.pipe(
                Stream.runForEach(() => Queue.offer(wakeups, undefined)),
                Effect.forkScoped({ startImmediately: true }),
              );
            }
            const nextEvent = Queue.take(wakeups).pipe(Effect.as("event" as const));
            let values = yield* inspect(input, provenance);
            // Admission without a producer Turn id stays unresolved. Every other omission
            // selects once; null then pins a genuinely empty Session for the whole call.
            const pin = (current: SessionWaitInput): SessionWaitInput => ({
              ...current,
              targets: current.targets.map((target) => {
                if (target.runId !== undefined) return target;
                const snapshot = values.find(
                  (value) =>
                    value.kind === "snapshot" &&
                    value.value.sessionId === target.sessionId &&
                    value.value.execution?.threadId === target.execution?.threadId,
                );
                return snapshot?.kind === "snapshot" && !snapshot.value.selectionPending
                  ? { ...target, runId: snapshot.value.selectedRunId }
                  : target;
              }),
            });
            let pinned = pin(input);
            if (input.timeoutMs === 0) return yield* deliver(values, "snapshot", provenance);
            for (;;) {
              const ready =
                values.some((value) => value.kind === "error") || hasChangedCompletion(values);
              if (ready) return yield* deliver(values, "ready", provenance);
              const remaining = deadline - (yield* Clock.currentTimeMillis);
              if (remaining <= 0) {
                const final = yield* inspect(pinned, provenance);
                const settled = hasChangedCompletion(final);
                return yield* deliver(final, settled ? "ready" : "timeout", provenance);
              }
              const ownerChanges = values.flatMap((value) =>
                value.kind === "snapshot" && value.value.executionRevision !== undefined
                  ? [
                      observations.awaitChange(value.value, provenance, remaining).pipe(
                        Effect.as("event" as const),
                        Effect.catch(() => Effect.succeed("event" as const)),
                      ),
                    ]
                  : [],
              );
              const wake = yield* Effect.raceAll([
                nextEvent,
                ...ownerChanges,
                Effect.sleep(remaining).pipe(Effect.as("timeout" as const)),
              ]);
              if (wake === "timeout") {
                const final = yield* inspect(pinned, provenance);
                const settled = hasChangedCompletion(final);
                return yield* deliver(final, settled ? "ready" : "timeout", provenance);
              }
              values = yield* inspect(pinned, provenance);
              pinned = pin(pinned);
            }
          }),
        );
      }),
    });
  });

export const make = Effect.gen(function* () {
  const database = yield* DatabaseNotifierRuntime;
  const codex = yield* CodexApplicationEventHub;
  const runtime = yield* AgentRuntimeSupervisor;
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
  ];
  return yield* makeWithSources(sources, {
    prepareSources: subscribeExecutionChanges(runtime.get()).pipe(Effect.map((source) => [source])),
  });
});

export const live = Layer.effect(SessionWaiter, make);
