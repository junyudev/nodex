import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";

/** Observes a bounded set of volatile operations without starting a Runtime. */
export const makeOperationCompletionObserver = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeSupervisor;
  const observationSignals = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  type Observation = {
    readonly key: string;
    readonly slot?: string;
    readonly generation: string;
    readonly phase: string;
    readonly read: Effect.Effect<{ readonly phase: string }, unknown>;
    readonly settled?: () => void;
    readonly onSucceeded?: Effect.Effect<void>;
    readonly released?: () => void;
  };
  const observations = new Map<string, Observation>();
  const observed = new Set<string>();
  const isPendingPhase = (phase: string) =>
    ["running", "starting", "waiting", "verifying"].includes(phase);
  const recordCompletion = (observation: Observation, phase: string) =>
    Effect.gen(function* () {
      observation.settled?.();
      if (observed.size >= 256) observed.delete(observed.values().next().value!);
      observed.add(observation.key);
      if (phase === "succeeded") yield* observation.onSucceeded ?? Effect.void;
    });
  const releaseObservation = (slot: string, observation: Observation) => {
    if (observations.get(slot) !== observation) return;
    observations.delete(slot);
    observation.released?.();
  };
  const observeCompletion = (input: Observation) =>
    Effect.gen(function* () {
      if (observed.has(input.key)) return;
      const slot = input.slot ?? input.key;
      if (observations.get(slot)?.key === input.key) return;
      const previous = observations.get(slot);
      if (previous) releaseObservation(slot, previous);
      if (!isPendingPhase(input.phase)) {
        input.released?.();
        yield* recordCompletion(input, input.phase);
        return;
      }
      observations.set(slot, input);
      yield* PubSub.publish(observationSignals, undefined);
    });
  const pollObservation = Effect.fn("AgentOperationCompletion.poll")(function* (
    slot: string,
    observation: Observation,
  ) {
    const process = yield* runtime.currentConnection;
    if (process?.identity.runtimeGeneration !== observation.generation) {
      releaseObservation(slot, observation);
      return;
    }
    const result = yield* Effect.result(observation.read);
    if (observations.get(slot) !== observation) return;
    const current = yield* runtime.currentConnection;
    if (
      current?.identity.runtimeGeneration !== observation.generation ||
      result._tag === "Failure"
    ) {
      releaseObservation(slot, observation);
      return;
    }
    if (isPendingPhase(result.success.phase)) return;
    releaseObservation(slot, observation);
    yield* recordCompletion(observation, result.success.phase);
  });
  const observationSubscription = yield* PubSub.subscribe(observationSignals);
  yield* Stream.fromSubscription(observationSubscription).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        while (observations.size > 0) {
          yield* Effect.sleep("500 millis");
          yield* Effect.forEach(
            [...observations],
            ([slot, observation]) => pollObservation(slot, observation),
            { concurrency: 8, discard: true },
          );
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return observeCompletion;
});
